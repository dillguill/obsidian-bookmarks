import { Notice, Plugin, TFile, TFolder, getFrontMatterInfo, normalizePath, parseLinktext, parseYaml } from "obsidian";
import { API_VERSION, CAPTURE_FILES, type CaptureFile, type ClipperTemplate, type Job, type RenderedNote } from "./api";
import { CaptureModal } from "./capture-modal";
import { ServerClient } from "./client";
import { DedupIndex } from "./dedup";
import {
  ENRICH_FILES,
  applyProperties,
  defaultSelection,
  enrichChoices,
  filesToSave,
  hasTikTokPlayer,
  placeContent,
  TEMPLATE_CONTENT,
  offlineFiles,
  ON_DEMAND_FILES,
  replaceTikTokPlayer,
  type EnrichSelection,
} from "./enrich";
import { EnrichModal, type EnrichModalOptions } from "./enrich-modal";
import { EnrichSession } from "./enrich-session";
import { redirectFrontmatter, redirectedLink, spliceSpans, type Span } from "./links";
import { appendBodies, applyMergedProperties, countsAsDuplicate, keptFrom, mergeChoices, mergePlan, rankNotes, unusedFiles, type MergeNote } from "./merge";
import { DuplicateListModal, MergeModal, type DuplicateEntry, type MergeSelection } from "./merge-modal";
import { BookmarksSettingTab, DEFAULT_SETTINGS, type BookmarksSettings } from "./settings";
import { DEFAULT_TEMPLATE, captureIdPropertyName, chooseTemplate, urlPropertyName, urlPropertyNames } from "./template";
import { findUrl, normalizeUrl } from "./url";
import { saveCaptureFiles, writeBookmark, type VaultPort, type WriteMode, type WriteResult } from "./writer";

// Server jobs are pruned a few days after delivery, so a few hundred covers any redelivery.
const WRITTEN_CAPTURES_KEPT = 500;
/**
 * Vault-scoped localStorage key for the token's secret name. Secrets live in each
 * device's own SecretStorage, so the name that points at one is per-device too and
 * stays out of data.json, which sync services share between devices.
 */
const TOKEN_SECRET_KEY = "obsidian-bookmarker-token-secret";

/** A capture for "Update note from source" and what the modal shows of it. */
interface LoadedEnrich {
  session: EnrichSession;
  options: EnrichModalOptions;
}

