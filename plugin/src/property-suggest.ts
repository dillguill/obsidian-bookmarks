import { AbstractInputSuggest, App } from "obsidian";

/** Suggests the vault's property names under a text input. */
export class PropertySuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    private readonly input: HTMLInputElement,
    private readonly names: () => string[],
    private readonly onPick: (name: string) => void,
  ) {
    super(app, input);
  }

  protected getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    const matches = this.names().filter((name) => name.toLowerCase().includes(q));
    // Names starting with the query first, the rest in their order.
    return [...matches.filter((name) => name.toLowerCase().startsWith(q)), ...matches.filter((name) => !name.toLowerCase().startsWith(q))];
  }

  renderSuggestion(name: string, el: HTMLElement): void {
    el.setText(name);
  }

  override selectSuggestion(name: string): void {
    this.setValue(name);
    this.onPick(name);
    this.close();
  }
}
