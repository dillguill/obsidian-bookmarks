import { App, PluginSettingTab, SecretComponent, Setting, requestUrl } from "obsidian";
import type BookmarksPlugin from "./main";

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
}

export const DEFAULT_SETTINGS: BookmarksSettings = {
  serverUrl: "",
  tokenSecretName: "",
  notesFolder: "Bookmarks/notes",
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
      .setDesc("Fallback check for finished captures when live updates drop.")
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
    const { serverUrl } = this.plugin.settings;
    if (!serverUrl) return false;
    try {
      const response = await requestUrl({
        url: new URL("/health", serverUrl).toString(),
        headers: { Authorization: `Bearer ${this.plugin.getToken() ?? ""}` },
        throw: false,
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }
}
