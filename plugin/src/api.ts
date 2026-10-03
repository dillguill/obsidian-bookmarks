// Wire types for the bookmarks-server HTTP API; mirrors harness/src/api.ts.
// Bump API_VERSION in both when the API changes incompatibly.
export const API_VERSION = 2;

export type JobStatus = "pending" | "running" | "done" | "failed" | "delivered";

/** Where a capture was requested from (audit #1: not `source`, which is the URL). */
export type CaptureOrigin = "plugin" | "api" | "shortcut" | "bookmarklet" | "share";

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
  /** File extension of the screenshot asset, when there is one. */
  screenshotExt: "jpg" | "png" | null;
  /** Template chosen at capture time by name; null means match by triggers. */
  template?: string | null;
}

/** `note` is the note rendered with Web Clipper's engine ({@link RenderedNote}, JSON). */
export type AssetKind = "screenshot" | "markdown" | "note";

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
}

/** Stands in for the screenshot's vault path in a RenderedNote: `{{screenshot}}` is the marker, `{{screenshot_link}}` is `[[marker]]`, `{{screenshot_embed}}` is `![[marker]]`. */
export const SCREENSHOT_MARKER = "bookmarks-screenshot-path-5f2c9e";

/** How much of the page the screenshot covers. */
export type ScreenshotStyle = "full" | "banner" | "none";

/**
 * Capture settings shared by every device, stored on the server so captures
 * from a phone Shortcut follow the same rules as the plugin.
 */
export interface CaptureSettings {
  screenshotStyle: ScreenshotStyle;
  /** Sites (and their subdomains) that get only the first screen. */
  bannerSites: string[];
  /** Sites (and their subdomains) saved without a screenshot. */
  noScreenshotSites: string[];
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
