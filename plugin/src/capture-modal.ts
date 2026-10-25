import { App } from "obsidian";
import type { CaptureAction, ClipperTemplate } from "./api";
import { ClipModal, type ClipAction } from "./clip-modal";
import { confirm } from "./confirm";
import { emptyFields, type FieldType, type PropertyField } from "./fields";
import { normalizeUrl } from "./url";

/** What the footer button does. On a page already saved, Add saves another note: the status line has said so, with a link to the saved one. */
export type CaptureModalAction = CaptureAction;

/** The note as the capture modal shows it, edits and all. */
export interface ClipDraft {
  url: string;
  template: string;
  noteName: string;
  properties: PropertyField[];
  body: string;
  folder: string;
  /** Values the template marked `|local`, from the rendered note: saved in the vault once it's added. */
  local: string[];
}

export interface CaptureHandlers {
  templates: readonly ClipperTemplate[];
  types: Record<string, FieldType>;
  /** Every property name used in the vault, for adding one. */
  propertyNames: () => string[];
  /** The template a URL's rules pick, before the page is read. */
  match: (url: string) => ClipperTemplate;
  /** Reads the page; `template` is null when the user hasn't picked one, so the server matches it (schema rules too). */
  onFetch: (url: string, template: string | null) => void;
  /** Renders the page already read with another template. */
  onTemplate: (name: string) => void;
  onAction: (action: CaptureModalAction, draft: ClipDraft) => void;
  onOpenExisting: (path: string) => void;
  /** The modal closed; `added` when an action ran. */
  onClose: (added: boolean) => void;
}

const LABELS: Record<CaptureModalAction, ClipAction> = {
  add: { id: "add", label: "Add to Obsidian", icon: "file-plus" },
  copy: { id: "copy", label: "Copy Markdown", icon: "copy" },
};

/** How long after the last keystroke a typed URL is fetched. */
const TYPING_MS = 600;

/**
 * Capture URL, after Obsidian Web Clipper's popup: the template and the page's
 * address, then the note's name, properties and body as the template renders
 * them, all editable, and a footer to add it. The page is read as soon as
 * there's a valid address; the fields fill in when it has been.
 */
export class CaptureModal extends ClipModal {
  private draft: ClipDraft;
  private template: ClipperTemplate;
  /** The user picked the template, so it's sent rather than matched. */
  private picked = false;
  private fetched: string | null = null;
  private filledIn = false;
  private failedToRead = false;
  private existingPath: string | null = null;
  private folderEdited = false;
  private edited = false;
  private done = false;
  private timer: number | null = null;
  private statusEl!: HTMLElement;
  private bodyInput!: HTMLTextAreaElement;
  private folderInput!: HTMLInputElement;

  constructor(
    app: App,
    initialUrl: string,
    private readonly handlers: CaptureHandlers,
  ) {
    super(app);
    this.template = handlers.match(initialUrl);
    this.draft = { url: initialUrl, template: this.template.name, noteName: "", properties: emptyFields(this.template, handlers.types), body: "", folder: this.template.path, local: [] };
  }

  override onOpen(): void {
    this.setTitle("Capture URL");
    this.shell();
    this.header((name) => void this.pickTemplate(name));
    this.setTemplates(
      this.handlers.templates.map((t) => t.name),
      this.template.name,
    );
    const { input, status } = this.urlRow(this.draft.url, (url, now) => this.urlChanged(url, now));
    this.statusEl = status;
    this.status(status, "");
    this.nameField((name) => {
      this.draft.noteName = name;
      this.markEdited();
    });
    this.propertiesSection((head) => {
      const add = head.createEl("button", { text: "Add property", cls: "mod-muted bookmarks-section-add" });
      add.onclick = () => {
        this.propertiesEl.parentElement?.removeClass("is-collapsed");
        const taken = () => new Set(this.draft.properties.map((f) => f.name));
        this.newPropertyRow(
          () => this.handlers.propertyNames().filter((name) => !taken().has(name)),
          (name) => {
            if (!taken().has(name)) this.draft.properties.push({ name, type: this.handlers.types[name] ?? "text", text: "", expression: "", edited: true });
            this.markEdited();
            this.drawFields();
            // Straight into the new value.
            this.propertiesEl.querySelector<HTMLInputElement>(`.bookmarks-property:last-child input`)?.focus();
          },
        );
      };
    });
    this.bodyInput = this.bodyField((body) => {
      this.draft.body = body;
      this.markEdited();
    });
    this.footer(
      (left) =>
        (this.folderInput = this.folderField(left, this.draft.folder, (folder) => {
          this.draft.folder = folder;
          this.folderEdited = true;
        })),
      (id) => this.act(id as CaptureModalAction),
    );
    this.drawFields();
    this.updateActions();
    this.setBusy(true);
    if (normalizeUrl(this.draft.url)) this.fetch();
    else window.setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.contentEl.empty();
    this.handlers.onClose(this.done);
  }

  // ---- what the controller tells the modal ----

