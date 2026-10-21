// Media in a note that can become vault files: for now, the TikTok player the
// {{tiktok_embed}} variable writes. Kept free of Obsidian so it can be tested.

/** The TikTok player {{tiktok_embed}} writes, however its attributes were edited since. */
export const TIKTOK_PLAYER = /<iframe\b[^>]*?\bsrc=["']https:\/\/www\.tiktok\.com\/player\/v1\/\d+[^"']*["'][^>]*>(?:\s*<\/iframe>)?/g;

export function hasTikTokPlayer(text: string): boolean {
  return new RegExp(TIKTOK_PLAYER.source).test(text);
}

/** Swaps each TikTok player in a note for embeds of the saved files (vault paths); unchanged when there are none. */
export function replaceTikTokPlayer(text: string, saved: readonly string[]): string {
  return saved.length ? text.replace(TIKTOK_PLAYER, saved.map((path) => `![[${path}]]`).join("\n")) : text;
}

/** Takes TikTok players out of text (and the blank lines they leave), for a note whose post was already saved as files. */
export function withoutTikTokPlayer(text: string): string {
  return text.replace(new RegExp(`\\n*${TIKTOK_PLAYER.source}\\n*`, "g"), "\n\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}

/** The sites "Download media" fetches videos from (TikTok has its own kinds). */
export type VideoSite = "youtube" | "x" | "vimeo" | "instagram";

/** What one media item is. */
export type MediaKind = "tiktok_video" | "tiktok_photos" | "tiktok_cover" | "site_video" | "image";

/** Where a media item is in the note, so the saved file can take its place. */
export type MediaSource =
  /** This exact text in the body (a player, an embed, an image). */
  | { in: "body"; text: string }
  /** This property, while it still holds this value. */
  | { in: "property"; name: string; value: string }
  /** Nothing to replace (only the bookmark's URL points at it): the file goes at the end of the note. */
  | { in: "end" };

export interface MediaItem {
  /** Unique within a note. */
  key: string;
  kind: MediaKind;
  label: string;
  /** What gets fetched: the post or video page, or the image itself. */
  url: string;
  source: MediaSource;
  /** An image for the picker, when one is known without fetching. */
  preview: string | null;
  /** Images are fetched by the plugin; posts and videos by the server. */
  via: "plugin" | "server";
}

const IMAGE_EXTENSIONS = /\.(bmp|png|jpe?g|gif|svg|webp|avif)$/i;
const TIKTOK_POST = /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/]+\/(video|photo)\/(\d+)/i;
const TIKTOK_PLAYER_ID = /tiktok\.com\/player\/v1\/(\d+)/;

/** Which video site a URL is a video on; null when it's none of them. */
export function videoSite(url: string): VideoSite | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const path = u.pathname;
  if ((host === "youtube.com" || host === "youtube-nocookie.com") && (/^\/(shorts|embed|live)\/[\w-]+/.test(path) || (path === "/watch" && u.searchParams.has("v")))) return "youtube";
  if (host === "youtu.be" && /^\/[\w-]{6,}/.test(path)) return "youtube";
  if ((host === "x.com" || host === "twitter.com") && /^\/[^/]+\/status\/\d+/.test(path)) return "x";
  if ((host === "vimeo.com" && /^\/\d+/.test(path)) || (host === "player.vimeo.com" && /^\/video\/\d+/.test(path))) return "vimeo";
  if (host === "instagram.com" && /^\/(p|reel|reels|tv)\/[\w-]+/.test(path)) return "instagram";
  return null;
}

