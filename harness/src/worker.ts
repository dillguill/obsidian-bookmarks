import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetExt, CAPTURE_FILES, type AssetKind, type CaptureFile, type Job, type MediaAsset, type MediaJobInfo, type MediaWant, type PageMeta, type RenderedNote } from "./api.js";
import { BlockedError, type CaptureEngine, type HeldPage } from "./capture.js";
import type { JobStore } from "./db.js";
import { startEgressProxy, type EgressProxy } from "./egress-proxy.js";
import { runYtDlp, VIDEO_MAX_BYTES, ytdlpVersion } from "./media.js";
import { MediaQueue } from "./media-queue.js";
import { PagePool } from "./pool.js";
import { renderRequest } from "./render.js";
import { tiktokPost } from "./tiktok.js";

export function assetPath(dataDir: string, id: string, kind: AssetKind, screenshotExt: Job["screenshotExt"]): string {
  const file = kind === "markdown" ? "content.md" : kind === "note" ? "note.json" : `${kind}.${assetExt(kind, screenshotExt) ?? "png"}`;
  return join(dataDir, "jobs", id, file);
}

/** How long a preview's page stays open without being asked for anything. */
export const HOLD_MS = 120_000;
/** Most preview pages held open at once; each is a browser tab's worth of memory. */
const MAX_HELD = 3;

/** A preview's page is no longer open (released, idle too long, or the server restarted). */
export class PageGone extends Error {
  constructor() {
    super("page released");
  }
}

/** The job isn't a preview, so it has no page to render or take files from. */
export class NotPreview extends Error {
  constructor() {
    super("not a preview");
  }
}

/**
 * Runs pending jobs through the capture engine, `concurrency` at a time.
 * Emits "settled" with the job id when a job reaches done or failed.
 * A preview job's page is handed to a pool once its note is out, freeing the
 * slot; the plugin then renders it again, takes its files or releases it.
 */
export class Worker extends EventEmitter {
  private active = 0;
  private stopped = false;
  private readonly pool: PagePool<HeldPage>;
  /** Asset kinds written so far for each job, so later writes add to the list. */
  private readonly written = new Map<string, AssetKind[]>();
  private readonly mediaQueue: MediaQueue;
  private mediaRunning = false;
  private mediaTimer: NodeJS.Timeout | null = null;
  private proxy: Promise<EgressProxy> | null = null;
  /** yt-dlp's version, once checked; null when it isn't installed. */
  readonly ytdlp: Promise<string | null>;

  constructor(
    private readonly store: JobStore,
    private readonly engine: CaptureEngine,
    private readonly dataDir: string,
    private readonly concurrency: number,
    private readonly media: { ytdlpPath: string | null; allowPrivateNetworks: boolean; siteGapMs?: number } = { ytdlpPath: null, allowPrivateNetworks: false },
  ) {
    super();
    this.mediaQueue = media.siteGapMs === undefined ? new MediaQueue() : new MediaQueue(Math.random, media.siteGapMs, 0);
    this.pool = new PagePool({ ttlMs: HOLD_MS, max: MAX_HELD, onExpire: (id) => void this.drop(id) });
    this.ytdlp = media.ytdlpPath ? ytdlpVersion(media.ytdlpPath) : Promise.resolve(null);
  }

