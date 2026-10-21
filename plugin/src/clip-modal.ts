import { Menu, Modal, setIcon } from "obsidian";
import { TYPE_ICONS, type PropertyField } from "./fields";
import { FolderSuggest } from "./folder-suggest";
import { iconButton, statusLine } from "./modal-ui";
import { PropertySuggest } from "./property-suggest";

const COLLAPSED_KEY = "bookmarks-properties-collapsed";

/** One of the footer button's actions. */
export interface ClipAction {
  id: string;
  label: string;
  icon: string;
}

/** A row's value input, by type: dates get date pickers only when the value fits one, so nothing typed is lost. */
function valueInput(parent: HTMLElement, field: PropertyField): HTMLInputElement {
  if (field.type === "checkbox") {
    const box = parent.createEl("input", { type: "checkbox", cls: "bookmarks-property-checkbox" });
    box.checked = /^(true|yes|1|on)$/i.test(field.text.trim());
    return box;
  }
  const text = field.text.trim();
  const type =
    field.type === "number" && (!text || Number.isFinite(Number(text)))
      ? "number"
      : field.type === "date" && (!text || /^\d{4}-\d{2}-\d{2}$/.test(text))
        ? "date"
        : field.type === "datetime" && (!text || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text))
          ? "datetime-local"
          : "text";
  const input = parent.createEl("input", { type, cls: "bookmarks-property-input" });
  if (type === "datetime-local") input.step = "1";
  input.value = field.text;
  if (field.type === "multitext" || field.type === "tags" || field.type === "aliases") input.placeholder = "Comma-separated";
  return input;
}

/**
 * The shell both bookmark modals share, after Obsidian Web Clipper's popup:
 * template dropdown, (URL), note name, collapsible properties, note body, and
 * a footer with the folder and a split action button.
 */
export abstract class ClipModal extends Modal {
  protected templateSelect!: HTMLSelectElement;
  private changedDot!: HTMLElement;
  protected nameInput!: HTMLInputElement;
  protected propertiesEl!: HTMLElement;
  /** Header and URL: always in view. */
  private topEl!: HTMLElement;
  /** Name, properties and body: scrolls, so the footer never leaves the screen. */
  private scrollEl!: HTMLElement;
  protected bodyArea!: HTMLElement;
  private actionButton!: HTMLButtonElement;
  private menuButton!: HTMLButtonElement;
  private actions: ClipAction[] = [];
  private mainAction = "";

  protected shell(): void {
    this.modalEl.addClass("bookmarks-clip-modal");
    this.contentEl.empty();
    this.contentEl.addClass("bookmarks-clip");
    this.topEl = this.contentEl.createDiv({ cls: "bookmarks-clip-top" });
    this.scrollEl = this.contentEl.createDiv({ cls: "bookmarks-clip-scroll" });
  }

  protected header(onChange: (template: string) => void): void {
    const head = this.topEl.createDiv({ cls: "bookmarks-clip-header" });
    setIcon(head.createSpan({ cls: "bookmarks-clip-line-icon", attr: { "aria-hidden": "true" } }), "layout-template");
    this.templateSelect = head.createEl("select", { cls: "dropdown bookmarks-clip-template", attr: { "aria-label": "Template" } });
    this.templateSelect.onchange = () => onChange(this.templateSelect.value);
    this.changedDot = head.createSpan({ cls: "bookmarks-clip-changed", attr: { "aria-label": "Changed from the template" } });
    this.changedDot.hide();
  }

  protected setTemplates(names: readonly string[], value: string, disabled = false): void {
    this.templateSelect.empty();
    for (const name of names) this.templateSelect.createEl("option", { text: name, value: name });
    this.templateSelect.value = value;
    this.templateSelect.disabled = disabled;
  }

  /** Shows that what will be saved differs from what the template made. */
  protected setChanged(on: boolean): void {
    this.changedDot.toggle(on);
  }

