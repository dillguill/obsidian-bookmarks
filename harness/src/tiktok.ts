import { fileMarker, TIKTOK_IMAGE_MAX } from "./api.js";

// TikTok video pages carry little useful metadata in their HTML: no
// published date, a generic "<creator> on TikTok" title and an image-less
// body, so Defuddle (and Web Clipper) see almost nothing. The video's details
// are in the JSON TikTok embeds for hydration; this reads them into
// tiktok_* variables, leaving Web Clipper's own variables as they are.

/** TikTok's variables; empty on other sites so templates can use them freely. */
export const TIKTOK_VARIABLES = [
  "tiktok_id",
  "tiktok_title",
  "tiktok_description",
  "tiktok_published",
  "tiktok_author",
  "tiktok_author_handle",
  "tiktok_embed",
  "tiktok_images",
  "tiktok_save",
  "tiktok_image_count",
  "tiktok_transcript",
  "tiktok_transcript_timestamps",
] as const;
export type TikTokVariable = (typeof TIKTOK_VARIABLES)[number];

export interface TikTokData {
  variables: Record<TikTokVariable, string>;
  /** Cover image URLs (TikTok's mirrors of one image), saved as the tiktok_thumbnail file since they expire; empty when unknown. */
  cover: string[];
  /** A photo post's carousel images in order, each as its mirror URLs, saved as tiktok_image_1… files. */
  images: string[][];
  /** A video post's MP4 URLs (mirrors of one video), saved as the tiktok_video file; empty for photo posts. */
  video: string[];
}

/** A TikTok post as its URL names it. */
export interface TikTokPost {
  id: string;
  handle: string;
  kind: "video" | "photo";
}

/** The parts of TikTok's item JSON used here. */
export interface TikTokItem {
  id?: string;
  desc?: string;
  createTime?: number | string;
  author?: { uniqueId?: string; nickname?: string };
  video?: {
    cover?: string;
    originCover?: string;
    playAddr?: string;
    bitrateInfo?: { PlayAddr?: { UrlList?: string[] } }[];
    subtitleInfos?: { Url?: string; LanguageCodeName?: string; Format?: string; Source?: string }[];
    claInfo?: {
      originalLanguageInfo?: { language?: string };
      captionInfos?: { url?: string; urlList?: string[]; language?: string; captionFormat?: string; isOriginalCaption?: boolean }[];
    };
  };
  imagePost?: { cover?: TikTokImage; images?: TikTokImage[] };
}

interface TikTokImage {
  imageURL?: { urlList?: string[] };
}

const POST_PATH = /^\/@([^/]+)\/(video|photo)\/(\d+)/;
const TITLE_MAX = 100;

/** The id, handle and kind of a TikTok video or photo post URL, else null. */
export function tiktokPost(url: string): TikTokPost | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return null;
    const match = POST_PATH.exec(u.pathname);
    return match ? { handle: decodeURIComponent(match[1]!), kind: match[2] as "video" | "photo", id: match[3]! } : null;
  } catch {
    return null;
  }
}

/**
 * The post's /video/ URL. TikTok serves photo posts' data only there: their
 * /photo/ page and oEmbed come back empty.
 */
export function videoUrl(post: TikTokPost): string {
  return `https://www.tiktok.com/@${encodeURIComponent(post.handle)}/video/${post.id}`;
}

/** TikTok ids start with the post's Unix time in their top 32 bits. */
export function idTime(id: string): Date | null {
  try {
    const seconds = Number(BigInt(id) >> 32n);
    return seconds > 1_400_000_000 ? new Date(seconds * 1000) : null;
  } catch {
    return null;
  }
}

/** The embed Obsidian renders as a playable video, or a swipeable carousel for photo posts. */
export function videoEmbed(id: string): string {
  return `<iframe\nsrc="https://www.tiktok.com/player/v1/${id}?autoplay=0"\nallow="fullscreen"\nstyle="width:100%;height:50vh;"\n/>`;
}

