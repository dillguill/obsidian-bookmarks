import { SCREENSHOT_MARKER, type Job, type RenderedNote } from "./api";
import type { DedupIndex } from "./dedup";
import type { PageData } from "./page-data";
import { formatDate, render, renderFrontmatter, type ClipperTemplate, type Variables } from "./template";

/** The slice of the vault the writer needs, so it can be tested without Obsidian. */
export interface VaultPort {
  exists(path: string): Promise<boolean>;
  ensureFolder(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  createNote(path: string, content: string): Promise<void>;
}

export interface CapturedBookmark {
  job: Job;
  /** Readable markdown; empty when the job failed or the page had none. */
  markdown: string;
  screenshot: ArrayBuffer | null;
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
 * on the same site, so the stored value and later dedup lookups agree (audit #4).
 */
export function bookmarkUrl(job: Job): string {
  const final = job.meta?.finalUrl || job.url;
  const canonical = job.meta?.canonical;
  return canonical && sameSite(canonical, final) ? canonical : final;
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

/** Swaps the server's screenshot marker for the saved file's vault path, or drops it when there's no screenshot. */
function fillScreenshot(text: string, path: string | null): string {
  if (path) return text.split(SCREENSHOT_MARKER).join(path);
  return text.split(`![[${SCREENSHOT_MARKER}]]`).join("").split(`[[${SCREENSHOT_MARKER}]]`).join("").split(SCREENSHOT_MARKER).join("");
}

async function saveScreenshot(input: CapturedBookmark, options: WriteOptions, noteBase: string): Promise<string | null> {
  const { job } = input;
  if (!input.screenshot || !job.screenshotExt) return null;
  await options.vault.ensureFolder(options.assetsFolder);
  const shotPath = await freePath(options.vault, options.assetsFolder, noteBase, job.screenshotExt);
  await options.vault.writeBinary(shotPath, input.screenshot);
  return shotPath;
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
  const duplicate = index.findByUrl(url, job.url, job.meta?.finalUrl);
  if (duplicate) return { kind: "duplicate", path: duplicate };

  if (input.note && job.status === "done") {
    const { note } = input;
    const folder = note.path.replace(/^\/+|\/+$/g, "") || options.notesFolder;
    const base = cleanName(note.noteName) || `bookmark-${formatDate((options.now ?? new Date()).toISOString(), "YYYY-MM-DD")}`;
    await vault.ensureFolder(folder);
    const notePath = await freePath(vault, folder, base, "md");
    const shotPath = await saveScreenshot(input, options, notePath.slice(notePath.lastIndexOf("/") + 1, -3));
    const body = fillScreenshot(note.content, shotPath).replace(/^\s+/, "").trimEnd();
    await vault.createNote(notePath, `${fillScreenshot(note.frontmatter, shotPath)}${body ? `${body}\n` : ""}`);
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
    screenshot: "",
    screenshot_link: "",
    screenshot_embed: "",
  };

  const page: PageData | undefined = meta ?? undefined;
  const base = noteBaseName(template, vars, page);
  await vault.ensureFolder(options.notesFolder);
  const notePath = await freePath(vault, options.notesFolder, base, "md");
  const noteBase = notePath.slice(notePath.lastIndexOf("/") + 1, -3);

  const shotPath = await saveScreenshot(input, options, noteBase);
  if (shotPath) {
    vars.screenshot = shotPath;
    vars.screenshot_link = `[[${shotPath}]]`;
    vars.screenshot_embed = `![[${shotPath}]]`;
  }

  let content = input.markdown.trim();
  if (job.status === "failed") {
    content = `> [!warning] Capture failed\n> ${(job.error ?? "Unknown error").replace(/\n/g, " ")}\n\n${content}`.trim();
  }
  vars.content = content;

  const body = render(template.noteContentFormat, vars, page).replace(/^\s+/, "").replace(/\n{3,}/g, "\n\n");
  await vault.createNote(notePath, `${renderFrontmatter(template, vars, page, options.hideCaptureId)}\n${body.trimEnd()}\n`);
  index.set(notePath, url, job.id);
  return { kind: "written", path: notePath };
}
