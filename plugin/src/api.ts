// Wire types for the bookmarks-server HTTP API; mirrors harness/src/api.ts.
// Bump API_VERSION in both when the API changes incompatibly.
export const API_VERSION = 8;

export type JobStatus = "pending" | "running" | "done" | "failed" | "delivered";

/**
 * Where a capture was requested from (audit #1: not `source`, which is the URL).
 * "enrich" re-fetches a page for a note that already exists: the plugin reads
 * it straight away, so it's never listed for delivery.
 */
export type CaptureOrigin = "plugin" | "api" | "shortcut" | "bookmarklet" | "share" | "enrich" | "media";

/**
 * "full" captures everything the template uses in one go. "preview" publishes
 * the rendered note as soon as the page settles, then holds the page open so
 * the plugin can render it with another template or ask for its screenshots
 * (POST /jobs/:id/render, /files, /release).
 */
export type CaptureMode = "full" | "preview";

export interface PageMeta {
  /** URL after redirects. */
  finalUrl: string;
  canonical: string | null;
  title: string;
  description: string;
  author: string;
  site: string;
  domain: string;
  published: string;
  image: string;
  favicon: string;
  wordCount: number;
  httpStatus: number | null;
  /** Screenshot was cut at the height cap. */
  truncated: boolean;
  /** schema.org JSON-LD objects on the page (arrays and @graph flattened), for `{{schema:…}}`. */
  schema?: unknown[];
  /** `<meta>` values keyed "name:author" or "property:og:title", for `{{meta:…}}`. */
  metaTags?: Record<string, string>;
}

export interface Job {
  id: string;
  url: string;
  origin: CaptureOrigin;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  meta: PageMeta | null;
  /** Asset kinds available from `GET /jobs/:id/asset/:kind`. */
  assets: AssetKind[];
  /** File extension of the screenshot and image assets, when there are any (see {@link fileExt}). */
  screenshotExt: "jpg" | "png" | null;
  /** Template chosen at capture time by name; null means match by triggers. */
  template?: string | null;
  /** Capture files asked for on top of the ones the rendered note uses. */
  files?: CaptureFile[];
  mode?: CaptureMode;
  /** While a preview's page is held: when it's released if nothing asks for it again. */
  heldUntil?: string | null;
  /** Media downloads (origin "media"), or a capture's follow-up media download. */
  media?: MediaJobInfo | null;
}

/** What a media download fetches: a post's video, its photos, its cover. */
export type MediaWant = "video" | "photos" | "cover";

/** A media download's progress: the files made so far and what couldn't be fetched. */
export interface MediaJobInfo {
  /** The post or video page. */
  url: string;
  want: MediaWant[];
  made: { asset: MediaAsset; want: MediaWant; index?: number; bytes: number }[];
  errors: { want: MediaWant; index?: number; message: string }[];
  /** On a capture job: the media download queued after it. */
  followUp?: string;
  /** On a media download queued after a capture: that capture's id, so the plugin puts the files in its note. */
  forCapture?: string;
}

/** Most photos a TikTok carousel can hold; each is its own capture file. */
export const TIKTOK_IMAGE_MAX = 35;

/**
 * Files a template can ask for, each named after its template variable, which
 * holds the file's vault path: full page, first screen, first screen at phone
 * width, the main content block and a small first screen, each also in the
 * site's dark mode (`_dark`), and a PDF of the page. The media variables after
 * them (`image_local`, `tiktok_thumbnail`, `tiktok_video`, `tiktok_image_1`…)
 * aren't made by a capture: the note shows the web address or the TikTok player
 * until "Download media" saves them (see harness/src/remote-media.ts).
 */
export const CAPTURE_FILES = [
  "screenshot_page",
  "screenshot_banner",
  "screenshot_mobile",
  "screenshot_article",
  "screenshot_thumbnail",
  "screenshot_page_dark",
  "screenshot_banner_dark",
  "screenshot_mobile_dark",
  "screenshot_article_dark",
  "screenshot_thumbnail_dark",
  "pdf_page",
  "image_local",
  "tiktok_thumbnail",
  "tiktok_video",
  ...Array.from({ length: TIKTOK_IMAGE_MAX }, (_, i) => `tiktok_image_${i + 1}` as const),
] as const;
export type CaptureFile = (typeof CAPTURE_FILES)[number];

