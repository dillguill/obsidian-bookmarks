import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import TurndownService from "turndown";
import { urlRejection } from "./ssrf.js";
import { CAPTURE_FILES, fileExt, fileMarker, type CaptureFile, type PageMeta, type RenderedNote } from "./api.js";
import type { Config } from "./config.js";
import { imageFile, tiktokItem, tiktokTranscript } from "./media.js";
import { hideOverlays, prepareForShots, VIEWPORT, waitForDomQuiet } from "./page.js";
import { bookmarkUrl, CLIPPER_BUNDLE_PATH, type RenderRequest } from "./render.js";
import { takeShots, type ShotFormat } from "./shots.js";
import { MEDIA_FILES, noteWithRemoteMedia, type RemoteMedia } from "./remote-media.js";
import { itemFromScripts, noTikTokVariables, readTikTokScripts, tiktokData, tiktokPost, videoEmbed, type TikTokData } from "./tiktok.js";

const require = createRequire(import.meta.url);
const DEFUDDLE_PATH = require.resolve("defuddle/full");

/**
 * Capture files are template variables: make only the ones the rendered note uses.
 * Without a rendered note the plugin falls back to its default template, which shows the page shot.
 * `extra` are asked for by name (enriching an existing note offers them as choices).
 */
export function filesWanted(note: RenderedNote | null, extra: readonly CaptureFile[] = []): Set<CaptureFile> {
  if (!note) return new Set(["screenshot_page", ...extra]);
  const text = [note.noteName, note.path, note.frontmatter, note.content].join("\n");
  return new Set(CAPTURE_FILES.filter((kind) => text.includes(fileMarker(kind)) || extra.includes(kind)));
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

/** Called as a capture goes: once with the page's text and rendered note, then with each capture file as it's made. */
export interface CaptureProgress {
  page(meta: PageMeta, markdown: string, note: RenderedNote | null): void;
  file(kind: CaptureFile, data: Buffer, ext: "jpg" | "png"): void;
}

/**
 * A page kept open after a preview: its note can be rendered again with
 * another template, and its screenshots taken, without loading it again.
 */
export interface HeldPage {
  meta: PageMeta;
  markdown: string;
  note: RenderedNote | null;
  /** The note rendered with another template. */
  render(templateName: string): Promise<RenderedNote | null>;
  /** Takes screenshot and PDF files, handing each to `put` as it's made; scrolls the page the first time so lazy content is in them. */
  files(kinds: readonly CaptureFile[], put: (kind: CaptureFile, data: Buffer, ext: "jpg" | "png") => void): Promise<{ screenshotExt: "jpg" | "png" | null }>;
  close(): Promise<void>;
}

export interface CaptureEngine {
  capture(url: string, render?: RenderRequest | null, progress?: CaptureProgress): Promise<CaptureResult>;
  /** Reads the page and renders its note as soon as it settles, without media, and keeps it open. */
  preview(url: string, render: RenderRequest): Promise<HeldPage>;
  /** A TikTok photo post's photos (in order) and cover, as image files; for "Download media". */
  tiktokPhotos(url: string, cover: boolean): Promise<{ photos: Buffer[]; cover: Buffer | null; ext: "jpg" | "png" }>;
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

function absolute(value: string | null | undefined, base: string): string {
  if (!value) return "";
  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

/** What reading a loaded page gives: its details and readable text, plus a TikTok post's data. */
interface PageRead {
  meta: PageMeta;
  markdown: string;
  tiktok: TikTokData | null;
  /** The TikTok post's id, when it is one. */
  tiktokId: string | null;
}

/** Where a page's media lives on the web, for notes that don't download it. */
function remoteMedia(read: PageRead): RemoteMedia {
  const images: RemoteMedia["images"] = {};
  if (read.meta.image) images.image_local = read.meta.image;
  if (read.tiktok?.cover[0]) images.tiktok_thumbnail = read.tiktok.cover[0];
  read.tiktok?.images.forEach((sources, i) => {
    if (sources[0]) images[`tiktok_image_${i + 1}` as CaptureFile] = sources[0];
  });
  return { player: read.tiktokId ? videoEmbed(read.tiktokId) : "", images };
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

  async capture(url: string, render: RenderRequest | null = null, progress?: CaptureProgress): Promise<CaptureResult> {
    const context = await this.openContext();
    try {
      // A timed-out page can leave Chromium wedged for every later context, so
      // restart the browser rather than just closing this context.
      return await withTimeout(this.run(context, url, render, progress), this.options.captureTimeoutMs, () => void this.restart());
    } finally {
      await context.close().catch(() => {});
    }
  }

  /** A fresh browser context for one capture. */
  private async openContext(): Promise<BrowserContext> {
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
      if (!verdicts.has(host)) verdicts.set(host, urlRejection(requestUrl, this.options.allowPrivateNetworks));
      return (await verdicts.get(host)) ? route.abort("blockedbyclient") : route.continue();
    });
    return context;
  }

  /**
   * Opens the page and waits for it to settle. Ad-heavy pages can take 30s+ to
   * fire load; content is usually there long before. `quick` (previews) skips
   * waiting for the network to go quiet.
   */
  private async load(context: BrowserContext, url: string, quick = false): Promise<{ page: Page; status: number | null }> {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const status = response?.status() ?? null;
    // A TikTok post's data is in the page as soon as it's parsed; its load event
    // takes ~8s more and its DOM never goes quiet, so a preview stops here.
    const post = quick ? tiktokPost(page.url()) : null;
    if (post && itemFromScripts(await page.evaluate(readTikTokScripts), post.id)) return { page, status };
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
    if (!quick) await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await waitForDomQuiet(page);
    return { page, status };
  }

  /**
   * Reads the page as served (before overlays are hidden): Defuddle's details
   * and text, TikTok's data, and a bot-wall check. `media` false means the
   * capture won't download the post's media (see tiktokData).
   */
  private async read(page: Page, status: number | null, media = true): Promise<PageRead> {
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
    const item = post ? await tiktokItem(page, post) : null;
    const tiktok = post ? tiktokData(post, item, await tiktokTranscript(page, item), media) : null;
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
      httpStatus: status,
      truncated: false,
      schema: parsed.schema,
      metaTags: parsed.metaTags,
    };
    const blocked = blockReason(meta, parsed.bodyText);
    if (blocked) throw new BlockedError(`Blocked by site: ${blocked}`, meta);
    return { meta, markdown: this.turndown.turndown(parsed.content), tiktok, tiktokId: post?.id ?? null };
  }

  /** The note rendered with a template, with the TikTok variables (empty off TikTok). */
  private render(page: Page, render: RenderRequest, read: PageRead): Promise<RenderedNote | null> {
    return renderNote(page, { ...render, extra: { ...render.extra, ...(read.tiktok?.variables ?? noTikTokVariables()) } }, bookmarkUrl(read.meta));
  }

  private shotFormat(): { format: ShotFormat; ext: "jpg" | "png" } {
    const type = this.options.screenshotFormat;
    return { format: type === "jpeg" ? { type, quality: 80 } : { type }, ext: type === "jpeg" ? "jpg" : "png" };
  }

  /**
   * Takes the wanted screenshots and PDF from a page made ready for shots,
   * handing each to `put` as it's made. Returns whether the full-page shot was
   * cut short.
   */
  private async shoot(
    page: Page,
    wanted: ReadonlySet<CaptureFile>,
    read: PageRead,
    viewportExtra: number,
    put: (kind: CaptureFile, data: Buffer) => void,
  ): Promise<boolean> {
    const { maxHeight } = this.options;
    const { format } = this.shotFormat();
    await hideOverlays(page);
    const { truncated } = await takeShots(page, wanted, { format, maxHeight, viewportExtra }, put);
    return truncated;
  }

  async preview(url: string, render: RenderRequest): Promise<HeldPage> {
    const context = await this.openContext();
    try {
      const { page, read, note } = await withTimeout(
        (async () => {
          const { page, status } = await this.load(context, url, true);
          const read = await this.read(page, status, false);
          const rendered = await this.render(page, render, read);
          return { page, read, note: rendered && noteWithRemoteMedia(rendered, remoteMedia(read)) };
        })(),
        this.options.captureTimeoutMs,
        () => void this.restart(),
      );
      const { ext } = this.shotFormat();
      let viewportExtra: number | null = null;
      // One thing at a time on the page: a render mid-screenshot would see a half-scrolled page.
      let queue: Promise<unknown> = Promise.resolve();
      const serial = <T>(task: () => Promise<T>): Promise<T> => {
        const next = queue.then(task, task);
        queue = next.catch(() => {});
        return next;
      };
      return {
        meta: read.meta,
        markdown: read.markdown,
        note,
        render: (templateName) =>
          serial(async () => {
            const rendered = await this.render(page, { ...render, templateName }, read);
            return rendered && noteWithRemoteMedia(rendered, remoteMedia(read));
          }),
        files: (kinds, put) =>
          serial(async () => {
            const wanted = new Set(kinds.filter((kind) => !MEDIA_FILES.includes(kind)));
            if (!wanted.size) return { screenshotExt: null };
            viewportExtra ??= await prepareForShots(page, this.options.maxHeight, this.options.scrollBudgetMs);
            let made = false;
            read.meta.truncated = await this.shoot(page, wanted, read, viewportExtra, (kind, data) => {
              made ||= fileExt(kind, ext) === ext;
              put(kind, data, ext);
            });
            return { screenshotExt: made ? ext : null };
          }),
        close: () => context.close().catch(() => {}),
      };
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  }

  /**
   * The capture: the page's text, its note, and the screenshots the note uses.
   * Media (the page image, a TikTok post's video, photos and cover) isn't
   * downloaded; the note points at it on the web until "Download media".
   */
  private async run(context: BrowserContext, url: string, render: RenderRequest | null, progress?: CaptureProgress): Promise<CaptureResult> {
    const { maxHeight, scrollBudgetMs } = this.options;
    const { page, status } = await this.load(context, url);
    // Lazy content loads before the page is read, so full captures get all of it.
    const extra = await prepareForShots(page, maxHeight, scrollBudgetMs);
    const read = await this.read(page, status, false);
    const { meta, markdown } = read;
    const rendered = render ? await this.render(page, render, read) : null;
    const note = rendered && noteWithRemoteMedia(rendered, remoteMedia(read));
    progress?.page(meta, markdown, note);
    const wanted = new Set([...filesWanted(note, render?.files)].filter((kind) => !MEDIA_FILES.includes(kind)));
    if (wanted.size === 0) return { meta, markdown, files: {}, screenshotExt: null, note };

    const { ext } = this.shotFormat();
    const files: Partial<Record<CaptureFile, Buffer>> = {};
    meta.truncated = await this.shoot(page, wanted, read, extra, (kind, data) => {
      files[kind] = data;
      progress?.file(kind, data, ext);
    });
    const hasImage = CAPTURE_FILES.some((kind) => fileExt(kind, ext) === ext && files[kind]);
    return { meta, markdown, files, screenshotExt: hasImage ? ext : null, note };
  }

  async tiktokPhotos(url: string, cover: boolean): Promise<{ photos: Buffer[]; cover: Buffer | null; ext: "jpg" | "png" }> {
    const context = await this.openContext();
    try {
      return await withTimeout(
        (async () => {
          const { page } = await this.load(context, url, true);
          const post = tiktokPost(page.url());
          if (!post) throw new Error("not a TikTok post");
          const item = await tiktokItem(page, post);
          if (!item) throw new Error("the post is unavailable (deleted, private or behind a login)");
          const data = tiktokData(post, item);
          const { format, ext } = this.shotFormat();
          const photos: Buffer[] = [];
          for (const sources of data.images) {
            const image = await imageFile(context, sources, format, this.options.maxHeight);
            if (image) photos.push(image);
          }
          const coverImage = cover && data.cover.length ? await imageFile(context, data.cover, format, this.options.maxHeight) : null;
          return { photos, cover: coverImage, ext };
        })(),
        this.options.captureTimeoutMs,
        () => void this.restart(),
      );
    } finally {
      await context.close().catch(() => {});
    }
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
