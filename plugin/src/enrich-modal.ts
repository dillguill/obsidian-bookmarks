import { App, Menu, Modal, Setting } from "obsidian";
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
  TEMPLATE_CONTENT,
  variableProperty,
} from "./enrich";

function preview(value: unknown, max = 160): string {
  if (value === undefined || value === null || value === "") return "(none)";
  const text = Array.isArray(value) ? value.map(String).join(", ") : typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/bookmarks-[a-z_0-9]+-5f2c9e/g, "…").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

type VariableItem = Extract<ContentItem, { kind: "variable" }>;
type FileItem = Extract<ContentItem, { kind: "file" }>;

/** A menu entry showing a variable's name with its value after it. */
function entryTitle(name: string, value: string): DocumentFragment {
  const frag = createFragment();
  frag.createSpan({ text: name });
  Object.assign(frag.createSpan({ text: value }).style, { color: "var(--text-muted)", marginLeft: "0.75em" });
  return frag;
}

const startedMenus = new WeakSet<Menu>();

/** A section heading in a menu, after a separator unless it's the first. */
function section(menu: Menu, title: string): void {
  if (startedMenus.has(menu)) menu.addSeparator();
  startedMenus.add(menu);
  menu.addItem((item) => {
    item.setTitle(title);
    // Labels are newer than the oldest Obsidian the plugin supports.
    if (typeof item.setIsLabel === "function") item.setIsLabel(true);
    else item.setDisabled(true);
  });
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
    this.setTitle(`Update ${this.o.noteName} from source`);
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

    new Setting(contentEl).setName("Properties").setHeading();
    this.propsEl = contentEl.createDiv();
    const addProperty = contentEl.createEl("button", { text: "+ Property" });
    addProperty.onclick = (evt) => this.propertyMenu(evt);
    if (o.choices.unchanged.length > 0) {
      contentEl.createEl("p", { cls: "setting-item-description", text: `Already up to date: ${o.choices.unchanged.join(", ")}` });
    }

    new Setting(contentEl).setName("Content").setHeading();
    this.contentEl2 = contentEl.createDiv();
    const addContent = contentEl.createEl("button", { text: "+ Content" });
    addContent.onclick = (evt) => this.contentMenu(evt);

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
      const setting = new Setting(el).setName(property.name);
      const now = this.o.frontmatter[pick.target];
      if (!isEmpty(now)) setting.descEl.createDiv({ text: `Now: ${preview(now)}` });
      setting.descEl.createDiv({ text: `${isEmpty(now) ? "Value" : "New"}: ${preview(property.value)}` });
      setting.addDropdown((dropdown) => {
        const select = dropdown.selectEl;
        if (!pick.target) select.createEl("option", { text: "Choose a property…", value: "" });
        // A template property can always go into its own name.
        if (property.target === undefined && !inNote.includes(property.name) && !inVault.includes(property.name)) select.createEl("option", { text: property.name, value: property.name });
        const group = (label: string, names: string[]) => {
          if (!names.length) return;
          const el = select.createEl("optgroup", { attr: { label } });
          for (const name of names) el.createEl("option", { text: name, value: name });
        };
        group("In this note", inNote);
        group("In the vault", inVault);
        dropdown.setValue(pick.target).onChange((value) => {
          pick.target = value;
          if (pick.mode === "merge" && !this.canMerge(property, value)) pick.mode = "replace";
          this.custom();
          this.renderProperties();
        });
      });
      setting.addDropdown((dropdown) => {
        dropdown.addOption("replace", isEmpty(now) ? "Add" : "Replace");
        if (this.canMerge(property, pick.target)) dropdown.addOption("merge", "Merge");
        dropdown.setValue(pick.mode).onChange((value) => {
          pick.mode = value as typeof pick.mode;
          this.custom();
        });
      });
      setting.addExtraButton((button) =>
        button
          .setIcon("x")
          .setTooltip("Remove")
          .onClick(() => {
            delete this.picks.properties[property.name];
            filesIn(property.value).forEach((kind) => this.dropIfUnused(kind));
            this.custom();
            this.renderProperties();
          }),
      );
    }
  }

  private canMerge(property: PropertyChoice, target: string): boolean {
    const now = this.o.frontmatter[target];
    return !isEmpty(now) && (Array.isArray(now) || Array.isArray(property.value));
  }

  private propertyMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const fromTemplate = this.o.choices.properties.filter((p) => p.target === undefined && !this.picks.properties[p.name]);
    const pick = (property: PropertyChoice) => {
      if (!this.o.choices.properties.some((p) => p.name === property.name)) this.o.choices.properties.push(property);
      const target = property.target ?? property.name;
      this.picks.properties[property.name] = { mode: this.canMerge(property, target) ? "merge" : "replace", target };
      this.custom();
      this.renderProperties();
    };
    if (fromTemplate.length) {
      section(menu, "Template");
      for (const property of fromTemplate) menu.addItem((item) => item.setTitle(entryTitle(property.name, preview(property.value, 60))).onClick(() => pick(property)));
    }
    // The template's whole body makes no sense as a property.
    this.offerSources(menu, (name) => name === TEMPLATE_CONTENT || !!this.picks.properties[name], (source) => {
      if (source.kind === "file") this.requestIfNeeded(source.file);
      pick(variableProperty(source, this.o.frontmatter, this.o.vaultProperties));
    });
    menu.showAtMouseEvent(evt);
  }

  /**
   * Adds every variable and capture file to a menu in TikTok, Screenshots and
   * Variables sections, each entry showing its name and value. `taken` says
   * which names (as "{{name}}") are already used.
   */
  private offerSources(menu: Menu, taken: (name: string) => boolean, choose: (source: VariableItem | FileItem) => void): void {
    const made = this.o.files.available();
    const capturing = this.o.files.pending();
    const files = [...made, ...this.o.files.onDemand.filter((kind) => !made.includes(kind))].filter((kind) => !taken(fileVariable(kind)));
    const fileEntry = (kind: CaptureFile) => {
      const later = !made.includes(kind) && !capturing.includes(kind);
      menu.addItem((item) => item.setTitle(entryTitle(fileVariable(kind), later ? `${fileLabel(kind)} (capture)` : fileLabel(kind))).onClick(() => choose({ kind: "file", file: kind })));
    };
    // Variables that only hold a capture file are offered as that file.
    const vars = this.o.variables.filter((v) => !taken(v.name) && !CAPTURE_FILES.some((kind) => v.name === fileVariable(kind)));
    const varEntry = (v: { name: string; value: string }) =>
      menu.addItem((item) => item.setTitle(entryTitle(v.name, preview(v.value, 60))).onClick(() => choose({ kind: "variable", name: v.name, value: v.value })));
    const isTikTok = (name: string) => name.startsWith("{{tiktok_");
    const tiktokFiles = files.filter((kind) => kind.startsWith("tiktok_"));
    const tiktokVars = vars.filter((v) => isTikTok(v.name));
    if (tiktokFiles.length || tiktokVars.length) {
      section(menu, "TikTok");
      tiktokVars.forEach(varEntry);
      tiktokFiles.forEach(fileEntry);
    }
    const shots = files.filter((kind) => !kind.startsWith("tiktok_"));
    if (shots.length) {
      section(menu, "Screenshots");
      shots.forEach(fileEntry);
    }
    const rest = vars.filter((v) => !isTikTok(v.name));
    if (rest.length) {
      section(menu, "Variables");
      rest.forEach(varEntry);
    }
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
      box.style.borderRadius = "6px";
      box.style.padding = "2px 4px";
      box.style.marginBottom = "6px";
      if (!items.length) box.style.border = "1px dashed var(--background-modifier-border)";
      box.dataset.heading = String(group.heading);
      box.dataset.position = group.position;
      box.createDiv({ text: this.placementLabel(group), cls: "setting-item-description" }).style.fontWeight = "600";
      for (const row of items) this.renderRow(box, row);
    }
  }

  private renderRow(parent: HTMLElement, row: ContentRow): void {
    const line = parent.createDiv();
    Object.assign(line.style, {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "8px",
      padding: "6px 8px",
      marginBottom: "4px",
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "6px",
      background: "var(--background-secondary)",
      opacity: this.dragging === row ? "0.4" : "1",
    });
    line.dataset.row = String(this.picks.content.indexOf(row));

    const handle = line.createSpan({ text: "⋮⋮", attr: { "aria-label": "Drag to move" } });
    Object.assign(handle.style, { cursor: "grab", touchAction: "none", color: "var(--text-muted)", userSelect: "none" });
    handle.onpointerdown = (evt) => this.startDrag(evt, row);

    const main = line.createDiv();
    Object.assign(main.style, { flex: "1 1 200px", minWidth: "0", display: "flex", alignItems: "center", gap: "8px" });
    this.renderItem(main, row.item);

    const target = line.createEl("select", { cls: "dropdown" });
    target.createEl("option", { text: "Note body", value: "" });
    this.noteHeads.forEach((h, i) => target.createEl("option", { text: `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}`, value: String(i) }));
    target.value = row.heading === null ? "" : String(row.heading);
    const position = line.createEl("select", { cls: "dropdown" });
    for (const [value, text] of Object.entries(POSITION_LABELS)) position.createEl("option", { text, value });
    position.value = row.position;
    const move = () => {
      row.heading = target.value === "" ? null : Number(target.value);
      row.position = position.value as Placement["position"];
      // Moved rows go last in their new group.
      this.picks.content = [...this.picks.content.filter((r) => r !== row), row];
      this.custom();
      this.renderContent();
    };
    target.onchange = move;
    position.onchange = move;

    const remove = line.createEl("button", { text: "×", attr: { "aria-label": "Remove" } });
    remove.onclick = () => {
      this.picks.content = this.picks.content.filter((r) => r !== row);
      rowFiles(row.item).forEach((kind) => this.dropIfUnused(kind));
      this.custom();
      this.renderContent();
    };
  }

  private renderItem(el: HTMLElement, item: ContentItem): void {
    if (item.kind === "file") {
      const kind = item.file;
      if (!this.o.files.available().includes(kind)) {
        el.createSpan({ text: fileLabel(kind) });
        el.createSpan({ text: this.o.files.pending().includes(kind) ? "Capturing…" : "Not captured", cls: "setting-item-description" });
        return;
      }
      if (fileExt(kind, null) === null) {
        const img = el.createEl("img", { attr: { alt: fileLabel(kind) } });
        Object.assign(img.style, { width: "64px", height: "40px", objectFit: "cover", objectPosition: "top", borderRadius: "4px", flex: "none" });
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
      el.createSpan({ text: fileLabel(item.file) });
    } else if (item.kind === "variable") {
      el.createSpan({ text: item.name }).style.fontWeight = "600";
      const value = el.createSpan({ text: preview(item.value, 80), cls: "setting-item-description" });
      Object.assign(value.style, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    } else {
      const input = el.createEl("textarea", { attr: { rows: "2", placeholder: "A heading or note" } });
      input.value = item.text;
      input.style.width = "100%";
      input.oninput = () => {
        item.text = input.value;
        this.custom();
      };
    }
  }

  private contentMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const picked = this.picks.content.map((row) => row.item);
    const add = (item: ContentItem) => {
      this.picks.content.push({ item, heading: null, position: "append" });
      this.custom();
      this.renderContent();
    };
    const taken = (name: string) => picked.some((i) => (i.kind === "file" ? fileVariable(i.file) === name : i.kind === "variable" && i.name === name));
    this.offerSources(menu, taken, (source) => {
      if (source.kind === "file") this.requestIfNeeded(source.file);
      add(source);
    });
    section(menu, "Text");
    menu.addItem((item) => item.setTitle("Text").onClick(() => add({ kind: "text", text: "" })));
    menu.showAtMouseEvent(evt);
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
