import { App, SuggestModal } from "obsidian";
import { filterSources, type SourceEntry } from "./enrich";

/** A searchable list of variables and files to add to the update. */
export class SourcePicker extends SuggestModal<SourceEntry> {
  constructor(
    app: App,
    private readonly entries: readonly SourceEntry[],
    placeholder: string,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
    this.emptyStateText = "No matching variables";
    this.limit = 500;
  }

  getSuggestions(query: string): SourceEntry[] {
    return filterSources(this.entries, query);
  }

  renderSuggestion(entry: SourceEntry, el: HTMLElement): void {
    const top = el.createDiv();
    Object.assign(top.style, { display: "flex", justifyContent: "space-between", gap: "8px" });
    const name = top.createSpan({ text: entry.name });
    Object.assign(name.style, { fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    Object.assign(top.createSpan({ text: entry.section }).style, { color: "var(--text-faint)", fontSize: "var(--font-ui-smaller)", flex: "none" });
    if (entry.detail) {
      const detail = el.createDiv({ text: entry.detail });
      Object.assign(detail.style, { color: "var(--text-muted)", fontSize: "var(--font-ui-smaller)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    }
  }

  onChooseSuggestion(entry: SourceEntry): void {
    entry.choose();
  }
}
