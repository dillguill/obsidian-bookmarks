import type { CaptureSettings, ClipperTemplate, PropertyType, PropertyTypeEntry, ScreenshotStyle, TemplateProperty } from "./api.js";
import { DEFAULT_TEMPLATE } from "./template-default.js";

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  screenshotStyle: "full",
  bannerSites: [],
  noScreenshotSites: [],
  templates: [DEFAULT_TEMPLATE],
  propertyTypes: DEFAULT_TEMPLATE.properties.map(({ name, type }) => ({ name, type })),
};

const STYLES: ReadonlySet<string> = new Set<ScreenshotStyle>(["full", "banner", "none"]);
const PROPERTY_TYPES: ReadonlySet<string> = new Set<PropertyType>(["text", "multitext", "number", "checkbox", "date", "datetime"]);
const MAX_SITES = 500;
const MAX_TEMPLATES = 50;
const MAX_TEXT = 20_000;

/** "https://www.NYTimes.com/x" -> "nytimes.com"; mirrors plugin/src/url.ts. */
export function siteEntry(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/[/?#:].*$/, "");
}

function matchesSite(url: string, sites: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/** Screenshot style for a URL: "no screenshot" sites win over banner sites, which win over the default. */
export function screenshotStyleFor(url: string, settings: CaptureSettings): ScreenshotStyle {
  if (matchesSite(url, settings.noScreenshotSites)) return "none";
  if (matchesSite(url, settings.bannerSites)) return "banner";
  return settings.screenshotStyle;
}

/** Validates a settings body; returns the cleaned settings or an error message. */
export function parseCaptureSettings(body: unknown): CaptureSettings | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  const fields = body as Record<string, unknown>;
  const style = fields.screenshotStyle ?? DEFAULT_CAPTURE_SETTINGS.screenshotStyle;
  if (typeof style !== "string" || !STYLES.has(style)) return "screenshotStyle must be full, banner or none.";
  const sites = (key: string): string[] | string => {
    const value = fields[key] ?? [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return `${key} must be a list of sites.`;
    if (value.length > MAX_SITES) return `${key} has more than ${MAX_SITES} sites.`;
    return [...new Set((value as string[]).map(siteEntry).filter(Boolean))];
  };
  const bannerSites = sites("bannerSites");
  if (typeof bannerSites === "string") return bannerSites;
  const noScreenshotSites = sites("noScreenshotSites");
  if (typeof noScreenshotSites === "string") return noScreenshotSites;
  const rawTemplates = fields.templates ?? DEFAULT_CAPTURE_SETTINGS.templates;
  if (!Array.isArray(rawTemplates) || rawTemplates.length === 0) return "templates must be a non-empty list.";
  if (rawTemplates.length > MAX_TEMPLATES) return `More than ${MAX_TEMPLATES} templates.`;
  const templates: ClipperTemplate[] = [];
  for (const [i, raw] of rawTemplates.entries()) {
    const template = parseTemplate(raw);
    if (typeof template === "string") return `Template ${i + 1}: ${template}`;
    templates.push(template);
  }
  const rawTypes = fields.propertyTypes ?? DEFAULT_CAPTURE_SETTINGS.propertyTypes;
  if (!Array.isArray(rawTypes) || rawTypes.length > 1000) return "propertyTypes must be a list.";
  const propertyTypes: PropertyTypeEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawTypes) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = text(entry.name)?.trim();
    const type = entry.type ?? "text";
    if (!name) return "every property type needs a name.";
    if (typeof type !== "string" || !PROPERTY_TYPES.has(type)) return `property "${name}" has unknown type ${String(type)}.`;
    if (!seen.has(name)) propertyTypes.push({ name, type: type as PropertyType });
    seen.add(name);
  }
  return { screenshotStyle: style as ScreenshotStyle, bannerSites, noScreenshotSites, templates, propertyTypes };
}

const text = (value: unknown, fallback = ""): string | null =>
  value === undefined || value === null ? fallback : typeof value === "string" && value.length <= MAX_TEXT ? value : null;

/**
 * Validates one template. Accepts a Web Clipper export as is: unknown fields
 * (context, schema triggers) are dropped or kept, and missing ones defaulted.
 */
export function parseTemplate(raw: unknown): ClipperTemplate | string {
  if (!raw || typeof raw !== "object") return "must be an object.";
  const t = raw as Record<string, unknown>;
  const name = text(t.name);
  if (!name?.trim()) return "needs a name.";
  const noteNameFormat = text(t.noteNameFormat, DEFAULT_TEMPLATE.noteNameFormat);
  const path = text(t.path, DEFAULT_TEMPLATE.path);
  const noteContentFormat = text(t.noteContentFormat, DEFAULT_TEMPLATE.noteContentFormat);
  if (noteNameFormat === null || path === null || noteContentFormat === null) return "has a field that isn't text or is too long.";
  const rawProps = t.properties ?? [];
  if (!Array.isArray(rawProps) || rawProps.length > 100) return "properties must be a list.";
  const properties: TemplateProperty[] = [];
  for (const p of rawProps) {
    const prop = (p ?? {}) as Record<string, unknown>;
    const propName = text(prop.name);
    const value = text(prop.value);
    const type = prop.type ?? "text";
    if (!propName?.trim() || value === null) return "every property needs a name and a text value.";
    if (typeof type !== "string" || !PROPERTY_TYPES.has(type)) return `property "${propName}" has unknown type ${String(type)}.`;
    properties.push({ name: propName.trim(), value, type: type as PropertyType });
  }
  const rawTriggers = t.triggers ?? [];
  if (!Array.isArray(rawTriggers) || rawTriggers.some((x) => typeof x !== "string")) return "triggers must be a list of text.";
  const triggers = (rawTriggers as string[]).map((x) => x.trim()).filter(Boolean);
  return {
    schemaVersion: typeof t.schemaVersion === "string" ? t.schemaVersion : "0.1.0",
    name: name.trim(),
    behavior: "create",
    noteNameFormat,
    path: path.trim().replace(/^\/+|\/+$/g, ""),
    noteContentFormat,
    properties,
    triggers,
  };
}
