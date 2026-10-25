import { Notice, TFile, parseYaml, stringifyYaml, type App } from "obsidian";
import type { CaptureFile, Job, RenderedNote } from "./api";
import { PageGone } from "./client";
import { CaptureModal, type CaptureModalAction, type ClipDraft } from "./capture-modal";
import { errorText } from "./errors";
import { fieldsFrom, frontmatterFrom } from "./fields";
import type BookmarksPlugin from "./main";
import { extractTokens, markersToTokens, type PendingInsert } from "./placeholders";
import { letGo, readPreview, type Preview } from "./preview";
import { DEFAULT_TEMPLATE, chooseTemplate, urlPropertyName } from "./template";
import { findUrl } from "./url";
import { writeEditedNote } from "./writer";

/** Capture URL: reading a page, showing its note to edit, and writing it. */
export class CaptureController {
  constructor(private readonly plugin: BookmarksPlugin) {}

  private get app(): App {
    return this.plugin.app;
  }

  async open(): Promise<void> {
    let initial = "";
    try {
      initial = findUrl(await navigator.clipboard.readText()) ?? "";
    } catch {
      // clipboard unavailable or denied
    }
    const types = await this.plugin.propertyTypes();
    let preview: Preview | null = null;
    /** Bumped on every read, so an older one that answers late is ignored. */
    let generation = 0;
    const letGo = () => {
      const current = preview;
      preview = null;
      if (current) void this.letGo(current);
    };

    const show = (note: RenderedNote, job: Job) => {
      const template = this.plugin.templates.find((t) => t.name === note.template) ?? DEFAULT_TEMPLATE;
      modal.filled(fieldsFrom(note, template, types, parseYaml), note.noteName, markersToTokens(note.content), template.name, note.path || template.path, note.local ?? []);
      preview = { job, read: true };
    };

    const modal = new CaptureModal(this.app, initial, {
      templates: this.plugin.templates,
      types,
      propertyNames: () => this.plugin.vaultProperties(),
      match: (url) => chooseTemplate(this.plugin.templates, url),
      urlProperty: urlPropertyName,
      onFetch: (url, template) => {
        letGo();
        const run = ++generation;
        const existing = this.plugin.index.findByUrl(url);
        modal.existing(existing, existing?.replace(/^.*\//, "").replace(/\.md$/, ""));
        void this.plugin.ready().then(() => readPreview(this.plugin.client(), url, template, (job) => {
          if (run === generation) preview = { job, read: false };
          else void this.letGo({ job, read: false });
        })).then(
          ({ job, note }) => {
            if (run !== generation) return void this.letGo({ job, read: true });
            show(note, job);
          },
          (err: unknown) => {
            if (run === generation) modal.failed(errorText(err));
          },
        );
      },
      onTemplate: (name) => {
        const current = preview;
        if (!current) return;
        const run = generation;
        void this.plugin
          .client()
          .render(current.job.id, name)
          .then(
            (note) => {
              if (run !== generation) return;
              if (note) show(note, current.job);
              else modal.templateFailed(`The ${name} template couldn't be rendered on this page.`);
            },
            (err: unknown) => {
              if (run !== generation) return;
              // The page was let go (left too long): read it again with this template.
              if (err instanceof PageGone) modal.refetch(name);
              else modal.templateFailed(`Couldn't render with ${name}: ${errorText(err)}`);
            },
          );
      },
      onAction: (action, draft) => {
        const current = preview;
        preview = null;
        void this.act(action, draft, current).catch((err: unknown) => new Notice(`Couldn't save the bookmark: ${errorText(err)}`));
      },
      onOpenExisting: (path) => this.plugin.openNote(path),
      onClose: (added) => {
        generation++;
        if (!added) letGo();
      },
    });
    modal.open();
  }

  /** Lets go of a preview the user didn't add. */
  private letGo(preview: Preview): Promise<void> {
    return letGo(this.plugin.client(), preview);
  }

  private async act(action: CaptureModalAction, draft: ClipDraft, preview: Preview | null): Promise<void> {
    if (action === "copy") {
      const frontmatter = frontmatterFrom(draft.properties);
      // Empty properties as Obsidian writes them ("status:"), not "status: null".
      const yaml = Object.keys(frontmatter).length ? `---\n${stringifyYaml(frontmatter).replace(/: null$/gm, ":")}---\n` : "";
      await navigator.clipboard.writeText(`${yaml}${extractTokens(draft.body).body.replace(/^\s+/, "")}`);
      new Notice("Copied the note's Markdown.");
      if (preview) await this.letGo(preview);
      return;
    }
    const path = await this.add(draft, preview);
    this.plugin.openNote(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (draft.keep.length && file instanceof TFile) await this.plugin.media.saveLocal(file, draft.keep, draft.local);
  }

  /** Writes the note as shown, then asks the server for the screenshots it waits on; they're put in when they arrive. */
  private async add(draft: ClipDraft, preview: Preview | null): Promise<string> {
    const template = this.plugin.templates.find((t) => t.name === draft.template) ?? DEFAULT_TEMPLATE;
    const urlName = urlPropertyName(template);
    const properties = [...draft.properties];
    // A page that couldn't be read is still saved, with its link.
    if (!properties.some((f) => f.name === urlName && f.text.trim())) {
      properties.unshift({ name: urlName, type: "text", text: draft.url, expression: "{{url}}", edited: false });
    }
    const url = properties.find((f) => f.name === urlName)?.text.trim() || draft.url;
    const id = preview?.read ? preview.job.id : null;
    const { path, waiting } = await writeEditedNote(this.plugin.vaultPort(), this.plugin.index, { ...draft, url, properties, captureId: id });
    if (!preview) return path;
    if (!id) {
      await this.letGo(preview);
      return path;
    }
    // Remembered before the server is told to finish, so drain never writes it again.
    await this.plugin.rememberCapture(id, path);
    const pending: PendingInsert[] = [
      ...waiting.body.map(({ kind, ...where }): PendingInsert => ({ captureId: id, notePath: path, kind, where })),
      ...waiting.properties.map(({ kind, name, expression }): PendingInsert => ({ captureId: id, notePath: path, kind, where: { in: "property", name, expression } })),
    ];
    const kinds = [...new Set(pending.map((p) => p.kind))] as CaptureFile[];
    const client = this.plugin.client();
    if (!kinds.length) {
      await client.release(id, true);
      return path;
    }
    this.plugin.settings.pendingInserts = [...this.plugin.settings.pendingInserts, ...pending];
    await this.plugin.persist();
    try {
      await client.files(id, kinds, true);
      this.plugin.watch(id);
    } catch (err) {
      // The page was let go before Add: the note stays as it is, without them.
      this.plugin.settings.pendingInserts = this.plugin.settings.pendingInserts.filter((p) => p.captureId !== id);
      await this.plugin.persist();
      new Notice(`Saved without its screenshots: ${err instanceof PageGone ? "the page was closed on the server" : errorText(err)}.`);
    }
    return path;
  }
}
