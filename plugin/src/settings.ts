import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
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
  /** Sites (and their subdomains) whose bookmarks are saved without a screenshot. */
  noScreenshotSites: string[];
}

export const DEFAULT_SETTINGS: BookmarksSettings = {
  serverUrl: "",
  tokenSecretName: "",
  notesFolder: "Bookmarks/notes",
  assetsFolder: "Bookmarks/assets",
  pollIntervalSeconds: 60,
  noScreenshotSites: [],
};

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
      .setName("Sites without screenshots")
      .setDesc("One site per line, e.g. nytimes.com. Bookmarks from these sites and their subdomains keep the link and text but no screenshot. Blocked pages never get one.")
      .addTextArea((area) => {
        area
          .setPlaceholder("nytimes.com\nreddit.com")
          .setValue(this.plugin.settings.noScreenshotSites.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.noScreenshotSites = value.split("\n").map(siteEntry).filter(Boolean);
            await this.plugin.saveSettings();
          });
        area.inputEl.rows = 4;
      });

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
