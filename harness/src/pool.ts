/** A page held open after a preview, until the plugin is done with it. */
export interface Held {
  close(): Promise<void>;
}

export interface PoolOptions {
  /** Released after this long without a `get`. */
  ttlMs: number;
  max: number;
  /** Called once per page the pool lets go of on its own (idle too long, or room needed for a newer one). */
  onExpire: (jobId: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface Entry<T> {
  page: T;
  lastUsed: number;
  timer: unknown;
  /** Taking files; never evicted meanwhile. */
  busy: boolean;
}

/**
 * Pages kept open after a preview so the note can be rendered with another
 * template, or its screenshots taken, without loading the page again. Pages
 * are closed after `ttlMs` idle, and the oldest idle one makes room when the
 * pool is full; one that's taking files is never evicted.
 */
export class PagePool<T extends Held> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly options: PoolOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  get size(): number {
    return this.entries.size;
  }

  /** When a held page will be released if nothing uses it, as an ISO time. */
  until(jobId: string): string | null {
    const entry = this.entries.get(jobId);
    return entry ? new Date(entry.lastUsed + this.options.ttlMs).toISOString() : null;
  }

  /** Holds a page; false (and the page closed) when the pool is full of busy pages. */
  hold(jobId: string, page: T): boolean {
    if (this.entries.size >= this.options.max) {
      const idle = [...this.entries].filter(([, e]) => !e.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) {
        void page.close().catch(() => {});
        return false;
      }
      this.expire(idle[0]);
    }
    this.entries.set(jobId, { page, lastUsed: this.now(), timer: null, busy: false });
    this.arm(jobId);
    return true;
  }

  /** The held page, with its idle time restarted; null when it isn't held. */
  get(jobId: string): T | null {
    const entry = this.entries.get(jobId);
    if (!entry) return null;
    entry.lastUsed = this.now();
    this.arm(jobId);
    return entry.page;
  }

  /** Marks a page busy (taking files) or idle again; its idle time restarts either way. */
  setBusy(jobId: string, busy: boolean): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    entry.busy = busy;
    entry.lastUsed = this.now();
    this.arm(jobId);
  }

  /** Closes and forgets a page; false when it wasn't held. */
  async release(jobId: string): Promise<boolean> {
    const entry = this.entries.get(jobId);
    if (!entry) return false;
    this.entries.delete(jobId);
    this.clearTimer(entry.timer);
    await entry.page.close().catch(() => {});
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.release(id)));
  }

  private arm(jobId: string): void {
    const entry = this.entries.get(jobId)!;
    this.clearTimer(entry.timer);
    entry.timer = this.setTimer(() => {
      const current = this.entries.get(jobId);
      // A busy page's timer is re-armed when it goes idle again.
      if (current && !current.busy) this.expire(jobId);
    }, this.options.ttlMs);
  }

  private expire(jobId: string): void {
    void this.release(jobId).then((released) => {
      if (released) this.options.onExpire(jobId);
    });
  }
}
