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
] as const;
export type TikTokVariable = (typeof TIKTOK_VARIABLES)[number];

export interface TikTokData {
  variables: Record<TikTokVariable, string>;
  /** Cover image URL, saved as the tiktok_thumbnail file since it expires; empty when unknown. */
  cover: string;
}

/** The parts of TikTok's item JSON used here. */
export interface TikTokItem {
  id?: string;
  desc?: string;
  createTime?: number | string;
  author?: { uniqueId?: string; nickname?: string };
  video?: { cover?: string; originCover?: string };
  imagePost?: { cover?: { imageURL?: { urlList?: string[] } } };
}

const VIDEO_PATH = /^\/@[^/]+\/(video|photo)\/(\d+)/;
const TITLE_MAX = 100;

/** The post id and kind of a TikTok video or photo post URL, else null. */
export function tiktokPost(url: string): { id: string; kind: "video" | "photo" } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return null;
    const match = VIDEO_PATH.exec(u.pathname);
    return match ? { id: match[2]!, kind: match[1] as "video" | "photo" } : null;
  } catch {
    return null;
  }
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

/** The embed Obsidian renders as a playable video. */
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

/**
 * TikTok's variables for a post. `item` is null when the page had no item
 * JSON; the id in the URL still gives the date and the embed.
 */
export function tiktokData(post: { id: string; kind: "video" | "photo" }, item: TikTokItem | null): TikTokData {
  const caption = (item?.desc ?? "").trim();
  const created = Number(item?.createTime);
  const date = Number.isFinite(created) && created > 0 ? new Date(created * 1000) : idTime(post.id);
  return {
    variables: {
      tiktok_id: post.id,
      tiktok_title: captionTitle(caption),
      tiktok_description: caption,
      tiktok_published: date?.toISOString() ?? "",
      tiktok_author: item?.author?.nickname?.trim() ?? "",
      tiktok_author_handle: item?.author?.uniqueId?.trim() ?? "",
      tiktok_embed: post.kind === "video" ? videoEmbed(post.id) : "",
    },
    cover: item?.video?.cover || item?.video?.originCover || item?.imagePost?.cover?.imageURL?.urlList?.[0] || "",
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

/**
 * Runs in the page: the post's item JSON from TikTok's hydration data, or
 * null. Self-contained for page.evaluate.
 */
export function readTikTokItem(id: string): TikTokItem | null {
  const json = (selector: string): unknown => {
    try {
      return JSON.parse(document.querySelector(selector)?.textContent ?? "");
    } catch {
      return null;
    }
  };
  type Scope = Record<string, { itemInfo?: { itemStruct?: TikTokItem } } | undefined>;
  const universal = json("#__UNIVERSAL_DATA_FOR_REHYDRATION__") as { __DEFAULT_SCOPE__?: Scope } | null;
  for (const entry of Object.values(universal?.__DEFAULT_SCOPE__ ?? {})) {
    const item = entry?.itemInfo?.itemStruct;
    if (item && String(item.id) === id) return item;
  }
  // Older pages.
  const sigi = json("#SIGI_STATE") as { ItemModule?: Record<string, TikTokItem> } | null;
  return sigi?.ItemModule?.[id] ?? null;
}
