import { Notice, Plugin, TFile, TFolder, getFrontMatterInfo, normalizePath, parseYaml } from "obsidian";
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
import { EnrichModal } from "./enrich-modal";
import { EnrichSession } from "./enrich-session";
import { BookmarksSettingTab, DEFAULT_SETTINGS, type BookmarksSettings } from "./settings";
import { DEFAULT_TEMPLATE, captureIdPropertyName, chooseTemplate, urlPropertyName } from "./template";
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

export default class BookmarksPlugin extends Plugin {
  override settings: BookmarksSettings = DEFAULT_SETTINGS;
  readonly index = new DedupIndex();
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
        const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
        if (!file || !frontmatter || !this.templates.map(urlPropertyName).some((name) => typeof frontmatter[name] === "string")) return false;
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
        if (!checking) void this.enrich(file);
        return true;
      },
    });
    this.addRibbonIcon("bookmark-plus", "Capture bookmark", () => void this.openCaptureModal());
    // The "Retry capture" link in a failed capture's note (writer.ts retryLink).
    this.registerObsidianProtocolHandler("bookmarks", (params) => {
      if (params.action === "retry" && params.path) void this.recapture(params.path);
    });

    this.app.workspace.onLayoutReady(() => {
      this.buildIndex();
      this.registerEvent(this.app.metadataCache.on("changed", (file) => this.indexFile(file)));
      this.registerEvent(this.app.vault.on("delete", (file) => this.index.remove(file.path)));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.index.rename(oldPath, file.path)));
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
    this.buildIndex();
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
    if (changed) this.buildIndex();
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

  private indexFile(file: TFile): void {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) return this.index.remove(file.path);
    // Templates can name the URL and capture id properties differently; take the first one present.
    const first = (names: string[]) => names.map((name) => frontmatter[name]).find((value) => typeof value === "string" && value);
    this.index.set(file.path, first(this.templates.map(urlPropertyName)), first(this.templates.map(captureIdPropertyName)));
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
      }),
      15000,
    );
  }

  /** Captures the page a bookmark note points at again and overwrites the note in place. */
  async recapture(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    const frontmatter = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const url = frontmatter && this.templates.map(urlPropertyName).map((name) => frontmatter[name]).find((v) => typeof v === "string" && v);
    if (!(file instanceof TFile) || typeof url !== "string") {
      new Notice("This note has no bookmark URL to capture again.");
      return;
    }
    await this.captureInteractive(url, null, { kind: "replace", path: file.path });
  }

  /** The page a note points at: a template's URL property, else a `url` or `source` property. */
  private noteUrl(file: TFile): string | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) return null;
    const names = [...this.templates.map(urlPropertyName), "url", "source", "URL"];
    const url = names.map((name) => frontmatter[name]).find((value) => typeof value === "string" && normalizeUrl(value));
    return typeof url === "string" ? url : null;
  }

  /**
   * Captures a note's page again and lets the user pick which properties, content
   * and files to pull into it. The modal opens once the note is rendered; the
   * screenshots keep arriving while it's open.
   */
  async enrich(file: TFile, templateName: string | null = null): Promise<void> {
    const url = this.noteUrl(file);
    if (!url) {
      new Notice("This note has no URL property to fetch.");
      return;
    }
    const progress = new Notice("Fetching page…", 0);
    let session: EnrichSession | null = null;
    const client = this.client();
    try {
      const problem = await this.checkServer();
      if (problem) throw new Error(problem);
      await this.syncShared().catch((err: unknown) => console.warn("bookmarks: couldn't fetch shared settings", err));
      session = new EnrichSession(client, await client.capture(url, "enrich", false, templateName, ENRICH_FILES), url, templateName);
      const job = await session.waitForNote();
      const note = JSON.parse(await client.assetText(job.id, "note")) as RenderedNote;
      const template = this.templates.find((t) => t.name === note.template) ?? DEFAULT_TEMPLATE;
      const current = { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) } as Record<string, unknown>;
      // Files the template uses count as on offer even before they're made.
      const choices = enrichChoices(note, current, parseYaml, CAPTURE_FILES, captureIdPropertyName(template));
      choices.images = session.available();
      const text = await this.app.vault.read(file);
      const markdown = job.assets.includes("markdown") ? await client.assetText(job.id, "markdown").catch(() => "") : "";
      const meta = job.meta;
      const variables = [
        { name: TEMPLATE_CONTENT, value: choices.body },
        { name: "{{content}}", value: markdown },
        { name: "{{title}}", value: meta?.title ?? "" },
        { name: "{{description}}", value: meta?.description ?? "" },
        { name: "{{author}}", value: meta?.author ?? "" },
        { name: "{{published}}", value: meta?.published ?? "" },
        { name: "{{site}}", value: meta?.site ?? "" },
        { name: "{{url}}", value: url },
      ].filter((v) => v.value.trim());
      progress.hide();
      const live = session;
      const tiktok = hasTikTokPlayer(text);
      const modal = new EnrichModal(this.app, {
        noteName: file.basename,
        templates: this.templates.filter((t) => t.updateFromSource !== false || t.name === template.name).map((t) => t.name),
        template: template.name,
        choices,
        defaults: defaultSelection(choices),
        body: text.slice(getFrontMatterInfo(text).contentStart),
        frontmatter: current,
        variables,
        files: {
          available: () => live.available(),
          pending: () => live.pending(),
          onDemand: ON_DEMAND_FILES,
          ready: () => live.ready(),
          data: (kind) => live.file(kind),
          imageType: () => (live.screenshotExt() === "png" ? "image/png" : "image/jpeg"),
          request: (kind) => void live.request(kind).catch((err: unknown) => new Notice(`Couldn't capture ${kind}: ${String(err)}`)),
          drop: (kind) => void live.drop(kind),
        },
        offline: tiktok ? offlineFiles(choices.images) : [],
        onTemplate: (name) => {
          live.close();
          void this.enrich(file, name);
        },
        onSubmit: (selection) => void this.applyEnrich(file, live, choices, selection).finally(() => live.close()),
        onDone: () => live.close(),
      });
      live.onChange = () => modal.refresh();
      modal.open();
    } catch (err) {
      progress.hide();
      session?.close();
      new Notice(`Couldn't fetch the page: ${err instanceof Error ? err.message : String(err)}`);
    }
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
