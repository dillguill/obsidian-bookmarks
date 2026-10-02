import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssetKind, CaptureOrigin, CaptureSettings, Job, JobStatus, PageMeta } from "./api.js";
import { DEFAULT_CAPTURE_SETTINGS } from "./settings.js";
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
    // A crash mid-capture leaves rows running; retry them.
    this.db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run();
  }

  create(url: string, origin: CaptureOrigin, template: string | null = null): Job {
    const now = new Date().toISOString();
    const id = ulid();
    this.db
      .prepare("INSERT INTO jobs (id, url, origin, status, template, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)")
      .run(id, url, origin, template, now, now);
    return this.get(id)!;
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  list(statuses: JobStatus[], limit: number): Job[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY id LIMIT ?`)
      .all(...statuses, limit) as unknown as Row[];
    return rows.map(toJob);
  }

  /** Atomically moves the oldest pending job to running. */
  claimNext(): Job | null {
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', updated_at = ?
         WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1)
         RETURNING *`,
      )
      .get(new Date().toISOString()) as Row | undefined;
    return row ? toJob(row) : null;
  }

  finish(id: string, meta: PageMeta, assets: AssetKind[], screenshotExt: Job["screenshotExt"]): void {
    this.db
      .prepare("UPDATE jobs SET status = 'done', error = NULL, meta = ?, assets = ?, screenshot_ext = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(meta), JSON.stringify(assets), screenshotExt, new Date().toISOString(), id);
  }

  fail(id: string, error: string, meta: PageMeta | null): void {
    this.db
      .prepare("UPDATE jobs SET status = 'failed', error = ?, meta = ?, assets = '[]', updated_at = ? WHERE id = ?")
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

  /** Delivered jobs whose blobs are older than `cutoff`; clears their asset list. */
  takePrunable(cutoff: Date): string[] {
    const rows = this.db
      .prepare("UPDATE jobs SET assets = '[]' WHERE status = 'delivered' AND delivered_at < ? AND assets != '[]' RETURNING id")
      .all(cutoff.toISOString()) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getSettings(): CaptureSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'capture'").get() as { value: string } | undefined;
    return { ...DEFAULT_CAPTURE_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<CaptureSettings>) : {}) };
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
