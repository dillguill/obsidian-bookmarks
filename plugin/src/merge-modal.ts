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
import { collapse, diffLines, diffStats, type DiffLine } from "./diff";
import { clipped, iconButton, preview, rowLine, sectionHead, smallSelect } from "./modal-ui";
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

/** What a merge would change, for the preview at the bottom of the view. */
export interface MergePreview {
  /** The kept note's text now and after the merge; null when only separate marks change. */
  kept: { name: string; before: string; after: string } | null;
  /** Notes whose bodies go into the kept note before they're trashed. */
  merged: string[];
  deleted: { name: string; text: string }[];
  /** Links in other notes that will point at the kept note. */
  redirects: number;
}

export interface MergeHandlers {
  /** URL and capture id property names, never offered. */
  skip: string[];
  /** Where to load a value's image from (a vault resource or web address), or null when it isn't one. */
  imageSrc: (value: unknown, from: string) => string | null;
  /** What the merge would change, for the preview. */
  preview: (selection: MergeSelection) => Promise<MergePreview>;
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
  /** Files only the removed notes use, counted once per change. */
  private unused = 0;
  /** Why counting them failed, shown instead of the file option so the merge still works. */
  private unusedError: string | null = null;
  private choices: PropertyChoice[] = [];
  private notesEl!: HTMLElement;
  private propsEl!: HTMLElement;
  private filesEl!: HTMLElement;
  private problemEl!: HTMLElement;
  private changesEl!: HTMLElement;
  private changesOpen = false;
  /** The preview last asked for, so a slower earlier one doesn't overwrite it. */
  private previewRun = 0;
  private lastPreview: MergePreview | null = null;
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
    this.changesEl = contentEl.createDiv();
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
      this.handlers.onApply(this.currentSelection());
    };
    this.renderNotes();
    this.update();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  // Not `selection`: Obsidian's Modal keeps the text selection under that name.
  private currentSelection(): MergeSelection {
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

  /** Recomputes the properties, the file option and the button after the dispositions change; a failure shows its message. */
  private update(): void {
    try {
      this.recompute();
    } catch (err) {
      console.error("bookmarks: merge view failed", err);
      this.problemEl.setText(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
      this.primary.setText("Merge");
    }
  }

  private recompute(): void {
    const kept = this.having("keep");
    this.choices = kept.length ? mergeChoices([...kept, ...this.having("merge")], this.handlers.skip, this.handlers.spelling) : [];
    // Picks that no longer fit their property (it stopped conflicting, or its values changed) start over.
    for (const [name, pick] of Object.entries(this.picks)) {
      const choice = this.choices.find((c) => c.name === name);
      if (choice?.kind !== "conflict" || (pick.kind === "each" && pick.names.length !== choice.options.length)) delete this.picks[name];
    }
    this.renderProperties();
    this.refresh();
  }

  /** Recounts the unused files and redraws the file option and the button. */
  private refresh(): void {
    try {
      this.unused = this.handlers.unusedCount(this.currentSelection());
      this.unusedError = null;
    } catch (err) {
      console.error("bookmarks: couldn't count unused files", err);
      this.unused = 0;
      this.unusedError = err instanceof Error ? err.message : String(err);
    }
    this.renderFiles();
    this.renderButton();
    void this.loadPreview();
  }

  /** Works out the preview for the current choices and shows it, unless newer choices came in meanwhile. */
  private async loadPreview(): Promise<void> {
    const run = ++this.previewRun;
    try {
      const next = await this.handlers.preview(this.currentSelection());
      if (run !== this.previewRun) return;
      this.lastPreview = next;
    } catch (err) {
      console.error("bookmarks: couldn't preview the merge", err);
      if (run !== this.previewRun) return;
      this.lastPreview = null;
    }
    this.renderChanges();
  }

  /** The Changes panel: a summary line that opens to a git-style diff of the kept note and the notes that go. */
  private renderChanges(): void {
    const el = this.changesEl;
    el.empty();
    const p = this.lastPreview;
    if (!p) return;
    const keptDiff = p.kept ? diffLines(p.kept.before.split("\n"), p.kept.after.split("\n")) : [];
    const { added, removed } = diffStats(keptDiff);
    const summary = [
      p.kept ? `+${added} −${removed} in “${p.kept.name}”` : "only separate marks change",
      p.deleted.length ? `${p.deleted.length} deleted` : "",
      p.redirects ? `${p.redirects} link${p.redirects === 1 ? "" : "s"} redirected` : "",
    ].filter(Boolean);

    const head = el.createDiv();
    Object.assign(head.style, { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap", margin: "12px 0 4px", cursor: "pointer" });
    head.createSpan({ text: `${this.changesOpen ? "▾" : "▸"} Changes` }).style.fontWeight = "600";
    head.createSpan({ text: summary.join(" · "), cls: "setting-item-description" });
    head.onclick = () => {
      this.changesOpen = !this.changesOpen;
      this.renderChanges();
    };
    if (!this.changesOpen) return;

    const box = el.createDiv();
    Object.assign(box.style, {
      maxHeight: "40vh",
      overflowY: "auto",
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "6px",
      fontFamily: "var(--font-monospace)",
      fontSize: "var(--font-ui-smaller)",
      lineHeight: "1.45",
    });
    const fileHead = (text: string) => {
      const h = box.createDiv({ text });
      Object.assign(h.style, { fontWeight: "600", padding: "4px 8px", background: "var(--background-secondary)", borderBottom: "1px solid var(--background-modifier-border)" });
    };
    if (p.kept) {
      fileHead(`${p.kept.name} (kept)`);
      for (const line of collapse(keptDiff, 3)) diffRow(box, line);
    }
    for (const name of p.merged) fileHead(`${name}: merged into “${p.kept?.name ?? ""}”, then trashed`);
    for (const note of p.deleted) {
      fileHead(`${note.name}: deleted`);
      const lines = note.text.split("\n");
      for (const text of lines.slice(0, 40)) diffRow(box, { op: "-", text });
      if (lines.length > 40) diffRow(box, { skip: lines.length - 40 }, "more lines");
    }
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
    select.createEl("option", { text: "Rename / keep each…", value: "each" });
    const pick = this.picks[choice.name] ?? { kind: "value", option: 0 };
    select.value = pick.kind === "value" ? `value:${pick.option}` : pick.kind;
    // Renaming is the "keep each" mode: every value gets a name box, the kept note's value first.
    iconButton(controls, "pencil", "Rename", () => {
      if (select.value === "each") return;
      select.value = "each";
      select.onchange?.(new Event("change"));
    });
    select.onchange = () => {
      if (select.value === "list") this.picks[choice.name] = { kind: "list" };
      // The kept note's value keeps the name; the others get a name to edit (empty drops one).
      else if (select.value === "each") this.picks[choice.name] = { kind: "each", names: choice.options.map((_, i) => (i === 0 ? choice.name : `${choice.name}_${i + 1}`)) };
      else this.picks[choice.name] = { kind: "value", option: Number(select.value.slice("value:".length)) };
      this.renderProperties();
      this.refresh();
    };
    if (pick.kind !== "each") {
      // Image values get thumbnails; tapping one picks it.
      const images = choice.options.map((option) => this.handlers.imageSrc(option.value, option.from));
      if (!images.some(Boolean)) return;
      const strip = el.createDiv();
      Object.assign(strip.style, { display: "flex", flexWrap: "wrap", gap: "8px", margin: "0 0 8px" });
      choice.options.forEach((option, i) => {
        const src = images[i];
        if (!src) return;
        const picked = pick.kind === "list" || (pick.kind === "value" && pick.option === i);
        const item = strip.createDiv({ attr: { "aria-label": `Use the value from ${from(option.from)}` } });
        Object.assign(item.style, { display: "flex", flexDirection: "column", alignItems: "center", gap: "2px", cursor: "pointer", maxWidth: "96px" });
        thumbnail(item, src, picked);
        clipped(item, from(option.from), true).style.maxWidth = "96px";
        item.onclick = () => {
          select.value = `value:${i}`;
          select.onchange?.(new Event("change"));
        };
      });
      return;
    }
    const list = el.createDiv();
    Object.assign(list.style, { paddingLeft: "12px", borderLeft: "2px solid var(--background-modifier-border)", marginBottom: "6px" });
    choice.options.forEach((option, i) => {
      const row = rowLine(list);
      const input = row.main.createEl("input", { type: "text", value: pick.names[i] ?? "", attr: { placeholder: "Don't keep" } });
      Object.assign(input.style, { width: "12em", maxWidth: "100%" });
      const set = (name: string) => {
        pick.names[i] = name;
        this.refresh();
      };
      new PropertySuggest(this.app, input, this.handlers.propertyNames, set);
      input.oninput = () => set(input.value);
      const src = this.handlers.imageSrc(option.value, option.from);
      if (src) thumbnail(row.controls, src, false, 40);
      const value = clipped(row.controls, `${preview(option.value, 60)} — ${from(option.from)}`, true);
      value.title = preview(option.value, 2000);
    });
  }

  private renderFiles(): void {
    const el = this.filesEl;
    el.empty();
    if (this.unusedError) {
      const note = el.createEl("p", { cls: "setting-item-description", text: `Couldn't check for files only removed notes use (${this.unusedError}); they'll be left in place.` });
      note.style.margin = "12px 0 0";
      return;
    }
    const count = this.unused;
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
    // Labelled before anything that could fail, so there's always a button to press.
    this.primary.setText("Merge");
    const kept = this.having("keep")[0];
    const merge = this.having("merge").length;
    const del = this.having("delete").length;
    const separate = this.having("separate").map((n) => n.path);
    const marksChanged = separate.length !== this.group.separate.length || separate.some((p) => !this.group.separate.includes(p));
    const files = this.removeFiles ? this.unused : 0;
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

/** One line of a diff, wrapping rather than scrolling sideways, or a count of folded lines. */
function diffRow(parent: HTMLElement, line: DiffLine | { skip: number }, folded = "unchanged lines"): void {
  const row = parent.createDiv();
  Object.assign(row.style, { whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "0 8px" });
  if ("skip" in line) {
    row.setText(`⋯ ${line.skip} ${folded}`);
    Object.assign(row.style, { color: "var(--text-faint)", fontStyle: "italic", padding: "2px 8px" });
    return;
  }
  row.setText(`${line.op} ${line.text}`);
  if (line.op === "+") Object.assign(row.style, { background: "rgba(var(--color-green-rgb), 0.15)", color: "var(--text-normal)" });
  else if (line.op === "-") Object.assign(row.style, { background: "rgba(var(--color-red-rgb), 0.15)", color: "var(--text-normal)" });
  else row.style.color = "var(--text-muted)";
}

/** A small image preview, outlined when picked; hidden if the image doesn't load. */
function thumbnail(parent: HTMLElement, src: string, picked: boolean, size = 64): HTMLImageElement {
  const img = parent.createEl("img", { attr: { src, alt: "", loading: "lazy" } });
  Object.assign(img.style, {
    height: `${size}px`,
    maxWidth: `${size * 1.5}px`,
    objectFit: "cover",
    borderRadius: "4px",
    flex: "none",
    outline: picked ? "2px solid var(--interactive-accent)" : "1px solid var(--background-modifier-border)",
    outlineOffset: "1px",
  });
  img.onerror = () => {
    img.style.display = "none";
  };
  return img;
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
