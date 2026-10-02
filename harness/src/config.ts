// Headless Chromium's default UA contains "HeadlessChrome", which YouTube,
// Reddit and X block outright (Spike 0).
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface Config {
  host: string;
  port: number;
  /** Per-device bearer tokens; remove one to revoke that device (design §8). */
  tokens: ReadonlySet<string>;
  /** SQLite database and capture blobs live here. */
  dataDir: string;
  /** Captures run at the same time. */
  concurrency: number;
  /** Hard cap on one capture, navigation through extraction. */
  captureTimeoutMs: number;
  /** Time allowed for scrolling lazy content into view. */
  scrollBudgetMs: number;
  /** Screenshot height cap in CSS pixels. */
  maxHeight: number;
  /** Longest a `POST /capture?wait=1` request is held open (audit #12). */
  waitCapMs: number;
  /** Delivered jobs keep their blobs this long, then they are pruned. */
  retentionDays: number;
  userAgent: string;
  screenshotFormat: "jpeg" | "png";
  /** Allow capturing private/loopback addresses. Off by default (SSRF). */
  allowPrivateNetworks: boolean;
  /** Use a local Chromium instead of Playwright's bundled one. */
  chromiumPath: string | undefined;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokens = new Set(
    (env.BOOKMARKS_TOKENS ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
  );
  return {
    // Safe default bind; the compose file publishes it explicitly.
    host: env.BOOKMARKS_HOST ?? "127.0.0.1",
    port: int(env.BOOKMARKS_PORT, 8787),
    tokens,
    dataDir: env.BOOKMARKS_DATA_DIR ?? "data",
    concurrency: Math.max(1, int(env.BOOKMARKS_CONCURRENCY, 1)),
    captureTimeoutMs: int(env.BOOKMARKS_CAPTURE_TIMEOUT_MS, 45_000),
    scrollBudgetMs: int(env.BOOKMARKS_SCROLL_BUDGET_MS, 15_000),
    maxHeight: int(env.BOOKMARKS_MAX_HEIGHT, 20_000),
    waitCapMs: int(env.BOOKMARKS_WAIT_CAP_MS, 60_000),
    retentionDays: int(env.BOOKMARKS_RETENTION_DAYS, 7),
    userAgent: env.BOOKMARKS_USER_AGENT || DEFAULT_USER_AGENT,
    screenshotFormat: env.BOOKMARKS_SCREENSHOT_FORMAT === "png" ? "png" : "jpeg",
    allowPrivateNetworks: env.BOOKMARKS_ALLOW_PRIVATE_NETWORKS === "1",
    chromiumPath: env.BOOKMARKS_CHROMIUM_PATH || undefined,
  };
}
