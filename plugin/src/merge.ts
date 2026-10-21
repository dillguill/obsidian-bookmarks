// Merging notes that point at the same page: which note survives, what
// happens to each of the others, and which property values the survivor ends
// up with. Kept free of Obsidian so it can be tested; the plugin reads the notes
// from the metadata cache and applies the plan.

import { asList, isEmpty, same } from "./values";

/** What a merge does with a note: keeps it, folds it into the kept note, trashes it, or leaves it alone for good. */
export type Disposition = "keep" | "merge" | "delete" | "separate";

export type Dispositions = Map<string, Disposition>;

export interface MergeNote {
  path: string;
  basename: string;
  folder: string;
  frontmatter: Record<string, unknown>;
  /** Number of other notes linking to this one. */
  backlinks: number;
  /** The plugin wrote it (a capture id is set). */
  hasCaptureId: boolean;
  /** From a created/date/captured property, as epoch ms; null when there's none. */
  date: number | null;
  ctime: number;
}

/** Notes in the order they're offered as the one to keep: most linked, plugin-written, earliest date, earliest file. */
export function rankNotes(notes: readonly MergeNote[]): MergeNote[] {
  return [...notes].sort(
    (a, b) =>
      b.backlinks - a.backlinks ||
      Number(b.hasCaptureId) - Number(a.hasCaptureId) ||
      (a.date ?? Infinity) - (b.date ?? Infinity) ||
      a.ctime - b.ctime,
  );
}

/** Starting dispositions: notes marked separate stay so, the best-ranked other note is kept, the rest merged into it. */
export function initialDispositions(ranked: readonly MergeNote[], separate: readonly string[]): Dispositions {
  const state: Dispositions = new Map();
  for (const n of ranked) state.set(n.path, separate.includes(n.path) ? "separate" : "merge");
  const first = ranked.find((n) => state.get(n.path) !== "separate");
  if (first) state.set(first.path, "keep");
  return state;
}

/**
 * Changes one note's disposition, keeping exactly one note Keep while any note
 * isn't separate: a new Keep demotes the old one to Merge, and demoting the Keep
 * note promotes the next-ranked note that isn't separate.
 */
export function setDisposition(state: Dispositions, ranked: readonly MergeNote[], path: string, to: Disposition): Dispositions {
  const next: Dispositions = new Map(state);
  if (to === "keep") for (const [p, d] of next) if (d === "keep") next.set(p, "merge");
  next.set(path, to);
  if (![...next.values()].includes("keep")) {
    const active = (p: string) => next.get(p) !== "separate";
    const heir = ranked.find((n) => n.path !== path && active(n.path))?.path ?? (active(path) ? path : undefined);
    if (heir) next.set(heir, "keep");
  }
  return next;
}

/** A group is worth offering while two or more of its notes aren't marked separate. */
export function countsAsDuplicate(paths: readonly string[], separate: readonly string[]): boolean {
  return paths.filter((p) => !separate.includes(p)).length >= 2;
}

/** One property across the kept and merged notes. */
export type PropertyChoice =
  /** Equal everywhere, or only one note has it. */
  | { name: string; variants: string[]; kind: "settled"; value: unknown }
  /** A list in at least one note: every item, once, in note order. */
  | { name: string; variants: string[]; kind: "list"; value: unknown[] }
  /** Differing single values: the user picks one. */
  | { name: string; variants: string[]; kind: "conflict"; options: { value: unknown; from: string }[] };

/**
 * How each property combines across `notes` (the kept note first, then the
 * notes merged into it). Names differing only by case are one property, spelled
 * as the kept note spells it, else as the vault mostly does; the other spellings
 * are listed in `variants` so they can be removed. Properties named in `skip`
 * (the URL and capture id) are left out.
 */
