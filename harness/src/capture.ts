import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import TurndownService from "turndown";
import type { PageMeta, ScreenshotStyle } from "./api.js";
import type { Config } from "./config.js";
import { urlRejection } from "./ssrf.js";

const require = createRequire(import.meta.url);
const DEFUDDLE_PATH = require.resolve("defuddle/full");
const VIEWPORT = { width: 1280, height: 800 };

export interface CaptureResult {
  meta: PageMeta;
  markdown: string;
  /** Null when the screenshot style is "none". */
  screenshot: Buffer | null;
  screenshotExt: "jpg" | "png" | null;
}

/** The site served a bot wall or challenge instead of the page. */
export class BlockedError extends Error {
  constructor(
    message: string,
    readonly meta: PageMeta,
  ) {
    super(message);
  }
}

export interface CaptureEngine {
  capture(url: string, style: ScreenshotStyle): Promise<CaptureResult>;
  close(): Promise<void>;
}

type EngineOptions = Pick<
  Config,
  | "captureTimeoutMs"
  | "scrollBudgetMs"
  | "maxHeight"
  | "userAgent"
  | "screenshotFormat"
  | "allowPrivateNetworks"
  | "chromiumPath"
>;

const BLOCK_TITLES = /^(just a moment|attention required|access denied|are you a robot|security check|verify you are human|pardon our interruption)/i;
const BLOCK_TEXT = /(you('|’)ve been blocked|you have been blocked|unusual traffic from your computer|verify you are (a )?human|enable javascript and cookies to continue|checking your browser)/i;

/** Detects bot walls and challenge pages (Spike 0: Cloudflare, Reddit, NYT). */
export function blockReason(meta: Pick<PageMeta, "title" | "wordCount" | "httpStatus">, bodyText: string): string | null {
  if (BLOCK_TITLES.test(meta.title.trim())) return `challenge page ("${meta.title.trim()}")`;
  if (meta.wordCount < 200 && BLOCK_TEXT.test(bodyText)) return "bot wall";
  // A non-2xx alone isn't enough: Stack Overflow returns 403 with the full page.
  const status = meta.httpStatus ?? 200;
  if (status === 429) return "rate limited (HTTP 429)";
  if (status >= 400 && meta.wordCount < 50) return `HTTP ${status} with no readable content`;
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(`capture timed out after ${Math.round(ms / 1000)}s`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// networkidle fires before client-side renders that run on timers, so also wait
// until the DOM stops changing for a quiet window (capped).
async function waitForDomQuiet(page: Page, quietMs = 500, maxMs = 5000): Promise<void> {
  await page.evaluate(
    ({ quiet, max }) =>
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          obs.disconnect();
          clearTimeout(cap);
          resolve();
        };
        const obs = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, quiet);
        });
        obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
        timer = setTimeout(done, quiet);
        const cap = setTimeout(done, max);
      }),
    { quiet: quietMs, max: maxMs },
  );
}

/** Hides cookie/consent banners and restores page scrolling before the screenshot. */
async function hideOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const selectors = [
      "#onetrust-consent-sdk",
      "#CybotCookiebotDialog",
      ".fc-consent-root",
      ".cc-window",
      ".js-consent-banner",
      "[id^='sp_message_container']",
      "#didomi-host",
      "#usercentrics-root",
      "#cookie-banner",
      "#cookie-notice",
    ];
    for (const el of document.querySelectorAll<HTMLElement>(selectors.join(","))) el.style.setProperty("display", "none", "important");
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      const text = el.innerText ?? "";
      if (text.length < 2000 && /\b(cookies?|consent)\b/i.test(text)) el.style.setProperty("display", "none", "important");
    }
    for (const el of [document.documentElement, document.body]) {
      if (getComputedStyle(el).overflow === "hidden") el.style.setProperty("overflow", "visible", "important");
    }
  });
}

/**
 * Some layouts (docs sites, app shells) scroll inside a container, so the page
 * itself is one viewport tall and a full-page screenshot shows one screen.
 * Returns how much taller the viewport must be for the largest such container
 * to fit its content. Growing the viewport, rather than restyling the
 * container, keeps virtualized renderers (Obsidian Publish) drawing.
 */
async function innerScrollExtra(page: Page): Promise<number> {
  return page.evaluate((viewportHeight) => {
    const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    if (pageHeight > viewportHeight + 50) return 0;
    let best: HTMLElement | null = null;
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const overflowY = getComputedStyle(el).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 50) {
        if (!best || el.scrollHeight * el.clientWidth > best.scrollHeight * best.clientWidth) best = el;
      }
    }
    if (!best || best.clientWidth < window.innerWidth / 3) return 0;
    return best.scrollHeight - best.clientHeight;
  }, VIEWPORT.height);
}

/** Scrolls in viewport steps so lazy images load, within a height and time budget. */
async function autoScroll(page: Page, maxHeight: number, budgetMs: number): Promise<void> {
  await page.evaluate(
    async ({ max, step, budget }) => {
      const start = performance.now();
      const height = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
      for (let y = 0; y < Math.min(height(), max) && performance.now() - start < budget; y += step) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      window.scrollTo(0, 0);
    },
    { max: maxHeight, step: VIEWPORT.height, budget: budgetMs },
  );
}