export default class BookmarksPlugin extends Plugin {
  override settings: BookmarksSettings = DEFAULT_SETTINGS;
  index = new DedupIndex();
  /** Templates from the server's shared settings; cached in plugin data so the index works offline. */
  private templates: ClipperTemplate[] = [DEFAULT_TEMPLATE];
  /** Job ids being written right now, so an interactive capture and a drain never both write one. */
  private readonly inFlight = new Set<string>();
  private draining = false;
  private pollTimer: number | null = null;
  private versionWarned = false;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new BookmarksSettingTab(this.app, this));

    this.addCommand({ id: "capture-url", name: "Capture URL", callback: () => void this.openCaptureModal() });
    this.addCommand({ id: "sync-captures", name: "Fetch finished captures now", callback: () => void this.drain(true) });
    this.addCommand({
      id: "recapture",
      name: "Capture current bookmark again",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.noteUrl(file)) return false;
        if (!checking) void this.recapture(file.path);
        return true;
      },
    });
    this.addCommand({
      id: "enrich",
      name: "Update note from source",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md" || !this.noteUrl(file)) return false;
        if (!checking) this.enrich(file);
        return true;
      },
    });
    this.addCommand({
      id: "merge-duplicates",
      name: "Merge duplicates of this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const key = file?.extension === "md" ? this.index.keyOf(file.path) : null;
        if (!key || this.index.paths(key).length < 2) return false;
        if (!checking) this.openMerge(key);
        return true;
      },
    });
    this.addCommand({ id: "find-duplicates", name: "Find duplicate bookmarks", callback: () => this.findDuplicates() });
    this.addRibbonIcon("bookmark-plus", "Capture bookmark", () => void this.openCaptureModal());
    // The "Retry capture" link in a failed capture's note (writer.ts retryLink).
    this.registerObsidianProtocolHandler("bookmarks", (params) => {
      if (params.action === "retry" && params.path) void this.recapture(params.path);
    });

    this.app.workspace.onLayoutReady(() => {
      this.buildIndex();
      this.registerEvent(this.app.metadataCache.on("changed", (file) => this.indexFile(file)));
      this.registerEvent(this.app.vault.on("delete", (file) => this.index.remove(file.path)));
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          this.index.rename(oldPath, file.path);
          void this.renameSeparate(oldPath, file.path);
        }),
      );
      void this.drain(false);
      this.schedulePoll();
    });
  }

  override onunload(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
  }

  getToken(): string | null {
    const name = this.settings.tokenSecretName;
    return name ? this.app.secretStorage.getSecret(name) : null;
  }

  client(): ServerClient {
    return new ServerClient(this.settings.serverUrl, this.getToken() ?? "");
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<BookmarksSettings>;
    const local: unknown = this.app.loadLocalStorage(TOKEN_SECRET_KEY);
    this.settings = { ...DEFAULT_SETTINGS, ...data, tokenSecretName: typeof local === "string" ? local : "" };
    // Versions before 0.1.9 kept the secret name in data.json; adopt it once on this device.
    if (typeof local !== "string" && data.tokenSecretName) {
      this.app.saveLocalStorage(TOKEN_SECRET_KEY, data.tokenSecretName);
      this.settings.tokenSecretName = data.tokenSecretName;
    }
    if (this.settings.templatesCache?.length) this.templates = this.settings.templatesCache;
  }

  /** Another device (through a sync service) changed data.json; reload so we don't write stale settings back over it. */
  override async onExternalSettingsChange(): Promise<void> {
    await this.loadSettings();
    this.rebuildIndex();
    this.schedulePoll();
  }

  /** Sets the per-device secret name for the API token. */
  setTokenSecretName(name: string): void {
    this.settings.tokenSecretName = name;
    this.app.saveLocalStorage(TOKEN_SECRET_KEY, name);
  }

  /** Writes data.json without the per-device token secret name. */
  private async persist(): Promise<void> {
    const { tokenSecretName: _local, ...shared } = this.settings;
    await this.saveData(shared);
  }

  /** The server's settings page, where capture settings and templates are edited. */
  settingsPageUrl(): string | null {
    try {
      return new URL("/ui/", this.settings.serverUrl).toString();
    } catch {
      return null;
    }
  }

  /**
   * Fetches the shared settings: moves any settings older versions kept on
   * this device to the server (once), then refreshes the template cache.
   */
  private async syncShared(): Promise<void> {
    const client = this.client();
    let shared = await client.getSettings();
    const legacyFolder = this.settings.notesFolder;
    const movedFolder = legacyFolder && legacyFolder !== DEFAULT_TEMPLATE.path ? legacyFolder : null;
    if (movedFolder) {
      shared = await client.saveSettings({
        ...shared,
        templates: shared.templates.map((t) => (movedFolder && t.path === DEFAULT_TEMPLATE.path ? { ...t, path: movedFolder } : t)),
      });
    }
    delete this.settings.noScreenshotSites;
    delete this.settings.notesFolder;
    const names = (list: ClipperTemplate[]) => propertyNames(list).join("\n");
    const changed = names(shared.templates) !== names(this.templates);
    this.templates = shared.templates;
    this.settings.templatesCache = shared.templates;
    this.settings.hideCaptureId = shared.hideCaptureId ?? false;
    await this.persist();
    if (changed) this.rebuildIndex();
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    this.schedulePoll();
  }

  schedulePoll(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    const ms = Math.max(10, this.settings.pollIntervalSeconds) * 1000;
    this.pollTimer = window.setInterval(() => void this.drain(false), ms);
  }

  /** Checks the server's API version; returns an error message or null when compatible. */
  async checkServer(): Promise<string | null> {
    const health = await this.client().health();
    if (health.apiVersion === API_VERSION) return null;
    return health.apiVersion > API_VERSION
      ? `Server ${health.version} is newer than this plugin. Update the Bookmarks plugin.`
      : `Server ${health.version} is older than this plugin. Update bookmarks-server.`;
  }

  // ---- dedup index ----

  private buildIndex(): void {
    for (const file of this.app.vault.getMarkdownFiles()) this.indexFile(file);
  }

  /** Indexes the vault from scratch, for when the properties a URL is read from change. */
  rebuildIndex(): void {
    this.index = new DedupIndex();
    this.buildIndex();
  }

  private indexFile(file: TFile): void {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) return this.index.remove(file.path);
    // Templates can name the capture id property differently; take the first one present.
    const captureId = this.templates.map((t) => frontmatter[captureIdPropertyName(t)]).find((value) => typeof value === "string" && value);
    this.index.set(file.path, this.urlIn(frontmatter), captureId);
  }

  // ---- writing ----

  private vaultPort(): VaultPort {
    const { vault } = this.app;
    return {
      exists: async (path) => vault.getAbstractFileByPath(normalizePath(path)) !== null || (await vault.adapter.exists(normalizePath(path))),
      ensureFolder: async (path) => {
        const folder = normalizePath(path);
        if (!folder || folder === "/" || vault.getAbstractFileByPath(folder) instanceof TFolder) return;
        await vault.createFolder(folder).catch(() => {});
      },
      writeBinary: async (path, data) => void (await vault.createBinary(normalizePath(path), data)),
      createNote: async (path, content) => void (await vault.create(normalizePath(path), content)),
      replaceNote: async (path, content) => {
        const file = vault.getAbstractFileByPath(normalizePath(path));
        if (!(file instanceof TFile)) throw new Error(`${path} no longer exists`);
        await vault.modify(file, content);
      },
    };
  }

  /** Fetches a finished job's assets and writes it; acks the server once the vault holds it. */
  private async deliver(job: Job, mode: WriteMode = { kind: "dedup" }): Promise<WriteResult | null> {
    if (this.inFlight.has(job.id)) return null;
    this.inFlight.add(job.id);
    try {
      const client = this.client();
      const markdown = job.assets.includes("markdown") ? await client.assetText(job.id, "markdown") : "";
      // The server takes only the shots the template's variables use.
      const files: Partial<Record<CaptureFile, ArrayBuffer>> = {};
      for (const kind of CAPTURE_FILES) if (job.assets.includes(kind)) files[kind] = await client.assetBinary(job.id, kind);
      // A failed job's metadata describes the block page, so schema triggers only see successful captures.
      const template =
        this.templates.find((t) => t.name === job.template) ??
        chooseTemplate(this.templates, job.url, job.status === "done" ? (job.meta ?? undefined) : undefined);
      // Rendered on the server with Web Clipper's engine; older servers and failed captures use the plugin's renderer.
      const note = job.assets.includes("note") ? (JSON.parse(await client.assetText(job.id, "note")) as RenderedNote) : null;
      const result = await writeBookmark(
        { job, markdown, files, note },
        {
          vault: this.vaultPort(),
          index: this.index,
          template,
          notesFolder: template.path || DEFAULT_TEMPLATE.path,
          assetsFolder: this.settings.assetsFolder,
          hideCaptureId: this.settings.hideCaptureId,
          writtenCapture: (id) => this.settings.writtenCaptures?.[id] ?? null,
          mode,
        },
      );
      if (result.kind === "written") await this.rememberCapture(job.id, result.path);
      await client.delivered(job.id);
      return result;
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  /** Keeps the last WRITTEN_CAPTURES_KEPT capture ids this device wrote. */
  private async rememberCapture(id: string, path: string): Promise<void> {
    const entries = Object.entries(this.settings.writtenCaptures ?? {}).filter(([key]) => key !== id);
    entries.push([id, path]);
    this.settings.writtenCaptures = Object.fromEntries(entries.slice(-WRITTEN_CAPTURES_KEPT));
    await this.persist();
  }

  // ---- entry points ----

  private async openCaptureModal(): Promise<void> {
    let initial = "";
    try {
      initial = findUrl(await navigator.clipboard.readText()) ?? "";
    } catch {
      // clipboard unavailable or denied
    }
    new CaptureModal(
      this.app,
      initial,
      this.templates.map((t) => t.name),
      (url, template) => void this.captureInteractive(url, template),
    ).open();
  }

  private openNote(path: string): void {
    void this.app.workspace.openLinkText(path, "", false);
  }

  /** Karakeep-style "already saved" popup, with the choices for a page that's already in the vault. */
  private alreadySavedNotice(path: string, label: string, raw: string, template: string | null): void {
    const notice = new Notice(
      createFragment((frag) => {
        frag.appendText(`Already saved: ${label}`);
        const actions = frag.createDiv({ cls: "bookmarks-notice-actions" });
        const action = (text: string, run: () => void) => {
          const link = actions.createEl("a", { text, href: "#" });
          link.style.marginRight = "1em";
          link.addEventListener("click", (event) => {
            event.preventDefault();
            notice.hide();
            run();
          });
        };
        action("Open existing", () => this.openNote(path));
        action("Replace", () => void this.captureInteractive(raw, template, { kind: "replace", path }));
        action("Save as new", () => void this.captureInteractive(raw, template, { kind: "new" }));
        const key = this.index.keyOf(path);
        if (key && this.isDuplicate(key)) action("Merge duplicates", () => this.openMerge(key));
      }),
      15000,
    );
  }

  /** Captures the page a bookmark note points at again and overwrites the note in place. */
  async recapture(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    const url = file instanceof TFile ? this.noteUrl(file) : null;
    if (!(file instanceof TFile) || !url) {
      new Notice("This note has no bookmark URL to capture again.");
      return;
    }
    await this.captureInteractive(url, null, { kind: "replace", path: file.path });
  }

  /** Properties a note's URL is read from: the URL property setting, then each template's. */
  urlNames(): string[] {
    return urlPropertyNames(this.settings.urlProperty, this.templates);
  }

  /** The page a note points at, from the first of {@link urlNames} holding a web address. */
  private noteUrl(file: TFile): string | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return frontmatter ? this.urlIn(frontmatter) : null;
  }

  private urlIn(frontmatter: Record<string, unknown>): string | null {
    const url = this.urlNames().map((name) => frontmatter[name]).find((value) => typeof value === "string" && normalizeUrl(value));
    return typeof url === "string" ? url : null;
  }

  /**
   * Captures a note's page again and lets the user pick which properties, content
   * and files to pull into it. The modal opens straight away and fills in once the
   * note is rendered; the screenshots keep arriving while it's open.
   */
  enrich(file: TFile): void {
    const url = this.noteUrl(file);
    if (!url) {
      new Notice("This note has no URL property to fetch.");
      return;
    }
    let current: LoadedEnrich | null = null;
    /** The capture being waited on, until it renders. */
    let loading: EnrichSession | null = null;
    let ended = false;
    let requested: string | null = null;
    const load = async (name: string | null): Promise<LoadedEnrich> => {
      const problem = await this.checkServer();
      if (problem) throw new Error(problem);
      await this.syncShared().catch((err: unknown) => console.warn("bookmarks: couldn't fetch shared settings", err));
      return this.loadEnrich(file, url, name, (session) => {
        if (ended) session.close();
        else loading = session;
      });
    };
    const start = (name: string | null) => {
      requested = name;
      load(name).then(
        (next) => {
          loading = null;
          if (ended) return next.session.close();
          current?.session.close();
          current = next;
          next.session.onChange = () => modal.refresh();
          modal.show(next.options);
        },
        (err: unknown) => {
          loading = null;
          if (ended) return;
          const message = err instanceof Error ? err.message : String(err);
          if (!current) return modal.failed(`Couldn't fetch the page: ${message}`);
          // The current capture stays on screen.
          new Notice(`Couldn't fetch the page with ${name}: ${message}`);
          modal.switchFailed();
        },
      );
    };
    const modal = new EnrichModal(
      this.app,
      {
        onTemplate: start,
        onRetry: () => {
          modal.retrying();
          start(requested);
        },
        onSubmit: (selection) => {
          ended = true;
          const loaded = current!;
          void this.applyEnrich(file, loaded.session, loaded.options.choices, selection).finally(() => loaded.session.close());
        },
        onDone: () => {
          ended = true;
          current?.session.close();
          (loading as EnrichSession | null)?.close();
        },
      },
      { templates: this.updateTemplates(null), template: null },
    );
    modal.open();
    start(null);
  }

  /** Templates an update can start from: those not switched off for it, plus the note's own. */
  private updateTemplates(own: string | null): string[] {
    return this.templates.filter((t) => t.updateFromSource !== false || t.name === own).map((t) => t.name);
  }

  /** Captures the note's page with a template and works out what it offers; the session is closed if that fails. */
  private async loadEnrich(file: TFile, url: string, templateName: string | null, started: (session: EnrichSession) => void): Promise<LoadedEnrich> {
    const client = this.client();
    const session = new EnrichSession(client, await client.capture(url, "enrich", false, templateName, ENRICH_FILES), url, templateName);
    started(session);
    try {
      const job = await session.waitForNote();
      const note = JSON.parse(await client.assetText(job.id, "note")) as RenderedNote;
      const template = this.templates.find((t) => t.name === note.template) ?? DEFAULT_TEMPLATE;
      const current = { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) } as Record<string, unknown>;
      // Files the template uses count as on offer even before they're made.
      const choices = enrichChoices(note, current, parseYaml, CAPTURE_FILES, captureIdPropertyName(template));
      choices.images = session.available();
      const text = await this.app.vault.read(file);
      const variables = [{ name: TEMPLATE_CONTENT, value: choices.body }, ...(await this.pageVariables(note, job, url))].filter((v) => v.value.trim());
      const tiktok = hasTikTokPlayer(text);
      return {
        session,
        options: {
          noteName: file.basename,
          templates: this.updateTemplates(template.name),
          template: template.name,
          choices,
          defaults: defaultSelection(choices),
          body: text.slice(getFrontMatterInfo(text).contentStart),
          frontmatter: current,
          vaultProperties: this.vaultProperties(),
          variables,
          files: {
            available: () => session.available(),
            pending: () => session.pending(),
            onDemand: ON_DEMAND_FILES,
            ready: () => session.ready(),
            data: (kind) => session.file(kind),
            imageType: () => (session.screenshotExt() === "png" ? "image/png" : "image/jpeg"),
            request: (kind) => void session.request(kind).catch((err: unknown) => new Notice(`Couldn't capture ${kind}: ${String(err)}`)),
            drop: (kind) => void session.drop(kind),
          },
          offline: tiktok ? offlineFiles(choices.images) : [],
        },
      };
    } catch (err) {
      session.close();
      throw err;
    }
  }

  /** Every property name used in the vault's notes, sorted. */
  vaultProperties(): string[] {
    const names = new Set<string>();
    for (const note of this.app.vault.getMarkdownFiles()) {
      for (const name of Object.keys(this.app.metadataCache.getFileCache(note)?.frontmatter ?? {})) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /** Every variable the server rendered the note with; older servers send only the note, so fall back to the page's details. */
  private async pageVariables(note: RenderedNote, job: Job, url: string): Promise<{ name: string; value: string }[]> {
    if (note.variables) return Object.entries(note.variables).map(([name, value]) => ({ name, value }));
    const markdown = job.assets.includes("markdown") ? await this.client().assetText(job.id, "markdown").catch(() => "") : "";
    const meta = job.meta;
    return [
      { name: "{{content}}", value: markdown },
      { name: "{{title}}", value: meta?.title ?? "" },
      { name: "{{description}}", value: meta?.description ?? "" },
      { name: "{{author}}", value: meta?.author ?? "" },
      { name: "{{published}}", value: meta?.published ?? "" },
      { name: "{{site}}", value: meta?.site ?? "" },
      { name: "{{url}}", value: url },
    ];
  }

  private async applyEnrich(file: TFile, session: EnrichSession, choices: ReturnType<typeof enrichChoices>, selection: EnrichSelection): Promise<void> {
    try {
      if (!session.ready()) {
        const waiting = new Notice("Updating the note once the screenshots are captured…", 0);
        await session.whenReady();
        waiting.hide();
      }
      choices.images = session.available();
      const wanted = filesToSave(choices, selection);
      const files: Partial<Record<CaptureFile, ArrayBuffer | null>> = {};
      for (const kind of wanted) files[kind] = await session.file(kind);
      const saved = await saveCaptureFiles(this.vaultPort(), this.settings.assetsFolder, files, session.screenshotExt(), file.basename);
      const offline = selection.offline ? offlineFiles(choices.images) : [];
      let changed = false;
      if (selection.content.length || offline.length) {
        await this.app.vault.process(file, (text) => {
          const out = replaceTikTokPlayer(placeContent(text, selection.content, saved, getFrontMatterInfo(text).contentStart), offline, saved);
          changed = out !== text;
          return out;
        });
      }
      if (Object.keys(selection.properties).length > 0) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => applyProperties(frontmatter, choices, selection, saved));
      }
      new Notice(changed || Object.keys(selection.properties).length > 0 ? `Updated ${file.basename}.` : "Nothing picked; the note is unchanged.");
    } catch (err) {
      new Notice(`Couldn't update the note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- duplicates ----

  /** A group still worth offering: two or more notes not marked separate. */
  private isDuplicate(key: string): boolean {
    return countsAsDuplicate(this.index.paths(key), this.settings.separateNotes?.[key] ?? []);
  }

  /** Lists every duplicate group in the vault and resolves the picked one, then the ones after it. */
  private findDuplicates(): void {
    const entries: DuplicateEntry[] = this.index
      .groups()
      .filter(({ key }) => this.isDuplicate(key))
      .map(({ key, paths }) => {
        const separate = this.settings.separateNotes?.[key] ?? [];
        const first = this.app.vault.getAbstractFileByPath(paths[0]!);
        const url = (first instanceof TFile && this.noteUrl(first)) || key;
        const names = paths.map((p) => p.replace(/^.*\//, "").replace(/\.md$/, ""));
        return { key, url, names, active: paths.filter((p) => !separate.includes(p)).length };
      })
      .sort((a, b) => b.active - a.active || a.url.localeCompare(b.url));
    if (!entries.length) {
      new Notice("No duplicate bookmarks.");
      return;
    }
    new DuplicateListModal(this.app, entries, (entry) => {
      const after = entries.slice(entries.indexOf(entry) + 1).map((e) => e.key);
      this.openMerge(entry.key, after);
    }).open();
  }

  /** Opens the merge view for a group; with a queue, the next group still worth offering opens after it. */
  private openMerge(key: string, queue?: string[]): void {
    const notes = this.mergeNotes(key);
    if (notes.length < 2) return;
    const first = this.app.vault.getAbstractFileByPath(notes[0]!.path);
    const sources = this.linkSources();
    const next = () => {
      if (!queue) return;
      const i = queue.findIndex((k) => this.isDuplicate(k));
      if (i >= 0) this.openMerge(queue[i]!, queue.slice(i + 1));
    };
    new MergeModal(
      this.app,
      { url: (first instanceof TFile && this.noteUrl(first)) || key, notes, separate: this.settings.separateNotes?.[key] ?? [] },
      {
        skip: this.mergeSkip(),
        propertyNames: () => this.vaultProperties(),
        spelling: this.propertySpelling(),
        unusedCount: (selection) => this.unusedFor(notes, selection, sources).length,
        onApply: (selection) =>
          void this.applyMerge(key, selection).then(next, (err: unknown) => {
            console.error("bookmarks: merge failed", err);
            new Notice(`Couldn't merge: ${err instanceof Error ? err.message : String(err)}`, 0);
          }),
        onSkip: queue ? next : undefined,
      },
    ).open();
  }

  /** URL and capture id property names, which a merge never offers or changes. */
  private mergeSkip(): string[] {
    return [...this.urlNames(), ...this.templates.map(captureIdPropertyName)];
  }

  /** Target path -> notes linking to it, from the resolved link index. */
  private linkSources(): Map<string, string[]> {
    const sources = new Map<string, string[]>();
    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      for (const target of Object.keys(targets)) sources.set(target, [...(sources.get(target) ?? []), source]);
    }
    return sources;
  }

  /** A group's notes, as the merge works with them, in the order they're offered as the one to keep. */
  private mergeNotes(key: string): MergeNote[] {
    const sources = this.linkSources();
    const captureIds = this.templates.map(captureIdPropertyName);
    const notes: MergeNote[] = [];
    for (const path of this.index.paths(key)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const frontmatter = { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) } as Record<string, unknown>;
      const dated = ["created", "date", "captured"].map((name) => Date.parse(String(frontmatter[name] ?? ""))).find(Number.isFinite);
      notes.push({
        path,
        basename: file.basename,
        folder: file.parent && file.parent.path !== "/" ? file.parent.path : "",
        frontmatter,
        backlinks: (sources.get(path) ?? []).filter((source) => source !== path).length,
        hasCaptureId: captureIds.some((name) => typeof frontmatter[name] === "string" && frontmatter[name]),
        date: dated ?? null,
        ctime: file.stat.ctime,
      });
    }
    return rankNotes(notes);
  }

  /** The vault's most used spelling of each property name, by its lowercase form. */
  private propertySpelling(): (lower: string) => string | undefined {
    const counts = new Map<string, Map<string, number>>();
    for (const note of this.app.vault.getMarkdownFiles()) {
      for (const name of Object.keys(this.app.metadataCache.getFileCache(note)?.frontmatter ?? {})) {
        const byName = counts.get(name.toLowerCase()) ?? new Map<string, number>();
        byName.set(name, (byName.get(name) ?? 0) + 1);
        counts.set(name.toLowerCase(), byName);
      }
    }
    return (lower) => [...(counts.get(lower) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  /** Where a note's link points, resolved the way Obsidian resolves it. */
  private linkTarget(link: string, source: string): TFile | null {
    return this.app.metadataCache.getFirstLinkpathDest(parseLinktext(link).path, source);
  }

  /** Files only the notes this selection removes use, which the merge can trash. */
  private unusedFor(notes: readonly MergeNote[], selection: MergeSelection, sources = this.linkSources()): string[] {
    const removed = notes.filter((n) => ["merge", "delete"].includes(selection.state.get(n.path) ?? "")).map((n) => n.path);
    if (!selection.state.size || ![...selection.state.values()].includes("keep") || !removed.length) return [];
    const { resolvedLinks } = this.app.metadataCache;
    // What the kept note takes over: links in merged bodies, and in properties whose value comes along.
    const carried: string[] = [];
    for (const path of removed.filter((p) => selection.state.get(p) === "merge")) {
      const cache = this.app.metadataCache.getCache(path);
      for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
        const target = this.linkTarget(ref.link, path);
        if (target) carried.push(target.path);
      }
      for (const ref of cache?.frontmatterLinks ?? []) {
        const choice = selection.choices.find((c) => c.name.toLowerCase() === ref.key.replace(/\.\d+$/, "").toLowerCase());
        const kept = choice && (choice.kind !== "conflict" || keptFrom(choice, selection.picks[choice.name]).includes(path));
        const target = kept ? this.linkTarget(ref.link, path) : null;
        if (target) carried.push(target.path);
      }
    }
    return unusedFiles({
      removed,
      linksFrom: (path) => Object.keys(resolvedLinks[path] ?? {}),
      linkedBy: (target) => sources.get(target) ?? [],
      carried,
      isNote: (path) => path.endsWith(".md"),
    });
  }

  /**
   * Applies a merge: links to the removed notes are pointed at the kept note,
   * the kept note gets the chosen properties and the merged bodies, separate
   * marks are saved, and only then are the removed notes and their unused files
   * trashed. Stops at the first step that fails and says what's left undone.
   */
  private async applyMerge(key: string, selection: MergeSelection): Promise<void> {
    const notes = this.mergeNotes(key);
    if ([...selection.state.keys()].some((path) => !notes.some((n) => n.path === path))) {
      new Notice("The notes changed while the merge view was open. Nothing was merged; open it again.");
      return;
    }
    const kept = notes.find((n) => selection.state.get(n.path) === "keep");
    const merging = notes.filter((n) => selection.state.get(n.path) === "merge");
    // Values come from the notes as they are now, in case one changed while the view was open.
    const choices = kept ? mergeChoices([kept, ...merging], this.mergeSkip(), this.propertySpelling()) : [];
    const files = selection.removeFiles ? this.unusedFor(notes, { ...selection, choices }) : [];
    const draft = mergePlan({ notes, state: selection.state, choices, picks: selection.picks, bodies: {} });
    if (!draft.kept) {
      await this.saveSeparate(key, draft.separate);
      new Notice("Saved.");
      return;
    }
    const keptFile = this.app.vault.getAbstractFileByPath(draft.kept) as TFile;
    const removed = [...draft.merge, ...draft.delete];
    let step = "redirect links";
    let redirected = 0;
    let trashed = 0;
    try {
      redirected = await this.redirectLinks(removed, keptFile);

      step = `update “${keptFile.basename}”`;
      const bodies: Record<string, string> = {};
      for (const path of draft.merge) {
        const text = await this.app.vault.read(this.app.vault.getAbstractFileByPath(path) as TFile);
        bodies[path] = text.slice(getFrontMatterInfo(text).contentStart);
      }
      const plan = mergePlan({ notes, state: selection.state, choices, picks: selection.picks, bodies });
      await this.app.fileManager.processFrontMatter(keptFile, (frontmatter: Record<string, unknown>) => applyMergedProperties(frontmatter, plan));
      if (plan.bodies.length) await this.app.vault.process(keptFile, (text) => appendBodies(text, plan, getFrontMatterInfo(text).contentStart));

      step = "save the separate notes";
      await this.saveSeparate(key, plan.separate);

      for (const path of removed) {
        step = `trash “${path}”`;
        await this.app.fileManager.trashFile(this.app.vault.getAbstractFileByPath(path)!);
      }
      for (const path of files) {
        step = `trash “${path}”`;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) await this.app.fileManager.trashFile(file);
        trashed++;
      }
    } catch (err) {
      console.error("bookmarks: merge failed", err);
      new Notice(`Merging into “${keptFile.basename}” stopped: couldn't ${step}: ${err instanceof Error ? err.message : String(err)}. Nothing after that step was done.`, 0);
      return;
    }
    const parts = [
      draft.delete.length ? `${draft.delete.length} deleted` : "",
      `${redirected} link${redirected === 1 ? "" : "s"} redirected`,
      trashed ? `${trashed} file${trashed === 1 ? "" : "s"} removed` : "",
    ].filter(Boolean);
    const done = draft.merge.length ? `Merged ${draft.merge.length + 1} notes into “${keptFile.basename}”` : `Kept “${keptFile.basename}”`;
    new Notice(`${done}: ${parts.join(", ")}.`);
    this.openNote(keptFile.path);
  }

  /** Points every link and embed resolving to one of `removed` at `kept`, keeping headings, blocks and visible text. Returns how many. */
  private async redirectLinks(removed: readonly string[], kept: TFile): Promise<number> {
    const { metadataCache, fileManager, vault } = this.app;
    const removedSet = new Set(removed);
    const sources = Object.entries(metadataCache.resolvedLinks)
      .filter(([, targets]) => removed.some((path) => targets[path]))
      .map(([source]) => source);
    let count = 0;
    for (const source of sources) {
      const file = vault.getAbstractFileByPath(source);
      const cache = file instanceof TFile ? metadataCache.getFileCache(file) : null;
      if (!(file instanceof TFile) || !cache) continue;
      const generate = (subpath: string, alias: string) => fileManager.generateMarkdownLink(kept, source, subpath, alias);
      const spans: (Span & { original: string })[] = [];
      for (const [refs, embed] of [[cache.links ?? [], false], [cache.embeds ?? [], true]] as const) {
        for (const ref of refs) {
          const target = this.linkTarget(ref.link, source);
          if (!target || !removedSet.has(target.path)) continue;
          spans.push({
            start: ref.position.start.offset,
            end: ref.position.end.offset,
            original: ref.original,
            replacement: redirectedLink({ original: ref.original, link: ref.link, displayText: ref.displayText, embed }, target.basename, generate),
          });
        }
      }
      if (spans.length) {
        await vault.process(file, (text) => {
          // Skip any link the text no longer holds where the cache says (an edit since it was read).
          const current = spans.filter((span) => text.slice(span.start, span.end) === span.original);
          count += current.length;
          return spliceSpans(text, current);
        });
      }
      const frontmatterRefs = (cache.frontmatterLinks ?? []).filter((ref) => removedSet.has(this.linkTarget(ref.link, source)?.path ?? ""));
      if (frontmatterRefs.length) {
        await fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          for (const ref of frontmatterRefs) {
            const target = this.linkTarget(ref.link, source)!;
            const replacement = redirectedLink({ original: ref.original, link: ref.link, displayText: ref.displayText, embed: false }, target.basename, generate);
            if (redirectFrontmatter(frontmatter, ref.key, ref.original, replacement) || redirectFrontmatter(frontmatter, ref.key.replace(/\.\d+$/, ""), ref.original, replacement)) count++;
          }
        });
      }
    }
    return count;
  }

  /** Saves which notes of a group are separate on purpose, dropping marks for notes that no longer exist. */
  private async saveSeparate(key: string, paths: string[]): Promise<void> {
    const marks = { ...(this.settings.separateNotes ?? {}), [key]: paths };
    for (const [k, list] of Object.entries(marks)) {
      const existing = list.filter((p) => this.app.vault.getAbstractFileByPath(p));
      if (existing.length) marks[k] = existing;
      else delete marks[k];
    }
    this.settings.separateNotes = marks;
    await this.persist();
  }

  /** Keeps a separate mark on a note when it's renamed or moved. */
  private async renameSeparate(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    for (const list of Object.values(this.settings.separateNotes ?? {})) {
      const i = list.indexOf(oldPath);
      if (i >= 0) {
        list[i] = newPath;
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async captureInteractive(raw: string, template: string | null = null, mode: WriteMode = { kind: "dedup" }): Promise<void> {
    if (!normalizeUrl(raw)) {
      new Notice("That doesn't look like a web address.");
      return;
    }
    const existing = mode.kind === "dedup" ? this.index.findByUrl(raw) : null;
    if (existing) {
      this.alreadySavedNotice(existing, raw, raw, template);
      return;
    }

    const progress = new Notice("Capturing…", 0);
    try {
      const problem = await this.checkServer();
      if (problem) throw new Error(problem);
      await this.syncShared().catch((err: unknown) => console.warn("bookmarks: couldn't fetch shared settings", err));
      const job = await this.client().capture(raw, "plugin", true, template);
      if (job.status !== "done" && job.status !== "failed") {
        new Notice("Still capturing. The note will appear when it's done.");
        return;
      }
      const result = await this.deliver(job, mode);
      if (!result) return;
      if (result.kind === "duplicate") this.alreadySavedNotice(result.path, job.meta?.title || raw, raw, template);
      else this.openNote(result.path);
      if (job.status === "failed") {
        new Notice(`Capture failed: ${job.error ?? "unknown error"}. ${mode.kind === "replace" ? "Kept the note." : "Saved the link anyway."}`);
      } else if (mode.kind === "replace") new Notice("Captured again.");
    } catch (err) {
      new Notice(`Capture failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      progress.hide();
    }
  }

  /** Writes every finished job waiting on the server (poll fallback, design §3). */
  async drain(manual: boolean): Promise<void> {
    if (this.draining || !this.settings.serverUrl) {
      if (manual && !this.settings.serverUrl) new Notice("Set the server URL in Bookmarks settings first.");
      return;
    }
    this.draining = true;
    let written = 0;
    try {
      const problem = await this.checkServer();
      if (problem) {
        if (manual || !this.versionWarned) new Notice(problem);
        this.versionWarned = true;
        return;
      }
      await this.syncShared().catch((err: unknown) => console.warn("bookmarks: couldn't fetch shared settings", err));
      for (const job of await this.client().finishedJobs()) {
        const result = await this.deliver(job);
        if (result?.kind === "written") written++;
        // Drained duplicates never block: skipped, acked and logged (design §4).
        if (result?.kind === "duplicate") console.info(`bookmarks: skipped duplicate ${job.url} (already in ${result.path})`);
      }
      if (written > 0) new Notice(`Saved ${written} bookmark${written === 1 ? "" : "s"}.`);
      else if (manual) new Notice("No new captures.");
    } catch (err) {
      // Background polls stay quiet when the server is unreachable.
      if (manual) new Notice(`Couldn't fetch captures: ${err instanceof Error ? err.message : String(err)}`);
      else console.warn("bookmarks: drain failed", err);
    } finally {
      this.draining = false;
    }
  }
}

/** URL and capture id property names across templates, for noticing when the index must be rebuilt. */
function propertyNames(templates: ClipperTemplate[]): string[] {
  return templates.flatMap((t) => [urlPropertyName(t), captureIdPropertyName(t)]);
}
