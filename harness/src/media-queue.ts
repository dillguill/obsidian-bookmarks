// When media downloads run: one at a time, oldest first, with a pause between
// two downloads from the same site so a burst of saves doesn't look like
// scraping (and get rate-limited). Kept free of I/O so it can be tested.

/** The pause after a download before the same site is asked again. */
export const SITE_GAP_MS = 5000;
/** Up to this much more, so downloads don't fall into a regular rhythm. */
export const SITE_JITTER_MS = 3000;

/** A site, as rate limits see it: the host without www., m. or vm. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m|vm|vt|mobile)\./, "");
  } catch {
    return url;
  }
}

export interface Waiting {
  id: string;
  url: string;
}

export class MediaQueue {
  /** When each site may be asked again. */
  private readonly readyAt = new Map<string, number>();

  constructor(
    private readonly random: () => number = Math.random,
    private readonly gapMs = SITE_GAP_MS,
    private readonly jitterMs = SITE_JITTER_MS,
  ) {}

  /** The download to run now (the oldest whose site isn't resting), or how long until one can. */
  next(waiting: readonly Waiting[], now: number): { run: Waiting } | { waitMs: number } | null {
    if (!waiting.length) return null;
    const ready = waiting.find((w) => (this.readyAt.get(siteOf(w.url)) ?? 0) <= now);
    if (ready) return { run: ready };
    return { waitMs: Math.min(...waiting.map((w) => this.readyAt.get(siteOf(w.url))! - now)) };
  }

  /** A download from this URL's site just ended; that site rests before the next one. */
  finished(url: string, now: number): void {
    this.readyAt.set(siteOf(url), now + this.gapMs + Math.round(this.random() * this.jitterMs));
  }
}
