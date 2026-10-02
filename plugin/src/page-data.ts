// Web Clipper's {{schema:…}} and {{meta:…}} variables, filled from the
// JSON-LD and <meta> tags the server collects with each capture.

export interface PageData {
  schema?: unknown[];
  metaTags?: Record<string, string>;
}

function typeMatches(value: unknown, type: string): boolean {
  if (!value || typeof value !== "object") return false;
  const t = (value as Record<string, unknown>)["@type"];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

/** "itemListElement[2].name" -> ["itemListElement", 2, "name"]; "[*]" maps over an array. */
function pathTokens(path: string): Array<string | number | "*"> {
  const tokens: Array<string | number | "*"> = [];
  for (const part of path.split(".")) {
    const match = /^([^[\]]*)((?:\[(?:\d+|\*)\])*)$/.exec(part);
    if (!match) return [];
    if (match[1]) tokens.push(match[1]);
    for (const index of match[2]!.matchAll(/\[(\d+|\*)\]/g)) tokens.push(index[1] === "*" ? "*" : Number(index[1]));
  }
  return tokens;
}

function walk(value: unknown, tokens: Array<string | number | "*">): unknown {
  if (tokens.length === 0) return value;
  const [token, ...rest] = tokens;
  if (token === "*") return Array.isArray(value) ? value.map((item) => walk(item, rest)).filter((v) => v !== undefined) : undefined;
  if (value === null || typeof value !== "object") return undefined;
  if (typeof token === "number") return Array.isArray(value) ? walk(value[token], rest) : undefined;
  // A property holding a one-item list reads like the item, as in Web Clipper.
  const next = (value as Record<string, unknown>)[token!];
  return walk(next, rest);
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v !== "object" || v === null)) return value.map(stringify).join(", ");
  return JSON.stringify(value);
}

/**
 * Resolves the part after "schema:" — "@Type:path", "@Type" or "path" —
 * against the page's JSON-LD; the first object that has the path wins.
 */
export function schemaValue(expr: string, data: PageData): string {
  const objects = data.schema ?? [];
  let type: string | null = null;
  let path = expr;
  if (expr.startsWith("@")) {
    const colon = expr.indexOf(":");
    type = colon === -1 ? expr.slice(1) : expr.slice(1, colon);
    path = colon === -1 ? "" : expr.slice(colon + 1);
  }
  const candidates = type ? objects.filter((o) => typeMatches(o, type!)) : objects;
  const tokens = pathTokens(path);
  for (const object of candidates) {
    const found = path ? walk(object, tokens) : object;
    if (found !== undefined && !(Array.isArray(found) && found.length === 0)) return stringify(found);
  }
  return "";
}

/** "name:author" or "property:og:title". */
export function metaValue(expr: string, data: PageData): string {
  return data.metaTags?.[expr] ?? "";
}

/** Value for a `schema:` / `meta:` variable, or undefined for any other name. */
export function pageVariable(key: string, data: PageData | undefined): string | undefined {
  if (!data) return undefined;
  if (key.startsWith("schema:")) return schemaValue(key.slice("schema:".length), data);
  if (key.startsWith("meta:")) return metaValue(key.slice("meta:".length), data);
  return undefined;
}
