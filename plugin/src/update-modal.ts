import { App } from "obsidian";
import { ClipModal } from "./clip-modal";
import { confirm } from "./confirm";
import { collapse, diffLines, diffStats } from "./diff";
import type { FieldType, PropertyField } from "./fields";
import { diffRow } from "./merge-modal";
import { canMerge, replaceAll, rowsChange, updateRows, withMode, type BodyMode, type RowMode, type UpdateRow } from "./update";

/** What a fetch gave: the template's properties, body, name and folder for the page. */
export interface Fetched {
  template: string;
  fields: PropertyField[];
  body: string;
  noteName: string;
  folder: string;
}

/** What the user settled on. */
export interface UpdatePlan {
  rows: UpdateRow[];
  bodyMode: BodyMode;
  /** The fetched body as edited, with screenshots as their {{variable}} tokens. */
  body: string;
  name: string;
  folder: string;
}

export interface UpdateHandlers {
  templates: readonly string[];
  template: string;
  url: string;
  name: string;
  folder: string;
  frontmatter: Record<string, unknown>;
  /** The note's body (after its frontmatter). */
  body: string;
  types: Record<string, FieldType>;
  /** URL and capture id properties, never offered. */
  skip: string[];
  propertyNames: () => string[];
  /** Fetch with "Replace whole note" chosen (the Retry capture link). */
  replaceAll: boolean;
  onFetch: (template: string) => void;
  onTemplate: (template: string) => void;
  onApply: (plan: UpdatePlan) => void;
  onClose: (applied: boolean) => void;
}

const MODE_LABELS: Record<RowMode, string> = { keep: "Keep", replace: "Use the page's", merge: "Merge both", edit: "Edited", remove: "Remove" };
const BODY_LABELS: Record<BodyMode, string> = { keep: "Keep", append: "Add to the end", replace: "Replace" };

/**
 * Update note from source, in the capture modal's layout: the note as it is,
 * and once the page is fetched, each property next to what the page gives,
 * set to keep, take the page's, merge or remove, and the body kept, added to
 * or replaced. The file name and folder rename and move the note.
 */
export class UpdateModal extends ClipModal {
  private rows: UpdateRow[];
  private fetched: Fetched | null = null;
  private bodyMode: BodyMode = "keep";
  private newBody = "";
  private name: string;
  private folder: string;
  private template: string;
  private applied = false;
  private busy = false;
  private showDiff = false;
  private statusEl!: HTMLElement;
  private folderInput!: HTMLInputElement;
  private hintEl!: HTMLElement;

  constructor(
    app: App,
    private readonly h: UpdateHandlers,
  ) {
    super(app);
    this.rows = updateRows(h.frontmatter, null, h.types, h.skip);
    this.name = h.name;
    this.folder = h.folder;
    this.template = h.template;
  }

  override onOpen(): void {
    this.setTitle("Update from source");
    this.shell();
    this.header((name) => void this.pickTemplate(name));
    this.setTemplates(this.h.templates, this.template);
    this.statusEl = this.urlRow(this.h.url, null).status;
    this.status(this.statusEl, "");
    const nameInput = this.nameField((name) => {
      this.name = name;
      this.refreshChanged();
    });
    nameInput.value = this.name;
    this.hintEl = createDiv({ cls: "bookmarks-clip-hint setting-item-description" });
    nameInput.parentElement!.after(this.hintEl);
    this.hintEl.hide();
    this.propertiesSection((head) => {
      const add = head.createEl("button", { text: "Add property", cls: "mod-muted bookmarks-section-add" });
      add.onclick = () => {
        this.propertiesEl.parentElement?.removeClass("is-collapsed");
        const taken = () => new Set(this.rows.map((r) => r.name));
        this.newPropertyRow(
          () => this.h.propertyNames().filter((name) => !taken().has(name)),
          (name) => {
            if (!taken().has(name)) this.rows.push({ name, type: this.h.types[name] ?? "text", current: undefined, next: null, mode: "edit", text: "" });
            this.drawRows();
            this.propertiesEl.querySelector<HTMLInputElement>(".bookmarks-property:last-child input")?.focus();
          },
        );
      };
    });
    // The body area is drawn by drawBody: the note's body, or the fetched one to add or replace it with.
    this.bodyField(() => {});
    this.footer(
      (left) =>
        (this.folderInput = this.folderField(left, this.folder, (folder) => {
          this.folder = folder;
          this.refreshChanged();
        })),
      (id) => this.act(id),
    );
    this.drawRows();
    this.drawBody();
    this.updateActions();
    if (this.h.replaceAll) this.fetch();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.h.onClose(this.applied);
  }

  // ---- what the controller tells the modal ----

