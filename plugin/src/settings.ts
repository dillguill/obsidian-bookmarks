import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { CaptureSettings, ScreenshotStyle } from "./api";
import type BookmarksPlugin from "./main";
import { siteEntry } from "./url";

export interface BookmarksSettings {
  /** Base URL of the bookmarks-server container, e.g. https://bookmarks.tailnet.ts.net */
  serverUrl: string;
  /**
   * Name of the SecretStorage entry holding the API token. The token itself is
   * never written to data.json (design §8).
   */
  tokenSecretName: string;
  notesFolder: string;
  assetsFolder: string;
  /** Poll fallback interval for draining completed jobs (design §3). */
  pollIntervalSeconds: number;
  /**
   * Legacy per-device site list from before capture settings moved to the
   * server; migrated there on the next successful sync, then removed.
   */
  noScreenshotSites?: string[];
}

export const DEFAULT_SETTINGS: BookmarksSettings = {
  serverUrl: "",
  tokenSecretName: "",
  notesFolder: "Bookmarks/notes",
  assetsFolder: "Bookmarks/assets",
  pollIntervalSeconds: 60,
};

const STYLE_LABELS: Record<ScreenshotStyle, string> = {
  full: "Full page",
  banner: "Banner (first screen)",
  none: "No screenshot",
};

const parseSites = (value: string): string[] => [...new Set(value.split("\n").map(siteEntry).filter(Boolean))];

export class BookmarksSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: BookmarksPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Address of your bookmarks-server container.")
      .addText((text) =>
        text
          .setPlaceholder("https://bookmarks.example.ts.net")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API token")
      .setDesc("Stored in Obsidian's secret storage, not in plugin data.")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.tokenSecretName)
          .onChange(async (value) => {
            this.plugin.settings.tokenSecretName = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Test connection")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          try {
            const ok = await this.testConnection();
            button.setButtonText(ok ? "Connected" : "Failed");
          } finally {
            button.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Bookmark notes folder")
      .addText((text) =>
        text.setValue(this.plugin.settings.notesFolder).onChange(async (value) => {
          this.plugin.settings.notesFolder = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Assets folder")
      .setDesc("Where screenshots are saved.")
      .addText((text) =>
        text.setValue(this.plugin.settings.assetsFolder).onChange(async (value) => {
          this.plugin.settings.assetsFolder = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Poll interval (seconds)")
      .setDesc("How often to check the server for captures sent from other devices.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pollIntervalSeconds)).onChange(async (value) => {
          const seconds = Number.parseInt(value, 10);
          if (Number.isFinite(seconds) && seconds > 0) {
            this.plugin.settings.pollIntervalSeconds = seconds;
            await this.plugin.saveSettings();
          }
        }),
      );

    void this.displayCaptureSettings(containerEl);
  }

  /**
   * Capture settings live on the server so every device, and captures sent
   * from a phone Shortcut, follow the same rules.
   */
  private async displayCaptureSettings(containerEl: HTMLElement): Promise<void> {
    const section = containerEl.createDiv();
    new Setting(section).setName("Capture").setHeading().setDesc("Shared by every device that uses this server.");
    if (!this.plugin.settings.serverUrl) {
      section.createEl("p", { text: "Set the server URL to change capture settings.", cls: "setting-item-description" });
      return;
    }
    let settings: CaptureSettings;
    try {
      settings = await this.plugin.client().getSettings();
    } catch (err) {
      section.createEl("p", {
        text: `Couldn't load capture settings: ${err instanceof Error ? err.message : String(err)}`,
        cls: "setting-item-description",
      });
      return;
    }

    const save = async (change: Partial<CaptureSettings>) => {
      try {
        settings = await this.plugin.client().saveSettings({ ...settings, ...change });
      } catch (err) {
        new Notice(`Couldn't save capture settings: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    new Setting(section)
      .setName("Screenshot style")
      .setDesc("Full page scrolls the whole page, banner keeps the first screen, or save no screenshot at all.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(STYLE_LABELS)
          .setValue(settings.screenshotStyle)
          .onChange((value) => void save({ screenshotStyle: value as ScreenshotStyle })),
      );

    const siteList = (name: string, desc: string, key: "bannerSites" | "noScreenshotSites", placeholder: string) =>
      new Setting(section)
        .setName(name)
        .setDesc(desc)
        .addTextArea((area) => {
          area.setPlaceholder(placeholder).setValue(settings[key].join("\n"));
          area.inputEl.rows = 4;
          // Save on blur, not per keystroke, so half-typed sites never reach the server.
          area.inputEl.addEventListener("blur", () => void save({ [key]: parseSites(area.getValue()) }));
        });
    siteList(
      "Sites with banner screenshots",
      "One site per line. These sites and their subdomains get only the first screen, whatever the style above.",
      "bannerSites",
      "youtube.com",
    );
    siteList(
      "Sites without screenshots",
      "One site per line, e.g. nytimes.com. These sites and their subdomains keep the link and text but no screenshot. Blocked pages never get one.",
      "noScreenshotSites",
      "nytimes.com\nreddit.com",
    );
  }

  private async testConnection(): Promise<boolean> {
    if (!this.plugin.settings.serverUrl) return false;
    try {
      const problem = await this.plugin.checkServer();
      if (problem) new Notice(problem);
      return problem === null;
    } catch (err) {
      new Notice(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
