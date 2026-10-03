import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { API_VERSION, type ClipperTemplate, type Job, type RenderedNote } from "./api";
import { CaptureModal } from "./capture-modal";
import { ServerClient } from "./client";
import { DedupIndex } from "./dedup";
import { BookmarksSettingTab, DEFAULT_SETTINGS, type BookmarksSettings } from "./settings";
import { DEFAULT_TEMPLATE, captureIdPropertyName, chooseTemplate, urlPropertyName } from "./template";
import { findUrl, normalizeUrl } from "./url";
import { writeBookmark, type VaultPort, type WriteMode, type WriteResult } from "./writer";

// Server jobs are pruned a few days after delivery, so a few hundred covers any redelivery.
const WRITTEN_CAPTURES_KEPT = 500;

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
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<BookmarksSettings>) };
    if (this.settings.templatesCache?.length) this.templates = this.settings.templatesCache;
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
    const { noScreenshotSites: legacySites, notesFolder: legacyFolder } = this.settings;
    const movedFolder = legacyFolder && legacyFolder !== DEFAULT_TEMPLATE.path ? legacyFolder : null;
    if (legacySites?.length || movedFolder) {
      shared = await client.saveSettings({
        ...shared,
        noScreenshotSites: [...new Set([...shared.noScreenshotSites, ...(legacySites ?? [])])],
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
    await this.saveData(this.settings);
    if (changed) this.buildIndex();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
      // The server applies the shared screenshot settings, so a missing screenshot asset means "none".
      const screenshot = job.assets.includes("screenshot") ? await client.assetBinary(job.id, "screenshot") : null;
      // A failed job's metadata describes the block page, so schema triggers only see successful captures.
      const template =
        this.templates.find((t) => t.name === job.template) ??
        chooseTemplate(this.templates, job.url, job.status === "done" ? (job.meta ?? undefined) : undefined);
      // Rendered on the server with Web Clipper's engine; older servers and failed captures use the plugin's renderer.
      const note = job.assets.includes("note") ? (JSON.parse(await client.assetText(job.id, "note")) as RenderedNote) : null;
      const result = await writeBookmark(
        { job, markdown, screenshot, note },
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
    await this.saveData(this.settings);
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