export function mergeChoices(notes: readonly MergeNote[], skip: readonly string[], spelling: (lower: string) => string | undefined): PropertyChoice[] {
  const skipped = new Set(skip.map((name) => name.toLowerCase()));
  const found = new Map<string, { spellings: string[]; values: { value: unknown; from: string }[]; inKept: string | null; keptValue: unknown }>();
  notes.forEach((n, i) => {
    for (const [key, value] of Object.entries(n.frontmatter)) {
      const lower = key.toLowerCase();
      if (skipped.has(lower)) continue;
      const entry = found.get(lower) ?? { spellings: [], values: [], inKept: null, keptValue: undefined };
      found.set(lower, entry);
      if (!entry.spellings.includes(key)) entry.spellings.push(key);
      if (i === 0 && entry.inKept === null) {
        entry.inKept = key;
        entry.keptValue = value;
      }
      if (!isEmpty(value) && !entry.values.some((v) => v.from === n.path)) entry.values.push({ value, from: n.path });
    }
  });

  const choices: PropertyChoice[] = [];
  for (const [lower, entry] of found) {
    const name = entry.inKept ?? spelling(lower) ?? entry.spellings[0]!;
    const variants = entry.spellings.filter((s) => s !== name);
    if (!entry.values.length) {
      if (entry.inKept !== null) choices.push({ name, variants, kind: "settled", value: entry.keptValue });
      continue;
    }
    if (entry.values.some((v) => Array.isArray(v.value))) {
      const items: unknown[] = [];
      for (const { value } of entry.values) for (const item of asList(value)) if (!items.some((x) => same(x, item))) items.push(item);
      choices.push({ name, variants, kind: "list", value: items });
      continue;
    }
    const options = entry.values.filter((v, i) => entry.values.findIndex((w) => same(w.value, v.value)) === i);
    if (options.length === 1) choices.push({ name, variants, kind: "settled", value: options[0]!.value });
    else choices.push({ name, variants, kind: "conflict", options });
  }
  return choices;
}

/** How a conflicting property is settled: one note's value, every value as a list, or each value under a name of its own ("" drops it). */
export type ConflictPick = { kind: "value"; option: number } | { kind: "list" } | { kind: "each"; names: string[] };

/** The values a conflict resolves to, by property name. */
function resolveConflict(choice: Extract<PropertyChoice, { kind: "conflict" }>, pick: ConflictPick | undefined): Record<string, unknown> {
  if (pick?.kind === "list") {
    const items: unknown[] = [];
    for (const { value } of choice.options) if (!items.some((x) => same(x, value))) items.push(value);
    return { [choice.name]: items };
  }
  if (pick?.kind === "each") {
    const out: Record<string, unknown> = {};
    choice.options.forEach((option, i) => {
      const name = pick.names[i]?.trim();
      if (name) out[name] = option.value;
    });
    return out;
  }
  const option = choice.options[pick?.option ?? 0] ?? choice.options[0]!;
  return { [choice.name]: option.value };
}

/** Notes whose value of a property survives the merge, for a conflict and how it's settled (none for other properties). */
export function keptFrom(choice: PropertyChoice, pick: ConflictPick | undefined): string[] {
  if (choice.kind !== "conflict") return [];
  if (pick?.kind === "list") return choice.options.map((o) => o.from);
  if (pick?.kind === "each") return choice.options.filter((_, i) => pick.names[i]?.trim()).map((o) => o.from);
  return [(choice.options[pick?.option ?? 0] ?? choice.options[0]!).from];
}

/** Why the conflict picks can't be applied (a name used twice, a property with nothing kept), or null. */
export function pickProblem(choices: readonly PropertyChoice[], picks: Record<string, ConflictPick>): string | null {
  const seen = new Set<string>();
  for (const choice of choices) {
    const pick = picks[choice.name];
    const names =
      choice.kind === "conflict" && pick?.kind === "each" ? pick.names.map((n) => n.trim()).filter(Boolean) : choice.kind === "conflict" ? Object.keys(resolveConflict(choice, pick)) : [choice.name];
    if (choice.kind === "conflict" && !names.length) return `Keep at least one value of ${choice.name}, or pick one.`;
    for (const name of names) {
      if (seen.has(name.toLowerCase())) return `“${name}” is used for two values.`;
      seen.add(name.toLowerCase());
    }
  }
  return null;
}

