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
  const head = parent.createDiv();
  Object.assign(head.style, { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0 4px" });
  head.createSpan({ text: title }).style.fontWeight = "600";
  if (!add || !onAdd) return;
  const button = head.createEl("button", { text: add, cls: "mod-muted" });
  Object.assign(button.style, { fontSize: "var(--font-ui-smaller)", padding: "2px 8px", height: "auto" });
  button.onclick = onAdd;
}

/** A small icon button. */
export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
  const button = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
  setIcon(button, icon);
  button.style.flex = "none";
  button.onclick = onClick;
  return button;
}

/** A select sized for a row rather than a settings line. */
export function smallSelect(parent: HTMLElement): HTMLSelectElement {
  const select = parent.createEl("select", { cls: "dropdown" });
  Object.assign(select.style, { fontSize: "var(--font-ui-smaller)", height: "auto", padding: "2px 24px 2px 8px", maxWidth: "11em" });
  return select;
}

/**
 * A row: what it is on the left, controls on the right. When the row is too
 * narrow for both (phones), the controls wrap onto their own line underneath.
 */
export function rowLine(parent: HTMLElement): { line: HTMLElement; main: HTMLElement; controls: HTMLElement } {
  const line = parent.createDiv();
  Object.assign(line.style, { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 6px", padding: "6px 0" });
  const main = line.createDiv();
  Object.assign(main.style, { flex: "1 1 12em", minWidth: "0", display: "flex", alignItems: "center", gap: "8px" });
  const controls = line.createDiv();
  Object.assign(controls.style, { flex: "1 0 auto", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px" });
  return { line, main, controls };
}

/** Fades an element in and out until it's removed. */
export function pulse(el: HTMLElement, duration = 1000): void {
  el.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration, iterations: Infinity });
}

/** A status line, with a pulsing dot while something is on its way. */
export function statusLine(el: HTMLElement, text: string, busy: boolean): void {
  el.empty();
  Object.assign(el.style, { display: "flex", alignItems: "center", gap: "6px" });
  if (busy) {
    const dot = el.createSpan();
    Object.assign(dot.style, { width: "8px", height: "8px", borderRadius: "50%", background: "var(--interactive-accent)", flex: "none" });
    pulse(dot);
  }
  el.createSpan({ text });
}

/** A grey stand-in for a row that hasn't arrived yet. */
export function placeholderRow(parent: HTMLElement, width: number): void {
  const { main, controls } = rowLine(parent);
  Object.assign(main.style, { flexDirection: "column", alignItems: "flex-start", gap: "5px" });
  const block = (into: HTMLElement, w: number, h: number) => {
    const el = into.createDiv();
    Object.assign(el.style, { width: `${w}px`, maxWidth: "100%", height: `${h}px`, borderRadius: "4px", background: "var(--background-modifier-border)" });
    pulse(el, 1400);
  };
  block(main, width, 12);
  block(main, width + 90, 10);
  block(controls, 84, 22);
  block(controls, 62, 22);
}

/** Text that cuts off with an ellipsis instead of wrapping. */
export function clipped(parent: HTMLElement, text: string, muted = false): HTMLElement {
  const span = parent.createSpan({ text, cls: muted ? "setting-item-description" : undefined });
  Object.assign(span.style, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0", padding: "0" });
  return span;
}