  /**
   * The page's address, as a quiet line under the template like Web Clipper's
   * header: a link icon and the address, with no box until it's hovered or
   * focused. A status line (reading, already saved, errors) sits under it.
   */
  protected urlRow(value: string, onInput: ((url: string, now: boolean) => void) | null): { input: HTMLInputElement; status: HTMLElement } {
    const row = this.topEl.createDiv({ cls: "bookmarks-clip-url" });
    const line = row.createDiv({ cls: "bookmarks-clip-url-line" });
    setIcon(line.createSpan({ cls: "bookmarks-clip-line-icon", attr: { "aria-hidden": "true" } }), "link");
    const input = line.createEl("input", { type: "url", cls: "bookmarks-clip-url-input", attr: { placeholder: "Paste a link", "aria-label": "Page address", spellcheck: "false" } });
    const status = row.createDiv({ cls: "bookmarks-clip-status setting-item-description" });
    input.value = value;
    if (!onInput) {
      // Update from source: the note's own address, for reference.
      input.readOnly = true;
      input.tabIndex = -1;
      row.addClass("is-readonly");
      return { input, status };
    }
    input.oninput = () => onInput(input.value, false);
    input.onpaste = () => window.setTimeout(() => onInput(input.value, true), 0);
    input.onkeydown = (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        onInput(input.value, true);
      }
    };
    return { input, status };
  }

  /** A status line under the URL or header: busy shows a pulsing dot, error turns it red. */
  protected status(el: HTMLElement, text: string, kind: "busy" | "info" | "error" = "info"): void {
    statusLine(el, text, kind === "busy");
    el.toggleClass("mod-error", kind === "error");
    el.toggle(Boolean(text));
  }

  /** The note's file name, labelled like a property so it reads as something to edit. */
  protected nameField(onInput: (name: string) => void): HTMLInputElement {
    const row = this.scrollEl.createDiv({ cls: "bookmarks-clip-name" });
    const label = row.createEl("label", { cls: "bookmarks-clip-name-label" });
    setIcon(label.createSpan({ cls: "bookmarks-property-icon", attr: { "aria-hidden": "true" } }), "file-text");
    label.createSpan({ text: "File name" });
    const input = row.createEl("input", { type: "text", cls: "bookmarks-clip-name-input", attr: { placeholder: "Untitled", "aria-label": "File name", spellcheck: "false" } });
    input.oninput = () => onInput(input.value);
    input.onkeydown = (evt) => {
      if (evt.key === "Enter") evt.preventDefault();
    };
    this.nameInput = input;
    return input;
  }

  protected setName(name: string): void {
    this.nameInput.value = name;
  }

  /** The Properties heading with its chevron, remembered collapsed or open on this device; `extra` adds to the heading line. */
  protected propertiesSection(extra?: (head: HTMLElement) => void): void {
    const section = this.scrollEl.createDiv({ cls: "bookmarks-clip-properties" });
    const head = section.createDiv({ cls: "bookmarks-clip-properties-head" });
    const toggle = head.createDiv({ cls: "bookmarks-clip-properties-toggle", attr: { role: "button", tabindex: "0" } });
    toggle.createSpan({ text: "Properties" });
    const chevron = toggle.createSpan({ cls: "bookmarks-clip-chevron" });
    setIcon(chevron, "chevron-down");
    extra?.(head);
    this.propertiesEl = section.createDiv({ cls: "bookmarks-clip-property-list" });
    let collapsed = false;
    try {
      collapsed = window.localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      // storage unavailable: start open
    }
    const apply = () => {
      section.toggleClass("is-collapsed", collapsed);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
      } catch {
        // not remembered this time
      }
    };
    toggle.onclick = () => {
      collapsed = !collapsed;
      apply();
    };
    toggle.onkeydown = (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        toggle.click();
      }
    };
    apply();
  }

  /**
   * Draws the property rows: type icon and name, then the value. `onEdit`
   * runs on every change; `extras` adds controls under a row (Update's
   * current value and keep/replace/merge). `readOnly` shows values without inputs.
   */
  protected renderFields(
    fields: readonly PropertyField[],
    options: {
      onEdit?: (field: PropertyField) => void;
      onRemove?: (field: PropertyField) => void;
      extras?: (row: HTMLElement, field: PropertyField) => void;
      readOnly?: boolean;
      empty?: string;
    } = {},
  ): void {
    const list = this.propertiesEl;
    list.empty();
    if (!fields.length) list.createDiv({ cls: "bookmarks-clip-empty setting-item-description", text: options.empty ?? "This template has no properties." });
    for (const field of fields) {
      const row = list.createDiv({ cls: "bookmarks-property" });
      const line = row.createDiv({ cls: "bookmarks-property-line" });
      const key = line.createDiv({ cls: "bookmarks-property-key" });
      setIcon(key.createSpan({ cls: "bookmarks-property-icon", attr: { "aria-label": field.type } }), TYPE_ICONS[field.type]);
      key.createSpan({ cls: "bookmarks-property-name", text: field.name, attr: { title: field.name } });
      const value = line.createDiv({ cls: "bookmarks-property-value" });
      if (options.readOnly) {
        value.createSpan({ cls: "bookmarks-property-text", text: field.text || "—", attr: { title: field.text } });
      } else {
        const input = valueInput(value, field);
        input.setAttr("aria-label", field.name);
        const read = () => (input.type === "checkbox" ? String(input.checked) : input.value);
        input.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
          field.text = read();
          field.edited = true;
          options.onEdit?.(field);
        });
      }
      if (options.onRemove) iconButton(line, "x", `Remove ${field.name}`, () => options.onRemove!(field)).addClass("bookmarks-property-remove");
      options.extras?.(row, field);
    }
  }

  /**
   * A row to name a new property, with the vault's property names suggested;
   * Enter or picking one adds it. Escape, or leaving it empty, takes the row away.
   */
  protected newPropertyRow(names: () => string[], onAdd: (name: string) => void): void {
    this.propertiesEl.querySelector(".bookmarks-property-new")?.remove();
    this.propertiesEl.querySelector(".bookmarks-clip-empty")?.remove();
    const row = this.propertiesEl.createDiv({ cls: "bookmarks-property bookmarks-property-new" });
    const input = row.createEl("input", { type: "text", cls: "bookmarks-property-input", attr: { placeholder: "Property name", "aria-label": "New property name" } });
    let done = false;
    const add = (name: string) => {
      if (done) return;
      done = true;
      row.remove();
      if (name.trim()) onAdd(name.trim());
    };
    new PropertySuggest(this.app, input, names, add);
    input.onkeydown = (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        add(input.value);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        evt.stopPropagation();
        add("");
      }
    };
    // A pick from the suggestions blurs the input first; give it a moment to land.
    input.onblur = () => window.setTimeout(() => add(input.value), 150);
    window.setTimeout(() => input.focus(), 0);
  }

  protected bodyField(onInput: (body: string) => void): HTMLTextAreaElement {
    this.bodyArea = this.scrollEl.createDiv({ cls: "bookmarks-clip-body" });
    const area = this.bodyArea.createEl("textarea", { cls: "bookmarks-clip-body-input", attr: { placeholder: "Note body", "aria-label": "Note body" } });
    area.oninput = () => onInput(area.value);
    return area;
  }

  /** The footer: what goes on the left (the folder, a toggle), then the split action button. */
  protected footer(left: (el: HTMLElement) => void, onAction: (id: string) => void): void {
    const foot = this.contentEl.createDiv({ cls: "bookmarks-clip-footer" });
    left(foot.createDiv({ cls: "bookmarks-clip-footer-left" }));
    const split = foot.createDiv({ cls: "bookmarks-clip-split" });
    this.actionButton = split.createEl("button", { cls: "mod-cta bookmarks-clip-action" });
    this.actionButton.onclick = () => onAction(this.mainAction);
    this.menuButton = split.createEl("button", { cls: "mod-cta bookmarks-clip-more", attr: { "aria-label": "More actions" } });
    setIcon(this.menuButton, "chevron-down");
    this.menuButton.onclick = (evt) => {
      const menu = new Menu();
      for (const action of this.actions.filter((a) => a.id !== this.mainAction)) {
        menu.addItem((item) => item.setTitle(action.label).setIcon(action.icon).onClick(() => onAction(action.id)));
      }
      menu.showAtMouseEvent(evt);
    };
  }

  /** A folder field with vault folder suggestions. */
  protected folderField(parent: HTMLElement, value: string, onInput: (folder: string) => void): HTMLInputElement {
    const input = parent.createEl("input", { type: "text", cls: "bookmarks-clip-folder", attr: { placeholder: "Folder", "aria-label": "Folder" } });
    input.value = value;
    input.oninput = () => onInput(input.value);
    new FolderSuggest(this.app, input, onInput);
    return input;
  }

  /** Sets the split button's actions, with `main` on the button and the rest in its menu. */
  protected setActions(actions: ClipAction[], main: string): void {
    this.actions = actions;
    this.mainAction = actions.some((a) => a.id === main) ? main : (actions[0]?.id ?? "");
    this.actionButton.setText(this.actions.find((a) => a.id === this.mainAction)?.label ?? "");
    this.menuButton.toggle(this.actions.length > 1);
    this.actionButton.toggleClass("mod-alone", this.actions.length <= 1);
  }

  protected setBusy(busy: boolean, label?: string): void {
    this.actionButton.disabled = busy;
    this.menuButton.disabled = busy;
    if (label) this.actionButton.setText(label);
    else if (!busy) this.actionButton.setText(this.actions.find((a) => a.id === this.mainAction)?.label ?? "");
  }
}
