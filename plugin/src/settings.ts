import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { ClipperTemplate } from "./api";
import { FolderSuggest } from "./folder-suggest";
import type { PendingInsert } from "./placeholders";
import type BookmarksPlugin from "./main";
import { PropertySuggest } from "./property-suggest";
import { urlPropertyName } from "./template";
import { errorText } from "./errors";

export interface BookmarksSettings {
  /** Base URL of the bookmarks-server container, e.g. https://bookmarks.tailnet.ts.net */
  serverUrl: string;
  /**
   * Name of the SecretStorage entry holding the API token. Per-device: kept in
   * the vault's localStorage, never in data.json (design §8).
   */
  tokenSecretName: string;
  /** Legacy: the notes folder is now each template's note location; migrated to the server once. */
  notesFolder?: string;
  /** Legacy: where capture files went before they followed Obsidian's attachment setting; becomes attachmentFolder once. */
  assetsFolder?: string;
  /** Where capture files and downloaded media go; empty follows Obsidian's "Default location for new attachments". */
  attachmentFolder: string;
  /** Screenshots a written note is still waiting on, with where each goes in the note. */
  pendingInserts: PendingInsert[];
  /** Poll fallback interval for draining completed jobs (design §3). */
  pollIntervalSeconds: number;
  /**
   * Legacy per-device "no screenshot" sites; screenshots are template
   * variables now, so this is dropped on the next successful sync.
   */
  noScreenshotSites?: string[];
  /** Last templates fetched from the server, so the dedup index works offline. */
  templatesCache?: ClipperTemplate[];
  /** Cached shared hideCaptureId setting. */
  hideCaptureId?: boolean;
  /** capture_id -> note path for recent captures this device wrote, so idempotency holds when capture_id is hidden. */
  writtenCaptures?: Record<string, string>;
  /** The property holding a note's web address; templates' URL properties are read too. */
  urlProperty: string;
  /** Normalized URL -> paths of notes that share it on purpose, so they aren't offered as duplicates. */
  separateNotes?: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: BookmarksSettings = {
  serverUrl: "",
  tokenSecretName: "",
  attachmentFolder: "",
  pendingInserts: [],
  pollIntervalSeconds: 60,
  urlProperty: "source",
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
      .setDesc("Stored in Obsidian's secret storage on this device, not in plugin data. Choose it once on each device.")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.tokenSecretName)
          .onChange((value) => {
            this.plugin.setTokenSecretName(value);
            this.plugin.schedulePoll();
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
      .setName("Attachment folder override")
      .setDesc(attachmentDescription(this.app))
      .addText((text) => {
        text.setPlaceholder("Use Obsidian's attachment setting").setValue(this.plugin.settings.attachmentFolder);
        const save = async (value: string) => {
          this.plugin.settings.attachmentFolder = value.trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        };
        text.onChange((value) => void save(value));
        new FolderSuggest(this.app, text.inputEl, (path) => void save(path));
      });

    const urlSetting = new Setting(containerEl).setName("URL property");
    const describeUrl = () => {
      urlSetting.descEl.empty();
      urlSetting.descEl.appendText("The property that holds a note's web address. Used to find duplicates and to update notes from their source.");
      // Notes the plugin writes keep their template's URL property, so those are read as well.
      for (const template of this.plugin.settings.templatesCache ?? []) {
        const name = urlPropertyName(template);
        if (name === this.plugin.settings.urlProperty) continue;
        const line = urlSetting.descEl.createDiv();
        line.appendText(`Template ${template.name} saves the URL in `);
        line.createEl("code", { text: name });
        line.appendText("; those notes are found too.");
      }
    };
    describeUrl();
    urlSetting.addText((text) => {
      const save = async (value: string) => {
        const name = value.trim() || DEFAULT_SETTINGS.urlProperty;
        text.setValue(name);
        if (name === this.plugin.settings.urlProperty) return;
        this.plugin.settings.urlProperty = name;
        await this.plugin.saveSettings();
        this.plugin.rebuildIndex();
        describeUrl();
      };
      text.setPlaceholder(DEFAULT_SETTINGS.urlProperty).setValue(this.plugin.settings.urlProperty);
      new PropertySuggest(this.app, text.inputEl, () => this.plugin.vaultProperties(), (name) => void save(name));
      text.inputEl.addEventListener("blur", () => void save(text.getValue()));
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
      new Notice(`Connection failed: ${errorText(err)}`);
      return false;
    }
  }
}

/** Says where screenshots and media go when the override is empty, from Obsidian's own setting. */
function attachmentDescription(app: App): string {
  let setting: unknown;
  try {
    // Not in the public API; only used to describe the setting, so a change there just loses the detail.
    setting = (app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.("attachmentFolderPath");
  } catch {
    setting = undefined;
  }
  const where =
    typeof setting !== "string"
      ? "where Obsidian's “Default location for new attachments” setting says"
      : setting === "/" || setting === ""
        ? "in the vault folder, as Obsidian's attachment setting says"
        : setting === "./"
          ? "next to each note, as Obsidian's attachment setting says"
          : setting.startsWith("./")
            ? `in a “${setting.slice(2)}” folder next to each note, as Obsidian's attachment setting says`
            : `in “${setting}”, as Obsidian's attachment setting says`;
  return `Screenshots and downloaded media go ${where}. Name a folder here to put them there instead.`;
}
