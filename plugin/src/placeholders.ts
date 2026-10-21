// Screenshot placeholders in the capture modal. The rendered note holds a
// marker for each screenshot its template uses; the modal shows each as its
// variable ({{screenshot_page}}) so the user sees where it goes and can delete
// it. A written note never links to a file that isn't there yet: each token is
// taken out when the note is written, with the text around it remembered, and
// the screenshot's link is put back there once its file is saved.
// Kept free of Obsidian so it can be tested.

import { CAPTURE_FILES, fileMarker, type CaptureFile } from "./api";

/** How a token was written: as an embed ![[…]], a link [[…]], or the bare path. */
export type TokenForm = "embed" | "link" | "bare";

/** Where a screenshot goes in a note's body, by the text around it. */
export interface BodyAnchor {
  in: "body";
  /** Up to ANCHOR_CHARS of text just before the token, after every token was taken out. */
  before: string;
  /** Up to ANCHOR_CHARS of text just after it. */
  after: string;
  form: TokenForm;
  /** The token had its line to itself, so its link goes back on its own line. */
  line: boolean;
  /** A blank line next to it was taken out with it. */
  blank: boolean;
  /** Its place among tokens at the same spot. */
  order: number;
}

/** A property whose value holds a screenshot, by the template's expression for it (e.g. "[[{{screenshot_banner}}]]"). */
export interface PropertyAnchor {
  in: "property";
  name: string;
  expression: string;
}

/** A screenshot a written note is still waiting on. */
export interface PendingInsert {
  captureId: string;
  notePath: string;
  kind: CaptureFile;
  where: BodyAnchor | PropertyAnchor;
}

const ANCHOR_CHARS = 120;
const token = (kind: CaptureFile) => `{{${kind}}}`;

/** Rendered text with each capture file's marker shown as its variable, for the modal. */
export function markersToTokens(text: string): string {
  return CAPTURE_FILES.reduce((out, kind) => out.split(fileMarker(kind)).join(token(kind)), text);
}

/** The capture files whose tokens are still in the text, in the order they first appear. */
export function tokensIn(text: string): CaptureFile[] {
  return CAPTURE_FILES.filter((kind) => text.includes(token(kind))).sort((a, b) => text.indexOf(token(a)) - text.indexOf(token(b)));
}

/** Every token in the text with its wrapper, in order. */
function findTokens(text: string): { kind: CaptureFile; start: number; end: number; form: TokenForm }[] {
  const found: { kind: CaptureFile; start: number; end: number; form: TokenForm }[] = [];
  const names = CAPTURE_FILES.map((kind) => kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(!?\\[\\[)?\\{\\{(${names})\\}\\}(\\]\\])?`, "g");
  for (const match of text.matchAll(pattern)) {
    const wrapped = match[1] && match[3];
    const start = wrapped ? match.index : match.index + (match[1]?.length ?? 0);
    const end = wrapped ? match.index + match[0].length : start + token(match[2] as CaptureFile).length;
    found.push({ kind: match[2] as CaptureFile, start, end, form: wrapped ? (match[1] === "![[" ? "embed" : "link") : "bare" });
  }
  return found;
}

/**
 * Takes every token out of a note's body, with its line when it had one to
 * itself, and says where each was by the text left around it.
 */
export function extractTokens(body: string): { body: string; anchors: (BodyAnchor & { kind: CaptureFile })[] } {
  const cuts: { kind: CaptureFile; from: number; to: number; form: TokenForm; line: boolean; blank: boolean }[] = [];
  for (const t of findTokens(body)) {
    const lineStart = body.lastIndexOf("\n", t.start - 1) + 1;
    const newline = body.indexOf("\n", t.end);
    const lineEnd = newline < 0 ? body.length : newline;
    const line = !body.slice(lineStart, t.start).trim() && !body.slice(t.end, lineEnd).trim();
    if (!line) {
      cuts.push({ kind: t.kind, from: t.start, to: t.end, form: t.form, line, blank: false });
      continue;
    }
    let to = newline < 0 ? body.length : newline + 1;
    // Between two blank lines: take one out too, so the gap doesn't double.
    const blank = lineStart >= 2 && body.slice(lineStart - 2, lineStart) === "\n\n" && body[to] === "\n";
    if (blank) to += 1;
    cuts.push({ kind: t.kind, from: lineStart, to, form: t.form, line, blank });
  }
  let out = "";
  let last = 0;
  const positions: number[] = [];
  const kept: typeof cuts = [];
  for (const cut of cuts) {
    if (cut.from < last) continue; // two tokens on one line: the first cut took the line
    out += body.slice(last, cut.from);
    positions.push(out.length);
    kept.push(cut);
    last = cut.to;
  }
  out += body.slice(last);
  const anchors = kept.map((cut, i) => {
    const at = positions[i]!;
    const order = positions.slice(0, i).filter((p) => p === at).length;
    return { in: "body" as const, kind: cut.kind, before: out.slice(Math.max(0, at - ANCHOR_CHARS), at), after: out.slice(at, at + ANCHOR_CHARS), form: cut.form, line: cut.line, blank: cut.blank, order };
  });
  return { body: out, anchors };
}

/** Where an anchor's link goes in the note as it is now: after its before-text, else before its after-text, else at the end. */
function findSpot(text: string, start: number, anchor: BodyAnchor): number {
  if (anchor.before) {
    let best = -1;
    for (let i = text.indexOf(anchor.before, start); i >= 0; i = text.indexOf(anchor.before, i + 1)) {
      const at = i + anchor.before.length;
      if (best < 0) best = at;
      // Prefer the spot whose after-text still matches.
      if (text.startsWith(anchor.after.slice(0, 20), at)) return at;
    }
    if (best >= 0) return best;
  }
  if (anchor.after) {
    const i = text.indexOf(anchor.after, start);
    if (i >= 0) return i;
  }
  return -1;
}

/** What goes into the note for an anchor, given the file's link (without the embed's "!"). */
function insertion(anchor: BodyAnchor, link: string, path: string): string {
  const text = anchor.form === "embed" ? `!${link}` : anchor.form === "link" ? link : path;
  return anchor.line ? `${text}\n${anchor.blank ? "\n" : ""}` : text;
}

/**
 * Puts saved screenshots back where their tokens were, in their original
 * order. `link` is the file's link as the user's link settings write it, and
 * `path` its vault path for bare tokens. A spot that's gone (the user edited
 * that part) gets its link at the end of the note.
 */
export function insertAll(text: string, items: readonly { anchor: BodyAnchor; link: string; path: string }[], contentStart = 0): string {
  let out = text;
  const sorted = [...items].sort((a, b) => a.anchor.order - b.anchor.order);
  // Same spot: each goes after the ones before it.
  const placed = new Map<string, number>();
  for (const item of sorted) {
    const key = `${item.anchor.before}\u0000${item.anchor.after}`;
    const add = insertion(item.anchor, item.link, item.path);
    let at = placed.get(key) ?? findSpot(out, contentStart, item.anchor);
    if (at < 0) {
      const body = out.trimEnd();
      out = `${body}${body.length > contentStart ? "\n\n" : ""}${add.trimEnd()}\n`;
      continue;
    }
    out = out.slice(0, at) + add + out.slice(at);
    at += add.length;
    placed.set(key, at);
  }
  return out;
}