  /** The page was read: fills every field the user hasn't edited. `local` are the values the template marked `|local`. */
  filled(fields: PropertyField[], noteName: string, body: string, template: string, folder: string, local: string[]): void {
    this.filledIn = true;
    this.failedToRead = false;
    const next = this.handlers.templates.find((t) => t.name === template);
    if (next) this.template = next;
    this.draft.template = template;
    this.templateSelect.value = template;
    // Rows typed into before the page arrived keep what was typed.
    const typed = new Map(this.draft.properties.filter((f) => f.edited).map((f) => [f.name, f]));
    this.draft.properties = [...fields.map((f) => typed.get(f.name) ?? f), ...[...typed.values()].filter((f) => !fields.some((g) => g.name === f.name))];
    this.draft.noteName = noteName;
    this.setName(noteName);
    this.draft.body = body;
    this.bodyInput.value = body;
    if (!this.folderEdited) {
      this.draft.folder = folder;
      this.folderInput.value = folder;
    }
    this.edited = typed.size > 0;
    this.setChanged(this.edited);
    this.drawFields();
    this.draft.local = local;
    this.status(this.statusEl, this.existingPath ? this.statusEl.getText() : "");
    if (this.existingPath) this.existing(this.existingPath, this.existingName);
    this.updateActions();
    this.setBusy(false);
  }

  /** Reading the page failed: says why, with Retry; the note can still be added with just its link. */
  failed(message: string): void {
    this.failedToRead = true;
    this.statusEl.empty();
    this.status(this.statusEl, `Couldn't read the page: ${message}`, "error");
    const retry = this.statusEl.createEl("a", { text: "Retry", href: "#" });
    retry.onclick = (evt) => {
      evt.preventDefault();
      this.fetch(true);
    };
    this.updateActions();
    this.setBusy(false);
  }

  /** The page read earlier was let go on the server: reads it again with this template. */
  refetch(template: string): void {
    this.picked = true;
    this.status(this.statusEl, "Reading the page again…", "busy");
    this.fetch(true);
    this.draft.template = template;
  }

  /** Re-rendering with another template failed: back to the one shown. */
  templateFailed(message: string): void {
    this.templateSelect.value = this.draft.template;
    this.status(this.statusEl, message, "error");
    this.setBusy(false);
  }

  private existingName = "";

  /** The page is already in the vault: names that note, with a link to open it. */
  existing(path: string | null, name = ""): void {
    this.existingPath = path;
    this.existingName = name;
    if (path) {
      this.statusEl.empty();
      this.status(this.statusEl, `Already saved: ${name}`);
      const open = this.statusEl.createEl("a", { text: "Open", href: "#" });
      open.onclick = (evt) => {
        evt.preventDefault();
        this.close();
        this.handlers.onOpenExisting(path);
      };
    }
    this.updateActions();
  }

  // ---- inside ----

  private markEdited(): void {
    if (!this.filledIn && !this.failedToRead) return;
    this.edited = true;
    this.setChanged(true);
  }

  private drawFields(): void {
    this.renderFields(this.draft.properties, {
      onEdit: () => this.markEdited(),
      onRemove: (field) => {
        this.draft.properties = this.draft.properties.filter((f) => f !== field);
        this.markEdited();
        this.drawFields();
      },
      empty: "This template has no properties.",
    });
  }

  private urlChanged(url: string, now: boolean): void {
    this.draft.url = url.trim();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.fetch(), now ? 0 : TYPING_MS);
  }

  /** Reads the page at the current address, unless it's the one already read. */
  private fetch(again = false): void {
    const url = this.draft.url;
    if (!normalizeUrl(url)) {
      this.status(this.statusEl, url ? "That doesn't look like a web address." : "", url ? "error" : "info");
      return;
    }
    if (!again && url === this.fetched) return;
    this.fetched = url;
    this.filledIn = false;
    this.failedToRead = false;
    this.existingPath = null;
    if (!this.picked) {
      const guess = this.handlers.match(url);
      if (guess.name !== this.template.name) {
        this.template = guess;
        this.templateSelect.value = guess.name;
        this.draft.template = guess.name;
        this.draft.properties = emptyFields(guess, this.handlers.types);
        if (!this.folderEdited) this.folderInput.value = this.draft.folder = guess.path;
        this.drawFields();
      }
    }
    this.status(this.statusEl, "Reading the page…", "busy");
    this.setBusy(true);
    this.handlers.onFetch(url, this.picked ? this.template.name : null);
  }

  private async pickTemplate(name: string): Promise<void> {
    if (name === this.draft.template) return;
    if (this.edited && !(await confirm(this.app, "Switch template?", "Your changes to this note will be replaced by what the other template makes.", "Switch"))) {
      this.templateSelect.value = this.draft.template;
      return;
    }
    this.picked = true;
    const next = this.handlers.templates.find((t) => t.name === name);
    if (!next) return;
    this.template = next;
    this.edited = false;
    this.setChanged(false);
    if (this.filledIn) {
      this.status(this.statusEl, `Rendering with ${name}…`, "busy");
      this.setBusy(true);
      this.handlers.onTemplate(name);
      return;
    }
    // Not read yet: the rows change now, and the read in flight starts over with this template.
    this.draft.template = name;
    this.draft.properties = emptyFields(next, this.handlers.types);
    if (!this.folderEdited) this.folderInput.value = this.draft.folder = next.path;
    this.drawFields();
    this.updateActions();
    if (this.fetched) this.fetch(true);
  }

  private updateActions(): void {
    const actions: CaptureModalAction[] = ["add", "copy"];
    this.setActions(
      actions.map((a) => LABELS[a]),
      this.template.onCapture ?? "add",
    );
  }

  private act(action: CaptureModalAction): void {
    if (!this.filledIn && !this.failedToRead) return;
    this.done = true;
    this.close();
    this.handlers.onAction(action, { ...this.draft, properties: this.draft.properties.map((f) => ({ ...f })), local: [...this.draft.local] });
  }
}