function absolute(value: string | null | undefined, base: string): string {
  if (!value) return "";
  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

export class PlaywrightEngine implements CaptureEngine {
  private browser: Promise<Browser> | null = null;
  private readonly turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });

  constructor(private readonly options: EngineOptions) {}

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const launching = chromium.launch({ executablePath: this.options.chromiumPath });
      launching.then(
        (browser) => browser.on("disconnected", () => (this.browser = null)),
        () => (this.browser = null),
      );
      this.browser = launching;
    }
    return this.browser;
  }

  async capture(url: string, style: ScreenshotStyle): Promise<CaptureResult> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      acceptDownloads: false,
      // Strict CSPs (GitHub, MDN) otherwise refuse the injected Defuddle script.
      bypassCSP: true,
      userAgent: this.options.userAgent,
      locale: "en-US",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    // tsx/esbuild (npm run dev) wraps functions in __name(), which page.evaluate
    // then calls inside the page; define it there as a no-op.
    await context.addInitScript({ content: "globalThis.__name ??= (fn) => fn;" });
    try {
      // A timed-out page can leave Chromium wedged for every later context, so
      // restart the browser rather than just closing this context.
      return await withTimeout(this.run(context, url, style), this.options.captureTimeoutMs, () => void this.restart());
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async run(context: BrowserContext, url: string, style: ScreenshotStyle): Promise<CaptureResult> {
    const { allowPrivateNetworks, maxHeight, scrollBudgetMs, screenshotFormat } = this.options;
    // Re-check every document the page loads (redirects, iframes), so a public
    // URL can't bounce the browser into the private network (design §8).
    // Subresources aren't intercepted: routing every request through Node
    // stalled ad-heavy pages (The Verge) past the capture timeout.
    const verdicts = new Map<string, Promise<string | null>>();
    await context.route("**/*", async (route) => {
      const request = route.request();
      const requestUrl = request.url();
      if (request.resourceType() !== "document" || !/^https?:/i.test(requestUrl)) return route.continue();
      const host = new URL(requestUrl).host;
      if (!verdicts.has(host)) verdicts.set(host, urlRejection(requestUrl, allowPrivateNetworks));
      return (await verdicts.get(host)) ? route.abort("blockedbyclient") : route.continue();
    });

    const page = await context.newPage();
    // Ad-heavy pages can take 30s+ to fire load; content is usually there long before.
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await waitForDomQuiet(page);
    const extra = await innerScrollExtra(page);
    if (extra > 0) {
      await page.setViewportSize({ width: VIEWPORT.width, height: Math.min(VIEWPORT.height + extra, maxHeight) });
      await waitForDomQuiet(page, 300, 2000);
    }
    await autoScroll(page, maxHeight, scrollBudgetMs);
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.evaluate(() =>
      Promise.all(
        [...document.images].map((img) =>
          img.complete
            ? null
            : new Promise((resolve) => {
                img.onload = img.onerror = resolve;
                setTimeout(resolve, 3000);
              }),
        ),
      ),
    );

    // Extract before hiding overlays so Defuddle sees the page as served.
    await page.addScriptTag({ path: DEFUDDLE_PATH });
    const parsed = await page.evaluate((pageUrl) => {
      const DefuddleCtor = (window as unknown as { Defuddle: new (doc: Document, opts: object) => { parse(): Record<string, unknown> } }).Defuddle;
      const r = new DefuddleCtor(document, { url: pageUrl }).parse();
      return {
        title: String(r.title ?? document.title ?? ""),
        description: String(r.description ?? ""),
        author: String(r.author ?? ""),
        site: String(r.site ?? ""),
        domain: String(r.domain ?? ""),
        published: String(r.published ?? ""),
        image: String(r.image ?? ""),
        favicon: String(r.favicon ?? ""),
        wordCount: Number(r.wordCount ?? 0),
        content: String(r.content ?? ""),
        canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
        bodyText: (document.body?.innerText ?? "").slice(0, 5000),
      };
    }, page.url());

    const finalUrl = page.url();
    const meta: PageMeta = {
      finalUrl,
      canonical: parsed.canonical ? absolute(parsed.canonical, finalUrl) || null : null,
      title: parsed.title,
      description: parsed.description,
      author: parsed.author,
      site: parsed.site,
      domain: parsed.domain || new URL(finalUrl).hostname.replace(/^www\./, ""),
      published: parsed.published,
      image: absolute(parsed.image, finalUrl),
      favicon: absolute(parsed.favicon, finalUrl),
      wordCount: parsed.wordCount,
      httpStatus: response?.status() ?? null,
      truncated: false,
    };

    const blocked = blockReason(meta, parsed.bodyText);
    if (blocked) throw new BlockedError(`Blocked by site: ${blocked}`, meta);

    const markdown = this.turndown.turndown(parsed.content);
    if (style === "none") return { meta, markdown, screenshot: null, screenshotExt: null };

    await hideOverlays(page);
    const type = screenshotFormat;
    const format = type === "jpeg" ? { type, quality: 80 } : { type };
    const ext = type === "jpeg" ? "jpg" : "png";
    if (style === "banner") {
      // First screen only, at the original viewport size even if it was grown for an inner scroller.
      await page.evaluate(() => window.scrollTo(0, 0));
      const screenshot = await page.screenshot({ ...format, clip: { x: 0, y: 0, ...VIEWPORT } });
      return { meta, markdown, screenshot, screenshotExt: ext };
    }

    const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    meta.truncated = height > maxHeight || VIEWPORT.height + extra > maxHeight;
    const screenshot = await page.screenshot({
      fullPage: true,
      ...format,
      ...(meta.truncated ? { clip: { x: 0, y: 0, width: VIEWPORT.width, height: maxHeight } } : {}),
    });

    return { meta, markdown, screenshot, screenshotExt: ext };
  }

  private restart(): void {
    const browser = this.browser;
    this.browser = null;
    void browser?.then((b) => b.close()).catch(() => {});
  }

  async close(): Promise<void> {
    const browser = await this.browser?.catch(() => null);
    await browser?.close();
  }
}
