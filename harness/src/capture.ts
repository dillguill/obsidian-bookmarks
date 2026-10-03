import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import TurndownService from "turndown";
import { CAPTURE_FILES, fileMarker, type CaptureFile, type PageMeta, type RenderedNote } from "./api.js";
import type { Config } from "./config.js";
import { bookmarkUrl, CLIPPER_BUNDLE_PATH, type RenderRequest } from "./render.js";
import { urlRejection } from "./ssrf.js";
import { noTikTokVariables, oembedItem, oembedUrl, readTikTokItem, tiktokData, tiktokPost, type TikTokItem } from "./tiktok.js";

const require = createRequire(import.meta.url);
const DEFUDDLE_PATH = require.resolve("defuddle/full");
const VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const THUMBNAIL_WIDTH = 480;
const IMAGE_MAX_WIDTH = 2000;

/**
 * Capture files are template variables: make only the ones the rendered note uses.
 * Without a rendered note the plugin falls back to its default template, which shows the page shot.
 */
export function filesWanted(note: RenderedNote | null): Set<CaptureFile> {
  if (!note) return new Set(["screenshot_page"]);
  const text = [note.noteName, note.path, note.frontmatter, note.content].join("\n");
  return new Set(CAPTURE_FILES.filter((kind) => text.includes(fileMarker(kind))));
}

