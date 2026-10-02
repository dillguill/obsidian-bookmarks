import type { Job } from "./api";
import type { DedupIndex } from "./dedup";
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
}

export interface WriteOptions {
  vault: VaultPort;
  index: DedupIndex;
  template: ClipperTemplate;
  notesFolder: string;
  assetsFolder: string;
  now?: Date;
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

function noteBaseName(template: ClipperTemplate, vars: Variables): string {
  const name = render(template.noteNameFormat, vars)
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-\s.]+|[-\s.]+$/g, "")
    .slice(0, 120);
  return name || `bookmark-${formatDate(vars.date ?? "", "YYYY-MM-DD")}`;
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

  const existing = index.findByCaptureId(job.id);
  if (existing) return { kind: "already-written", path: existing };

  const url = bookmarkUrl(job);
  const duplicate = index.findByUrl(url, job.url, job.meta?.finalUrl);
  if (duplicate) return { kind: "duplicate", path: duplicate };

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

  const base = noteBaseName(template, vars);
  await vault.ensureFolder(options.notesFolder);
  const notePath = await freePath(vault, options.notesFolder, base, "md");
  const noteBase = notePath.slice(notePath.lastIndexOf("/") + 1, -3);

  if (input.screenshot && job.screenshotExt) {
    await vault.ensureFolder(options.assetsFolder);
    const shotPath = await freePath(vault, options.assetsFolder, noteBase, job.screenshotExt);
    await vault.writeBinary(shotPath, input.screenshot);
    vars.screenshot = shotPath;
    vars.screenshot_link = `[[${shotPath}]]`;
    vars.screenshot_embed = `![[${shotPath}]]`;
  }

  let content = input.markdown.trim();
  if (job.status === "failed") {
    content = `> [!warning] Capture failed\n> ${(job.error ?? "Unknown error").replace(/\n/g, " ")}\n\n${content}`.trim();
  }
  vars.content = content;

  const body = render(template.noteContentFormat, vars).replace(/^\s+/, "").replace(/\n{3,}/g, "\n\n");
  await vault.createNote(notePath, `${renderFrontmatter(template, vars)}\n${body.trimEnd()}\n`);
  index.set(notePath, url, job.id);
  return { kind: "written", path: notePath };
}
