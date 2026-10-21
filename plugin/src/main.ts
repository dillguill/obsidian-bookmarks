import { Notice, Plugin, TFile, TFolder, getFrontMatterInfo, normalizePath } from "obsidian";
import { API_VERSION, CAPTURE_FILES, type CaptureFile, type ClipperTemplate, type Job, type PropertyType, type RenderedNote } from "./api";
import { CaptureController } from "./capture-controller";
import { ServerClient } from "./client";
import { DedupIndex } from "./dedup";
import { errorText } from "./errors";
import { vaultTypes, type FieldType } from "./fields";
import { MediaController } from "./media-controller";
import { MergeController } from "./merge-controller";
import { BookmarksSettingTab, DEFAULT_SETTINGS, type BookmarksSettings } from "./settings";
import { DEFAULT_TEMPLATE, captureIdPropertyName, chooseTemplate, urlPropertyName, urlPropertyNames } from "./template";
import { normalizeUrl } from "./url";
import { UpdateController } from "./update-controller";
import { insertAll, type PendingInsert } from "./placeholders";
import { saveCaptureFiles, writeBookmark, type VaultPort, type WriteMode, type WriteResult } from "./writer";

// Server jobs are pruned a few days after delivery, so a few hundred covers any redelivery.
const WRITTEN_CAPTURES_KEPT = 500;
/** How often, and for how long, a capture added from the modal is followed for its screenshots. */
const WATCH_POLL_MS = 2000;
const WATCH_MS = 10 * 60_000;
/** Screenshots still waiting after this long won't come: the server has pruned their capture. */
const WAITING_KEPT_MS = 14 * 86_400_000;
/**
 * Vault-scoped localStorage key for the token's secret name. Secrets live in each
 * device's own SecretStorage, so the name that points at one is per-device too and
 * stays out of data.json, which sync services share between devices.
 */
const TOKEN_SECRET_KEY = "obsidian-bookmarker-token-secret";

