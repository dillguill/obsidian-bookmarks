import { CAPTURE_FILES, type CaptureFile, type Job } from "./api";
import type { ServerClient } from "./client";

const POLL_MS = 1500;
/** How long to keep checking on a capture before giving up on it. */
const TIMEOUT_MS = 3 * 60_000;

const settled = (job: Job) => job.status !== "pending" && job.status !== "running";

/**
 * The server captures behind one "Update note from source": the main capture,
 * whose note and text arrive before its screenshots, plus one capture per file
 * the user adds that the main one didn't make. Polls them, downloads files on
 * request and cleans up on the server when the update ends.
 */
export class EnrichSession {
  private main: Job;
  /** Captures started for one file each, by that file. */
  private readonly extra = new Map<CaptureFile, Job>();
  private readonly data = new Map<CaptureFile, Promise<ArrayBuffer | null>>();
  private timer: number | null = null;
  private readonly started = Date.now();
  private closed = false;
  private waiters: (() => void)[] = [];
  /** Called whenever a capture makes progress. */
  onChange: () => void = () => {};

  constructor(
    private readonly client: ServerClient,
    job: Job,
    private readonly url: string,
    private readonly template: string | null,
  ) {
    this.main = job;
  }

  get job(): Job {
    return this.main;
  }

  /** Polls until the main capture has rendered its note (or failed). */
  async waitForNote(): Promise<Job> {
    while (!this.main.assets.includes("note") && !settled(this.main)) {
      if (Date.now() - this.started > TIMEOUT_MS) throw new Error("the server is still capturing the page. Try again in a minute.");
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      this.main = await this.client.job(this.main.id);
    }
    if (this.main.status === "failed") throw new Error(this.main.error ?? "unknown error");
    if (!this.main.assets.includes("note")) throw new Error("the server didn't render the page. Update bookmarks-server.");
    this.poll();
    return this.main;
  }

  /** Files made so far, by any of the captures. */
  available(): CaptureFile[] {
    return CAPTURE_FILES.filter((kind) => this.source(kind));
  }

  /** Files still being captured on demand. */
  pending(): CaptureFile[] {
    return [...this.extra].filter(([, job]) => !settled(job)).map(([kind]) => kind);
  }

  /** Every capture has finished. */
  ready(): boolean {
    return settled(this.main) && this.pending().length === 0;
  }

  screenshotExt(): Job["screenshotExt"] {
    return this.main.screenshotExt ?? [...this.extra.values()].find((job) => job.screenshotExt)?.screenshotExt ?? null;
  }

  /** Resolves once every capture has finished. */
  whenReady(): Promise<void> {
    return this.ready() ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Asks the server for a file the main capture didn't make. */
  async request(kind: CaptureFile): Promise<void> {
    if (this.source(kind) || this.extra.has(kind)) return;
    const job = await this.client.capture(this.url, "enrich", false, this.template, [kind]);
    if (this.closed) return void this.client.cancel(job.id).catch(() => {});
    this.extra.set(kind, job);
    this.onChange();
    this.poll();
  }

  /** Stops capturing a file the user no longer wants. */
  async drop(kind: CaptureFile): Promise<void> {
    const job = this.extra.get(kind);
    if (!job || settled(job)) return;
    this.extra.delete(kind);
    this.onChange();
    this.notifyIfReady();
    await this.client.cancel(job.id).catch(() => {});
  }

  /** A file's data, downloaded once; null when no capture made it. */
  file(kind: CaptureFile): Promise<ArrayBuffer | null> {
    const job = this.source(kind);
    if (!job) return Promise.resolve(null);
    let data = this.data.get(kind);
    if (!data) {
      data = this.client.assetBinary(job.id, kind).catch(() => null);
      this.data.set(kind, data);
    }
    return data;
  }

  /** Ends the update: unfinished captures are cancelled and finished ones collected, so the server drops their files. */
  close(): void {
    this.closed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    for (const job of [this.main, ...this.extra.values()]) {
      if (settled(job)) void this.client.delivered(job.id).catch(() => {});
      else void this.client.cancel(job.id).catch(() => {});
    }
    this.notify();
  }

  private source(kind: CaptureFile): Job | undefined {
    if (this.main.assets.includes(kind)) return this.main;
    const job = this.extra.get(kind);
    return job?.assets.includes(kind) ? job : undefined;
  }

  private poll(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, POLL_MS);
  }

  private async tick(): Promise<void> {
    const open = [this.main, ...this.extra.values()].filter((job) => !settled(job));
    if (!open.length || this.closed) return;
    let changed = false;
    for (const job of open) {
      const next = await this.client.job(job.id).catch(() => job);
      if (next.status !== job.status || next.assets.length !== job.assets.length) changed = true;
      if (job === this.main) this.main = next;
      else for (const [kind, j] of this.extra) if (j === job) this.extra.set(kind, next);
    }
    // Give up on captures that never finish, so the update can still be applied.
    if (Date.now() - this.started > TIMEOUT_MS) {
      for (const [kind, job] of this.extra) if (!settled(job)) await this.drop(kind);
      if (!settled(this.main)) this.main = { ...this.main, status: "failed" };
      changed = true;
    }
    if (this.closed) return;
    if (changed) this.onChange();
    this.notifyIfReady();
    if (!this.ready()) this.poll();
  }

  private notifyIfReady(): void {
    if (this.ready()) this.notify();
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
