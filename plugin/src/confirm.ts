import { App, Modal, Setting } from "obsidian";

/** Asks a yes/no question; resolves true when the user confirms. */
export function confirm(app: App, title: string, message: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new (class extends Modal {
      override onOpen(): void {
        this.setTitle(title);
        this.contentEl.createEl("p", { text: message });
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
          .addButton((button) =>
            button
              .setButtonText(ok)
              .setWarning()
              .onClick(() => {
                answered = true;
                this.close();
              }),
          );
      }

      override onClose(): void {
        this.contentEl.empty();
        resolve(answered);
      }
    })(app);
    modal.open();
  });
}
