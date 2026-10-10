import { App, Modal, SuggestModal } from "obsidian";
import {
  initialDispositions,
  mergeChoices,
  pickProblem,
  setDisposition,
  type ConflictPick,
  type Disposition,
  type Dispositions,
  type MergeNote,
  type PropertyChoice,
} from "./merge";
import { clipped, preview, rowLine, sectionHead, smallSelect } from "./modal-ui";
import { PropertySuggest } from "./property-suggest";

const DISPOSITIONS: { value: Disposition; text: string }[] = [
  { value: "keep", text: "Keep" },
  { value: "merge", text: "Merge" },
  { value: "delete", text: "Delete" },
  { value: "separate", text: "Separate" },
];

/** One page's notes, as the merge view shows them. */
export interface MergeGroup {
  url: string;
  /** In the order they're offered as the one to keep (rankNotes). */
  notes: MergeNote[];
  /** Paths already marked separate. */
  separate: string[];
}

/** What the user settled on. */
export interface MergeSelection {
  state: Dispositions;
  choices: PropertyChoice[];
  /** How each conflicting property is settled. */
  picks: Record<string, ConflictPick>;
  removeFiles: boolean;
}

export interface MergeHandlers {
  /** URL and capture id property names, never offered. */
  skip: string[];
  /** Every property name in the vault, for naming kept values. */
  propertyNames: () => string[];
  /** The vault's usual spelling of a property name, by its lowercase form. */
  spelling: (lower: string) => string | undefined;
  /** Files only the removed notes use, for the current selection. */
  unusedCount: (selection: MergeSelection) => number;
  onApply: (selection: MergeSelection) => void;
  /** Given in the vault-wide flow: moves on without changing anything. */
  onSkip?: () => void;
}

