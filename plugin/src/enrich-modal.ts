import { App, Modal, Setting, setIcon } from "obsidian";
import { CAPTURE_FILES, fileExt, fileMarker, type CaptureFile } from "./api";
import {
  fileLabel,
  filesIn,
  fileVariable,
  noteHeadings,
  placementOrder,
  samePlacement,
  type ContentItem,
  type ContentRow,
  type EnrichChoices,
  type EnrichSelection,
  type Placement,
  type PropertyChoice,
  rowFiles,
  type SourceEntry,
  TEMPLATE_CONTENT,
  variableProperty,
} from "./enrich";
import { SourcePicker } from "./source-picker";

function preview(value: unknown, max = 160): string {
  if (value === undefined || value === null || value === "") return "(none)";
  const text = Array.isArray(value) ? value.map(String).join(", ") : typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/bookmarks-[a-z_0-9]+-5f2c9e/g, "…").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

type VariableItem = Extract<ContentItem, { kind: "variable" }>;
type FileItem = Extract<ContentItem, { kind: "file" }>;

/** A section heading with its add button on the same line. */
function sectionHead(parent: HTMLElement, title: string, add: string, onAdd: (evt: MouseEvent) => void): void {
  const head = parent.createDiv();
  Object.assign(head.style, { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0 4px" });
  head.createSpan({ text: title }).style.fontWeight = "600";
  const button = head.createEl("button", { text: add, cls: "mod-muted" });
  Object.assign(button.style, { fontSize: "var(--font-ui-smaller)", padding: "2px 8px", height: "auto" });
  button.onclick = onAdd;
}

/** A small icon button. */
function iconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
  const button = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
  setIcon(button, icon);
  button.style.flex = "none";
  button.onclick = onClick;
  return button;
}

/** A select sized for a row rather than a settings line. */
function smallSelect(parent: HTMLElement): HTMLSelectElement {
  const select = parent.createEl("select", { cls: "dropdown" });
  Object.assign(select.style, { fontSize: "var(--font-ui-smaller)", height: "auto", padding: "2px 24px 2px 8px", maxWidth: "11em" });
  return select;
}

/** One line: what it is on the left (shrinking first), controls on the right. */
function rowLine(parent: HTMLElement): { line: HTMLElement; main: HTMLElement } {
  const line = parent.createDiv();
  Object.assign(line.style, { display: "flex", alignItems: "center", gap: "6px", padding: "4px 0" });
  const main = line.createDiv();
  Object.assign(main.style, { flex: "1 1 auto", minWidth: "0", display: "flex", alignItems: "center", gap: "8px" });
  return { line, main };
}

/** Text that cuts off with an ellipsis instead of wrapping. */
function clipped(parent: HTMLElement, text: string, muted = false): HTMLElement {
  const span = parent.createSpan({ text, cls: muted ? "setting-item-description" : undefined });
  Object.assign(span.style, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0", padding: "0" });
  return span;
}


function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

const CUSTOM = "\u0000custom";

function startingPicks(o: EnrichModalOptions): EnrichSelection {
  return { properties: { ...o.defaults.properties }, content: o.defaults.content.map((row) => ({ ...row })), offline: o.defaults.offline };
}
const POSITION_LABELS: Record<Placement["position"], string> = { prepend: "Prepend", append: "Append", replace: "Replace" };

export interface EnrichFiles {
  /** Files made so far. */
  available(): CaptureFile[];
  /** Files being captured because the user added them. */
  pending(): CaptureFile[];
  /** Files that can be captured when added. */
  onDemand: readonly CaptureFile[];
  /** Every capture has finished. */
  ready(): boolean;
  data(kind: CaptureFile): Promise<ArrayBuffer | null>;
  imageType(): string;
  request(kind: CaptureFile): void;
  drop(kind: CaptureFile): void;
}

export interface EnrichModalOptions {
  noteName: string;
  /** Templates the update can start from; picking one captures the page again with it, and the modal shows that capture via switchTo. */
  templates: string[];
  template: string;
  choices: EnrichChoices;
  /** The selection the template sets up. */
  defaults: EnrichSelection;
  /** The note's body (after its frontmatter), for its headings. */
  body: string;
  /** The note's frontmatter now, for property targets and current values. */
  frontmatter: Record<string, unknown>;
  /** Properties used anywhere in the vault, which variables can go into. */
  vaultProperties: string[];
  /** Variables + Content offers, with their values (capture file markers still in them). */
  variables: { name: string; value: string }[];
  /** The captures behind the update, which keep making files while the modal is open. */
  files: EnrichFiles;
  /** Files that can replace the note's TikTok player; empty when it has none. */
  offline: CaptureFile[];
  onTemplate: (name: string) => void;
  onSubmit: (selection: EnrichSelection) => void;
  onDone: () => void;
}

/**
 * Lists what a fresh capture adds to an existing note, starting from what the
 * template sets up: properties (each into a property, added, replaced or merged)
 * and content rows (screenshots, variables and typed text), each put before, after
 * or in place of the note body or one of its headings. Content rows are grouped by
 * where they land, in note order; dragging a row into another group moves it there.
 */
export class EnrichModal extends Modal {
  private readonly urls = new Map<CaptureFile, string>();
  private submitted = false;
  // Not "selection": Obsidian's Modal stores its own selection there when it opens.
  private picks: EnrichSelection;
  private readonly noteHeads;
  private templateSelect!: HTMLSelectElement;
  private propsEl!: HTMLElement;
  private contentEl2!: HTMLElement;
  private dragging: ContentRow | null = null;
  private statusEl!: HTMLElement;
  private applyButton!: HTMLButtonElement;
  private staleContent = false;
  /** Template whose capture is on its way, while switching. */
  private pendingTemplate: string | null = null;

  constructor(
    app: App,
    private o: EnrichModalOptions,
  ) {
    super(app);
    this.picks = startingPicks(o);
    this.noteHeads = noteHeadings(o.body);
  }

  override onOpen(): void {
    this.setTitle("Update from source");
    this.build();
  }

  /** Shows a capture made with another template, starting over from what it sets up. */
  switchTo(o: EnrichModalOptions): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.o = o;
    this.pendingTemplate = null;
    this.picks = startingPicks(o);
    this.contentEl.empty();
    this.build();
  }

  /** Waits on another template's capture, keeping the current one on screen until it's ready. */
  switching(name: string): void {
    this.pendingTemplate = name;
    this.templateSelect.disabled = true;
    this.applyButton.disabled = true;
    this.renderStatus();
  }

  /** The other template's capture failed: back to the current one. */
  switchFailed(): void {
    this.pendingTemplate = null;
    this.templateSelect.value = this.o.template;
    this.templateSelect.disabled = false;
    this.applyButton.disabled = false;
    this.renderStatus();
  }

  private build(): void {
    const { contentEl, o } = this;

    new Setting(contentEl).setName("Template").addDropdown((dropdown) => {
      for (const name of o.templates) dropdown.addOption(name, name);
      dropdown.addOption(CUSTOM, "Custom");
      dropdown.setValue(o.template).onChange((value) => {
        if (value === CUSTOM) return;
        this.switching(value);
        o.onTemplate(value);
      });
      this.templateSelect = dropdown.selectEl;
    });

    this.statusEl = contentEl.createEl("p", { cls: "setting-item-description" });

    sectionHead(contentEl, "Properties", "+ Property", () => this.propertyMenu());
    this.propsEl = contentEl.createDiv();
    if (o.choices.unchanged.length > 0) {
      const details = contentEl.createEl("details", { cls: "setting-item-description" });
      details.createEl("summary", { text: `${o.choices.unchanged.length} already up to date` });
      details.createDiv({ text: o.choices.unchanged.join(", ") });
    }

    sectionHead(contentEl, "Content", "+ Content", () => this.contentMenu());
    this.contentEl2 = contentEl.createDiv();

    if (o.offline.length > 0) {
      const video = o.offline.includes("tiktok_video");
      new Setting(contentEl)
        .setName("Save TikTok offline")
        .setDesc(`Replace the TikTok player in the note with the ${video ? "video" : `${o.offline.length} photos`}, saved in the vault.`)
        .addToggle((toggle) =>
          toggle.setValue(this.picks.offline).onChange((on) => {
            this.picks.offline = on;
            this.custom();
          }),
        );
    }

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => {
        this.applyButton = button.buttonEl;
        button
          .setButtonText("Apply")
          .setCta()
          .onClick(() => {
            this.submitted = true;
            this.close();
            this.o.onSubmit(this.picks);
          });
      });

    this.renderProperties();
    this.renderContent();
    this.renderStatus();
  }

  /** Shows files the captures made since the modal opened. */
  refresh(): void {
    this.renderStatus();
    // Don't pull a text box out from under the user's typing; redraw when they leave it.
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && this.contentEl2.contains(active)) {
      if (!this.staleContent) active.addEventListener("blur", () => this.renderContent(), { once: true });
      this.staleContent = true;
      return;
    }
    this.renderContent();
  }

  private renderStatus(): void {
    if (this.pendingTemplate !== null) {
      this.statusEl.setText(`Fetching the page with ${this.pendingTemplate}…`);
      this.statusEl.toggle(true);
      return;
    }
    const ready = this.o.files.ready();
    this.statusEl.setText(ready ? "" : this.o.files.pending().length ? "Capturing the screenshots you added…" : "Still capturing screenshots…");
    this.statusEl.toggle(!ready);
    this.applyButton?.setText(ready ? "Apply" : "Apply when ready");
  }

  override onClose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.contentEl.empty();
    if (!this.submitted) this.o.onDone();
  }

  /** Any change makes the selection the user's own. */
  private custom(): void {
    this.templateSelect.value = CUSTOM;
  }

  // ---- properties ----

  private renderProperties(): void {
    const el = this.propsEl;
    el.empty();
    const picked = this.o.choices.properties.filter((p) => this.picks.properties[p.name]);
    if (!picked.length) el.createEl("p", { cls: "setting-item-description", text: "No properties picked." });
    const inNote = Object.keys(this.o.frontmatter);
    const inVault = this.o.vaultProperties.filter((name) => !inNote.includes(name));
    for (const property of picked) {
      const pick = this.picks.properties[property.name]!;
      const now = this.o.frontmatter[pick.target];
      const { line, main } = rowLine(el);
      main.style.flexDirection = "column";
      main.style.alignItems = "stretch";
      main.style.gap = "0";
      clipped(main, property.name).style.fontWeight = "600";
      const value = preview(property.value, 120);
      clipped(main, value, true).title = isEmpty(now) ? value : `Now: ${preview(now, 120)}`;

      const target = smallSelect(line);
      if (!pick.target) target.createEl("option", { text: "Choose…", value: "" });
      // A template property can always go into its own name.
      if (property.target === undefined && !inNote.includes(property.name) && !inVault.includes(property.name)) target.createEl("option", { text: property.name, value: property.name });
      const group = (label: string, names: string[]) => {
        if (!names.length) return;
        const og = target.createEl("optgroup", { attr: { label } });
        for (const name of names) og.createEl("option", { text: name, value: name });
      };
      group("In this note", inNote);
      group("In the vault", inVault);
      target.value = pick.target;
      target.onchange = () => {
        pick.target = target.value;
        if (pick.mode === "merge" && !this.canMerge(property, pick.target)) pick.mode = "replace";
        this.custom();
        this.renderProperties();
      };

      const mode = smallSelect(line);
      mode.createEl("option", { text: isEmpty(now) ? "Add" : "Replace", value: "replace" });
      if (this.canMerge(property, pick.target)) mode.createEl("option", { text: "Merge", value: "merge" });
      mode.value = pick.mode;
      mode.onchange = () => {
        pick.mode = mode.value as typeof pick.mode;
        this.custom();
      };

      iconButton(line, "x", "Remove", () => {
        delete this.picks.properties[property.name];
        filesIn(property.value).forEach((kind) => this.dropIfUnused(kind));
        this.custom();
        this.renderProperties();
      });
    }
  }

  private canMerge(property: PropertyChoice, target: string): boolean {
    const now = this.o.frontmatter[target];
    return !isEmpty(now) && (Array.isArray(now) || Array.isArray(property.value));
  }

  private propertyMenu(): void {
    const pick = (property: PropertyChoice) => {
      if (!this.o.choices.properties.some((p) => p.name === property.name)) this.o.choices.properties.push(property);
      const target = property.target ?? property.name;
      this.picks.properties[property.name] = { mode: this.canMerge(property, target) ? "merge" : "replace", target };
      this.custom();
      this.renderProperties();
    };
    const fromTemplate: SourceEntry[] = this.o.choices.properties
      .filter((p) => p.target === undefined && !this.picks.properties[p.name])
      .map((property) => ({ section: "Template", name: property.name, detail: preview(property.value, 100), searchText: JSON.stringify(property.value ?? ""), choose: () => pick(property) }));
    // The template's whole body makes no sense as a property.
    const sources = this.sources((name) => name === TEMPLATE_CONTENT || !!this.picks.properties[name], (source) => {
      if (source.kind === "file") this.requestIfNeeded(source.file);
      pick(variableProperty(source, this.o.frontmatter, this.o.vaultProperties));
    });
    new SourcePicker(this.app, [...fromTemplate, ...sources], "Search properties and variables…").open();
  }

  /**
   * Every variable and capture file not yet `taken` (by "{{name}}"), in TikTok,
   * Screenshots and Variables sections, each with its name and value.
   */
  private sources(taken: (name: string) => boolean, choose: (source: VariableItem | FileItem) => void): SourceEntry[] {
    const made = this.o.files.available();
    const capturing = this.o.files.pending();
    const files = [...made, ...this.o.files.onDemand.filter((kind) => !made.includes(kind))].filter((kind) => !taken(fileVariable(kind)));
    const fileEntry = (section: string) => (kind: CaptureFile): SourceEntry => {
      const later = !made.includes(kind) && !capturing.includes(kind);
      return { section, name: fileVariable(kind), detail: later ? `${fileLabel(kind)} (capture)` : fileLabel(kind), choose: () => choose({ kind: "file", file: kind }) };
    };
    // Variables that only hold a capture file are offered as that file.
    const vars = this.o.variables.filter((v) => !taken(v.name) && !CAPTURE_FILES.some((kind) => v.name === fileVariable(kind)));
    const varEntry = (section: string) => (v: { name: string; value: string }): SourceEntry => ({
      section,
      name: v.name,
      detail: preview(v.value, 100),
      searchText: v.value,
      choose: () => choose({ kind: "variable", name: v.name, value: v.value }),
    });
    const isTikTok = (name: string) => name.startsWith("{{tiktok_");
    return [
      ...vars.filter((v) => isTikTok(v.name)).map(varEntry("TikTok")),
      ...files.filter((kind) => kind.startsWith("tiktok_")).map(fileEntry("TikTok")),
      ...files.filter((kind) => !kind.startsWith("tiktok_")).map(fileEntry("Screenshots")),
      ...vars.filter((v) => !isTikTok(v.name)).map(varEntry("Variables")),
    ];
  }

  /** Starts capturing a file the main capture didn't make. */
  private requestIfNeeded(kind: CaptureFile): void {
    if (!this.o.files.available().includes(kind) && !this.o.files.pending().includes(kind)) this.o.files.request(kind);
  }

  /** A file is still wanted by some property or content row. */
  private fileWanted(kind: CaptureFile): boolean {
    const marker = fileMarker(kind);
    return (
      this.picks.content.some((row) => (row.item.kind === "file" ? row.item.file === kind : row.item.kind === "variable" && row.item.value.includes(marker))) ||
      this.o.choices.properties.some((p) => this.picks.properties[p.name] && JSON.stringify(p.value ?? "").includes(marker))
    );
  }

  private dropIfUnused(kind: CaptureFile): void {
    if (this.o.files.pending().includes(kind) && !this.fileWanted(kind)) this.o.files.drop(kind);
  }

  // ---- content ----

  private targetLabel(heading: number | null): string {
    if (heading === null) return "Note body";
    const h = this.noteHeads[heading]!;
    return `${"#".repeat(h.level)} ${h.text}`;
  }

  private placementLabel(p: Placement): string {
    return `${POSITION_LABELS[p.position]} ${p.position === "replace" ? "" : "to "}${this.targetLabel(p.heading)}`;
  }

  /** Every placement a row can be dragged to (replacing is picked from the dropdown). */
  private allPlacements(): Placement[] {
    const targets: (number | null)[] = [null, ...this.noteHeads.map((_, i) => i)];
    return targets.flatMap((heading) => [
      { heading, position: "prepend" as const },
      { heading, position: "append" as const },
    ]);
  }

  private renderContent(): void {
    this.staleContent = false;
    const el = this.contentEl2;
    el.empty();
    const rows = this.picks.content;
    if (!rows.length && !this.dragging) el.createEl("p", { cls: "setting-item-description", text: "Nothing picked for the note body." });
    const used = rows.map((row): Placement => ({ heading: row.heading, position: row.position }));
    const shown = this.dragging ? [...used, ...this.allPlacements()] : used;
    const groups: Placement[] = [];
    for (const p of placementOrder(shown, this.o.body)) if (!groups.some((g) => samePlacement(g, p))) groups.push(p);
    for (const group of groups) {
      const items = rows.filter((row) => samePlacement(row, group));
      const box = el.createDiv();
      box.dataset.heading = String(group.heading);
      box.dataset.position = group.position;
      // Each row names its own placement; the groups only show as drop targets while dragging.
      if (this.dragging) {
        Object.assign(box.style, { borderRadius: "6px", padding: "2px 4px", marginBottom: "6px", border: "1px dashed var(--background-modifier-border)" });
        box.createDiv({ text: this.placementLabel(group), cls: "setting-item-description" }).style.fontWeight = "600";
      }
      for (const row of items) this.renderRow(box, row);
    }
  }

  private renderRow(parent: HTMLElement, row: ContentRow): void {
    const { line, main } = rowLine(parent);
    line.style.borderBottom = "1px solid var(--background-modifier-border)";
    line.style.opacity = this.dragging === row ? "0.4" : "1";
    line.dataset.row = String(this.picks.content.indexOf(row));

    const handle = line.createSpan({ text: "⋮⋮", attr: { "aria-label": "Drag to reorder" } });
    Object.assign(handle.style, { cursor: "grab", touchAction: "none", color: "var(--text-muted)", userSelect: "none", flex: "none" });
    handle.onpointerdown = (evt) => this.startDrag(evt, row);
    line.prepend(handle);
    this.renderItem(main, row.item);

    const move = () => {
      // Moved rows go last in their new spot.
      this.picks.content = [...this.picks.content.filter((r) => r !== row), row];
      this.custom();
      this.renderContent();
    };
    const target = smallSelect(line);
    target.createEl("option", { text: "Note body", value: "" });
    this.noteHeads.forEach((h, i) => target.createEl("option", { text: `${"#".repeat(h.level)} ${h.text}`, value: String(i) }));
    target.value = row.heading === null ? "" : String(row.heading);
    target.onchange = () => {
      row.heading = target.value === "" ? null : Number(target.value);
      move();
    };
    const position = smallSelect(line);
    for (const [value, text] of Object.entries(POSITION_LABELS)) position.createEl("option", { text, value });
    position.value = row.position;
    position.onchange = () => {
      row.position = position.value as Placement["position"];
      move();
    };

    iconButton(line, "x", "Remove", () => {
      this.picks.content = this.picks.content.filter((r) => r !== row);
      rowFiles(row.item).forEach((kind) => this.dropIfUnused(kind));
      this.custom();
      this.renderContent();
    });
  }

  private renderItem(el: HTMLElement, item: ContentItem): void {
    const text = el.createDiv();
    Object.assign(text.style, { minWidth: "0", flex: "1 1 auto", display: "flex", flexDirection: "column" });
    const name = (value: string) => (clipped(text, value).style.fontWeight = "600");
    if (item.kind === "file") {
      const kind = item.file;
      const made = this.o.files.available().includes(kind);
      if (made && fileExt(kind, null) === null) {
        const img = el.createEl("img", { attr: { alt: fileLabel(kind) } });
        Object.assign(img.style, { width: "40px", height: "28px", objectFit: "cover", objectPosition: "top", borderRadius: "4px", flex: "none", order: "-1" });
        const known = this.urls.get(kind);
        if (known) img.src = known;
        else
          void this.o.files.data(kind).then((data) => {
            if (!data) return img.remove();
            const url = this.urls.get(kind) ?? URL.createObjectURL(new Blob([data], { type: this.o.files.imageType() }));
            this.urls.set(kind, url);
            img.src = url;
          });
      }
      name(fileLabel(kind));
      clipped(text, made ? fileVariable(kind) : this.o.files.pending().includes(kind) ? "Capturing…" : "Not captured", true);
    } else if (item.kind === "variable") {
      name(item.name);
      clipped(text, preview(item.value, 120), true);
    } else {
      const input = text.createEl("textarea", { attr: { rows: "1", placeholder: "A heading or note" } });
      input.value = item.text;
      Object.assign(input.style, { width: "100%", resize: "vertical" });
      input.oninput = () => {
        item.text = input.value;
        this.custom();
      };
    }
  }

  private contentMenu(): void {
    const picked = this.picks.content.map((row) => row.item);
    const add = (item: ContentItem) => {
      this.picks.content.push({ item, heading: null, position: "append" });
      this.custom();
      this.renderContent();
    };
    const taken = (name: string) => picked.some((i) => (i.kind === "file" ? fileVariable(i.file) === name : i.kind === "variable" && i.name === name));
    const sources = this.sources(taken, (source) => {
      if (source.kind === "file") this.requestIfNeeded(source.file);
      add(source);
    });
    const text: SourceEntry = { section: "Text", name: "Text", detail: "A heading or note you type", choose: () => add({ kind: "text", text: "" }) };
    new SourcePicker(this.app, [...sources, text], "Search variables, screenshots or text…").open();
  }


  // ---- drag to move ----

  private startDrag(evt: PointerEvent, row: ContentRow): void {
    evt.preventDefault();
    this.dragging = row;
    this.renderContent();
    const over = (e: PointerEvent): HTMLElement | null => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      return el?.closest<HTMLElement>("[data-position]") ?? null;
    };
    const onMove = (e: PointerEvent) => {
      for (const box of Array.from(this.contentEl2.querySelectorAll<HTMLElement>("[data-position]"))) box.style.background = "";
      const box = over(e);
      if (box) box.style.background = "var(--background-modifier-hover)";
    };
    const onUp = (e: PointerEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      const box = over(e);
      this.dragging = null;
      if (box && this.contentEl2.contains(box)) {
        const rest = this.picks.content.filter((r) => r !== row);
        row.heading = box.dataset.heading === "null" ? null : Number(box.dataset.heading);
        row.position = box.dataset.position as Placement["position"];
        // Before the row under the pointer when on its top half, else after the group's last row.
        const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-row]");
        const beside = target ? this.picks.content[Number(target.dataset.row)] : undefined;
        let at = rest.length;
        if (beside && beside !== row && samePlacement(beside, row)) {
          const rect = target!.getBoundingClientRect();
          at = rest.indexOf(beside) + (e.clientY > rect.top + rect.height / 2 ? 1 : 0);
        }
        rest.splice(at, 0, row);
        this.picks.content = rest;
        this.custom();
      }
      this.renderContent();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }
}
