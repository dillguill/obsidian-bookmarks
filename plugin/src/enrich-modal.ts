import { App, Modal, Setting } from "obsidian";
import type { CaptureFile } from "./api";
import { fileLabel, type EnrichChoices, type EnrichSelection } from "./enrich";

function preview(value: unknown): string {
  if (value === undefined || value === null || value === "") return "(none)";
  const text = Array.isArray(value) ? value.map(String).join(", ") : typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * Lets the user pick what a fresh capture adds to an existing note: each
 * property (added, replaced, or merged into a list), the note body and each
 * image, and whether they go before or after the note's body.
 */
export class EnrichModal extends Modal {
  private readonly urls: string[] = [];
  private submitted = false;

  constructor(
    app: App,
    private readonly noteName: string,
    private readonly choices: EnrichChoices,
    /** Image data by capture file, for previews. */
    private readonly images: Partial<Record<CaptureFile, ArrayBuffer>>,
    private readonly imageType: string,
    private readonly noteBodyEmpty: boolean,
    private readonly onSubmit: (selection: EnrichSelection) => void,
    private readonly onDone: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, choices } = this;
    this.setTitle(`Enrich ${this.noteName}`);
    // Missing properties are picked by default; ones that would overwrite a value aren't.
    const selection: EnrichSelection = {
      properties: Object.fromEntries(choices.properties.filter((p) => p.current === undefined || p.current === null || p.current === "").map((p) => [p.name, "replace"])),
      body: this.noteBodyEmpty && choices.body !== "",
      images: [],
      position: "append",
    };

    if (choices.properties.length + choices.images.length === 0 && !choices.body) {
      contentEl.createEl("p", { text: "The page has nothing this note doesn't already have." });
    }

    if (choices.properties.length > 0) new Setting(contentEl).setName("Properties").setHeading();
    for (const property of choices.properties) {
      const exists = !(property.current === undefined || property.current === null || property.current === "");
      const setting = new Setting(contentEl).setName(property.name);
      const desc = setting.descEl;
      if (exists) desc.createDiv({ text: `Now: ${preview(property.current)}` });
      desc.createDiv({ text: `${exists ? "New" : "Value"}: ${preview(property.value)}` });
      let mode: "replace" | "merge" = "replace";
      if (property.mergeable) {
        setting.addDropdown((dropdown) =>
          dropdown
            .addOption("replace", "Replace")
            .addOption("merge", "Add to list")
            .setValue(mode)
            .onChange((value) => {
              mode = value as "replace" | "merge";
              if (selection.properties[property.name]) selection.properties[property.name] = mode;
            }),
        );
      }
      setting.addToggle((toggle) =>
        toggle
          .setTooltip(exists ? (property.mergeable ? "Replace or add to the current value" : "Replace the current value") : "Add this property")
          .setValue(property.name in selection.properties)
          .onChange((on) => {
            if (on) selection.properties[property.name] = mode;
            else delete selection.properties[property.name];
          }),
      );
    }
    if (choices.unchanged.length > 0) {
      contentEl.createEl("p", { cls: "setting-item-description", text: `Already up to date: ${choices.unchanged.join(", ")}` });
    }

    if (choices.body || choices.images.length > 0) new Setting(contentEl).setName("Note body").setHeading();
    if (choices.body) {
      new Setting(contentEl)
        .setName("Page content")
        .setDesc(preview(choices.body.replace(/bookmarks-[a-z_]+-5f2c9e/g, "…")))
        .addToggle((toggle) => toggle.setValue(selection.body).onChange((on) => (selection.body = on)));
    }
    for (const kind of choices.images) {
      const setting = new Setting(contentEl).setName(fileLabel(kind));
      const data = this.images[kind];
      if (data && kind !== "pdf_page") {
        const url = URL.createObjectURL(new Blob([data], { type: this.imageType }));
        this.urls.push(url);
        const img = setting.descEl.createEl("img", { attr: { src: url, alt: fileLabel(kind) } });
        img.style.maxWidth = "220px";
        img.style.maxHeight = "140px";
        img.style.objectFit = "cover";
        img.style.objectPosition = "top";
        img.style.borderRadius = "4px";
      }
      setting.addToggle((toggle) =>
        toggle.setValue(false).onChange((on) => {
          selection.images = on ? [...selection.images, kind] : selection.images.filter((k) => k !== kind);
        }),
      );
    }
    if (choices.body || choices.images.length > 0) {
      new Setting(contentEl)
        .setName("Position")
        .setDesc("Where picked content and images go in the note.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("append", "After the note's body")
            .addOption("prepend", "Before the note's body")
            .addOption("replace", "Replace the note's body")
            .setValue(selection.position)
            .onChange((value) => (selection.position = value as EnrichSelection["position"])),
        );
    }

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Apply")
          .setCta()
          .onClick(() => {
            this.submitted = true;
            this.close();
            this.onSubmit(selection);
          }),
      );
  }

  override onClose(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.contentEl.empty();
    if (!this.submitted) this.onDone();
  }
}