/** Resolves one group of notes for the same page: what happens to each note and which property values win. */
export class MergeModal extends Modal {
  private state: Dispositions;
  private picks: Record<string, ConflictPick> = {};
  private removeFiles = true;
  private choices: PropertyChoice[] = [];
  private notesEl!: HTMLElement;
  private propsEl!: HTMLElement;
  private filesEl!: HTMLElement;
  private problemEl!: HTMLElement;
  private primary!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly group: MergeGroup,
    private readonly handlers: MergeHandlers,
  ) {
    super(app);
    this.state = initialDispositions(group.notes, group.separate);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText("Merge duplicates");
    const url = contentEl.createDiv({ text: this.group.url, cls: "setting-item-description" });
    Object.assign(url.style, { wordBreak: "break-all", marginBottom: "4px" });
    sectionHead(contentEl, "Notes");
    this.notesEl = contentEl.createDiv();
    this.propsEl = contentEl.createDiv();
    this.filesEl = contentEl.createDiv();
    this.problemEl = contentEl.createDiv();
    Object.assign(this.problemEl.style, { color: "var(--text-error)", marginTop: "8px" });
    const buttons = contentEl.createDiv();
    Object.assign(buttons.style, { display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "8px", marginTop: "16px" });
    if (this.handlers.onSkip) {
      buttons.createEl("button", { text: "Skip" }).onclick = () => {
        this.close();
        this.handlers.onSkip?.();
      };
    }
    this.primary = buttons.createEl("button", { cls: "mod-cta" });
    this.primary.onclick = () => {
      this.close();
      this.handlers.onApply(this.selection());
    };
    this.renderNotes();
    this.update();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private selection(): MergeSelection {
    return { state: this.state, choices: this.choices, picks: this.picks, removeFiles: this.removeFiles };
  }

  private having(d: Disposition): MergeNote[] {
    return this.group.notes.filter((n) => this.state.get(n.path) === d);
  }

  private renderNotes(): void {
    this.notesEl.empty();
    for (const note of this.group.notes) {
      const { main, controls } = rowLine(this.notesEl);
      Object.assign(main.style, { flexDirection: "column", alignItems: "stretch", gap: "0" });
      const name = clipped(main, note.basename);
      Object.assign(name.style, { fontWeight: "600", cursor: "pointer" });
      name.title = note.path;
      name.onclick = () => void this.app.workspace.openLinkText(note.path, "", "tab");
      const links = `${note.backlinks} link${note.backlinks === 1 ? "" : "s"}`;
      clipped(main, note.folder ? `${note.folder} · ${links}` : links, true);

      const select = smallSelect(controls);
      for (const d of DISPOSITIONS) select.createEl("option", { text: d.text, value: d.value });
      select.value = this.state.get(note.path)!;
      select.onchange = () => {
        this.state = setDisposition(this.state, this.group.notes, note.path, select.value as Disposition);
        this.renderNotes();
        this.update();
      };
    }
  }

  /** Recomputes the properties, the file option and the button after the dispositions change. */
  private update(): void {
    const kept = this.having("keep");
    this.choices = kept.length ? mergeChoices([...kept, ...this.having("merge")], this.handlers.skip, this.handlers.spelling) : [];
    // Picks that no longer fit their property (it stopped conflicting, or its values changed) start over.
    for (const [name, pick] of Object.entries(this.picks)) {
      const choice = this.choices.find((c) => c.name === name);
      if (choice?.kind !== "conflict" || (pick.kind === "each" && pick.names.length !== choice.options.length)) delete this.picks[name];
    }
    this.renderProperties();
    this.renderFiles();
    this.renderButton();
  }

  private renderProperties(): void {
    const el = this.propsEl;
    el.empty();
    if (!this.having("merge").length) return;
    const conflicts = this.choices.filter((c) => c.kind === "conflict");
    const combined = this.choices.filter((c) => c.kind !== "conflict").map((c) => c.name);
    if (conflicts.length) sectionHead(el, "Properties");
    for (const choice of conflicts) this.renderConflict(el, choice);
    if (combined.length) {
      const shown = combined.slice(0, 4).join(", ") + (combined.length > 4 ? ", …" : "");
      const line = el.createEl("p", { cls: "setting-item-description", text: `${combined.length} propert${combined.length === 1 ? "y" : "ies"} combined automatically (${shown}).` });
      line.style.margin = "6px 0 0";
    }
  }

  /** A conflicting property: pick one value, keep them all as a list, or keep each under a name of its own. */
  private renderConflict(el: HTMLElement, choice: Extract<PropertyChoice, { kind: "conflict" }>): void {
    const from = (path: string) => this.group.notes.find((n) => n.path === path)?.basename ?? path;
    const { main, controls } = rowLine(el);
    clipped(main, choice.name).style.fontWeight = "600";
    const select = smallSelect(controls);
    select.style.maxWidth = "16em";
    choice.options.forEach((option, i) => {
      const item = select.createEl("option", { text: `${preview(option.value, 60)} — ${from(option.from)}`, value: `value:${i}` });
      item.title = preview(option.value, 2000);
    });
    select.createEl("option", { text: "Keep all as a list", value: "list" });
    select.createEl("option", { text: "Keep each value…", value: "each" });
    const pick = this.picks[choice.name] ?? { kind: "value", option: 0 };
    select.value = pick.kind === "value" ? `value:${pick.option}` : pick.kind;
    select.onchange = () => {
      if (select.value === "list") this.picks[choice.name] = { kind: "list" };
      // The kept note's value keeps the name; the others get a name to edit (empty drops one).
      else if (select.value === "each") this.picks[choice.name] = { kind: "each", names: choice.options.map((_, i) => (i === 0 ? choice.name : `${choice.name}_${i + 1}`)) };
      else this.picks[choice.name] = { kind: "value", option: Number(select.value.slice("value:".length)) };
      this.renderProperties();
      this.renderFiles();
      this.renderButton();
    };
    if (pick.kind !== "each") return;
    const list = el.createDiv();
    Object.assign(list.style, { paddingLeft: "12px", borderLeft: "2px solid var(--background-modifier-border)", marginBottom: "6px" });
    choice.options.forEach((option, i) => {
      const row = rowLine(list);
      const input = row.main.createEl("input", { type: "text", value: pick.names[i] ?? "", attr: { placeholder: "Don't keep" } });
      Object.assign(input.style, { width: "12em", maxWidth: "100%" });
      const set = (name: string) => {
        pick.names[i] = name;
        this.renderFiles();
        this.renderButton();
      };
      new PropertySuggest(this.app, input, this.handlers.propertyNames, set);
      input.oninput = () => set(input.value);
      const value = clipped(row.controls, `${preview(option.value, 60)} — ${from(option.from)}`, true);
      value.title = preview(option.value, 2000);
    });
  }

  private renderFiles(): void {
    const el = this.filesEl;
    el.empty();
    const count = this.handlers.unusedCount(this.selection());
    if (!count) return;
    const label = el.createEl("label");
    Object.assign(label.style, { display: "flex", alignItems: "center", gap: "8px", marginTop: "12px", cursor: "pointer" });
    const box = label.createEl("input", { type: "checkbox" });
    box.checked = this.removeFiles;
    box.onchange = () => {
      this.removeFiles = box.checked;
      this.renderButton();
    };
    label.createSpan({ text: `Remove ${count} file${count === 1 ? "" : "s"} only removed notes use` });
  }

  private renderButton(): void {
    const kept = this.having("keep")[0];
    const merge = this.having("merge").length;
    const del = this.having("delete").length;
    const separate = this.having("separate").map((n) => n.path);
    const marksChanged = separate.length !== this.group.separate.length || separate.some((p) => !this.group.separate.includes(p));
    const files = this.removeFiles ? this.handlers.unusedCount(this.selection()) : 0;
    let text = "Save";
    if (kept && merge + del > 0) {
      text = merge ? `Merge ${merge + 1} notes into “${kept.basename}”` : `Keep “${kept.basename}”`;
      if (del) text += ` · delete ${del}`;
      if (files) text += ` · remove ${files} file${files === 1 ? "" : "s"}`;
    }
    const problem = merge ? pickProblem(this.choices, this.picks) : null;
    this.problemEl.setText(problem ?? "");
    this.primary.setText(text);
    this.primary.disabled = (merge + del === 0 && !marksChanged) || problem !== null;
  }
}

/** A duplicate group in the vault-wide list. */
export interface DuplicateEntry {
  key: string;
  url: string;
  names: string[];
  /** Notes not marked separate. */
  active: number;
}

/** Searchable list of every duplicate group in the vault. */
export class DuplicateListModal extends SuggestModal<DuplicateEntry> {
  constructor(
    app: App,
    private readonly entries: readonly DuplicateEntry[],
    private readonly onChoose: (entry: DuplicateEntry) => void,
  ) {
    super(app);
    this.setPlaceholder("Search duplicate bookmarks…");
    this.emptyStateText = "No matching duplicates";
    this.limit = 500;
  }

  getSuggestions(query: string): DuplicateEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.entries.filter((entry) => {
      const text = `${entry.url}\n${entry.names.join("\n")}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }

  renderSuggestion(entry: DuplicateEntry, el: HTMLElement): void {
    const url = el.createDiv({ text: entry.url });
    Object.assign(url.style, { fontWeight: "600", wordBreak: "break-all" });
    const names = el.createDiv({ text: entry.names.join(" · ") });
    Object.assign(names.style, { color: "var(--text-muted)", fontSize: "var(--font-ui-smaller)" });
  }

  onChooseSuggestion(entry: DuplicateEntry): void {
    this.onChoose(entry);
  }
}
