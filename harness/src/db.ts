import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssetKind, CaptureFile, CaptureMode, CaptureOrigin, CaptureSettings, Job, JobStatus, MediaJobInfo, PageMeta } from "./api.js";
import { currentSettings } from "./settings.js";
import { ulid } from "./ulid.js";

interface Row {
  id: string;
  url: string;
  origin: string;
  status: string;
  error: string | null;
  meta: string | null;
  assets: string;
  screenshot_ext: string | null;
  template: string | null;
  files: string | null;
  mode: string;
  held_until: string | null;
  media: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    url: row.url,
    origin: row.origin as CaptureOrigin,
    status: row.status as JobStatus,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    meta: row.meta ? (JSON.parse(row.meta) as PageMeta) : null,
    assets: JSON.parse(row.assets) as AssetKind[],
    screenshotExt: row.screenshot_ext as Job["screenshotExt"],
    template: row.template ?? null,
    files: row.files ? (JSON.parse(row.files) as CaptureFile[]) : [],
    mode: row.mode as CaptureMode,
    heldUntil: row.held_until,
    media: row.media ? (JSON.parse(row.media) as MediaJobInfo) : null,
  };
}

/** SQLite-backed job queue (design §5.2). Jobs move pending -> running -> done|failed -> delivered. */
export class JobStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        meta TEXT,
        assets TEXT NOT NULL DEFAULT '[]',
        screenshot_ext TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Databases from before the template column existed.
    const columns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "template")) this.db.exec("ALTER TABLE jobs ADD COLUMN template TEXT");
    if (!columns.some((c) => c.name === "files")) this.db.exec("ALTER TABLE jobs ADD COLUMN files TEXT");
    if (!columns.some((c) => c.name === "mode")) this.db.exec("ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'");
    if (!columns.some((c) => c.name === "held_until")) this.db.exec("ALTER TABLE jobs ADD COLUMN held_until TEXT");
    if (!columns.some((c) => c.name === "media")) this.db.exec("ALTER TABLE jobs ADD COLUMN media TEXT");
    // A crash mid-capture leaves rows running; retry them. A preview's held page
    // died with the process and nobody is waiting on it any more.
    this.db.prepare("UPDATE jobs SET status = 'failed', error = 'cancelled', held_until = NULL WHERE status = 'running' AND mode = 'preview'").run();
    this.db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run();
  }

  create(url: string, origin: CaptureOrigin, template: string | null = null, files: CaptureFile[] = [], mode: CaptureMode = "full", media: MediaJobInfo | null = null): Job {
    const now = new Date().toISOString();
    const id = ulid();
    this.db
      .prepare("INSERT INTO jobs (id, url, origin, status, template, files, mode, media, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)")
      .run(id, url, origin, template, files.length ? JSON.stringify(files) : null, mode, media ? JSON.stringify(media) : null, now, now);
    return this.get(id)!;
  }

  /** Records that a preview's page is held, until `until` unless used again; null when it's let go. */
  hold(id: string, until: string | null): void {
    this.db.prepare("UPDATE jobs SET held_until = ?, updated_at = ? WHERE id = ?").run(until, new Date().toISOString(), id);
  }

  /** Records a media download's progress, or a capture's follow-up download. */
  setMedia(id: string, media: MediaJobInfo): void {
    this.db.prepare("UPDATE jobs SET media = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(media), new Date().toISOString(), id);
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /**
   * Jobs waiting for delivery. Enrich jobs are read by the plugin that asked for
   * them, and a preview that failed or was let go was already shown to the user,
   * so both are left out. Media downloads are listed only when asked for.
   */
  list(statuses: JobStatus[], limit: number, origin: "media" | null = null): Job[] {
    const placeholders = statuses.map(() => "?").join(",");
    const which = origin === "media" ? "origin = 'media'" : "origin NOT IN ('enrich', 'media') AND NOT (mode = 'preview' AND status = 'failed')";
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) AND ${which} ORDER BY id LIMIT ?`)
      .all(...statuses, limit) as unknown as Row[];
    return rows.map(toJob);
  }

  /** Atomically moves the oldest pending job to running. */
  claimNext(): Job | null {
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', updated_at = ?
         WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND origin != 'media' ORDER BY id LIMIT 1)
         RETURNING *`,
      )
      .get(new Date().toISOString()) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** Media downloads waiting their turn, oldest first. */
  pendingMedia(): Job[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE status = 'pending' AND origin = 'media' ORDER BY id").all() as unknown as Row[]).map(toJob);
  }

  /** Moves one pending job to running; false when it isn't pending any more. */
  claim(id: string): boolean {
    return this.db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'").run(new Date().toISOString(), id).changes > 0;
  }

  /** Ends a media download: done when anything was made, else failed with the reason. */
  finishMedia(id: string, assets: AssetKind[], screenshotExt: Job["screenshotExt"], error: string | null): void {
    this.db
      .prepare("UPDATE jobs SET status = ?, error = ?, assets = ?, screenshot_ext = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(assets.length ? "done" : "failed", assets.length ? null : (error ?? "nothing could be downloaded"), JSON.stringify(assets), screenshotExt, new Date().toISOString(), id);
  }

  /** Records what a running capture has made so far; its assets can be read before it's done. */
  progress(id: string, meta: PageMeta | null, assets: AssetKind[], screenshotExt: Job["screenshotExt"]): void {
    this.db
      .prepare(
        "UPDATE jobs SET meta = COALESCE(?, meta), assets = ?, screenshot_ext = COALESCE(?, screenshot_ext), updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(meta ? JSON.stringify(meta) : null, JSON.stringify(assets), screenshotExt, new Date().toISOString(), id);
  }

  /**
   * Stops a job that hasn't finished: it fails as cancelled and its assets are
   * dropped. A running capture still runs to its end, but its result is thrown
   * away. Returns false when the job had already finished.
   */
  cancel(id: string): boolean {
    const result = this.db
      .prepare("UPDATE jobs SET status = 'failed', error = 'cancelled', assets = '[]', held_until = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')")
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  /** Drops a finished job's assets now, once whoever asked for it has what they need. */
  discard(id: string): void {
    this.db.prepare("UPDATE jobs SET assets = '[]', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  finish(id: string, meta: PageMeta, assets: AssetKind[], screenshotExt: Job["screenshotExt"]): void {
    this.db
      .prepare("UPDATE jobs SET status = 'done', error = NULL, meta = ?, assets = ?, screenshot_ext = ?, held_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(JSON.stringify(meta), JSON.stringify(assets), screenshotExt, new Date().toISOString(), id);
  }

  fail(id: string, error: string, meta: PageMeta | null): void {
    this.db
      .prepare("UPDATE jobs SET status = 'failed', error = ?, meta = ?, assets = '[]', updated_at = ? WHERE id = ? AND status = 'running'")
      .run(error, meta ? JSON.stringify(meta) : null, new Date().toISOString(), id);
  }

  /** Returns false when the job doesn't exist or isn't finished yet. */
  markDelivered(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE jobs SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE id = ? AND status IN ('done', 'failed', 'delivered')",
      )
      .run(now, now, id);
    return result.changes > 0;
  }

  /** Delivered jobs whose blobs are older than `cutoff`, and enrich jobs nobody collected; clears their asset list. */
  takePrunable(cutoff: Date): string[] {
    const rows = this.db
      .prepare(
        `UPDATE jobs SET assets = '[]'
         WHERE assets != '[]' AND ((status = 'delivered' AND delivered_at < ?) OR (origin IN ('enrich', 'media') AND status IN ('done', 'failed') AND updated_at < ?))
         RETURNING id`,
      )
      .all(cutoff.toISOString(), cutoff.toISOString()) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getSettings(): CaptureSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'capture'").get() as { value: string } | undefined;
    return currentSettings(row ? (JSON.parse(row.value) as Partial<CaptureSettings>) : {});
  }

  saveSettings(settings: CaptureSettings): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('capture', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(settings));
  }

  close(): void {
    this.db.close();
  }
}
