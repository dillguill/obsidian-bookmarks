import { App, SuggestModal } from "obsidian";
import { filterWords } from "./search";

export interface PickerOptions<T> {
  placeholder: string;
  empty: string;
  /** What a search matches against. */
  text: (item: T) => string;
  render: (item: T, el: HTMLElement) => void;
  choose: (item: T) => void;
}

/** A searchable list to pick one item from; the query matches every word anywhere in an item's text. */
export class Picker<T> extends SuggestModal<T> {
  constructor(
    app: App,
    private readonly items: readonly T[],
    private readonly options: PickerOptions<T>,
  ) {
    super(app);
    this.setPlaceholder(options.placeholder);
    this.emptyStateText = options.empty;
    this.limit = 500;
  }

  getSuggestions(query: string): T[] {
    return filterWords(this.items, query, this.options.text);
  }

  renderSuggestion(item: T, el: HTMLElement): void {
    this.options.render(item, el);
  }

  onChooseSuggestion(item: T): void {
    this.options.choose(item);
  }
}

