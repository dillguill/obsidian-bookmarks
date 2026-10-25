// Media in a note stays where it lives on the web (an image's address, the
// TikTok player for a post) unless the template marks it with the `|local`
// filter, which asks for a copy in the vault. Web Clipper's engine has no such
// filter, so it's taken out of the template before rendering and the value it
// was on is wrapped in two markers; after rendering, the markers are taken
// out again and the values between them listed, for the plugin (or the
// server, for captures nobody is watching) to download once the note is written.

import type { ClipperTemplate, RenderedNote } from "./api.js";

const OPEN = "bookmarkslocal5f2c9eopen";
const CLOSE = "bookmarkslocal5f2c9eclose";

/** Text with each tag that has a `|local` filter rewritten as the tag without it, between the markers. */
export function withLocalTags(text: string): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (tag: string, inner: string) => {
    const parts = inner.split("|");
    const kept = parts.filter((part, i) => i === 0 || part.trim() !== "local");
    return kept.length === parts.length ? tag : `${OPEN}{{${kept.join("|").trim()}}}${CLOSE}`;
  });
}

/** The template with `|local` taken out of every field, ready for Web Clipper's engine. */
export function withLocalFilter(template: ClipperTemplate): ClipperTemplate {
  return {
    ...template,
    noteNameFormat: withLocalTags(template.noteNameFormat),
    path: withLocalTags(template.path),
    noteContentFormat: withLocalTags(template.noteContentFormat),
    properties: template.properties.map((p) => ({ ...p, value: withLocalTags(p.value) })),
  };
}

/** A value worth saving: it holds a web address (an image, a video page, a player). */
function isMedia(value: string): boolean {
  return /https?:\/\//i.test(value);
}

/**
 * Takes the markers out of rendered text, adding each media value between
 * them to `marks`. With `single`, for properties, a value can only become a
 * link to one file: one that isn't a single web address (a player, a list) is
 * left blank rather than written as something that can't be saved there.
 */
function takeMarks(text: string, marks: Set<string>, single = false): string {
  return text.replace(new RegExp(`${OPEN}([\\s\\S]*?)${CLOSE}`, "g"), (_, value: string) => {
    const trimmed = value.trim();
    if (single && trimmed && !/^(\[\[)?https?:\/\/[^\s"'\]]+(\]\])?$/i.test(trimmed)) return "";
    if (trimmed && isMedia(trimmed)) marks.add(trimmed);
    return value;
  });
}

/**
 * A web address wrapped as a wikilink, as a template written for saved files
 * does (`[[{{tiktok_thumbnail}}]]`): an embed becomes a Markdown image and a
 * link the bare address, since Obsidian can't follow a wikilink to the web.
 */
export function unwrapWebLinks(text: string): string {
  return text.replace(/(!?)\[\[\s*(https?:\/\/[^\]|\s]+)\s*\]\]/g, (_, bang: string, url: string) => (bang ? `![](${url})` : url));
}

/** The same player twice in a row (from {{tiktok_embed}} and {{tiktok_images}} both) is shown once. */
export function oneTikTokPlayer(text: string, player: string): string {
  if (!player) return text;
  const twice = new RegExp(`(${escape(player)})(\\s*${escape(player)})+`, "g");
  return text.replace(twice, "$1");
}

/** A rendered note with its `|local` markers taken out and listed in `local` (a property's only when it's one address), and web addresses unwrapped. */
export function withLocalMarks(note: RenderedNote, player: string): RenderedNote {
  const marks = new Set<string>();
  // A value left blank takes its [[ ]] or ![[ ]] with it, as a missing screenshot's does.
  const clean = (text: string, single = false) => unwrapWebLinks(takeMarks(text, marks, single)).replace(/!?\[\[\s*\]\]/g, "");
  const local = (text: string) => text.split(OPEN).join("").split(CLOSE).join("");
  const frontmatter = clean(note.frontmatter, true);
  const content = oneTikTokPlayer(clean(note.content), player);
  return {
    ...note,
    noteName: local(note.noteName),
    path: local(note.path),
    frontmatter,
    content,
    local: [...marks].map(unwrapWebLinks),
  };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