/** A capture file's extension: the PDF and the TikTok video have their own, images share the screenshot format's. */
export function fileExt(kind: CaptureFile, screenshotExt: Job["screenshotExt"]): string | null {
  return kind === "pdf_page" ? "pdf" : kind === "tiktok_video" ? "mp4" : screenshotExt;
}

/** A capture file, the readable `markdown`, or the `note` rendered with Web Clipper's engine ({@link RenderedNote}, JSON). */
export type AssetKind = CaptureFile | MediaAsset | "markdown" | "note";

/** Files a media download makes: the video, the cover and each photo. */
export const MEDIA_ASSETS = ["media_video", "media_cover", ...Array.from({ length: TIKTOK_IMAGE_MAX }, (_, i) => `media_photo_${i + 1}` as const)] as const;
export type MediaAsset = (typeof MEDIA_ASSETS)[number];

/** A capture file or media file's extension: media images share the screenshot format's, jpg when there's none. */
export function assetExt(kind: CaptureFile | MediaAsset, screenshotExt: Job["screenshotExt"]): string | null {
  if (kind === "media_video") return "mp4";
  if (kind.startsWith("media_")) return screenshotExt ?? "jpg";
  return fileExt(kind as CaptureFile, screenshotExt);
}

/** A note rendered on the server by Obsidian Web Clipper's template engine. */
export interface RenderedNote {
  /** Name of the template used. */
  template: string;
  /** File name without ".md", before collision suffixes. */
  noteName: string;
  /** Vault folder. */
  path: string;
  /** "---\n…\n---\n" */
  frontmatter: string;
  content: string;
  /** Every non-empty template variable the note was rendered with, by "{{name}}", for "Update note from source". */
  variables: Record<string, string>;
}

/**
 * Stands in for a capture file's vault path in a RenderedNote until the plugin
 * saves the file, which then replaces it (or removes it, with any [[ ]] or ![[ ]]
 * around it, when there is no file).
 */
export function fileMarker(kind: CaptureFile): string {
  return `bookmarks-${kind}-5f2c9e`;
}

/**
 * Capture settings shared by every device, stored on the server so captures
 * from a phone Shortcut follow the same rules as the plugin.
 */
export interface CaptureSettings {
  /** Note templates; the first is the default. */
  templates: ClipperTemplate[];
  /** Property name -> type, shared by every template, like Web Clipper's Properties settings. */
  propertyTypes: PropertyTypeEntry[];
  /** Leave capture_id out of note frontmatter; the plugin then tracks it itself. */
  hideCaptureId?: boolean;
  /** Settings migrations applied so far. */
  schemaRevision?: number;
}

/** What adding a captured page does: write the note, write it then download its media, or copy its Markdown. */
export type CaptureAction = "add" | "add-media" | "copy";

export interface PropertyTypeEntry {
  name: string;
  type: PropertyType;
}

export type PropertyType = "text" | "multitext" | "number" | "checkbox" | "date" | "datetime";

export interface TemplateProperty {
  name: string;
  value: string;
  type: PropertyType;
}

/** A note template in Obsidian Web Clipper's JSON format (design §4). */
export interface ClipperTemplate {
  schemaVersion: string;
  name: string;
  behavior: "create";
  noteNameFormat: string;
  /** Vault folder for the note. */
  path: string;
  noteContentFormat: string;
  properties: TemplateProperty[];
  /** URL prefixes or `/regex/`; the first template whose trigger matches is used, else the first template. */
  triggers?: string[];
  /** False hides the template from "Update note from source"; missing means shown. Not part of Web Clipper's format. */
  updateFromSource?: boolean;
  /** What the capture modal's main button does; missing means "add". Not part of Web Clipper's format. */
  onCapture?: CaptureAction;
}
