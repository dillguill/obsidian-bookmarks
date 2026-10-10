// Pointing links at another note: when duplicates are merged, links to the
// removed notes are rewritten to the kept one. Kept free of Obsidian so it can
// be tested; the plugin finds the links and generates the new ones.

export interface Span {
  start: number;
  end: number;
  replacement: string;
}

/** Replaces each span of `text`, working from the end so earlier offsets stay valid. Overlapping spans are a bug. */
export function spliceSpans(text: string, spans: readonly Span[]): string {
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  let limit = Infinity;
  for (const span of sorted) {
    if (span.end > limit) throw new Error(`overlapping link spans at ${span.start}`);
    out = out.slice(0, span.start) + span.replacement + out.slice(span.end);
    limit = span.start;
  }
  return out;
}

/** A link as Obsidian's metadata cache describes it. */
export interface LinkRef {
  /** The link as written, e.g. `[[A#H|x]]` or `[x](A.md)`. */
  original: string;
  /** Its destination, e.g. `A#H`. */
  link: string;
  displayText?: string;
  embed: boolean;
}

/**
 * The link to write in place of one pointing at a removed note: same heading or
 * block, same visible text. Links show their text as the alias (falling back to
 * the removed note's name); embeds keep an alias only if one was written.
 */
export function redirectedLink(ref: LinkRef, removedBasename: string, generate: (subpath: string, alias: string) => string): string {
  const hash = ref.link.indexOf("#");
  const subpath = hash >= 0 ? ref.link.slice(hash) : "";
  const written = ref.original.includes("|") || /^!?\[[^\]]*\]\(/.test(ref.original);
  const alias = ref.embed ? (written ? (ref.displayText ?? "") : "") : (ref.displayText ?? removedBasename);
  return (ref.embed ? "!" : "") + generate(subpath, alias);
}

/** Replaces `original` in a frontmatter value (a string, or an item of a list); true when something changed. */
export function redirectFrontmatter(frontmatter: Record<string, unknown>, key: string, original: string, replacement: string): boolean {
  const value = frontmatter[key];
  if (value === original) {
    frontmatter[key] = replacement;
    return true;
  }
  if (Array.isArray(value) && value.includes(original)) {
    frontmatter[key] = value.map((item) => (item === original ? replacement : item));
    return true;
  }
  return false;
}
