import { setIcon } from "obsidian";

/** A value on one line, for previews: lists joined, capture file markers shortened. */
export function preview(value: unknown, max = 160): string {
  if (value === undefined || value === null || value === "") return "(none)";
  const text = Array.isArray(value) ? value.map(String).join(", ") : typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/bookmarks-[a-z_0-9]+-5f2c9e/g, "…").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A section heading with its add button on the same line. */
export function sectionHead(parent: HTMLElement, title: string, add?: string, onAdd?: (evt: MouseEvent) => void): void {
  const head = parent.createDiv({ cls: "bookmarks-section-head" });
  head.createSpan({ text: title, cls: "bookmarks-strong" });
  if (!add || !onAdd) return;
  const button = head.createEl("button", { text: add, cls: "mod-muted bookmarks-section-add" });
  button.onclick = onAdd;
}

/** A small icon button. */
export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
  const button = parent.createDiv({ cls: "clickable-icon bookmarks-icon-button", attr: { "aria-label": label } });
  setIcon(button, icon);
  button.onclick = onClick;
  return button;
}

/** A select sized for a row rather than a settings line. */
export function smallSelect(parent: HTMLElement): HTMLSelectElement {
  return parent.createEl("select", { cls: "dropdown bookmarks-small-select" });
}

/**
 * A row: what it is on the left, controls on the right. When the row is too
 * narrow for both (phones), the controls wrap onto their own line underneath.
 */
export function rowLine(parent: HTMLElement): { line: HTMLElement; main: HTMLElement; controls: HTMLElement } {
  const line = parent.createDiv({ cls: "bookmarks-row" });
  const main = line.createDiv({ cls: "bookmarks-row-main" });
  const controls = line.createDiv({ cls: "bookmarks-row-controls" });
  return { line, main, controls };
}

/** Fades an element in and out until it's removed. */
export function pulse(el: HTMLElement, duration = 1000): void {
  el.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration, iterations: Infinity });
}

/** A status line, with a pulsing dot while something is on its way. */
export function statusLine(el: HTMLElement, text: string, busy: boolean): void {
  el.empty();
  el.addClass("bookmarks-status");
  if (busy) pulse(el.createSpan({ cls: "bookmarks-status-dot" }));
  el.createSpan({ text });
}

/** Text that cuts off with an ellipsis instead of wrapping. */
export function clipped(parent: HTMLElement, text: string, muted = false): HTMLElement {
  return parent.createSpan({ text, cls: muted ? "bookmarks-clipped setting-item-description" : "bookmarks-clipped" });
}
