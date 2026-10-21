import { Notice, TFile, getFrontMatterInfo, normalizePath, parseYaml, type App } from "obsidian";
import type { CaptureFile, ClipperTemplate, RenderedNote } from "./api";
import { PageGone } from "./client";
import { errorText } from "./errors";
import { fieldsFrom } from "./fields";
import type BookmarksPlugin from "./main";
import { extractTokens, markersToTokens, tokensIn, type PendingInsert } from "./placeholders";
import { letGo, readPreview, type Preview } from "./preview";
import { captureIdPropertyName, chooseTemplate, DEFAULT_TEMPLATE } from "./template";
import { applyRows, updateBody } from "./update";
import { UpdateModal, type UpdatePlan } from "./update-modal";

/** Update note from source: fetching a note's page when asked, and applying what the user picks to the note. */
export class UpdateController {
  constructor(private readonly plugin: BookmarksPlugin) {}

  private get app(): App {
    return this.plugin.app;
  }

  /**
   * The template a note records it was made with: the value of a template's
   * `{{template}}` property, when that names a template. Null when none does,
   * and the template is matched by the note's URL instead.
   */
  private noteTemplate(file: TFile): ClipperTemplate | null {
    const frontmatter = this.plugin.frontmatterOf(file);
    const names = new Set(this.plugin.templates.flatMap((t) => t.properties.filter((p) => /^\{\{\s*template\s*\}\}$/.test(p.value.trim())).map((p) => p.name)));
    for (const name of names) {
      const value = frontmatter[name];
      const found = typeof value === "string" ? this.plugin.templates.find((t) => t.name === value.trim()) : undefined;
      if (found) return found;
    }
    return null;
  }

  /** Templates an update can start from: those not switched off for it, plus the note's own. */
  private updateTemplates(own: string | null): string[] {
    return this.plugin.templates.filter((t) => t.updateFromSource !== false || t.name === own).map((t) => t.name);
  }

  /**
   * Opens the update for a note, showing it as it is; nothing is fetched until
   * the user asks. `replaceAll` (the Retry capture link) fetches straight away
   * with every property and the body set to be replaced.
   */
  async open(file: TFile, options: { replaceAll?: boolean } = {}): Promise<void> {
    const url = this.plugin.noteUrl(file);
    if (!url) {
      new Notice("This note has no URL property to fetch.");
      return;
    }
    const text = await this.app.vault.read(file);
    const types = await this.plugin.propertyTypes();
    const own = this.noteTemplate(file) ?? chooseTemplate(this.plugin.templates, url);
    const templates = this.updateTemplates(own.name);
    let preview: Preview | null = null;
    let generation = 0;
    const client = () => this.plugin.client();

    const show = (note: RenderedNote) => {
      const template = this.plugin.templates.find((t) => t.name === note.template) ?? DEFAULT_TEMPLATE;
      modal.filled({
        template: template.name,
        fields: fieldsFrom(note, template, types, parseYaml),
        body: markersToTokens(note.content).trim(),
        noteName: note.noteName,
        folder: (note.path || template.path).replace(/^\/+|\/+$/g, ""),
      });
    };

    const modal = new UpdateModal(this.app, {
      templates,
      template: templates.includes(own.name) ? own.name : (templates[0] ?? own.name),
      url,
      name: file.basename,
      folder: file.parent && file.parent.path !== "/" ? file.parent.path : "",
      frontmatter: this.plugin.frontmatterOf(file),
      body: text.slice(getFrontMatterInfo(text).contentStart),
      types,
      skip: [...this.plugin.urlNames(), ...this.plugin.templates.map(captureIdPropertyName)],
      propertyNames: () => this.plugin.vaultProperties(),
      replaceAll: options.replaceAll ?? false,
      onFetch: (template) => {
        const previous = preview;
        preview = null;
        if (previous) void letGo(client(), previous);
        const run = ++generation;
        void this.plugin
          .ready()
          .then(() =>
            readPreview(client(), url, template, (job) => {
              if (run === generation) preview = { job, read: false };
              else void letGo(client(), { job, read: false });
            }),
          )
          .then(
            ({ job, note }) => {
              if (run !== generation) return void letGo(client(), { job, read: true });
              preview = { job, read: true };
              show(note);
            },
            (err: unknown) => {
              if (run === generation) modal.failed(errorText(err));
            },
          );
      },
      onTemplate: (template) => {
        const current = preview;
        if (!current?.read) return modal.refetch(template);
        const run = generation;
        void client()
          .render(current.job.id, template)
          .then(
            (note) => {
              if (run !== generation) return;
              if (note) show(note);
              else modal.failed(`the ${template} template couldn't be rendered on this page`);
            },
            (err: unknown) => {
              if (run !== generation) return;
              if (err instanceof PageGone) modal.refetch(template);
              else modal.failed(errorText(err));
            },
          );
      },
      onApply: (plan) => {
        const current = preview;
        preview = null;
        void this.apply(file, plan, current).catch((err: unknown) => new Notice(`Couldn't update the note: ${errorText(err)}`));
      },
      onClose: (applied) => {
        generation++;
        if (!applied && preview) void letGo(client(), preview);
      },
    });
    modal.open();
  }

