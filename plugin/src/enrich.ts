// Enriching a note that already exists (one saved before a template had some
// property, or a thin note with just a URL): the page is captured again, and
// the user picks which of the rendered note's properties, its body and which
// images to pull into the note. Kept free of Obsidian so it can be tested.

import { CAPTURE_FILES, fileMarker, type CaptureFile, type RenderedNote } from "./api";
import { fillFiles, type SavedFiles } from "./writer";

/**
 * Files an enrich capture asks for on top of the ones the template uses: cheap
 * ones, so the first capture stays quick. Other screenshots are captured on demand.
 */
export const ENRICH_FILES: readonly CaptureFile[] = [
  "image_local",
  "tiktok_thumbnail",
  "tiktok_video",
  ...CAPTURE_FILES.filter((kind) => kind.startsWith("tiktok_image_")),
  "screenshot_thumbnail",
];

/** Files an update can ask the server to capture later, when the user adds one the first capture didn't make. */
export const ON_DEMAND_FILES: readonly CaptureFile[] = CAPTURE_FILES.filter((kind) => kind.startsWith("screenshot_") || kind === "pdf_page");

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
  /** Property it goes into unless the user picks another; defaults to `name`. Set for variables added as properties. */
  target?: string;
}

/** Name of the variable a capture file is, as templates write it. */
export function fileVariable(kind: CaptureFile): string {
  return `{{${kind}}}`;
}

/**
 * A variable (or capture file, linked) offered as a property: it goes into the
 * property named after it, so {{tiktok_author}} goes into tiktok_author.
 */
export function variableProperty(item: { kind: "variable"; name: string; value: string } | { kind: "file"; file: CaptureFile }, frontmatter: Record<string, unknown>): PropertyChoice {
  const name = item.kind === "file" ? fileVariable(item.file) : item.name;
  const value = item.kind === "file" ? `[[${fileMarker(item.file)}]]` : item.value;
  const target = name.replace(/^\{\{|\}\}$/g, "").trim();
  const current = frontmatter[target];
  return { name, value, current, mergeable: !isEmpty(current) && Array.isArray(current), target };
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

/** What a property row writes: its value, into `target` (the same name unless retargeted), replacing or merged into a list. */
export interface PropertyPick {
  mode: PropertyMode;
  target: string;
}

/** Something a content row puts in the note: a capture file's embed, a variable's value, or text the user typed. */
export type ContentItem =
  | { kind: "file"; file: CaptureFile }
  | { kind: "variable"; name: string; value: string }
  | { kind: "text"; text: string };

/** Where a content row goes: the note body or one of its headings (by index in {@link noteHeadings}), at its start, its end, or in place of it. */
export interface Placement {
  heading: number | null;
  position: "prepend" | "append" | "replace";
}

export interface ContentRow extends Placement {
  item: ContentItem;
}

export interface EnrichSelection {
  /** Picked properties by their name in the capture. */
  properties: Record<string, PropertyPick>;
  /** Content rows in list order; rows with the same placement go in that order. */
  content: ContentRow[];
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

/** Capture files a content row shows. */
export function rowFiles(item: ContentItem): CaptureFile[] {
  if (item.kind === "file") return [item.file];
  return item.kind === "variable" ? filesIn(item.value) : [];
}

/** Capture files the selection needs saved: picked files plus any a picked property or variable uses. */
export function filesToSave(choices: EnrichChoices, selection: EnrichSelection): CaptureFile[] {
  const used = new Set<CaptureFile>(selection.offline ? offlineFiles(choices.images) : []);
  for (const property of choices.properties) if (selection.properties[property.name]) filesIn(property.value).forEach((kind) => used.add(kind));
  for (const row of selection.content) rowFiles(row.item).forEach((kind) => used.add(kind));
  return choices.images.filter((kind) => used.has(kind));
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : isEmpty(value) ? [] : [value];
}

/** Sets the picked properties on a note's frontmatter object (as Obsidian's processFrontMatter hands it over). */
export function applyProperties(frontmatter: Record<string, unknown>, choices: EnrichChoices, selection: EnrichSelection, saved: SavedFiles): void {
  for (const property of choices.properties) {
    const pick = selection.properties[property.name];
    if (!pick) continue;
    const value = fillValue(property.value, saved);
    if (isEmpty(value)) continue;
    const target = pick.target || property.target || property.name;
    const now = frontmatter[target];
    if (pick.mode === "merge" && !isEmpty(now)) {
      const merged = asList(now);
      for (const item of asList(value)) if (!merged.some((existing) => same(existing, item))) merged.push(item);
      frontmatter[target] = merged;
    } else frontmatter[target] = value;
  }
}

/** The Markdown a content row adds, with capture file markers swapped for saved paths. */
export function rowText(item: ContentItem, saved: SavedFiles): string {
  if (item.kind === "file") return saved[item.file] ? `![[${saved[item.file]}]]` : "";
  const text = item.kind === "variable" ? fillFiles(item.value, saved) : item.text;
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export interface NoteHeading {
  level: number;
  text: string;
  /** Offset in the body just after the heading line. */
  start: number;
  /** Offset in the body where the heading's section ends: the next heading of the same or a higher level, else the body's end. */
  end: number;
}

/** The headings in a note body (the text after its frontmatter), skipping fenced code. */
export function noteHeadings(body: string): NoteHeading[] {
  const found: { level: number; text: string; lineStart: number; start: number }[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const lineEnd = offset + line.length;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1]![0]!;
      else if (marker[1]![0] === fence) fence = null;
    } else if (!fence) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) found.push({ level: heading[1]!.length, text: heading[2]!, lineStart: offset, start: lineEnd });
    }
    offset = lineEnd + 1;
  }
  return found.map((h, i) => {
    const next = found.slice(i + 1).find((other) => other.level <= h.level);
    return { level: h.level, text: h.text, start: h.start, end: next ? next.lineStart : body.length };
  });
}

