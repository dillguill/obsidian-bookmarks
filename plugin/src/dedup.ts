import { normalizeUrl } from "./url";

/**
 * In-memory dedup index (design §4, audit #5): normalized URL -> note paths,
 * and capture_id -> note path for write idempotency. Built from frontmatter on
 * load and kept current from metadata-cache events.
 */
export class DedupIndex {
  private readonly byUrl = new Map<string, Set<string>>();
  private readonly byCaptureId = new Map<string, string>();
  private readonly entries = new Map<string, { url: string | null; captureId: string | null }>();

  /** Records (or replaces) what `path` holds. */
  set(path: string, url: unknown, captureId: unknown): void {
    this.remove(path);
    const key = typeof url === "string" ? normalizeUrl(url) : null;
    const id = typeof captureId === "string" && captureId ? captureId : null;
    if (!key && !id) return;
    this.entries.set(path, { url: key, captureId: id });
    if (key) {
      const paths = this.byUrl.get(key) ?? new Set<string>();
      paths.add(path);
      this.byUrl.set(key, paths);
    }
    if (id) this.byCaptureId.set(id, path);
  }

  remove(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    if (entry.url) {
      const paths = this.byUrl.get(entry.url);
      paths?.delete(path);
      if (paths?.size === 0) this.byUrl.delete(entry.url);
    }
    if (entry.captureId && this.byCaptureId.get(entry.captureId) === path) this.byCaptureId.delete(entry.captureId);
  }

  rename(oldPath: string, newPath: string): void {
    const entry = this.entries.get(oldPath);
    if (!entry) return;
    this.remove(oldPath);
    this.entries.set(newPath, entry);
    if (entry.url) this.byUrl.set(entry.url, (this.byUrl.get(entry.url) ?? new Set()).add(newPath));
    if (entry.captureId) this.byCaptureId.set(entry.captureId, newPath);
  }

  /** First note saved for any of `urls`, after normalization. */
  findByUrl(...urls: Array<string | null | undefined>): string | null {
    for (const url of urls) {
      const key = url ? normalizeUrl(url) : null;
      const first = key ? this.byUrl.get(key)?.values().next().value : undefined;
      if (first) return first;
    }
    return null;
  }

  findByCaptureId(id: string): string | null {
    return this.byCaptureId.get(id) ?? null;
  }

  get size(): number {
    return this.entries.size;
  }
}
