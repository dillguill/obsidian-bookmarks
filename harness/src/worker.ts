import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetKind, Job } from "./api.js";
import { BlockedError, type CaptureEngine } from "./capture.js";
import type { JobStore } from "./db.js";
import { renderRequest } from "./render.js";

export function assetPath(dataDir: string, id: string, kind: AssetKind, ext: string | null): string {
  const file =
    kind === "markdown" ? "content.md" : kind === "note" ? "note.json" : kind === "banner" ? `banner.${ext ?? "png"}` : `screenshot.${ext ?? "png"}`;
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
      const result = await this.engine.capture(job.url, renderRequest(settings, job.template, job.id));
      await mkdir(join(this.dataDir, "jobs", job.id), { recursive: true });
      const assets: AssetKind[] = [];
      if (result.screenshot) {
        await writeFile(assetPath(this.dataDir, job.id, "screenshot", result.screenshotExt), result.screenshot);
        assets.push("screenshot");
      }
      if (result.banner) {
        await writeFile(assetPath(this.dataDir, job.id, "banner", result.screenshotExt), result.banner);
        assets.push("banner");
      }
      await writeFile(assetPath(this.dataDir, job.id, "markdown", null), result.markdown);
      assets.push("markdown");
      if (result.note) {
        await writeFile(assetPath(this.dataDir, job.id, "note", null), JSON.stringify(result.note));
        assets.push("note");
      }
      this.store.finish(job.id, result.meta, assets, result.screenshot || result.banner ? result.screenshotExt : null);
    } catch (err) {
      const message = String((err as Error)?.message ?? err).split("\n")[0] ?? "capture failed";
      this.store.fail(job.id, message, err instanceof BlockedError ? err.meta : null);
    }
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