/** Where a placement's text goes in the body, and its rank among placements at the same offset (lower first). */
function spot(placement: Placement, headings: readonly NoteHeading[], body: string): { from: number; to: number; rank: number } {
  const h = placement.heading === null ? null : headings[placement.heading];
  if (!h) {
    if (placement.position === "prepend") return { from: 0, to: 0, rank: -1 };
    if (placement.position === "append") return { from: body.length, to: body.length, rank: headings.length + 1 };
    return { from: 0, to: body.length, rank: 0 };
  }
  const i = headings.indexOf(h);
  if (placement.position === "prepend") return { from: h.start, to: h.start, rank: 0 };
  // A nested section ends where its parent does: the inner one's appended text comes first.
  if (placement.position === "append") return { from: h.end, to: h.end, rank: headings.length - i };
  return { from: h.start, to: h.end, rank: 0 };
}

/** Placements sorted in the order their text lands in the note, for listing rows in note order. */
export function placementOrder(placements: readonly Placement[], body: string): Placement[] {
  const headings = noteHeadings(body);
  return [...placements].sort((a, b) => {
    const x = spot(a, headings, body);
    const y = spot(b, headings, body);
    return x.from - y.from || x.rank - y.rank;
  });
}

export function samePlacement(a: Placement, b: Placement): boolean {
  return a.heading === b.heading && a.position === b.position;
}

/**
 * Puts each content row's text into a note at its placement, keeping the
 * frontmatter. Rows with the same placement go in list order; a replaced
 * section keeps its heading.
 */
export function placeContent(text: string, rows: readonly ContentRow[], saved: SavedFiles, frontmatterEnd: number): string {
  const front = text.slice(0, frontmatterEnd);
  const body = text.slice(frontmatterEnd);
  const headings = noteHeadings(body);
  const groups: { from: number; to: number; rank: number; blocks: string[] }[] = [];
  for (const row of rows) {
    const block = rowText(row.item, saved);
    if (!block) continue;
    const at = spot(row, headings, body);
    const group = groups.find((g) => g.from === at.from && g.to === at.to && g.rank === at.rank);
    if (group) group.blocks.push(block);
    else groups.push({ ...at, blocks: [block] });
  }
  // Replacing a whole section or body drops anything else placed inside it.
  const replaced = groups.filter((g) => g.to > g.from);
  const kept = groups.filter((g) => g.to > g.from || !replaced.some((r) => r !== g && g.from > r.from && g.from < r.to));
  if (!kept.length) return text;
  kept.sort((a, b) => a.from - b.from || a.rank - b.rank);
  let out = "";
  let cursor = 0;
  for (const g of kept) {
    if (g.from < cursor) continue;
    out = join(join(out, body.slice(cursor, g.from)), g.blocks.join("\n\n"));
    cursor = g.to;
  }
  out = join(out, body.slice(cursor));
  const lead = front && !front.endsWith("\n") ? `${front}\n` : front;
  return `${lead}${out}\n`;
}

/** Joins two pieces of Markdown with one blank line, dropping the newlines at their edges. */
function join(out: string, piece: string): string {
  const p = piece.replace(/^\n+/, "").replace(/\s+$/, "");
  if (!p.trim()) return out;
  return out ? `${out}\n\n${p}` : p;
}

/** Name of the variable holding the template's rendered note content. */
export const TEMPLATE_CONTENT = "Template content";

/**
 * The selection a template sets up: properties the note is missing are added
 * and lists are merged, and the template's note content is appended to the body.
 */
export function defaultSelection(choices: EnrichChoices): EnrichSelection {
  const properties: Record<string, PropertyPick> = {};
  for (const property of choices.properties) {
    if (isEmpty(property.current)) properties[property.name] = { mode: "replace", target: property.name };
    else if (property.mergeable) properties[property.name] = { mode: "merge", target: property.name };
  }
  const content: ContentRow[] = choices.body ? [{ item: { kind: "variable", name: TEMPLATE_CONTENT, value: choices.body }, heading: null, position: "append" }] : [];
  return { properties, content, offline: false };
}