export default class BookmarksPlugin extends Plugin {
  override settings: BookmarksSettings = DEFAULT_SETTINGS;
  index = new DedupIndex();
  /** Templates from the server's shared settings; cached in plugin data so the index works offline. */
  templates: ClipperTemplate[] = [DEFAULT_TEMPLATE];
  /** Job ids being written right now, so an interactive capture and a drain never both write one. */
  private readonly inFlight = new Set<string>();
  private draining = false;
  private pollTimer: number | null = null;
  private versionWarned = false;
  private unloaded = false;
  readonly capture = new CaptureController(this);
  readonly update = new UpdateController(this);
  readonly merge = new MergeController(this);
  readonly media = new MediaController(this);

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new BookmarksSettingTab(this.app, this));

    this.addCommand({ id: "capture-url", name: "Capture URL", callback: () => void this.capture.open() });
    this.addCommand({ id: "sync-captures", name: "Fetch finished captures now", callback: () => void this.drain(true) });
    this.addCommand({
      id: "enrich",
      name: "Update note from source",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md" || !this.noteUrl(file)) return false;
        if (!checking) void this.update.open(file);
        return true;
      },
    });
    this.addCommand({
      id: "download-media",
      name: "Download media for current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension !== "md") return false;
        if (!checking) void this.media.download(file);
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
        if (!checking) this.merge.open(key);
        return true;
      },
    });
    this.addCommand({ id: "find-duplicates", name: "Find duplicate bookmarks", callback: () => this.merge.findDuplicates() });
    this.addRibbonIcon("bookmark-plus", "Capture bookmark", () => void this.capture.open());
    // The "Retry capture" link in a failed capture's note (writer.ts retryLink): Update from source, replacing the whole note.
    this.registerObsidianProtocolHandler("bookmarks", (params) => {
      if (params.action !== "retry" || !params.path) return;
      const file = this.app.vault.getAbstractFileByPath(normalizePath(params.path));
      if (file instanceof TFile) void this.update.open(file, { replaceAll: true });
      else new Notice("That note isn't in the vault any more.");
    });

    this.app.workspace.onLayoutReady(() => {
      this.buildIndex();
      this.registerEvent(this.app.metadataCache.on("changed", (file) => this.indexFile(file)));
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          this.index.remove(file.path);
          void this.updateWaiting((p) => (p.notePath === file.path ? null : p));
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          this.index.rename(oldPath, file.path);
          void this.merge.renameSeparate(oldPath, file.path);
          void this.updateWaiting((p) => (p.notePath === oldPath ? { ...p, notePath: file.path } : p));
        }),
      );
      void this.drain(false);
      this.schedulePoll();
    });
  }

  override onunload(): void {
    this.unloaded = true;
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
    const saved = (await this.loadData()) as Partial<BookmarksSettings> | null;
    const data = saved ?? {};
    const local: unknown = this.app.loadLocalStorage(TOKEN_SECRET_KEY);
    this.settings = { ...DEFAULT_SETTINGS, ...data, tokenSecretName: typeof local === "string" ? local : "" };
    // Files went to the plugin's assets folder before they followed Obsidian's
    // attachment setting; existing installs keep that folder so nothing moves.
    if (saved && saved.attachmentFolder === undefined) {
      this.settings.attachmentFolder = saved.assetsFolder ?? "Bookmarks/assets";
      delete this.settings.assetsFolder;
      await this.persist();
    }
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
  async persist(): Promise<void> {
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
  async syncShared(): Promise<void> {
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
    // The server formats phone captures' values; the vault's property types win
    // there, and types only the server knows (from its templates) stay.
    const types = await this.propertyTypes();
    const merged = [
      ...shared.propertyTypes.filter((entry) => !(entry.name in types)),
      ...Object.entries(types).map(([name, type]) => ({ name, type: serverType(type) })),
    ];
    const key = (list: { name: string; type: string }[]) => JSON.stringify([...list].sort((x, y) => x.name.localeCompare(y.name)));
    if (Object.keys(types).length && key(merged) !== key(shared.propertyTypes)) await client.saveSettings({ ...shared, propertyTypes: merged });
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

  /** Before talking to the server: throws when it's incompatible, then refreshes the shared settings (a failure there only warns). */
  async ready(): Promise<void> {
    const problem = await this.checkServer();
    if (problem) throw new Error(problem);
    await this.syncShared().catch((err: unknown) => console.warn("bookmarks: couldn't fetch shared settings", err));
  }

  /** The vault's property types, from Obsidian's types.json; empty when it can't be read. */
  async propertyTypes(): Promise<Record<string, FieldType>> {
    const path = normalizePath(`${this.app.vault.configDir}/types.json`);
    return vaultTypes(await this.app.vault.adapter.read(path).catch(() => null));
  }

  /** A note's frontmatter as the metadata cache has it, copied so callers can change it; empty when it has none. */
  frontmatterOf(file: TFile): Record<string, unknown> {
    return { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) } as Record<string, unknown>;
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

  vaultPort(): VaultPort {
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
      attachmentPath: (name, notePath) => this.app.fileManager.getAvailablePathForAttachment(name, normalizePath(notePath)),
      setFrontmatter: async (path, values) => {
        const file = vault.getAbstractFileByPath(normalizePath(path));
        if (!(file instanceof TFile)) throw new Error(`${path} no longer exists`);
        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => Object.assign(frontmatter, values));
      },
    };
  }

  /** Fetches a finished job's assets and writes it; acks the server once the vault holds it. */
  async deliver(job: Job, mode: WriteMode = { kind: "dedup" }): Promise<WriteResult | null> {
    if (this.inFlight.has(job.id)) return null;
    this.inFlight.add(job.id);
    try {
      // A preview's note was written from the capture modal; only its screenshots are left.
      if (job.mode === "preview") return await this.insertWaiting(job);
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
          attachmentFolder: this.settings.attachmentFolder,
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

  /**
   * Puts a written note's screenshots in, now that its preview job is done:
   * each file is saved as an attachment and linked where its token was. The
   * job's waiting list is dropped first, so a second delivery adds nothing.
   */
  private async insertWaiting(job: Job): Promise<WriteResult | null> {
    const client = this.client();
    const pending = this.settings.pendingInserts.filter((p) => p.captureId === job.id);
    const path = this.settings.writtenCaptures?.[job.id] ?? pending[0]?.notePath ?? null;
    if (pending.length) {
      this.settings.pendingInserts = this.settings.pendingInserts.filter((p) => p.captureId !== job.id);
      await this.persist();
    }
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    const made = pending.filter((p) => job.assets.includes(p.kind));
    if (file instanceof TFile && made.length) {
      const files: Partial<Record<CaptureFile, ArrayBuffer>> = {};
      for (const kind of new Set(made.map((p) => p.kind))) files[kind] = await client.assetBinary(job.id, kind);
      const saved = await saveCaptureFiles(this.vaultPort(), this.settings.attachmentFolder, files, job.screenshotExt, file.path);
      const savedFile = (kind: CaptureFile) => {
        const target = saved[kind] ? this.app.vault.getAbstractFileByPath(saved[kind]) : null;
        return target instanceof TFile ? target : null;
      };
      const body = made.flatMap((p) => {
        const target = savedFile(p.kind);
        return p.where.in === "body" && target ? [{ anchor: p.where, link: this.app.fileManager.generateMarkdownLink(target, file.path), path: target.path }] : [];
      });
      if (body.length) await this.app.vault.process(file, (text) => insertAll(text, body, getFrontMatterInfo(text).contentStart));
      const properties = made.filter((p) => p.where.in === "property" && savedFile(p.kind));
      if (properties.length) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          for (const p of properties) {
            if (p.where.in !== "property") continue;
            const link = this.app.metadataCache.fileToLinktext(savedFile(p.kind)!, file.path, false);
            frontmatter[p.where.name] = p.where.expression.split(`{{${p.kind}}}`).join(link);
          }
        });
      }
    }
    await client.delivered(job.id);
    return path ? { kind: "already-written", path } : null;
  }

  /**
   * Follows one capture until it's done and delivers it straight away, so a
   * note added from the capture modal gets its screenshots without waiting for
   * the next poll. Drain still picks it up if Obsidian closes first.
   */
  watch(id: string): void {
    const started = Date.now();
    const tick = async () => {
      if (this.unloaded) return;
      const job = await this.client().job(id).catch(() => null);
      if (job && (job.status === "done" || job.status === "failed")) {
        await this.deliver(job).catch((err: unknown) => console.warn("bookmarks: couldn't add the screenshots", err));
        return;
      }
      if (!job || job.status === "delivered" || Date.now() - started > WATCH_MS) return;
      window.setTimeout(() => void tick(), WATCH_POLL_MS);
    };
    window.setTimeout(() => void tick(), WATCH_POLL_MS);
  }

  /**
   * Puts finished follow-up downloads (media the server fetched after a phone
   * capture) into their captures' notes. One whose note isn't in the vault yet
   * waits for a later drain; one whose note is gone is collected and dropped.
   */
  private async collectFollowUps(): Promise<void> {
    for (const job of await this.client().mediaJobs()) {
      const capture = job.media?.forCapture;
      if (!capture || this.inFlight.has(job.id)) continue;
      const path = this.index.findByCaptureId(capture) ?? this.settings.writtenCaptures?.[capture] ?? null;
      if (!path) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      this.inFlight.add(job.id);
      try {
        if (file instanceof TFile) await this.media.applyFollowUp(file, job);
        else await this.client().delivered(job.id);
      } catch (err) {
        console.warn("bookmarks: couldn't put the downloaded media in the note", err);
      } finally {
        this.inFlight.delete(job.id);
      }
    }
  }

  /** Changes or drops (null) waiting screenshots; ones older than the server keeps captures are dropped too. */
  private async updateWaiting(change: (p: PendingInsert) => PendingInsert | null): Promise<void> {
    const before = this.settings.pendingInserts;
    const cutoff = Date.now() - WAITING_KEPT_MS;
    const after = before.map(change).filter((p): p is PendingInsert => p !== null && ulidTime(p.captureId) > cutoff);
    if (after.length === before.length && after.every((p, i) => p === before[i])) return;
    this.settings.pendingInserts = after;
    await this.persist();
  }

  /** Keeps the last WRITTEN_CAPTURES_KEPT capture ids this device wrote. */
  async rememberCapture(id: string, path: string): Promise<void> {
    const entries = Object.entries(this.settings.writtenCaptures ?? {}).filter(([key]) => key !== id);
    entries.push([id, path]);
    this.settings.writtenCaptures = Object.fromEntries(entries.slice(-WRITTEN_CAPTURES_KEPT));
    await this.persist();
  }

  // ---- entry points ----


  openNote(path: string): void {
    void this.app.workspace.openLinkText(path, "", false);
  }

  /** Properties a note's URL is read from: the URL property setting, then each template's. */
  urlNames(): string[] {
    return urlPropertyNames(this.settings.urlProperty, this.templates);
  }

  /** The page a note points at, from the first of {@link urlNames} holding a web address. */
  noteUrl(file: TFile): string | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return frontmatter ? this.urlIn(frontmatter) : null;
  }

  private urlIn(frontmatter: Record<string, unknown>): string | null {
    const url = this.urlNames().map((name) => frontmatter[name]).find((value) => typeof value === "string" && normalizeUrl(value));
    return typeof url === "string" ? url : null;
  }

  /** Every property name used in the vault's notes, sorted. */
  vaultProperties(): string[] {
    const names = new Set<string>();
    for (const note of this.app.vault.getMarkdownFiles()) {
      for (const name of Object.keys(this.frontmatterOf(note))) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
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
      await this.updateWaiting((p) => p);
      for (const job of await this.client().finishedJobs()) {
        const result = await this.deliver(job);
        if (result?.kind === "written") written++;
        // Drained duplicates never block: skipped, acked and logged (design §4).
        if (result?.kind === "duplicate") console.info(`bookmarks: skipped duplicate ${job.url} (already in ${result.path})`);
      }
      await this.collectFollowUps();
      if (written > 0) new Notice(`Saved ${written} bookmark${written === 1 ? "" : "s"}.`);
      else if (manual) new Notice("No new captures.");
    } catch (err) {
      // Background polls stay quiet when the server is unreachable.
      if (manual) new Notice(`Couldn't fetch captures: ${errorText(err)}`);
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

/** The server's property types: Obsidian's tags and aliases are lists to it. */
function serverType(type: FieldType): PropertyType {
  return type === "tags" || type === "aliases" ? "multitext" : type;
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** When a capture was made, from its ULID's first ten characters; 0 when it isn't one. */
function ulidTime(id: string): number {
  let ms = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) {
    const digit = ULID_ALPHABET.indexOf(ch);
    if (digit < 0) return 0;
    ms = ms * 32 + digit;
  }
  return ms;
}
