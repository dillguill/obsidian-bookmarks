import { execFile } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { ShotFormat } from "./shots.js";
import {
  itemFromScripts,
  oembedItem,
  oembedUrl,
  readTikTokScripts,
  scriptsFromHtml,
  transcriptSources,
  vttCues,
  videoUrl,
  type TikTokItem,
  type TikTokPost,
  type TranscriptCue,
} from "./tiktok.js";

const IMAGE_MAX_WIDTH = 2000;
export const VIDEO_MAX_BYTES = 300 * 1024 * 1024;

/**
 * An image as a file, so the note keeps it after the link expires (TikTok's
 * cover links last days). Drawn in a blank page and screenshotted,
 * so it comes out in the screenshot format whatever the source format was.
 * Each of `sources` (mirrors of one image) is tried in turn; null when none
 * loads.
 */
export async function imageFile(context: BrowserContext, sources: readonly string[], format: ShotFormat, maxHeight: number): Promise<Buffer | null> {
  const page = await context.newPage();
  try {
    await page.setContent(`<body style="margin:0"><img style="display:block;width:100%;height:auto"></body>`);
    let size: { width: number; height: number } | null = null;
    for (const src of sources) {
      size = await page.evaluate(
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
      if (size) break;
    }
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
 * A TikTok post's item JSON: from the page, else from its /video/ page (where
 * photo posts keep theirs), else the few fields TikTok's oEmbed API gives
 * (for pages that came back as a login wall). Null when all three fail.
 */
export async function tiktokItem(page: Page, post: TikTokPost): Promise<TikTokItem | null> {
  const fromPage = itemFromScripts(await page.evaluate(readTikTokScripts), post.id);
  if (fromPage) return fromPage;
  const get = (url: string) => tiktokGet(page, url);
  const videoPage = await get(videoUrl(post));
  const fromVideoPage = videoPage ? itemFromScripts(scriptsFromHtml(await videoPage.text()), post.id) : null;
  if (fromVideoPage) return fromVideoPage;
  const oembed = await get(oembedUrl(videoUrl(post)));
  return oembed ? oembedItem(await oembed.json().catch(() => null)) : null;
}

/** A GET with the page's cookies, or null when it fails. */
async function tiktokGet(page: Page, url: string) {
  try {
    const response = await page.context().request.get(url, { timeout: 10_000 });
    return response.ok() ? response : null;
  } catch {
    return null;
  }
}

/** The post's captions, from the first of their mirror URLs that answers; empty when it has none. */
export async function tiktokTranscript(page: Page, item: TikTokItem | null): Promise<TranscriptCue[]> {
  for (const url of transcriptSources(item)) {
    const response = await tiktokGet(page, url);
    const cues = response ? vttCues(await response.text().catch(() => "")) : [];
    if (cues.length) return cues;
  }
  return [];
}

/** What a yt-dlp run made: the video and its cover in the job's folder, or why there's no video. */
export interface YtDlpResult {
  video: string | null;
  cover: string | null;
  /** A TikTok photo post: yt-dlp only gets its music, so the photos must come from the page. */
  slideshow: boolean;
  /** Over the size cap, so skipped. */
  tooLarge: boolean;
  /** yt-dlp's own last error line, when it failed. */
  error: string | null;
}

export interface YtDlpOptions {
  ytdlpPath: string;
  /** The egress proxy every request goes through (see egress-proxy.ts). */
  proxy: string;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Downloads a page's video and cover with yt-dlp into `dir`, as media_video.mp4
 * and media_cover.jpg. Every request goes through the egress proxy, and only
 * yt-dlp's own downloader is used: an external one (ffmpeg, aria2c) would
 * fetch streams itself, past the proxy. ffmpeg only merges and converts files
 * here.
 */
export async function runYtDlp(url: string, dir: string, options: YtDlpOptions): Promise<YtDlpResult> {
  const maxBytes = options.maxBytes ?? VIDEO_MAX_BYTES;
  const args = [
    "--no-playlist",
    "--no-progress",
    "--no-mtime",
    "--no-config",
    "--proxy",
    options.proxy,
    "--downloader",
    "native",
    "--max-filesize",
    String(maxBytes),
    "-f",
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "--write-thumbnail",
    "--convert-thumbnails",
    "jpg",
    "--write-info-json",
    "-o",
    join(dir, "media_video.%(ext)s"),
    "-o",
    `thumbnail:${join(dir, "media_cover.%(ext)s")}`,
    "-o",
    `infojson:${join(dir, "media_info")}`,
    "--",
    url,
  ];
  const run = await new Promise<{ error: string | null }>((resolve) => {
    execFile(options.ytdlpPath, args, { timeout: options.timeoutMs ?? 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const last = String(stderr).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("ERROR:")).pop();
      resolve({ error: err ? (last?.replace(/^ERROR:\s*/, "") ?? (err.killed ? "timed out" : err.message.split("\n")[0]!)) : null });
    });
  });
  const files = await readdir(dir).catch(() => [] as string[]);
  const info = (await readFile(join(dir, "media_info.info.json"), "utf8").then(JSON.parse, () => null)) as {
    vcodec?: string;
    filesize?: number;
    filesize_approx?: number;
    extractor_key?: string;
  } | null;
  await rm(join(dir, "media_info.info.json"), { force: true });
  const video = files.find((f) => /^media_video\.[a-z0-9]+$/.test(f) && !f.endsWith(".part")) ?? null;
  const cover = files.includes("media_cover.jpg") ? join(dir, "media_cover.jpg") : null;
  const audioOnly = info?.vcodec === "none";
  const slideshow = audioOnly && /tiktok/i.test(info?.extractor_key ?? "");
  // A photo post's music, or a leftover from a failed merge: not the video.
  if (video && (audioOnly || !video.endsWith(".mp4"))) await rm(join(dir, video), { force: true });
  const size = info?.filesize ?? info?.filesize_approx ?? 0;
  return {
    video: video && !audioOnly && video.endsWith(".mp4") ? join(dir, video) : null,
    cover,
    slideshow,
    tooLarge: !video && size > maxBytes,
    error: run.error,
  };
}

/** yt-dlp's version, or null when it isn't installed (video downloads are then off). */
export async function ytdlpVersion(ytdlpPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(ytdlpPath, ["--version"], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}
