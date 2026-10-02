import { App, Modal, Setting } from "obsidian";

/** Asks for the URL to capture (prefilled from the clipboard) and which template to use. */
export class CaptureModal extends Modal {
  constructor(
    app: App,
    private readonly initial: string,
    private readonly templates: readonly string[],
    private readonly onSubmit: (url: string, template: string | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Capture bookmark");
    let value = this.initial;
    let template = "";
    const submit = () => {
      if (!value.trim()) return;
      this.close();
      this.onSubmit(value.trim(), template || null);
    };

    new Setting(this.contentEl).setName("URL").addText((text) => {
      text.setPlaceholder("https://…").setValue(value).onChange((v) => (value = v));
      text.inputEl.style.width = "100%";
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });
      window.setTimeout(() => text.inputEl.select(), 0);
    });

    if (this.templates.length > 1) {
      new Setting(this.contentEl)
        .setName("Template")
        .setDesc("Automatic picks the first template whose trigger matches, else the default.")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Automatic");
          for (const name of this.templates) dropdown.addOption(name, name);
          dropdown.onChange((v) => (template = v));
        });
    }

    new Setting(this.contentEl).addButton((button) => button.setButtonText("Capture").setCta().onClick(submit));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