export interface CaptureResult {
  meta: PageMeta;
  markdown: string;
  /** The capture files the rendered note uses; screenshot_article is missing when the page has no main content block. */
  files: Partial<Record<CaptureFile, Buffer>>;
  /** Extension of the screenshots in `files`; null when there are none. */
  screenshotExt: "jpg" | "png" | null;
  /** Null when no render was requested or Web Clipper's engine failed on the page. */
  note: RenderedNote | null;
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
  capture(url: string, render?: RenderRequest | null): Promise<CaptureResult>;
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
  | "timezone"
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

/**
 * Renders the note with Obsidian Web Clipper's own engine on the live page, so
 * templates behave as they do in Web Clipper. A failure here falls back to the
 * plugin's simpler renderer rather than failing the capture.
 */
async function renderNote(page: Page, render: RenderRequest, url: string): Promise<RenderedNote | null> {
  try {
    await page.addScriptTag({ path: CLIPPER_BUNDLE_PATH });
    return await page.evaluate(
      ({ request, pageUrl }) => {
        const clipper = (globalThis as unknown as { __bookmarksClipper: { clipPage(o: object): Promise<RenderedNote> } }).__bookmarksClipper;
        return clipper.clipPage({ ...request, url: pageUrl });
      },
      { request: render, pageUrl: url },
    );
  } catch (err) {
    console.warn(`render failed for ${url}: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
    return null;
  }
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

/**
 * The page as an A4 PDF. Lazy images are loaded first (Chromium doesn't load
 * them for print), and fixed or sticky headers become static so they don't
 * cover text on every page; both only affect print, not later screenshots.
 */
async function pagePdf(page: Page): Promise<Buffer> {
  await page.evaluate(() =>
    Promise.all(
      [...document.images].map((img) => {
        img.loading = "eager";
        return img.complete
          ? null
          : new Promise((resolve) => {
              img.onload = img.onerror = resolve;
              setTimeout(resolve, 3000);
            });
      }),
    ),
  );
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const position = getComputedStyle(el).position;
      if (position === "fixed" || position === "sticky") el.setAttribute("data-bookmarks-pinned", "");
    }
    const style = document.createElement("style");
    style.textContent = "@media print { [data-bookmarks-pinned] { position: static !important; } }";
    document.head.append(style);
  });
  await page.emulateMedia({ media: null });
  return page.pdf({ format: "A4", printBackground: true });
}

/** The first screen scaled down to THUMBNAIL_WIDTH, through CDP since Playwright can't scale a screenshot. */
async function thumbnail(page: Page, type: "jpeg" | "png"): Promise<Buffer> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: type,
      ...(type === "jpeg" ? { quality: 80 } : {}),
      clip: { x: 0, y: 0, ...VIEWPORT, scale: THUMBNAIL_WIDTH / VIEWPORT.width },
    });
    return Buffer.from(data, "base64");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * The page's main content block: the article/main element with the most text,
 * or a smaller one inside it that holds nearly all of that text. Null when the
 * page has none.
 */
async function articleShot(page: Page, format: { type: "jpeg" | "png"; quality?: number }, maxHeight: number): Promise<Buffer | null> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll<HTMLElement>('article, [itemprop="articleBody"], main, [role="main"]')]
      .map((el) => {
        let rect = el.getBoundingClientRect();
        // display: contents (MDN's <main>) has no box of its own; measure what it holds.
        if (rect.width === 0 && rect.height === 0) {
          const range = document.createRange();
          range.selectNodeContents(el);
          rect = range.getBoundingClientRect();
        }
        return { el, rect, text: (el.innerText ?? "").length };
      })
      .filter((b) => b.rect.width >= 200 && b.rect.height >= 200 && b.text > 0)
      .sort((a, b) => b.text - a.text);
    let best = blocks[0];
    if (!best) return null;
    for (const b of blocks) {
      if (b.el !== best.el && best.el.contains(b.el) && b.text >= best.text * 0.8) best = b;
    }
    const { left, top, width, height } = best.rect;
    return { x: Math.max(0, left + window.scrollX), y: Math.max(0, top + window.scrollY), width, height };
  });
  if (!box) return null;
  return page.screenshot({ ...format, fullPage: true, clip: { ...box, height: Math.min(box.height, maxHeight) } });
}

/**
 * An image as a file, so the note keeps it after the link expires (TikTok's
 * cover links last days). Drawn in a blank page and screenshotted,
 * so it comes out in the screenshot format whatever the source format was.
 * Null when it doesn't load.
 */
async function imageFile(context: BrowserContext, src: string, format: { type: "jpeg" | "png"; quality?: number }, maxHeight: number): Promise<Buffer | null> {
  const page = await context.newPage();
  try {
    await page.setContent(`<body style="margin:0"><img style="display:block;width:100%;height:auto"></body>`);
    const size = await page.evaluate(
      (url) =>
        new Promise<{ width: number; height: number } | null>((resolve) => {
          const img = document.querySelector("img")!;
          const done = () => resolve(img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
          img.onload = img.onerror = done;
          setTimeout(done, 10_000);
          img.src = url;
        }),
      src,
    );
    if (!size) return null;
    const width = Math.min(size.width, IMAGE_MAX_WIDTH);
    const height = Math.min(Math.round((size.height * width) / size.width), maxHeight);
    await page.setViewportSize({ width, height });
    return await page.screenshot(format);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * A TikTok post's item from TikTok's oEmbed API, for when the page came back
 * without its item JSON (TikTok serves some visitors a login wall). Null on
 * any failure.
 */
async function tiktokOembed(page: Page, postUrl: string): Promise<TikTokItem | null> {
  try {
    const response = await page.context().request.get(oembedUrl(postUrl), { timeout: 10_000 });
    return response.ok() ? oembedItem(await response.json()) : null;
  } catch {
    return null;
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

  async capture(url: string, render: RenderRequest | null = null): Promise<CaptureResult> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      acceptDownloads: false,
      // Strict CSPs (GitHub, MDN) otherwise refuse the injected Defuddle script.
      bypassCSP: true,
      userAgent: this.options.userAgent,
      locale: "en-US",
      // Web Clipper's engine formats {{date}} in the page's time zone.
      timezoneId: this.options.timezone,
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    // tsx/esbuild (npm run dev) wraps functions in __name(), which page.evaluate
    // then calls inside the page; define it there as a no-op.
    await context.addInitScript({ content: "globalThis.__name ??= (fn) => fn;" });
    try {
      // A timed-out page can leave Chromium wedged for every later context, so
      // restart the browser rather than just closing this context.
      return await withTimeout(this.run(context, url, render), this.options.captureTimeoutMs, () => void this.restart());
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async run(context: BrowserContext, url: string, render: RenderRequest | null): Promise<CaptureResult> {
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
        title: String(r.title || document.title || ""),
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
        ...pageData(),
      };

      /** JSON-LD objects and meta tags for Web Clipper's {{schema:…}} and {{meta:…}} variables. */
      function pageData() {
        const schema: unknown[] = [];
        let budget = 200_000;
        const add = (value: unknown) => {
          if (Array.isArray(value)) return value.forEach(add);
          if (!value || typeof value !== "object") return;
          const size = JSON.stringify(value).length;
          if (size > budget) return;
          budget -= size;
          schema.push(value);
          const graph = (value as { "@graph"?: unknown })["@graph"];
          if (graph) add(graph);
        };
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            add(JSON.parse(script.textContent ?? ""));
          } catch {
            // malformed JSON-LD is common; skip it
          }
        }
        const metaTags: Record<string, string> = {};
        for (const el of document.querySelectorAll<HTMLMetaElement>("meta[name], meta[property]")) {
          const key = el.hasAttribute("property") ? `property:${el.getAttribute("property")}` : `name:${el.getAttribute("name")}`;
          const content = el.content?.trim();
          if (content && !(key in metaTags) && Object.keys(metaTags).length < 300) metaTags[key] = content.slice(0, 2000);
        }
        return { schema, metaTags };
      }
    }, page.url());

    const finalUrl = page.url();
    const post = tiktokPost(finalUrl);
    const tiktok = post ? tiktokData(post, (await page.evaluate(readTikTokItem, post.id)) ?? (await tiktokOembed(page, finalUrl))) : null;
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
      schema: parsed.schema,
      metaTags: parsed.metaTags,
    };

    const blocked = blockReason(meta, parsed.bodyText);
    if (blocked) throw new BlockedError(`Blocked by site: ${blocked}`, meta);

    const markdown = this.turndown.turndown(parsed.content);
    const note = render
      ? await renderNote(page, { ...render, extra: { ...render.extra, ...(tiktok?.variables ?? noTikTokVariables()) } }, bookmarkUrl(meta))
      : null;
    const wanted = filesWanted(note);
    const files: Partial<Record<CaptureFile, Buffer>> = {};
    if (wanted.size === 0) return { meta, markdown, files, screenshotExt: null, note };

    await hideOverlays(page);
    const type = screenshotFormat;
    const format = type === "jpeg" ? { type, quality: 80 } : { type };
    const ext = type === "jpeg" ? "jpg" : "png";
    // At the original viewport size even if it was grown for an inner scroller.
    const firstScreen = async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      return page.screenshot({ ...format, clip: { x: 0, y: 0, ...VIEWPORT } });
    };
    /** Desktop shots in one color scheme; `suffix` is "" or "_dark". */
    const desktopShots = async (suffix: "" | "_dark") => {
      const want = (type: string) => wanted.has(`screenshot_${type}${suffix}` as CaptureFile);
      const put = (type: string, data: Buffer | null) => {
        if (data) files[`screenshot_${type}${suffix}` as CaptureFile] = data;
      };
      if (want("banner")) put("banner", await firstScreen());
      if (want("thumbnail")) put("thumbnail", await thumbnail(page, type));
      if (want("article")) put("article", await articleShot(page, format, maxHeight));
      if (want("page")) {
        const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
        meta.truncated = height > maxHeight || VIEWPORT.height + extra > maxHeight;
        put(
          "page",
          await page.screenshot({
            fullPage: true,
            ...format,
            ...(meta.truncated ? { clip: { x: 0, y: 0, width: VIEWPORT.width, height: maxHeight } } : {}),
          }),
        );
      }
    };
    const mobileShot = async (suffix: "" | "_dark") => {
      if (!wanted.has(`screenshot_mobile${suffix}`)) return;
      await page.evaluate(() => window.scrollTo(0, 0));
      files[`screenshot_mobile${suffix}`] = await page.screenshot({ ...format, clip: { x: 0, y: 0, ...MOBILE_VIEWPORT } });
    };
    const darkMode = async (on: boolean) => {
      await page.emulateMedia({ colorScheme: on ? "dark" : "light" });
      await waitForDomQuiet(page, 300, 2000);
    };
    const anyDark = [...wanted].some((kind) => kind.endsWith("_dark"));

    await desktopShots("");
    if (wanted.has("pdf_page")) files.pdf_page = await pagePdf(page);
    if (anyDark) {
      await darkMode(true);
      await desktopShots("_dark");
    }
    // Last: the layout reflows at phone width.
    if (wanted.has("screenshot_mobile") || wanted.has("screenshot_mobile_dark")) {
      await page.setViewportSize(MOBILE_VIEWPORT);
      await waitForDomQuiet(page, 300, 2000);
      // Still in dark mode if any dark shot was wanted, so take that one first.
      if (anyDark) await mobileShot("_dark");
      if (wanted.has("screenshot_mobile")) {
        if (anyDark) await darkMode(false);
        await mobileShot("");
      }
    }
    for (const [kind, src] of [["image_local", meta.image], ["tiktok_thumbnail", tiktok?.cover]] as const) {
      if (!wanted.has(kind) || !src) continue;
      const image = await imageFile(page.context(), src, format, maxHeight);
      if (image) files[kind] = image;
    }
    const hasImage = CAPTURE_FILES.some((kind) => kind !== "pdf_page" && files[kind]);
    return { meta, markdown, files, screenshotExt: hasImage ? ext : null, note };
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