  /** The page was fetched: each property gets the page's value, preset as the template sets up. */
  filled(fetched: Fetched): void {
    this.fetched = fetched;
    this.template = fetched.template;
    this.templateSelect.value = fetched.template;
    const typed = this.rows.filter((r) => r.mode === "edit" || r.mode === "remove");
    this.rows = updateRows(this.h.frontmatter, fetched.fields, this.h.types, this.h.skip).map((row) => {
      const mine = typed.find((t) => t.name === row.name);
      return mine ? withMode(row, mine.mode, mine.text) : row;
    });
    for (const mine of typed) if (!this.rows.some((r) => r.name === mine.name)) this.rows.push(mine);
    this.newBody = fetched.body;
    if (this.h.replaceAll) {
      this.rows = replaceAll(this.rows);
      this.bodyMode = "replace";
    }
    this.busy = false;
    this.status(this.statusEl, "");
    this.showHint();
    this.drawRows();
    this.drawBody();
    this.updateActions();
  }

  failed(message: string): void {
    this.busy = false;
    this.statusEl.empty();
    this.status(this.statusEl, `Couldn't fetch the page: ${message}`, "error");
    const retry = this.statusEl.createEl("a", { text: "Retry", href: "#" });
    retry.onclick = (evt) => {
      evt.preventDefault();
      this.fetch();
    };
    this.templateSelect.value = this.fetched?.template ?? this.template;
    this.updateActions();
  }

  /** The page was let go on the server: fetches it again with this template. */
  refetch(template: string): void {
    this.template = template;
    this.fetch();
  }

  // ---- inside ----

  private fetch(): void {
    this.busy = true;
    this.status(this.statusEl, "Fetching the page…", "busy");
    this.updateActions();
    this.h.onFetch(this.template);
  }

  private async pickTemplate(name: string): Promise<void> {
    if (name === this.template) return;
    const edited = this.rows.some((r) => r.mode === "edit");
    if (edited && !(await confirm(this.app, "Switch template?", "Properties you typed are kept; the rest start over from the other template.", "Switch"))) {
      this.templateSelect.value = this.template;
      return;
    }
    this.template = name;
    if (!this.fetched) return;
    this.busy = true;
    this.status(this.statusEl, `Rendering with ${name}…`, "busy");
    this.updateActions();
    this.h.onTemplate(name);
  }

  /** "Use the template's name and folder", when they differ from the note's. */
  private showHint(): void {
    const f = this.fetched;
    this.hintEl.empty();
    const differs = f && ((f.noteName && f.noteName !== this.name) || (f.folder && f.folder !== this.folder));
    this.hintEl.toggle(Boolean(differs));
    if (!f || !differs) return;
    this.hintEl.appendText(`${this.template} would name it “${f.noteName}” in ${f.folder || "the vault folder"}. `);
    const use = this.hintEl.createEl("a", { text: "Use that", href: "#" });
    use.onclick = (evt) => {
      evt.preventDefault();
      this.name = f.noteName || this.name;
      this.folder = f.folder;
      this.setName(this.name);
      this.folderInput.value = this.folder;
      this.hintEl.hide();
      this.refreshChanged();
    };
  }

  private drawRows(): void {
    const fields: (PropertyField & { row: UpdateRow })[] = this.rows.map((row) => ({ name: row.name, type: row.type, text: row.text, expression: "", edited: row.mode === "edit", row }));
    this.renderFields(fields, {
      empty: "This note has no properties.",
      onEdit: (field) => {
        const i = this.rows.findIndex((r) => r.name === field.name);
        if (i >= 0) this.rows[i] = withMode(this.rows[i]!, "edit", field.text);
        this.refreshRow(field.name);
      },
      onRemove: (field) => {
        const i = this.rows.findIndex((r) => r.name === field.name);
        const row = this.rows[i]!;
        // A property the note never had just goes from the list.
        if (row.current === undefined && row.next === null) this.rows.splice(i, 1);
        else this.rows[i] = withMode(row, row.mode === "remove" ? (row.next !== null ? "replace" : "keep") : "remove");
        this.drawRows();
      },
      extras: (el, field) => this.rowExtras(el, (field as PropertyField & { row: UpdateRow }).row),
    });
    this.refreshChanged();
  }

  /** Under a row: what the note has and what the page gives, and the choice between them. */
  private rowExtras(el: HTMLElement, row: UpdateRow): void {
    el.toggleClass("is-removed", row.mode === "remove");
    el.toggleClass("is-changed", row.mode !== "keep");
    if (row.mode === "remove") {
      el.querySelector("input")?.setAttr("disabled", "true");
      el.createDiv({ cls: "bookmarks-property-extra", text: "Will be removed. Press × again to keep it." });
      return;
    }
    if (row.next === null && row.mode !== "edit") return;
    const extra = el.createDiv({ cls: "bookmarks-property-extra" });
    const now = row.current === undefined ? "not in the note" : `now ${short(row.current)}`;
    extra.createSpan({ text: row.next === null ? now : `${now} · page has ${short(row.next) || "nothing"}`, cls: "bookmarks-property-compare" });
    if (row.next === null) return;
    const select = extra.createEl("select", { cls: "dropdown bookmarks-small-select" });
    const modes: RowMode[] = ["keep", "replace", ...(canMerge(row) ? (["merge"] as const) : []), ...(row.mode === "edit" ? (["edit"] as const) : [])];
    for (const mode of modes) select.createEl("option", { text: MODE_LABELS[mode], value: mode });
    select.value = row.mode;
    select.onchange = () => {
      const i = this.rows.indexOf(row);
      this.rows[i] = withMode(row, select.value as RowMode);
      this.drawRows();
    };
  }

