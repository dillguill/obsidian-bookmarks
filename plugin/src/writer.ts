import { CAPTURE_FILES, fileMarker, type CaptureFile, type Job, type RenderedNote } from "./api";
import type { DedupIndex } from "./dedup";
import type { PageData } from "./page-data";
import { cleanUrl } from "./url";
import { formatDate, render, renderFrontmatter, type ClipperTemplate, type Variables } from "./template";

/** The slice of the vault the writer needs, so it can be tested without Obsidian. */
export interface VaultPort {
  exists(path: string): Promise<boolean>;
  ensureFolder(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  createNote(path: string, content: string): Promise<void>;
  /** Overwrites an existing note. */
  replaceNote(path: string, content: string): Promise<void>;
}

/**
 * How a capture relates to a note for the same page: skip it (the default),
 * overwrite that note in place, or save a second note anyway.
 */
export type WriteMode = { kind: "dedup" } | { kind: "replace"; path: string } | { kind: "new" };

/** Link in a failed capture's note that re-captures it in place (see the plugin's protocol handler). */
export function retryLink(notePath: string): string {
  return `obsidian://bookmarks?action=retry&path=${encodeURIComponent(notePath)}`;
}

export interface CapturedBookmark {
  job: Job;
  /** Readable markdown; empty when the job failed or the page had none. */
  markdown: string;
  /** Screenshots and PDF, by template variable; the server makes only the ones the template uses. */
  files?: Partial<Record<CaptureFile, ArrayBuffer | null>>;
  /** The note as the server rendered it with Web Clipper's engine; absent for failed captures and older servers. */
  note?: RenderedNote | null;
}

export interface WriteOptions {
  vault: VaultPort;
  index: DedupIndex;
  template: ClipperTemplate;
  notesFolder: string;
  assetsFolder: string;
  now?: Date;
  /** Leave capture_id out of the fallback renderer's frontmatter (the shared hideCaptureId setting). */
  hideCaptureId?: boolean;
  /** Captures this device already wrote, for when capture_id isn't in the frontmatter. */
  writtenCapture?: (id: string) => string | null;
  mode?: WriteMode;
}

export type WriteResult =
  | { kind: "written"; path: string }
  /** A note for this URL already exists; nothing was written. */
  | { kind: "duplicate"; path: string }
  /** This capture was already written (SSE/poll race, second device). */
  | { kind: "already-written"; path: string };

function join(folder: string, name: string): string {
  const clean = folder.replace(/^\/+|\/+$/g, "");
  return clean ? `${clean}/${name}` : name;
}

function sameSite(a: string, b: string): boolean {
  try {
    const host = (u: string) => new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    return host(a) === host(b);
  } catch {
    return false;
  }
}

/**
 * The URL stored in the note. Prefers the page's canonical link when it stays
 * on the same site, so the stored value and later dedup lookups agree (audit #4),
 * and drops tracking and bot-wall params.
 */
export function bookmarkUrl(job: Job): string {
  const final = job.meta?.finalUrl || job.url;
  const canonical = job.meta?.canonical;
  return cleanUrl(canonical && sameSite(canonical, final) ? canonical : final);
}

function cleanName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-\s.]+|[-\s.]+$/g, "")
    .slice(0, 120);
}

function noteBaseName(template: ClipperTemplate, vars: Variables, page: PageData | undefined): string {
  return cleanName(render(template.noteNameFormat, vars, page)) || `bookmark-${formatDate(vars.date ?? "", "YYYY-MM-DD")}`;
}

/** Every capture file's variable, its vault path or empty. Mirrors fileVariables in harness/src/render.ts. */
export function fileVariables(paths: Partial<Record<CaptureFile, string | null>>): Variables {
  return Object.fromEntries(CAPTURE_FILES.map((kind) => [kind, paths[kind] ?? ""]));
}

type SavedFiles = Partial<Record<CaptureFile, string>>;

/** Swaps each capture file's marker for its vault path, or drops it (with any [[ ]] or ![[ ]] around it) when there's no file. */
function fillFiles(text: string, saved: SavedFiles): string {
  return CAPTURE_FILES.reduce((out, kind) => {
    const marker = fileMarker(kind);
    const path = saved[kind];
    if (path) return out.split(marker).join(path);
    return out.split(`![[${marker}]]`).join("").split(`[[${marker}]]`).join("").split(marker).join("");
  }, text);
}

