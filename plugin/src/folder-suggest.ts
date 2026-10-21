import { AbstractInputSuggest, App, TFolder } from "obsidian";

/** Suggests the vault's folders under a text input. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    input: HTMLInputElement,
    private readonly onPick: (path: string) => void,
  ) {
    super(app, input);
  }

  protected getSuggestions(query: string): TFolder[] {
    const q = query.trim().toLowerCase();
    return this.app.vault
      .getAllFolders(false)
      .filter((folder) => folder.path.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.path.toLowerCase().startsWith(q)) - Number(!b.path.toLowerCase().startsWith(q)) || a.path.localeCompare(b.path))
      .slice(0, 100);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  override selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path);
    this.onPick(folder.path);
    this.close();
  }
}
