import { App, Modal, Setting } from "obsidian";

/** Asks for the URL to capture, prefilled from the clipboard when it holds one. */
export class CaptureModal extends Modal {
  constructor(
    app: App,
    private readonly initial: string,
    private readonly onSubmit: (url: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Capture bookmark");
    let value = this.initial;
    const submit = () => {
      if (!value.trim()) return;
      this.close();
      this.onSubmit(value.trim());
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

    new Setting(this.contentEl).addButton((button) => button.setButtonText("Capture").setCta().onClick(submit));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