/** Saves capture files in the assets folder: <note>.jpg for the page, <note>-banner.jpg, <note>-banner-dark.jpg and so on, <note>.pdf. */
async function saveFiles(input: CapturedBookmark, options: WriteOptions, noteBase: string): Promise<SavedFiles> {
  const saved: SavedFiles = {};
  for (const kind of CAPTURE_FILES) {
    const data = input.files?.[kind];
    const ext = kind === "pdf_page" ? "pdf" : input.job.screenshotExt;
    if (!data || !ext) continue;
    // screenshot_page -> note, screenshot_banner_dark -> note-banner-dark, screenshot_page_dark -> note-dark.
    const suffix = kind.replace(/^(screenshot|pdf)_/, "").replace(/^page_?/, "").replace(/_/g, "-");
    const base = suffix ? `${noteBase}-${suffix}` : noteBase;
    await options.vault.ensureFolder(options.assetsFolder);
    const path = await freePath(options.vault, options.assetsFolder, base, ext);
    await options.vault.writeBinary(path, data);
    saved[kind] = path;
  }
  return saved;
}

async function freePath(vault: VaultPort, folder: string, base: string, ext: string): Promise<string> {
  for (let n = 1; ; n++) {
    const path = join(folder, `${n === 1 ? base : `${base}-${n}`}.${ext}`);
    if (!(await vault.exists(path))) return path;
  }
}

/** "ai-rogue-agents-liability" from ".../ai-rogue-agents-liability.html"; the host when the path is empty. */
export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    const words = decodeURIComponent(segment).replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[-_+]+/g, " ").trim();
    return words || parsed.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The one write path for every capture, interactive or drained (design §6):
 * idempotency by capture_id, then dedup by URL, then screenshot + note.
 */
export async function writeBookmark(input: CapturedBookmark, options: WriteOptions): Promise<WriteResult> {
  const { job } = input;
  const { vault, index, template } = options;

  const existing = index.findByCaptureId(job.id) ?? options.writtenCapture?.(job.id) ?? null;
  if (existing) return { kind: "already-written", path: existing };

  const url = bookmarkUrl(job);
  const mode = options.mode ?? { kind: "dedup" };
  if (mode.kind === "dedup") {
    const duplicate = index.findByUrl(url, job.url, job.meta?.finalUrl);
    if (duplicate) return { kind: "duplicate", path: duplicate };
  }
  const replacing = mode.kind === "replace" ? mode.path : null;
  /** A free path for a new note, or the note being replaced. */
  const targetPath = async (folder: string, base: string) => {
    if (replacing) return replacing;
    await vault.ensureFolder(folder);
    return freePath(vault, folder, base, "md");
  };
  const save = (path: string, content: string) => (replacing ? vault.replaceNote(path, content) : vault.createNote(path, content));

  if (input.note && job.status === "done") {
    const { note } = input;
    const folder = note.path.replace(/^\/+|\/+$/g, "") || options.notesFolder;
    const base = cleanName(note.noteName) || `bookmark-${formatDate((options.now ?? new Date()).toISOString(), "YYYY-MM-DD")}`;
    const notePath = await targetPath(folder, base);
    const saved = await saveFiles(input, options, notePath.slice(notePath.lastIndexOf("/") + 1, -3));
    const body = fillFiles(note.content, saved).replace(/^\s+/, "").trimEnd();
    await save(notePath, `${fillFiles(note.frontmatter, saved)}${body ? `${body}\n` : ""}`);
    index.set(notePath, url, job.id);
    return { kind: "written", path: notePath };
  }

  // A failed job's metadata describes the block page, not the bookmark.
  const meta = job.status === "failed" ? null : job.meta;
  const vars: Variables = {
    url,
    title: meta?.title || titleFromUrl(url),
    description: meta?.description ?? "",
    author: meta?.author ?? "",
    domain: meta?.domain || hostOf(url),
    site: meta?.site ?? "",
    published: meta?.published ?? "",
    image: meta?.image ?? "",
    favicon: meta?.favicon ?? "",
    date: (options.now ?? new Date()).toISOString(),
    capture_id: job.id,
    // Markers, filled in after rendering so ![[{{screenshot_page}}]] disappears when there's no screenshot.
    ...fileVariables(Object.fromEntries(CAPTURE_FILES.map((kind) => [kind, fileMarker(kind)]))),
  };

  const page: PageData | undefined = meta ?? undefined;
  const base = noteBaseName(template, vars, page);
  const notePath = await targetPath(options.notesFolder, base);
  const noteBase = notePath.slice(notePath.lastIndexOf("/") + 1, -3);

  const saved = await saveFiles(input, options, noteBase);

  let content = input.markdown.trim();
  if (job.status === "failed") {
    const error = (job.error ?? "Unknown error").replace(/\n/g, " ");
    content = `> [!warning] Capture failed\n> ${error}\n> [Retry capture](${retryLink(notePath)})\n\n${content}`.trim();
  }
  vars.content = content;

  const body = fillFiles(render(template.noteContentFormat, vars, page), saved).replace(/^\s+/, "").replace(/\n{3,}/g, "\n\n");
  await save(notePath, `${fillFiles(renderFrontmatter(template, vars, page, options.hideCaptureId), saved)}\n${body.trimEnd()}\n`);
  index.set(notePath, url, job.id);
  return { kind: "written", path: notePath };
}