/** The caption's first line without trailing hashtags, cut at a word near TITLE_MAX characters. */
export function captionTitle(caption: string): string {
  const line = (caption.split("\n").find((l) => l.trim()) ?? "").replace(/(\s*#[^\s#]+)+\s*$/u, "").trim();
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** TikTok's variables, all empty, for pages that aren't TikTok posts. */
export function noTikTokVariables(): Record<TikTokVariable, string> {
  return Object.fromEntries(TIKTOK_VARIABLES.map((name) => [name, ""])) as Record<TikTokVariable, string>;
}

/** A caption line and when it starts, in seconds. */
export interface TranscriptCue {
  start: number;
  text: string;
}

/**
 * URLs of the post's captions in the language spoken (TikTok's mirrors of one
 * WebVTT file), else of the first captions it has; empty when there are none.
 */
export function transcriptSources(item: TikTokItem | null): string[] {
  const cla = item?.video?.claInfo;
  const captions = (cla?.captionInfos ?? []).filter((c) => !c.captionFormat || c.captionFormat === "webvtt");
  const caption = captions.find((c) => c.isOriginalCaption) ?? captions[0];
  const fromCla = caption ? [...(caption.urlList ?? []), caption.url ?? ""] : [];
  const subtitles = (item?.video?.subtitleInfos ?? []).filter((s) => !s.Format || s.Format === "webvtt");
  const original = cla?.originalLanguageInfo?.language;
  const subtitle =
    subtitles.find((s) => original && s.LanguageCodeName === original) ?? subtitles.find((s) => s.Source === "ASR") ?? subtitles[0];
  return [...new Set([...fromCla, subtitle?.Url ?? ""].filter(Boolean))];
}

/** A WebVTT file's cues, without markup and without a cue that repeats the one before. */
export function vttCues(vtt: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  for (const block of vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const time = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(lines[timing]!);
    if (!time) continue;
    const text = lines
      .slice(timing + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === cues.at(-1)?.text) continue;
    const start = Number(time[1] ?? 0) * 3600 + Number(time[2]) * 60 + Number(time[3]) + Number(time[4]!.padEnd(3, "0")) / 1000;
    cues.push({ start, text });
  }
  return cues;
}

/** Seconds as m:ss, or h:mm:ss from an hour on. */
function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/**
 * TikTok's variables for a post. `item` is null when no item JSON was found;
 * the id still gives the date and the embed. `transcript` is the captions'
 * cues, saved now since their links expire.
 */
export function tiktokData(post: TikTokPost, item: TikTokItem | null, transcript: TranscriptCue[] = []): TikTokData {
  const caption = (item?.desc ?? "").trim();
  const created = Number(item?.createTime);
  const date = Number.isFinite(created) && created > 0 ? new Date(created * 1000) : idTime(post.id);
  const urls = (image: TikTokImage | undefined) => (image?.imageURL?.urlList ?? []).filter(Boolean);
  const images = (item?.imagePost?.images ?? []).map(urls).filter((list) => list.length).slice(0, TIKTOK_IMAGE_MAX);
  const videoCover = [item?.video?.cover, item?.video?.originCover].filter((url): url is string => Boolean(url));
  // playAddr is the version TikTok plays on the web; bitrateInfo lists it again with its mirrors.
  const video = images.length
    ? []
    : [...new Set([item?.video?.playAddr ?? "", ...(item?.video?.bitrateInfo ?? []).flatMap((rate) => rate.PlayAddr?.UrlList ?? [])].filter(Boolean))];
  // Each marker becomes the saved file's vault path, as with any capture file.
  const photos = images.map((_, i) => `![[${fileMarker(`tiktok_image_${i + 1}`)}]]`).join("\n");
  return {
    variables: {
      tiktok_id: post.id,
      tiktok_title: captionTitle(caption),
      tiktok_description: caption,
      tiktok_published: date?.toISOString() ?? "",
      tiktok_author: item?.author?.nickname?.trim() ?? "",
      tiktok_author_handle: item?.author?.uniqueId?.trim() || post.handle,
      tiktok_embed: videoEmbed(post.id),
      tiktok_images: photos,
      // The post saved in the vault: its video, or a carousel's photos.
      tiktok_save: video.length ? `![[${fileMarker("tiktok_video")}]]` : photos,
      tiktok_image_count: images.length ? String(images.length) : "",
      tiktok_transcript: transcript.map((cue) => cue.text).join(" "),
      tiktok_transcript_timestamps: transcript.map((cue) => `[${clock(cue.start)}] ${cue.text}`).join("\n"),
    },
    cover: videoCover.length ? videoCover : urls(item?.imagePost?.cover),
    images,
    video,
  };
}

/** TikTok's oEmbed endpoint for a post URL. */
export function oembedUrl(postUrl: string): string {
  return `https://www.tiktok.com/oembed?url=${encodeURIComponent(postUrl)}`;
}

/**
 * The item fields TikTok's oEmbed reply carries: caption, creator and cover,
 * but no post time (tiktokData then takes it from the id). For pages that
 * came back as a login wall without the item JSON.
 */
export function oembedItem(reply: unknown): TikTokItem | null {
  if (!reply || typeof reply !== "object") return null;
  const r = reply as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const item: TikTokItem = {
    desc: text(r.title),
    author: { nickname: text(r.author_name), uniqueId: text(r.author_unique_id) },
    video: { cover: text(r.thumbnail_url) },
  };
  return item.desc || item.author?.nickname || item.video?.cover ? item : null;
}

/** The text of TikTok's hydration scripts. */
export interface TikTokScripts {
  universal: string | null;
  sigi: string | null;
}

/** Runs in the page: the hydration scripts' text. Self-contained for page.evaluate. */
export function readTikTokScripts(): TikTokScripts {
  return {
    universal: document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent ?? null,
    sigi: document.getElementById("SIGI_STATE")?.textContent ?? null,
  };
}

/** The hydration scripts' text from a page's HTML. */
export function scriptsFromHtml(html: string): TikTokScripts {
  const script = (id: string) => new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`).exec(html)?.[1] ?? null;
  return { universal: script("__UNIVERSAL_DATA_FOR_REHYDRATION__"), sigi: script("SIGI_STATE") };
}

/** The post's item JSON from TikTok's hydration scripts, or null. */
export function itemFromScripts({ universal, sigi }: TikTokScripts, id: string): TikTokItem | null {
  const json = (text: string | null): unknown => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  type Scope = Record<string, { itemInfo?: { itemStruct?: TikTokItem } } | undefined>;
  const data = json(universal) as { __DEFAULT_SCOPE__?: Scope } | null;
  for (const entry of Object.values(data?.__DEFAULT_SCOPE__ ?? {})) {
    const item = entry?.itemInfo?.itemStruct;
    if (item && String(item.id) === id) return item;
  }
  // Older pages.
  return (json(sigi) as { ItemModule?: Record<string, TikTokItem> } | null)?.ItemModule?.[id] ?? null;
}