/** What applying a merge does. */
export interface MergePlan {
  /** The surviving note; null when only Separate marks change. */
  kept: string | null;
  merge: string[];
  delete: string[];
  separate: string[];
  properties: { set: Record<string, unknown>; remove: string[] };
  /** Names of the removed notes, for the kept note's aliases. */
  aliases: string[];
  /** Merge notes' bodies, in order, to append under a heading each. */
  bodies: { heading: string; body: string }[];
}

/** Turns the user's choices into a plan. `picks` settles each conflicting property (default: the kept note's value). */
export function mergePlan(input: {
  notes: readonly MergeNote[];
  state: Dispositions;
  choices: readonly PropertyChoice[];
  picks: Record<string, ConflictPick>;
  bodies: Record<string, string>;
}): MergePlan {
  const having = (d: Disposition) => input.notes.filter((n) => input.state.get(n.path) === d);
  const kept = having("keep")[0] ?? null;
  const merge = kept ? having("merge") : [];
  const del = kept ? having("delete") : [];
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  if (kept) {
    for (const choice of input.choices) {
      const values = choice.kind === "conflict" ? resolveConflict(choice, input.picks[choice.name]) : { [choice.name]: choice.value };
      Object.assign(set, values);
      remove.push(...choice.variants);
      if (!(choice.name in values)) remove.push(choice.name);
    }
  }
  return {
    kept: kept?.path ?? null,
    merge: merge.map((n) => n.path),
    delete: del.map((n) => n.path),
    separate: having("separate").map((n) => n.path),
    properties: { set, remove },
    aliases: [...merge, ...del].map((n) => n.basename),
    bodies: merge.map((n) => ({ heading: n.basename, body: (input.bodies[n.path] ?? "").trim() })).filter((b) => b.body),
  };
}

/** Sets the planned properties on the kept note's frontmatter (as processFrontMatter hands it over). */
export function applyMergedProperties(frontmatter: Record<string, unknown>, plan: Pick<MergePlan, "properties" | "aliases">): void {
  for (const name of plan.properties.remove) delete frontmatter[name];
  Object.assign(frontmatter, plan.properties.set);
  const aliases = asList(frontmatter.aliases);
  const known = new Set(aliases.map((a) => String(a).toLowerCase()));
  const added = plan.aliases.filter((a) => !known.has(a.toLowerCase()) && known.add(a.toLowerCase()));
  if (added.length) frontmatter.aliases = [...aliases, ...added];
}

/** The kept note's text with each merged body appended under a heading with that note's name. */
export function appendBodies(text: string, plan: Pick<MergePlan, "bodies">, frontmatterEnd: number): string {
  if (!plan.bodies.length) return text;
  const front = text.slice(0, frontmatterEnd);
  let body = joinBlocks("", text.slice(frontmatterEnd));
  for (const b of plan.bodies) body = joinBlocks(body, `# ${b.heading}\n\n${b.body}`.replace(/\n{3,}/g, "\n\n").trim());
  return `${front && !front.endsWith("\n") ? `${front}\n` : front}${body}\n`;
}

/** Joins two pieces of Markdown with one blank line, dropping the newlines at their edges. */
function joinBlocks(out: string, piece: string): string {
  const p = piece.replace(/^\n+/, "").replace(/\s+$/, "");
  if (!p.trim()) return out;
  return out ? `${out}\n\n${p}` : p;
}

/**
 * Files (not notes) the removed notes link to that nothing else will use: no
 * note outside `removed` links to them, and the merge doesn't carry them into
 * the kept note.
 */
export function unusedFiles(input: {
  removed: readonly string[];
  linksFrom: (path: string) => readonly string[];
  linkedBy: (target: string) => readonly string[];
  carried: readonly string[];
  isNote: (path: string) => boolean;
}): string[] {
  const out: string[] = [];
  for (const path of input.removed) {
    for (const target of input.linksFrom(path)) {
      if (out.includes(target) || input.isNote(target) || input.carried.includes(target)) continue;
      if (input.linkedBy(target).every((source) => input.removed.includes(source))) out.push(target);
    }
  }
  return out;
}