/** A YouTube video's id, for its thumbnail. */
function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    return u.searchParams.get("v") ?? /^\/(?:shorts|embed|live)\/([\w-]+)/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** A web address of an image, or a data: image. */
function isImageUrl(value: string): boolean {
  if (/^data:image\//i.test(value)) return true;
  try {
    const u = new URL(value);
    // TikTok's CDN serves images without an extension.
    return /^https?:$/.test(u.protocol) && (IMAGE_EXTENSIONS.test(u.pathname) || /tiktokcdn/i.test(u.hostname));
  } catch {
    return false;
  }
}

/** The body with fenced code blanked out (same length), so nothing inside code counts. */
function withoutCode(body: string): string {
  return body.replace(/^(\s{0,3})(`{3,}|~{3,})[\s\S]*?^\s{0,3}\2[^\n]*$/gm, (block) => block.replace(/[^\n]/g, " "));
}

const SITE_LABELS: Record<VideoSite, string> = { youtube: "YouTube video", x: "X video", vimeo: "Vimeo video", instagram: "Instagram video" };

/**
 * The media in a note that "Download media" can turn into vault files: a
 * TikTok post's video or photos and its cover, videos from YouTube, X, Vimeo
 * and Instagram, images embedded from the web, and image addresses in
 * properties. Taken from the note's players, embeds and properties, and from
 * its bookmark URL when nothing in the note shows it. Plain links aren't media.
 */
export function findMedia(body: string, frontmatter: Record<string, unknown>, bookmarkUrl: string | null): MediaItem[] {
  const items: MediaItem[] = [];
  const seen = new Set<string>();
  const add = (item: Omit<MediaItem, "key">) => {
    const key = `${item.kind}:${item.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ...item, key });
  };
  const scan = withoutCode(body);
  const tiktok = bookmarkUrl ? TIKTOK_POST.exec(bookmarkUrl) : null;
  const tiktokUrl = tiktok ? bookmarkUrl! : null;
  const postKind = (id: string): "tiktok_video" | "tiktok_photos" => (tiktok && tiktok[2] === id && tiktok[1] === "photo" ? "tiktok_photos" : "tiktok_video");
  const postLabel = (kind: MediaKind) => (kind === "tiktok_photos" ? "TikTok photos" : "TikTok video");

  // TikTok players, in the note.
  let tiktokShown = false;
  for (const match of scan.matchAll(new RegExp(TIKTOK_PLAYER.source, "g"))) {
    const text = body.slice(match.index, match.index + match[0].length);
    const id = TIKTOK_PLAYER_ID.exec(text)?.[1];
    if (!id) continue;
    const url = tiktokUrl && tiktok![2] === id ? tiktokUrl : `https://www.tiktok.com/@_/video/${id}`;
    const kind = postKind(id);
    add({ kind, label: postLabel(kind), url, source: { in: "body", text }, preview: null, via: "server" });
    tiktokShown ||= tiktok?.[2] === id;
  }

  // Video embeds: iframes and ![](…) of a video site.
  for (const match of scan.matchAll(/<iframe\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>(?:\s*<\/iframe>)?/gi)) {
    const site = videoSite(match[1]!);
    if (!site) continue;
    const id = site === "youtube" ? youtubeId(match[1]!) : null;
    add({ kind: "site_video", label: SITE_LABELS[site], url: match[1]!, source: { in: "body", text: body.slice(match.index, match.index + match[0].length) }, preview: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null, via: "server" });
  }
  for (const match of scan.matchAll(/!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const url = match[2]!;
    const text = body.slice(match.index, match.index + match[0].length);
    const site = videoSite(url);
    if (site) {
      const id = site === "youtube" ? youtubeId(url) : null;
      add({ kind: "site_video", label: SITE_LABELS[site], url, source: { in: "body", text }, preview: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null, via: "server" });
    } else if (/^(https?:|data:image\/)/i.test(url)) {
      add({ kind: "image", label: imageLabel(url, match[1]!), url, source: { in: "body", text }, preview: url, via: "plugin" });
    }
  }

  // Image addresses in properties; TikTok's expiring cover links are fetched fresh from the post.
  for (const [name, value] of Object.entries(frontmatter)) {
    if (typeof value !== "string" || !isImageUrl(value.trim())) continue;
    const url = value.trim();
    if (tiktokUrl && /tiktokcdn/i.test(url)) add({ kind: "tiktok_cover", label: "TikTok cover", url: tiktokUrl, source: { in: "property", name, value }, preview: url, via: "server" });
    else add({ kind: "image", label: imageLabel(url, name), url, source: { in: "property", name, value }, preview: url, via: "plugin" });
  }

  // Only the bookmark's URL: the post or video goes at the end of the note.
  if (tiktokUrl && !tiktokShown && !savedTikTok(body)) {
    const kind = postKind(tiktok![2]!);
    add({ kind, label: postLabel(kind), url: tiktokUrl, source: { in: "end" }, preview: null, via: "server" });
  }
  const site = bookmarkUrl ? videoSite(bookmarkUrl) : null;
  if (site && bookmarkUrl && !items.some((i) => i.kind === "site_video") && !/!\[\[[^\]]*-video\.mp4\]\]/i.test(body)) {
    const id = site === "youtube" ? youtubeId(bookmarkUrl) : null;
    add({ kind: "site_video", label: SITE_LABELS[site], url: bookmarkUrl, source: { in: "end" }, preview: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null, via: "server" });
  }
  return items;
}

/** A TikTok post already saved as files in the body. */
function savedTikTok(body: string): boolean {
  return /!\[\[[^\]]*tiktok[^\]]*\.(mp4|jpe?g|png|webp)\]\]/i.test(body) || /!\[\[[^\]]*-(video\.mp4|photo-\d+\.\w+)\]\]/i.test(body);
}

function imageLabel(url: string, alt: string): string {
  if (url.startsWith("data:")) return alt || "Embedded image";
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return name || alt || "Image";
  } catch {
    return alt || "Image";
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

/** A downloaded image's file name, as Obsidian's own download does: the URL's file name, else the server's, else "Image" with the type's extension. */
export function imageName(url: string, contentType: string | null, disposition: string | null): { base: string; ext: string } {
  const bad = /[\\/:*?"<>|#^[\]]/;
  const split = (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot > 0 && /^[a-z0-9]{1,5}$/i.test(name.slice(dot + 1)) && !bad.test(name) ? { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() } : null;
  };
  const fromDisposition = disposition && /attachment/i.test(disposition) ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] : null;
  if (fromDisposition) {
    const named = split(decodeURIComponent(fromDisposition.trim()));
    if (named) return named;
  }
  if (!url.startsWith("data:")) {
    try {
      const named = split(decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""));
      if (named) return named;
    } catch {
      // not a URL with a file name
    }
  }
  const type = (contentType ?? (url.startsWith("data:") ? /^data:([^;,]+)/.exec(url)?.[1] : null) ?? "").split(";")[0]!.trim().toLowerCase();
  return { base: "Image", ext: MIME_EXTENSIONS[type] ?? "jpg" };
}

/**
 * Swaps an item's place in the body for the saved files' embeds (several for
 * a photo post); at the end of the note when it had no place. Unchanged, and
 * `replaced` false, when the text it came from isn't in the note any more.
 */
export function replaceSource(text: string, source: MediaSource, embeds: readonly string[]): { text: string; replaced: boolean } {
  if (!embeds.length) return { text, replaced: false };
  const block = embeds.join("\n");
  if (source.in === "end") return { text: `${text.trimEnd()}\n\n${block}\n`, replaced: true };
  if (source.in !== "body") return { text, replaced: false };
  const at = text.indexOf(source.text);
  if (at < 0) return { text, replaced: false };
  return { text: text.slice(0, at) + block + text.slice(at + source.text.length), replaced: true };
}
