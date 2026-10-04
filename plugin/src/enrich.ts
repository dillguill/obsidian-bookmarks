// Enriching a note that already exists (one saved before a template had some
// property, or a thin note with just a URL): the page is captured again, and
// the user picks which of the rendered note's properties, its body and which
// images to pull into the note. Kept free of Obsidian so it can be tested.

import { CAPTURE_FILES, fileMarker, type CaptureFile, type RenderedNote } from "./api";
import { fillFiles, type SavedFiles } from "./writer";

/**
 * Images an enrich capture asks for on top of the ones the template uses, so
 * there's something to pick from even when the template has no screenshot.
 */
export const ENRICH_FILES: readonly CaptureFile[] = [
  "image_local",
  "tiktok_thumbnail",
  "tiktok_video",
  ...CAPTURE_FILES.filter((kind) => kind.startsWith("tiktok_image_")),
  "screenshot_banner",
  "screenshot_thumbnail",
  "screenshot_page",
];

const FILE_LABELS: Partial<Record<CaptureFile, string>> = {
  screenshot_page: "Full page screenshot",
  screenshot_banner: "First screen screenshot",
  screenshot_mobile: "Phone screenshot",
  screenshot_article: "Main content screenshot",
  screenshot_thumbnail: "Small screenshot",
  screenshot_page_dark: "Full page screenshot (dark)",
  screenshot_banner_dark: "First screen screenshot (dark)",
  screenshot_mobile_dark: "Phone screenshot (dark)",
  screenshot_article_dark: "Main content screenshot (dark)",
  screenshot_thumbnail_dark: "Small screenshot (dark)",
  pdf_page: "PDF of the page",
  image_local: "Page image",
  tiktok_thumbnail: "TikTok cover",
  tiktok_video: "TikTok video",
};

export function fileLabel(kind: CaptureFile): string {
  const photo = /^tiktok_image_(\d+)$/.exec(kind);
  return FILE_LABELS[kind] ?? (photo ? `TikTok photo ${photo[1]}` : kind);
}

export interface PropertyChoice {
  name: string;
  /** Value from the fresh capture, with capture file markers still in it. */
  value: unknown;
  /** Value in the note now; undefined when the note doesn't have the property. */
  current: unknown;
  /** Either side is a list, so the values can be merged instead of replaced. */
  mergeable: boolean;
}

export interface EnrichChoices {
  properties: PropertyChoice[];
  /** Properties whose value already matches the note, so there's nothing to pick. */
  unchanged: string[];
  /** The rendered note body, with capture file markers still in it; empty when the template has none. */
  body: string;
  /** Capture files the server made, in CAPTURE_FILES order. */
  images: CaptureFile[];
}

export type PropertyMode = "replace" | "merge";

export interface EnrichSelection {
  /** Picked properties by name. "merge" keeps the note's list values and adds the new ones. */
  properties: Record<string, PropertyMode>;
  body: boolean;
  images: CaptureFile[];
  /** Where the body and images go: before the note's body (after its properties), after it, or in place of it. */
  position: "prepend" | "append" | "replace";
  /** Replace the note's TikTok player with the saved video or photos ({@link offlineFiles}). */
  offline: boolean;
}

/** The TikTok player {{tiktok_embed}} writes, however its attributes were edited since. */
const TIKTOK_PLAYER = /<iframe\b[^>]*?\bsrc=["']https:\/\/www\.tiktok\.com\/player\/v1\/\d+[^"']*["'][^>]*>(?:\s*<\/iframe>)?/g;

export function hasTikTokPlayer(text: string): boolean {
  return new RegExp(TIKTOK_PLAYER.source).test(text);
}

/** The files that take the TikTok player's place when saving it offline: the video, else a carousel's photos. */
export function offlineFiles(available: readonly CaptureFile[]): CaptureFile[] {
  if (available.includes("tiktok_video")) return ["tiktok_video"];
  return CAPTURE_FILES.filter((kind) => kind.startsWith("tiktok_image_") && available.includes(kind));
}

/** Swaps each TikTok player in a note for embeds of the saved files; unchanged when none were saved. */
export function replaceTikTokPlayer(text: string, files: readonly CaptureFile[], saved: SavedFiles): string {
  const embeds = files.filter((kind) => saved[kind]).map((kind) => `![[${saved[kind]}]]`);
  return embeds.length ? text.replace(TIKTOK_PLAYER, embeds.join("\n")) : text;
}

/** Splits "---\n…\n---\n" into the YAML between the fences. */
function frontmatterYaml(frontmatter: string): string {
  return frontmatter.replace(/^---\r?\n/, "").replace(/\r?\n?---\s*$/, "");
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.every(isEmpty));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Capture file kinds whose markers appear in a value. */
export function filesIn(value: unknown): CaptureFile[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return CAPTURE_FILES.filter((kind) => text.includes(fileMarker(kind)));
}

