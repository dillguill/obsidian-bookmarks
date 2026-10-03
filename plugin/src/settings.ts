import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { ClipperTemplate } from "./api";
import type BookmarksPlugin from "./main";

export interface BookmarksSettings {
  /** Base URL of the bookmarks-server container, e.g. https://bookmarks.tailnet.ts.net */
  serverUrl: string;
  /**
   * Name of the SecretStorage entry holding the API token. The token itself is
   * never written to data.json (design §8).
   */
  tokenSecretName: string;
  /** Legacy: the notes folder is now each template's note location; migrated to the server once. */
  notesFolder?: string;
  assetsFolder: string;
  /** Poll fallback interval for draining completed jobs (design §3). */
  pollIntervalSeconds: number;
  /**
   * Legacy per-device site list from before capture settings moved to the
   * server; migrated there on the next successful sync, then removed.
   */
  noScreenshotSites?: string[];
  /** Last templates fetched from the server, so the dedup index works offline. */
  templatesCache?: ClipperTemplate[];
  /** Cached shared hideCaptureId setting. */
  hideCaptureId?: boolean;
  /** capture_id -> note path for recent captures this device wrote, so idempotency holds when capture_id is hidden. */
  writtenCaptures?: Record<string, string>;
}

export const DEFAULT_SETTINGS: BookmarksSettings = {
  serverUrl: "",
  tokenSecretName: "",
  assetsFolder: "Bookmarks/assets",
  pollIntervalSeconds: 60,
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
      .setName("Capture settings and templates")
      .setDesc("Screenshot style, site lists and note templates are shared by every device, so they're edited on the server's settings page.")
      .addButton((button) =>
        button.setButtonText("Open settings page").onClick(() => {
          const url = this.plugin.settingsPageUrl();
          if (url) window.open(url);
          else new Notice("Set the server URL first.");
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
