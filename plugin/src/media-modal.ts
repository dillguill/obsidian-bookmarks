import { App, Modal, setIcon } from "obsidian";
import { MEDIA_ICONS as ICONS, type MediaItem } from "./media";

/** Where an item is, for its row. */
function whereText(item: MediaItem): string {
  if (item.source.in === "property") return `Property: ${item.source.name}`;
  if (item.source.in === "end") return "From the note's link; added at the end";
  return "In the note";
}

export type ItemState = { state: "waiting" | "working" | "done" } | { state: "failed"; reason: string };

/**
 * Download media for current note, after Obsidian's own Download attachments:
 * every item found, ticked, with a preview where there is one. While the
 * downloads run each row shows how it went; the modal can be closed meanwhile.
 */
export class MediaModal extends Modal {
  private readonly picked = new Set<string>();
  private readonly rows = new Map<string, { el: HTMLElement; status: HTMLElement; box: HTMLInputElement; thumb: HTMLElement }>();
  private button!: HTMLButtonElement;
  private running = false;

  constructor(
    app: App,
    private readonly items: readonly MediaItem[],
    private readonly onDownload: (items: MediaItem[]) => void,
  ) {
    super(app);
    for (const item of items) this.picked.add(item.key);
  }

  override onOpen(): void {
    this.setTitle("Download media");
    this.modalEl.addClass("bookmarks-media-modal");
    const list = this.contentEl.createDiv({ cls: "bookmarks-media-list" });
    for (const item of this.items) {
      const el = list.createEl("label", { cls: "bookmarks-media-row" });
      const box = el.createEl("input", { type: "checkbox" });
      box.checked = true;
      box.onchange = () => {
        if (box.checked) this.picked.add(item.key);
        else this.picked.delete(item.key);
        this.label();
      };
      const thumb = el.createDiv({ cls: "bookmarks-media-thumb" });
      this.drawThumb(thumb, item, item.preview);
      const text = el.createDiv({ cls: "bookmarks-media-text" });
      text.createDiv({ cls: "bookmarks-media-label", text: item.label });
      text.createDiv({ cls: "bookmarks-media-where setting-item-description", text: whereText(item) });
      const status = el.createDiv({ cls: "bookmarks-media-status" });
      this.rows.set(item.key, { el, status, box, thumb });
    }
    const foot = this.contentEl.createDiv({ cls: "bookmarks-buttons" });
    foot.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    this.button = foot.createEl("button", { cls: "mod-cta" });
    this.button.onclick = () => {
      if (this.running) return this.close();
      const chosen = this.items.filter((item) => this.picked.has(item.key));
      if (!chosen.length) return;
      this.running = true;
      for (const row of this.rows.values()) row.box.disabled = true;
      (foot.firstElementChild as HTMLElement).hide();
      this.onDownload(chosen);
    };
    this.label();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  /** A preview found later (a TikTok post's thumbnail). */
  setPreview(key: string, url: string): void {
    const row = this.rows.get(key);
    const item = this.items.find((i) => i.key === key);
    if (row && item) this.drawThumb(row.thumb, item, url);
  }

  /** Shows how one item's download went, and how many are left on the button. */
  setState(key: string, state: ItemState): void {
    const row = this.rows.get(key);
    if (!row) return;
    row.status.empty();
    row.el.removeClass("is-working", "is-done", "is-failed");
    if (state.state === "waiting") return;
    row.el.addClass(`is-${state.state}`);
    const icon = row.status.createSpan({ cls: "bookmarks-media-status-icon" });
    setIcon(icon, state.state === "done" ? "check" : state.state === "failed" ? "alert-triangle" : "loader");
    if (state.state === "failed") {
      row.status.setAttr("aria-label", state.reason);
      row.status.createSpan({ cls: "bookmarks-media-reason", text: state.reason });
    }
  }

  /** "Downloading 2 of 5…", then Done. */
  progress(done: number, total: number): void {
    if (!this.button) return;
    this.button.setText(done >= total ? "Done" : `Downloading ${done + 1} of ${total}…`);
  }

  private label(): void {
    if (this.running) return;
    const n = this.picked.size;
    this.button.setText(n ? `Download ${n === this.items.length ? "all" : n}` : "Download");
    this.button.disabled = n === 0;
  }

  private drawThumb(el: HTMLElement, item: MediaItem, url: string | null): void {
    el.empty();
    if (url) {
      const img = el.createEl("img", { attr: { src: url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" } });
      img.onerror = () => {
        img.remove();
        setIcon(el, ICONS[item.kind]);
      };
    } else setIcon(el, ICONS[item.kind]);
  }
}