  /**
   * Applies an update: renames or moves the note, sets its properties, puts the
   * fetched body in, then asks the server for any screenshots the new parts
   * use, which are put in when they arrive.
   */
  private async apply(file: TFile, plan: UpdatePlan, preview: Preview | null): Promise<void> {
    await this.moveTo(file, plan.folder, plan.name);
    const changing = plan.rows.filter((r) => r.mode !== "keep" && r.mode !== "remove");
    const { body, anchors } = plan.bodyMode === "keep" ? { body: "", anchors: [] } : extractTokens(plan.body);
    if (plan.rows.some((r) => r.mode !== "keep")) {
      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => applyRows(frontmatter, plan.rows));
    }
    if (plan.bodyMode !== "keep") await this.app.vault.process(file, (text) => updateBody(text, getFrontMatterInfo(text).contentStart, body, plan.bodyMode));

    const client = this.plugin.client();
    const id = preview?.read ? preview.job.id : null;
    const valueOf = (r: (typeof changing)[number]) => (r.mode === "replace" ? (r.next ?? "") : r.text);
    const pending: PendingInsert[] = id
      ? [
          ...anchors.map(({ kind, ...where }): PendingInsert => ({ captureId: id, notePath: file.path, kind, where })),
          ...changing.flatMap((r) => tokensIn(valueOf(r)).map((kind): PendingInsert => ({ captureId: id, notePath: file.path, kind, where: { in: "property", name: r.name, expression: valueOf(r) } }))),
        ]
      : [];
    const kinds = [...new Set(pending.map((p) => p.kind))] as CaptureFile[];
    if (id && kinds.length) {
      await this.plugin.rememberCapture(id, file.path);
      this.plugin.settings.pendingInserts = [...this.plugin.settings.pendingInserts, ...pending];
      await this.plugin.persist();
      try {
        await client.files(id, kinds, true);
        this.plugin.watch(id);
      } catch (err) {
        this.plugin.settings.pendingInserts = this.plugin.settings.pendingInserts.filter((p) => p.captureId !== id);
        await this.plugin.persist();
        new Notice(`Updated without its screenshots: ${err instanceof PageGone ? "the page was closed on the server" : errorText(err)}.`);
      }
    } else if (preview) await letGo(client, preview);
    const changed = plan.rows.some((r) => r.mode !== "keep") || plan.bodyMode !== "keep";
    new Notice(changed ? `Updated ${file.basename}.` : `${file.basename} is unchanged.`);
  }

  /** Renames or moves the note when its name or folder changed; links to it follow the user's Obsidian setting. */
  private async moveTo(file: TFile, folder: string, name: string): Promise<void> {
    const current = file.parent && file.parent.path !== "/" ? file.parent.path : "";
    if (folder === current && name === file.basename) return;
    const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || file.basename;
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
    let path = normalizePath(folder ? `${folder}/${clean}.md` : `${clean}.md`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path) && path !== file.path; n++) path = normalizePath(folder ? `${folder}/${clean} ${n}.md` : `${clean} ${n}.md`);
    if (path !== file.path) await this.app.fileManager.renameFile(file, path);
  }
}