  /** Redraws one row's extras after its value was typed, without redrawing the input being typed in. */
  private refreshRow(name: string): void {
    const row = this.rows.find((r) => r.name === name)!;
    const el = Array.from(this.propertiesEl.querySelectorAll<HTMLElement>(".bookmarks-property")).find((e) => e.querySelector(".bookmarks-property-name")?.textContent === name);
    if (el) {
      for (const extra of Array.from(el.querySelectorAll(".bookmarks-property-extra"))) extra.remove();
      this.rowExtras(el, row);
    }
    this.refreshChanged();
  }

  private drawBody(): void {
    const el = this.bodyArea;
    el.empty();
    const head = el.createDiv({ cls: "bookmarks-clip-body-head" });
    head.createSpan({ text: "Body", cls: "bookmarks-clip-section-title" });
    if (this.fetched) {
      const modes = head.createDiv({ cls: "bookmarks-segmented", attr: { role: "radiogroup", "aria-label": "Body" } });
      for (const mode of ["keep", "append", "replace"] as BodyMode[]) {
        const button = modes.createEl("button", { text: BODY_LABELS[mode], cls: mode === this.bodyMode ? "is-active" : "", attr: { role: "radio", "aria-checked": String(mode === this.bodyMode) } });
        button.onclick = () => {
          this.bodyMode = mode;
          this.drawBody();
          this.refreshChanged();
        };
      }
    }
    const editing = this.fetched && this.bodyMode !== "keep";
    const area = el.createEl("textarea", { cls: "bookmarks-clip-body-input", attr: { "aria-label": editing ? "Fetched body" : "Note body" } });
    area.value = editing ? this.newBody : this.h.body;
    area.readOnly = !editing;
    area.toggleClass("is-readonly", !editing);
    area.oninput = () => {
      this.newBody = area.value;
      if (this.showDiff) this.drawDiff(el);
    };
    if (!editing) return;
    const toggle = el.createEl("a", { text: this.showDiff ? "Hide changes" : "Preview changes", href: "#", cls: "bookmarks-clip-diff-toggle" });
    toggle.onclick = (evt) => {
      evt.preventDefault();
      this.showDiff = !this.showDiff;
      this.drawBody();
    };
    if (this.showDiff) this.drawDiff(el);
  }

  /** The body before and after, git style. */
  private drawDiff(parent: HTMLElement): void {
    parent.querySelector(".bookmarks-diff")?.remove();
    const after = this.bodyMode === "replace" ? this.newBody.trim() : `${this.h.body.trimEnd()}\n\n${this.newBody.trim()}`;
    const lines = diffLines(this.h.body.trimEnd().split("\n"), after.split("\n"));
    const box = parent.createDiv({ cls: "bookmarks-diff" });
    const { added, removed } = diffStats(lines);
    box.createDiv({ cls: "bookmarks-diff-file", text: `+${added} −${removed}` });
    for (const line of collapse(lines, 3)) diffRow(box, line);
  }

  private refreshChanged(): void {
    const moved = this.name.trim() !== this.h.name || this.folder.trim().replace(/^\/+|\/+$/g, "") !== this.h.folder;
    this.setChanged(rowsChange(this.rows) || this.bodyMode !== "keep" || moved);
  }

  private updateActions(): void {
    if (!this.fetched) this.setActions([{ id: "fetch", label: "Fetch from source", icon: "download-cloud" }], "fetch");
    else
      this.setActions(
        [
          { id: "apply", label: "Apply", icon: "check" },
          { id: "replace-all", label: "Replace whole note", icon: "replace-all", runs: true },
        ],
        "apply",
      );
    this.setBusy(this.busy);
  }

  private act(id: string): void {
    if (this.busy) return;
    if (id === "fetch") return this.fetch();
    if (id === "replace-all") {
      this.rows = replaceAll(this.rows);
      this.bodyMode = "replace";
      this.showDiff = true;
      this.drawRows();
      this.drawBody();
      return;
    }
    this.applied = true;
    this.close();
    this.h.onApply({ rows: this.rows, bodyMode: this.bodyMode, body: this.newBody, name: this.name.trim() || this.h.name, folder: this.folder.trim().replace(/^\/+|\/+$/g, "") });
  }
}

/** A value on one short line, for the "now · page has" line. */
function short(value: unknown): string {
  const text = Array.isArray(value) ? value.map(String).join(", ") : value === null || value === undefined ? "" : String(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat ? `“${flat}”` : "nothing";
}
