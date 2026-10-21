// Updating a note from its source: each of its properties next to what the
// fetched page gives for it, and what the note will hold after. Kept free of
// Obsidian so it can be tested.

import { fieldValue, splitList, valueText, type FieldType, type PropertyField } from "./fields";
import { hasTikTokPlayer, withoutTikTokPlayer } from "./media";
import { asList, isEmpty, same } from "./values";

/** What happens to a property: stays as it is, takes the fetched value, combines both lists, takes what the user typed, or goes. */
export type RowMode = "keep" | "replace" | "merge" | "edit" | "remove";

export interface UpdateRow {
  name: string;
  type: FieldType;
  /** The note's value now; undefined when it doesn't have the property. */
  current: unknown;
  /** What the fetched page gives for it, as text; null when the template doesn't have it, or nothing was fetched. */
  next: string | null;
  mode: RowMode;
  /** What the property will hold, as the row shows it. */
  text: string;
}

const LISTS: ReadonlySet<FieldType> = new Set(["multitext", "tags", "aliases"]);

export const isList = (type: FieldType) => LISTS.has(type);

/** Both lists, each item once, the note's first. */
function mergedList(current: unknown, next: string): unknown[] {
  const out: unknown[] = [];
  for (const item of [...asList(current), ...splitList(next)]) if (!out.some((o) => same(o, item))) out.push(item);
  return out;
}

/** The row's text for a mode. */
function textFor(row: Omit<UpdateRow, "text">, typed = ""): string {
  if (row.mode === "replace") return row.next ?? "";
  if (row.mode === "merge") return valueText(mergedList(row.current, row.next ?? ""));
  if (row.mode === "edit") return typed;
  if (row.mode === "remove") return "";
  return valueText(row.current);
}

/** What the template sets up for a property: fill it when it's empty, combine lists, otherwise keep what the note has. */
function defaultMode(type: FieldType, current: unknown, next: string | null): RowMode {
  if (next === null || !next.trim()) return "keep";
  if (isEmpty(current)) return "replace";
  if (valueText(current) === next) return "keep";
  return isList(type) ? "merge" : "keep";
}

/**
 * The rows for a note: its properties in their order, then the fetched ones it
 * doesn't have. `skip` are properties never offered (its URL and capture id).
 */
export function updateRows(frontmatter: Record<string, unknown>, fetched: readonly PropertyField[] | null, types: Record<string, FieldType>, skip: readonly string[] = []): UpdateRow[] {
  const next = new Map((fetched ?? []).map((f) => [f.name, f]));
  const names = [...Object.keys(frontmatter), ...(fetched ?? []).map((f) => f.name)].filter((name, i, all) => all.indexOf(name) === i && !skip.includes(name));
  return names.map((name) => {
    const field = next.get(name);
    const type = types[name] ?? field?.type ?? "text";
    const row = { name, type, current: frontmatter[name], next: field ? field.text : null, mode: defaultMode(type, frontmatter[name], field ? field.text : null) };
    return { ...row, text: textFor(row) };
  });
}

/** A row with another mode; `typed` is the text for "edit". */
export function withMode(row: UpdateRow, mode: RowMode, typed = row.text): UpdateRow {
  const next = { ...row, mode: mode === "merge" && !canMerge(row) ? "replace" : mode };
  return { ...next, text: textFor(next, typed) };
}

/** Merging needs a list on one side and something on both. */
export function canMerge(row: Pick<UpdateRow, "type" | "current" | "next">): boolean {
  return row.next !== null && !isEmpty(row.current) && (isList(row.type) || Array.isArray(row.current));
}

/** "Replace whole note": every property the page gives takes its value; the rest stay. */
export function replaceAll(rows: readonly UpdateRow[]): UpdateRow[] {
  return rows.map((row) => (row.next !== null && row.mode !== "remove" ? withMode(row, "replace") : row));
}

/** Applies the rows to a note's frontmatter (from processFrontMatter); kept rows aren't touched, so their YAML stays as it was. */
export function applyRows(frontmatter: Record<string, unknown>, rows: readonly UpdateRow[]): void {
  for (const row of rows) {
    if (row.mode === "keep") continue;
    if (row.mode === "remove") delete frontmatter[row.name];
    else if (row.mode === "merge") frontmatter[row.name] = mergedList(row.current, row.next ?? "");
    else frontmatter[row.name] = fieldValue({ type: row.type, text: row.mode === "replace" ? (row.next ?? "") : row.text });
  }
}

/** Something will change. */
export function rowsChange(rows: readonly UpdateRow[]): boolean {
  return rows.some((row) => row.mode !== "keep");
}

/** What happens to the note's body: stays, gets the fetched body after it, or is replaced by it. */
export type BodyMode = "keep" | "append" | "replace";

/** A body whose TikTok post was saved as files: an embed of a saved TikTok video or photo, and no player. */
function savedTikTok(body: string): boolean {
  return !hasTikTokPlayer(body) && /!\[\[[^\]]*tiktok[^\]]*\.(mp4|jpe?g|png|webp)\]\]/i.test(body);
}

/**
 * The note's text with its body kept, the fetched body appended, or replaced
 * by it; the frontmatter stays. A post already saved as files doesn't get the
 * TikTok player back.
 */
export function updateBody(text: string, contentStart: number, next: string, mode: BodyMode): string {
  if (mode === "keep") return text;
  const front = text.slice(0, contentStart);
  const body = text.slice(contentStart);
  const incoming = (savedTikTok(body) ? withoutTikTokPlayer(next) : next).trim();
  if (mode === "replace") return `${front}${incoming ? `${incoming}\n` : ""}`;
  if (!incoming) return text;
  const kept = body.trimEnd();
  return `${front}${kept ? `${kept}\n\n` : ""}${incoming}\n`;
}