  /** Call after enqueueing; starts as many jobs as there are free slots. */
  kick(): void {
    while (!this.stopped && this.active < this.concurrency) {
      const job = this.store.claimNext();
      if (!job) return;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        const current = this.store.get(job.id);
        // A held preview settles later, when its files are taken or it's released.
        if (!current?.heldUntil) this.emit("settled", job.id);
        this.kick();
      });
    }
  }

  /** Writes one of a job's assets and lists it, unless the job was cancelled meanwhile. */
  private async save(id: string, kind: AssetKind, data: string | Buffer, ext: Job["screenshotExt"], meta: PageMeta | null = null): Promise<void> {
    const job = this.store.get(id);
    if (job?.status !== "running") return;
    await writeFile(assetPath(this.dataDir, id, kind, ext), data);
    const assets = this.written.get(id) ?? [...job.assets];
    if (!assets.includes(kind)) assets.push(kind);
    this.written.set(id, assets);
    this.store.progress(id, meta, assets, ext);
  }

  private async run(job: Job): Promise<void> {
    try {
      const settings = this.store.getSettings();
      await mkdir(join(this.dataDir, "jobs", job.id), { recursive: true });
      const render = renderRequest(settings, job.template, job.id, job.files);
      if (job.mode === "preview") return await this.preview(job, render);
      // Each piece is written and listed as soon as it's made, so the plugin can
      // show the note while the screenshots are still being taken.
      let ext: Job["screenshotExt"] = null;
      let writes = Promise.resolve();
      const queue = (kind: AssetKind, data: string | Buffer, meta: PageMeta | null = null) => {
        writes = writes.then(() => this.save(job.id, kind, data, ext, meta)).catch((err: unknown) => {
          if (this.store.get(job.id)?.status === "running") throw err;
        });
      };
      const result = await this.engine.capture(job.url, render, {
        page: (meta, markdown, note) => {
          queue("markdown", markdown, meta);
          if (note) queue("note", JSON.stringify(note));
        },
        file: (kind, data, fileExt) => {
          ext = fileExt;
          queue(kind, data);
        },
      });
      ext = result.screenshotExt;
      for (const kind of CAPTURE_FILES) {
        const data = result.files[kind];
        if (data) queue(kind, data);
      }
      queue("markdown", result.markdown);
      if (result.note) queue("note", JSON.stringify(result.note));
      await writes;
      this.store.finish(job.id, result.meta, this.written.get(job.id) ?? [], result.screenshotExt);
      this.followUp(job, result.meta.finalUrl, result.note);
    } catch (err) {
      const message = String((err as Error)?.message ?? err).split("\n")[0] ?? "capture failed";
      this.store.fail(job.id, message, err instanceof BlockedError ? err.meta : null);
    } finally {
      if (!this.store.get(job.id)?.heldUntil) this.written.delete(job.id);
    }
    // Cancelled while running: the result isn't wanted.
    if (this.store.get(job.id)?.error === "cancelled") await rm(join(this.dataDir, "jobs", job.id), { recursive: true, force: true });
  }

  /** Reads the page, publishes its note, and holds the page for the plugin. */
  private async preview(job: Job, render: ReturnType<typeof renderRequest>): Promise<void> {
    const held = await this.engine.preview(job.url, render);
    if (this.store.get(job.id)?.status !== "running") {
      // Cancelled while the page loaded.
      await held.close();
      return;
    }
    await this.save(job.id, "markdown", held.markdown, null, held.meta);
    if (held.note) await this.save(job.id, "note", JSON.stringify(held.note), null);
    if (!this.pool.hold(job.id, held)) throw new Error("the server is busy with other pages. Try again in a moment.");
    this.store.hold(job.id, this.pool.until(job.id));
  }

  /** The held page for a preview job, its idle time restarted. */
  private held(id: string): HeldPage {
    const job = this.store.get(id);
    if (job?.mode !== "preview") throw new NotPreview();
    const page = this.pool.get(id);
    if (!page || job.status !== "running") throw new PageGone();
    this.store.hold(id, this.pool.until(id));
    return page;
  }

  /** Renders a held preview with another template; the job's note asset is replaced. */
  async render(id: string, templateName: string): Promise<RenderedNote | null> {
    const note = await this.held(id).render(templateName);
    if (note) await this.save(id, "note", JSON.stringify(note), this.store.get(id)?.screenshotExt ?? null);
    return note;
  }

  /**
   * Starts taking files on a held preview's page, listing each as it's made.
   * With `finish`, the job is done afterwards and its page released, so drain
   * delivers it; otherwise the page stays held for more.
   */
  files(id: string, kinds: readonly CaptureFile[], finish: boolean): void {
    const page = this.held(id);
    this.pool.setBusy(id, true);
    let ext: Job["screenshotExt"] = this.store.get(id)?.screenshotExt ?? null;
    let writes = Promise.resolve();
    void page
      .files(kinds, (kind, data, fileExt) => {
        ext = fileExt;
        writes = writes.then(() => this.save(id, kind, data, ext));
      })
      .then(async (result) => {
        await writes;
        ext = result.screenshotExt ?? ext;
        this.pool.setBusy(id, false);
        if (finish) await this.finishPreview(id, ext);
        else this.store.hold(id, this.pool.until(id));
      })
      .catch(async (err: unknown) => {
        console.warn(`files failed for ${id}: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
        await writes.catch(() => {});
        this.pool.setBusy(id, false);
        // The note is already written; it just doesn't get the files that failed.
        if (finish) await this.finishPreview(id, ext);
      });
  }

  /**
   * Lets go of a preview's page. With `keep` (the note was written), the job is
   * done so drain delivers it; otherwise it's thrown away.
   */
  async release(id: string, keep: boolean): Promise<void> {
    const job = this.store.get(id);
    if (job?.mode !== "preview") throw new NotPreview();
    if (job.status !== "running") return;
    if (keep) await this.finishPreview(id, job.screenshotExt);
    else await this.drop(id);
  }

  private async finishPreview(id: string, ext: Job["screenshotExt"]): Promise<void> {
    await this.pool.release(id);
    const job = this.store.get(id);
    if (job?.status === "running" && job.meta) this.store.finish(id, job.meta, this.written.get(id) ?? job.assets, ext);
    else if (job?.status === "running") this.store.fail(id, "released before the page was read", null);
    this.written.delete(id);
    this.emit("settled", id);
  }

  /** Throws a preview away: page closed, job cancelled, files removed. */
  private async drop(id: string): Promise<void> {
    await this.pool.release(id);
    this.written.delete(id);
    await this.cancel(id);
  }

  /** Resolves when the job settles or `timeoutMs` passes, with its latest state. */
  waitFor(id: string, timeoutMs: number): Promise<Job | null> {
    return new Promise((resolve) => {
      const settledNow = (job: Job | null) => !job || job.status === "done" || job.status === "failed" || job.status === "delivered";
      const current = this.store.get(id);
      if (settledNow(current)) return resolve(current);
      const onSettled = (settledId: string) => {
        if (settledId !== id) return;
        cleanup();
        resolve(this.store.get(id));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.store.get(id));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("settled", onSettled);
      };
      this.on("settled", onSettled);
    });
  }

  // ---- media downloads ----

  /**
   * A capture shared from elsewhere (a phone, a bookmarklet) whose note marks
   * media `|local` gets it queued straight away, since nobody is there to ask
   * for it, and posts can be deleted. Images are left to the plugin, which
   * fetches them itself; the job still lists them, so the plugin knows what
   * to save when it collects the job with the note.
   */
  private followUp(job: Job, url: string, note: RenderedNote | null): void {
    if (job.origin === "plugin" || job.origin === "enrich" || job.origin === "media" || job.mode === "preview") return;
    const local = note?.local ?? [];
    if (!local.length) return;
    const want = localWants(local, url);
    const media = this.store.create(url, "media", null, [], "full", { url, want, made: [], errors: [], forCapture: job.id, local });
    this.store.setMedia(job.id, { url, want, made: [], errors: [], followUp: media.id });
    this.kickMedia();
  }

  /** Starts the next media download when none is running and its site has rested (see MediaQueue). */
  kickMedia(): void {
    if (this.stopped || this.mediaRunning) return;
    if (this.mediaTimer) clearTimeout(this.mediaTimer);
    this.mediaTimer = null;
    const next = this.mediaQueue.next(this.store.pendingMedia(), Date.now());
    if (!next) return;
    if ("waitMs" in next) {
      this.mediaTimer = setTimeout(() => this.kickMedia(), next.waitMs);
      return;
    }
    const job = next.run as Job;
    if (!this.store.claim(job.id)) return this.kickMedia();
    this.mediaRunning = true;
    void this.runMedia(job)
      .catch((err: unknown) => this.store.finishMedia(job.id, [], null, String((err as Error)?.message ?? err).split("\n")[0]!))
      .finally(() => {
        this.mediaQueue.finished(job.url, Date.now());
        this.mediaRunning = false;
        this.written.delete(job.id);
        this.emit("settled", job.id);
        this.kickMedia();
      });
  }

  private egress(): Promise<EgressProxy> {
    this.proxy ??= startEgressProxy({ allowPrivate: this.media.allowPrivateNetworks });
    return this.proxy;
  }

  /**
   * Downloads what a media job wants. Videos and their covers come from
   * yt-dlp, through the egress proxy; a TikTok photo post's photos (which
   * yt-dlp can't get: it only finds their music) from the post in the browser.
   */
  private async runMedia(job: Job): Promise<void> {
    const info: MediaJobInfo = { ...(job.media ?? { url: job.url, want: ["video", "cover"] }), made: [], errors: [] };
    const dir = join(this.dataDir, "jobs", job.id);
    await mkdir(dir, { recursive: true });
    const wants = (want: MediaJobInfo["want"][number]) => info.want.includes(want);
    const made = (asset: MediaAsset, want: MediaJobInfo["want"][number], bytes: number, index?: number) => info.made.push({ asset, want, bytes, ...(index ? { index } : {}) });
    const failed = (want: MediaJobInfo["want"][number], message: string) => info.errors.push({ want, message });
    let ext: Job["screenshotExt"] = "jpg";
    const post = tiktokPost(job.url);
    // A photo post's cover comes with its photos, from the post in the browser.
    let photos = Boolean(post && (wants("photos") || (post.kind === "photo" && wants("cover"))));

    if (!photos && (wants("video") || wants("cover"))) {
      const ytdlpPath = (await this.ytdlp) ? this.media.ytdlpPath : null;
      if (!ytdlpPath) {
        for (const want of info.want) failed(want, "video downloads aren't set up on the server (yt-dlp isn't installed)");
      } else {
        const result = await runYtDlp(job.url, dir, { ytdlpPath, proxy: (await this.egress()).url, maxBytes: VIDEO_MAX_BYTES, video: wants("video") });
        if (result.slideshow && post) photos = true;
        else {
          if (wants("video")) {
            if (result.video) await this.list(job.id, "media_video", ext).then(() => made("media_video", "video", 0));
            else failed("video", result.tooLarge ? "larger than 300 MB" : (result.error ?? "no video found on the page"));
          }
          if (wants("cover")) {
            if (result.cover) await this.list(job.id, "media_cover", ext).then(() => made("media_cover", "cover", 0));
            else failed("cover", result.error ?? "no cover found");
          }
        }
      }
    }
    if (photos) {
      try {
        const result = await this.engine.tiktokPhotos(job.url, { photos: wants("photos") || wants("video"), cover: wants("cover") });
        ext = result.ext;
        for (const [i, photo] of result.photos.entries()) {
          await this.save(job.id, `media_photo_${i + 1}` as MediaAsset, photo, ext);
          made(`media_photo_${i + 1}` as MediaAsset, "photos", photo.length, i + 1);
        }
        if (!result.photos.length && (wants("photos") || wants("video"))) failed("photos", "the post has no photos the server could load");
        if (wants("cover")) {
          if (result.cover) {
            await this.save(job.id, "media_cover", result.cover, ext);
            made("media_cover", "cover", result.cover.length);
          } else failed("cover", "no cover found");
        }
      } catch (err) {
        failed("photos", String((err as Error)?.message ?? err).split("\n")[0]!);
      }
    }
    this.store.setMedia(job.id, info);
    const assets = this.written.get(job.id) ?? [];
    this.store.finishMedia(job.id, assets, assets.length ? ext : null, info.errors[0]?.message ?? null);
  }

  /** Lists a file a download already wrote in the job's folder, under its asset name. */
  private async list(id: string, kind: AssetKind, ext: Job["screenshotExt"]): Promise<void> {
    const job = this.store.get(id);
    if (job?.status !== "running") return;
    const assets = this.written.get(id) ?? [...job.assets];
    if (!assets.includes(kind)) assets.push(kind);
    this.written.set(id, assets);
    this.store.progress(id, null, assets, ext);
  }

  /** Cancels a job that hasn't finished (see {@link JobStore.cancel}); false when it had. */
  async cancel(id: string): Promise<boolean> {
    await this.pool.release(id);
    if (!this.store.cancel(id)) return false;
    await rm(join(this.dataDir, "jobs", id), { recursive: true, force: true });
    this.emit("settled", id);
    return true;
  }

  /** Removes a job's files now (a cancelled job, or an update the plugin has collected). */
  async discard(id: string): Promise<void> {
    this.store.discard(id);
    await rm(join(this.dataDir, "jobs", id), { recursive: true, force: true });
  }

  async prune(retentionDays: number): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    for (const id of this.store.takePrunable(cutoff)) {
      await rm(join(this.dataDir, "jobs", id), { recursive: true, force: true });
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.mediaTimer) clearTimeout(this.mediaTimer);
    void this.pool.closeAll();
    void this.proxy?.then((proxy) => proxy.close()).catch(() => {});
  }
}

/** The TikTok player, as {{tiktok_embed}} writes it. */
const TIKTOK_PLAYER = /tiktok\.com\/player\/v1\/\d+/;

/**
 * What the server downloads for a note's `|local` values: a TikTok post's
 * video or photos for its player, its cover for an address on TikTok's CDN,
 * and a video site's video for its page. Other images aren't the server's
 * (see followUp).
 */
export function localWants(local: readonly string[], url: string): MediaWant[] {
  const want = new Set<MediaWant>();
  const post = tiktokPost(url);
  for (const value of local) {
    if (post && TIKTOK_PLAYER.test(value)) want.add(post.kind === "photo" ? "photos" : "video");
    else if (post && /^https?:\/\/[^/\s]*tiktokcdn/i.test(value)) want.add("cover");
    else if (!post && value.includes(url) && videoPage(url)) want.add("video");
  }
  return [...want];
}

/** A YouTube, X, Vimeo or Instagram video's page. */
export function videoPage(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
    return (
      ((host === "youtube.com" && (u.pathname === "/watch" || /^\/(shorts|live)\//.test(u.pathname))) || host === "youtu.be") ||
      ((host === "x.com" || host === "twitter.com") && /\/status\/\d+/.test(u.pathname)) ||
      (host === "vimeo.com" && /^\/\d+/.test(u.pathname)) ||
      (host === "instagram.com" && /^\/(p|reel|reels|tv)\//.test(u.pathname))
    );
  } catch {
    return false;
  }
}
