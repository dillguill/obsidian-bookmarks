import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { API_VERSION, type Job } from "./api";
import { CaptureModal } from "./capture-modal";
import { ServerClient } from "./client";
import { DedupIndex } from "./dedup";
import { BookmarksSettingTab, DEFAULT_SETTINGS, type BookmarksSettings } from "./settings";
import { DEFAULT_TEMPLATE, captureIdPropertyName, urlPropertyName } from "./template";
import { findUrl, normalizeUrl } from "./url";
import { writeBookmark, type VaultPort, type WriteResult } from "./writer";

export default class BookmarksPlugin extends Plugin {
  override settings: BookmarksSettings = DEFAULT_SETTINGS;
  readonly index = new DedupIndex();
  private readonly template = DEFAULT_TEMPLATE;
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
    this.addRibbonIcon("bookmark-plus", "Capture bookmark", () => void this.openCaptureModal());

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
  }

  /**
   * Older versions kept "Sites without screenshots" in this device's plugin
   * data. Moves that list into the server's shared settings once.
   */
  private async migrateLocalSites(): Promise<void> {
    const legacy = this.settings.noScreenshotSites;
    if (!legacy?.length) return;
    const client = this.client();
    const shared = await client.getSettings();
    await client.saveSettings({ ...shared, noScreenshotSites: [...new Set([...shared.noScreenshotSites, ...legacy])] });
    delete this.settings.noScreenshotSites;
    await this.saveData(this.settings);
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
    this.index.set(file.path, frontmatter[urlPropertyName(this.template)], frontmatter[captureIdPropertyName(this.template)]);
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
    };
  }

  /** Fetches a finished job's assets and writes it; acks the server once the vault holds it. */
  private async deliver(job: Job): Promise<WriteResult | null> {
    if (this.inFlight.has(job.id)) return null;
    this.inFlight.add(job.id);
    try {
      const client = this.client();
      const markdown = job.assets.includes("markdown") ? await client.assetText(job.id, "markdown") : "";
      // The server applies the shared screenshot settings, so a missing screenshot asset means "none".
      const screenshot = job.assets.includes("screenshot") ? await client.assetBinary(job.id, "screenshot") : null;
      const result = await writeBookmark(
        { job, markdown, screenshot },
        {
          vault: this.vaultPort(),
          index: this.index,
          template: this.template,
          notesFolder: this.settings.notesFolder,
          assetsFolder: this.settings.assetsFolder,
        },
      );
      await client.delivered(job.id);
      return result;
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  // ---- entry points ----

  private async openCaptureModal(): Promise<void> {
    let initial = "";
    try {
      initial = findUrl(await navigator.clipboard.readText()) ?? "";
    } catch {
      // clipboard unavailable or denied
    }
    new CaptureModal(this.app, initial, (url) => void this.captureInteractive(url)).open();
  }

  private openNote(path: string): void {
    void this.app.workspace.openLinkText(path, "", false);
  }

  private alreadySavedNotice(path: string, label: string): void {
    new Notice(
      createFragment((frag) => {
        frag.appendText(`Already saved: ${label} `);
        const link = frag.createEl("a", { text: "Open existing", href: "#" });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          this.openNote(path);
        });
      }),
      8000,
    );
  }

  async captureInteractive(raw: string): Promise<void> {
    if (!normalizeUrl(raw)) {
      new Notice("That doesn't look like a web address.");
      return;
    }
    const existing = this.index.findByUrl(raw);
    if (existing) {
      this.alreadySavedNotice(existing, raw);
      return;
    }

    const progress = new Notice("Capturing…", 0);
    try {
      const problem = await this.checkServer();
      if (problem) throw new Error(problem);
      const job = await this.client().capture(raw, "plugin", true);
      if (job.status !== "done" && job.status !== "failed") {
        new Notice("Still capturing. The note will appear when it's done.");
        return;
      }
      const result = await this.deliver(job);
      if (!result) return;
      if (result.kind === "duplicate") this.alreadySavedNotice(result.path, job.meta?.title || raw);
      else this.openNote(result.path);
      if (job.status === "failed") new Notice(`Capture failed: ${job.error ?? "unknown error"}. Saved the link anyway.`);
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
      await this.migrateLocalSites().catch((err: unknown) => console.warn("bookmarks: settings migration failed", err));
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
