import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPTURE_FILES, fileExt, type AssetKind, type Job, type PageMeta } from "./api.js";
import { BlockedError, type CaptureEngine } from "./capture.js";
import type { JobStore } from "./db.js";
import { renderRequest } from "./render.js";

export function assetPath(dataDir: string, id: string, kind: AssetKind, screenshotExt: Job["screenshotExt"]): string {
  const file = kind === "markdown" ? "content.md" : kind === "note" ? "note.json" : `${kind}.${fileExt(kind, screenshotExt) ?? "png"}`;
  return join(dataDir, "jobs", id, file);
}

/**
 * Runs pending jobs through the capture engine, `concurrency` at a time.
 * Emits "settled" with the job id when a job reaches done or failed.
 */
export class Worker extends EventEmitter {
  private active = 0;
  private stopped = false;

  constructor(
    private readonly store: JobStore,
    private readonly engine: CaptureEngine,
    private readonly dataDir: string,
    private readonly concurrency: number,
  ) {
    super();
  }

  /** Call after enqueueing; starts as many jobs as there are free slots. */
  kick(): void {
    while (!this.stopped && this.active < this.concurrency) {
      const job = this.store.claimNext();
      if (!job) return;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        this.emit("settled", job.id);
        this.kick();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const settings = this.store.getSettings();
      const dir = join(this.dataDir, "jobs", job.id);
      await mkdir(dir, { recursive: true });
      // Each piece is written and listed as soon as it's made, so the plugin can
      // show the note while the screenshots are still being taken.
      const assets: AssetKind[] = [];
      let ext: Job["screenshotExt"] = null;
      let writes = Promise.resolve();
      const save = (kind: AssetKind, data: string | Buffer, meta: PageMeta | null = null) => {
        writes = writes.then(async () => {
          // Nothing more to keep once a job is cancelled.
          if (assets.includes(kind) || this.store.get(job.id)?.status !== "running") return;
          await writeFile(assetPath(this.dataDir, job.id, kind, ext), data);
          assets.push(kind);
          this.store.progress(job.id, meta, assets, ext);
        }).catch((err: unknown) => {
          if (this.store.get(job.id)?.status === "running") throw err;
        });
      };
      const result = await this.engine.capture(job.url, renderRequest(settings, job.template, job.id, job.files), {
        page: (meta, markdown, note) => {
          save("markdown", markdown, meta);
          if (note) save("note", JSON.stringify(note));
        },
        file: (kind, data, fileExt) => {
          ext = fileExt;
          save(kind, data);
        },
      });
      ext = result.screenshotExt;
      for (const kind of CAPTURE_FILES) {
        const data = result.files[kind];
        if (data) save(kind, data);
      }
      save("markdown", result.markdown);
      if (result.note) save("note", JSON.stringify(result.note));
      await writes;
      this.store.finish(job.id, result.meta, assets, result.screenshotExt);
    } catch (err) {
      const message = String((err as Error)?.message ?? err).split("\n")[0] ?? "capture failed";
      this.store.fail(job.id, message, err instanceof BlockedError ? err.meta : null);
    }
    // Cancelled while running: the result isn't wanted.
    if (this.store.get(job.id)?.error === "cancelled") await rm(join(this.dataDir, "jobs", job.id), { recursive: true, force: true });
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

  /** Cancels a job that hasn't finished (see {@link JobStore.cancel}); false when it had. */
  async cancel(id: string): Promise<boolean> {
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
  }
}