/** Swaps capture file markers in a property value (strings, or lists of them) for vault paths. */
export function fillValue(value: unknown, saved: SavedFiles): unknown {
  if (typeof value === "string") return fillFiles(value, saved);
  if (Array.isArray(value)) return value.map((item) => fillValue(item, saved)).filter((item) => !isEmpty(item));
  return value;
}

/**
 * What a fresh capture offers for a note: its properties that differ from the
 * note's, its body and its images. A property that can only be filled with a
 * capture file the server didn't make is left out, as is the capture id
 * property: the capture is thrown away once the note is enriched.
 */
export function enrichChoices(
  note: RenderedNote,
  current: Record<string, unknown>,
  parseYaml: (yaml: string) => unknown,
  available: readonly CaptureFile[],
  captureIdName: string,
): EnrichChoices {
  const images = CAPTURE_FILES.filter((kind) => available.includes(kind));
  const asIfSaved: SavedFiles = Object.fromEntries(images.map((kind) => [kind, kind]));
  const parsed = (parseYaml(frontmatterYaml(note.frontmatter)) ?? {}) as Record<string, unknown>;
  const properties: PropertyChoice[] = [];
  const unchanged: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (name === captureIdName || isEmpty(fillValue(value, asIfSaved))) continue;
    const now = current[name];
    if (same(now, value)) {
      unchanged.push(name);
      continue;
    }
    properties.push({ name, value, current: now, mergeable: !isEmpty(now) && (Array.isArray(now) || Array.isArray(value)) });
  }
  return { properties, unchanged, body: fillFiles(note.content, asIfSaved).trim() ? note.content.trim() : "", images };
}

/** Capture files the selection needs saved: picked images plus any a picked property or body uses. */
export function filesToSave(choices: EnrichChoices, selection: EnrichSelection): CaptureFile[] {
  const used = new Set<CaptureFile>([...selection.images, ...(selection.offline ? offlineFiles(choices.images) : [])]);
  for (const property of choices.properties) if (selection.properties[property.name]) filesIn(property.value).forEach((kind) => used.add(kind));
  if (selection.body) filesIn(choices.body).forEach((kind) => used.add(kind));
  return choices.images.filter((kind) => used.has(kind));
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : isEmpty(value) ? [] : [value];
}

/** Sets the picked properties on a note's frontmatter object (as Obsidian's processFrontMatter hands it over). */
export function applyProperties(frontmatter: Record<string, unknown>, choices: EnrichChoices, selection: EnrichSelection, saved: SavedFiles): void {
  for (const property of choices.properties) {
    const mode = selection.properties[property.name];
    if (!mode) continue;
    const value = fillValue(property.value, saved);
    if (isEmpty(value)) continue;
    if (mode === "merge" && property.mergeable) {
      const merged = asList(frontmatter[property.name]);
      for (const item of asList(value)) if (!merged.some((existing) => same(existing, item))) merged.push(item);
      frontmatter[property.name] = merged;
    } else frontmatter[property.name] = value;
  }
}

/**
 * The text to add to the note: embeds for picked images the picked body,
 * properties and offline player don't already show, then the body.
 */
export function bodyBlock(choices: EnrichChoices, selection: EnrichSelection, saved: SavedFiles): string {
  const shown = new Set<CaptureFile>();
  if (selection.body) filesIn(choices.body).forEach((kind) => shown.add(kind));
  for (const property of choices.properties) if (selection.properties[property.name]) filesIn(property.value).forEach((kind) => shown.add(kind));
  // Saved offline, they show where the player was.
  if (selection.offline) offlineFiles(choices.images).forEach((kind) => shown.add(kind));
  const embeds = selection.images.filter((kind) => saved[kind] && !shown.has(kind)).map((kind) => `![[${saved[kind]}]]`);
  const body = selection.body ? fillFiles(choices.body, saved).replace(/\n{3,}/g, "\n\n").trim() : "";
  return [...embeds, body].filter(Boolean).join("\n\n");
}

/** Puts `block` right after the note's frontmatter, at its end, or in place of its body (the frontmatter stays). */
export function insertBlock(text: string, block: string, position: EnrichSelection["position"], frontmatterEnd: number): string {
  if (!block) return text;
  if (position === "append") {
    const head = text.trimEnd();
    return `${head}${head ? "\n\n" : ""}${block}\n`;
  }
  const front = text.slice(0, frontmatterEnd);
  const rest = position === "replace" ? "" : text.slice(frontmatterEnd).replace(/^\s+/, "");
  const lead = front && !front.endsWith("\n") ? `${front}\n` : front;
  return `${lead}${block}\n${rest ? `\n${rest}` : ""}`;
}
