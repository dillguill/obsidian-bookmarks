// Wire types for the HTTP API. plugin/src/api.ts mirrors these; bump
// API_VERSION on any breaking change so a mismatched pair says which side to
// update (design §5.3).
export const API_VERSION = 5;

export type JobStatus = "pending" | "running" | "done" | "failed" | "delivered";

/**
 * Where a capture was requested from (audit #1: not `source`, which is the URL).
 * "enrich" re-fetches a page for a note that already exists: the plugin reads
 * it straight away, so it's never listed for delivery.
 */
export type CaptureOrigin = "plugin" | "api" | "shortcut" | "bookmarklet" | "share" | "enrich";

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
  /** File extension of the screenshot and image assets, when there are any (the PDF is always .pdf). */
  screenshotExt: "jpg" | "png" | null;
  /** Template chosen at capture time by name; null means match by triggers. */
  template: string | null;
  /** Capture files asked for on top of the ones the rendered note uses. */
  files: CaptureFile[];
}

/**
 * Files a template can ask for, each named after its template variable, which
 * holds the file's vault path: full page, first screen, first screen at phone
 * width, the main content block and a small first screen, each also in the
 * site's dark mode (`_dark`), a PDF of the page, the page's {{image}} saved
 * locally (`image_local`), and a TikTok post's cover (`tiktok_thumbnail`,
 * whose link expires). The server makes only the ones the rendered note uses.
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
] as const;
export type CaptureFile = (typeof CAPTURE_FILES)[number];

/** A capture file, the readable `markdown`, or the `note` rendered with Web Clipper's engine ({@link RenderedNote}, JSON). */
export type AssetKind = CaptureFile | "markdown" | "note";

/**
 * A note rendered on the server by Obsidian Web Clipper's template engine.
 * The plugin only picks a free file name, saves the capture files and swaps
 * each {@link fileMarker} for its vault path.
 */
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
}

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
}
