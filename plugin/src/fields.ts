// Property rows in the capture and update modals: a rendered note's properties
// as editable text, each typed the way the vault already types it, and back
// to frontmatter values. Kept free of Obsidian so it can be tested.

import type { ClipperTemplate, RenderedNote } from "./api";
import { markersToTokens, tokensIn } from "./placeholders";

/** The property types Obsidian's Properties view knows. */
export const FIELD_TYPES = ["text", "multitext", "number", "checkbox", "date", "datetime", "tags", "aliases"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Lucide icon Obsidian's Properties view shows for each type. */
export const TYPE_ICONS: Record<FieldType, string> = {
  text: "text",
  multitext: "list",
  number: "binary",
  checkbox: "check-square",
  date: "calendar",
  datetime: "clock",
  tags: "tags",
  aliases: "forward",
};

const LIST_TYPES: ReadonlySet<FieldType> = new Set(["multitext", "tags", "aliases"]);

/** One property as the modal shows and edits it. */
export interface PropertyField {
  name: string;
  type: FieldType;
  /** As shown and edited: lists comma-separated, screenshots as their {{variable}}. */
  text: string;
  /** The template's value for it, or "" for a property the template doesn't have. */
  expression: string;
  edited: boolean;
}

/** The vault's property types, from Obsidian's types.json ({"types": {name: type}}); empty when it's missing or unreadable. */
export function vaultTypes(typesJson: string | null): Record<string, FieldType> {
  if (!typesJson) return {};
  try {
    const types = (JSON.parse(typesJson) as { types?: Record<string, unknown> }).types ?? {};
    return Object.fromEntries(Object.entries(types).filter((entry): entry is [string, FieldType] => FIELD_TYPES.includes(entry[1] as FieldType)));
  } catch {
    return {};
  }
}

/** A property's type: the vault's, else the template's, else text. */
export function fieldType(name: string, types: Record<string, FieldType>, template?: ClipperTemplate): FieldType {
  const fromTemplate = template?.properties.find((p) => p.name === name)?.type;
  return types[name] ?? (fromTemplate && FIELD_TYPES.includes(fromTemplate) ? fromTemplate : "text");
}

/** A frontmatter value as one line of editable text: lists comma-separated. */
export function valueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((item) => valueText(item)).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The template's properties as empty rows, for before the page is read. */
export function emptyFields(template: ClipperTemplate, types: Record<string, FieldType>): PropertyField[] {
  return template.properties.map((p) => ({ name: p.name, type: fieldType(p.name, types, template), text: "", expression: p.value, edited: false }));
}

/** A rendered note's properties as rows, in the template's order, then any the server added (its URL and capture id). */
export function fieldsFrom(note: RenderedNote, template: ClipperTemplate, types: Record<string, FieldType>, parseYaml: (yaml: string) => unknown): PropertyField[] {
  const yaml = /^---\n([\s\S]*?)\n?---/.exec(note.frontmatter)?.[1] ?? "";
  const values = (yaml.trim() ? parseYaml(yaml) : {}) as Record<string, unknown> | null;
  const names = [...template.properties.map((p) => p.name), ...Object.keys(values ?? {})].filter((name, i, all) => all.indexOf(name) === i);
  return names
    .filter((name) => values && name in values)
    .map((name) => ({
      name,
      type: fieldType(name, types, template),
      text: markersToTokens(valueText(values![name])),
      expression: template.properties.find((p) => p.name === name)?.value ?? "",
      edited: false,
    }));
}

/** Splits a list typed as text on commas, leaving commas inside [[links]] and quotes alone, as Web Clipper does. */
export function splitList(text: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (text.startsWith("[[", i)) {
      depth++;
      current += "[[";
      i++;
    } else if (text.startsWith("]]", i) && depth > 0) {
      depth--;
      current += "]]";
      i++;
    } else if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
    } else current += ch;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

/** One field's frontmatter value, typed; null (an empty property, as Obsidian keeps one) when it's empty or waiting on a screenshot. */
export function fieldValue(field: Pick<PropertyField, "type" | "text">): unknown {
  const text = field.text.trim();
  if (!text || tokensIn(text).length) return null;
  if (LIST_TYPES.has(field.type)) return splitList(text);
  if (field.type === "number") {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  if (field.type === "checkbox") return /^(true|yes|1|on)$/i.test(text);
  return text;
}

/**
 * The fields as frontmatter values for processFrontMatter. Empty ones stay as
 * empty properties, the way a template's blank `tags` or `status` is meant to
 * be filled in later; one waiting on a screenshot is empty until it arrives.
 */
export function frontmatterFrom(fields: readonly PropertyField[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.name, fieldValue(field)]));
}
