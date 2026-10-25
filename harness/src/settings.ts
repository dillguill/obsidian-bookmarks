import type { CaptureAction, CaptureSettings, ClipperTemplate, PropertyType, PropertyTypeEntry, TemplateProperty } from "./api.js";
import { DEFAULT_TEMPLATE } from "./template-default.js";

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  templates: [DEFAULT_TEMPLATE],
  propertyTypes: DEFAULT_TEMPLATE.properties.map(({ name, type }) => ({ name, type })),
  hideCaptureId: false,
};

const PROPERTY_TYPES: ReadonlySet<string> = new Set<PropertyType>(["text", "multitext", "number", "checkbox", "date", "datetime"]);
const MAX_TEMPLATES = 50;
const MAX_TEXT = 20_000;

/** Old screenshot variable names: `screenshot`, and `_link`/`_embed` forms of it and of screenshot_page/banner. */
const OLD_SCREENSHOT = /\bscreenshot(_page|_banner)?(?:_(link|embed))?\b/g;
const base = (kind: string | undefined) => `screenshot${kind ?? "_page"}`;

/**
 * Brings older variables up to date: {{screenshot}} becomes
 * {{screenshot_page}}, and the {{…_link}}/{{…_embed}} shortcuts become
 * [[{{screenshot_page}}]]/![[{{screenshot_page}}]]. Only text inside {{ }} and
 * {% %} changes, so prose that says "screenshot" is left alone. Media
 * variables that always saved a file become their `|local` form:
 * {{image_local}} is {{image|local}}, {{tiktok_save}} {{tiktok_embed|local}}
 * and {{tiktok_image_N}} {{tiktok_images|local}}.
 */
export function renameVariables(text: string): string {
  return renameScreenshotVariables(text)
    .replace(/\{\{\s*image_local\s*(\||\}\})/g, "{{image|local$1")
    // The post is a player, not a file, so a [[ ]] or ![[ ]] around it goes.
    .replace(/(?:!?\[\[)?\{\{\s*tiktok_save\s*\}\}(?:\]\])?/g, "{{tiktok_embed|local}}")
    .replace(/(?:!?\[\[)?\{\{\s*tiktok_image_\d+\s*\}\}(?:\]\])?/g, "{{tiktok_images|local}}");
}

function renameScreenshotVariables(text: string): string {
  return text.replace(/\{\{([\s\S]*?)\}\}|\{%[\s\S]*?%\}/g, (tag, inner: string | undefined) => {
    const simple = inner === undefined ? null : /^\s*screenshot(_page|_banner)?_(link|embed)\s*$/.exec(inner);
    if (simple) return `${simple[2] === "embed" ? "!" : ""}[[{{${base(simple[1])}}}]]`;
    return tag.replace(OLD_SCREENSHOT, (name, kind: string | undefined, form: string | undefined) =>
      kind && !form ? name : base(kind),
    );
  });
}

/** A template with `change` applied to every field that can hold variables. */
function mapTemplate(template: ClipperTemplate, change: (text: string) => string): ClipperTemplate {
  return {
    ...template,
    noteNameFormat: change(template.noteNameFormat),
    path: change(template.path),
    noteContentFormat: change(template.noteContentFormat),
    properties: template.properties.map((p) => ({ ...p, value: change(p.value) })),
  };
}

function renameInTemplate(template: ClipperTemplate): ClipperTemplate {
  return mapTemplate(template, renameVariables);
}

const CAPTURE_ACTIONS: ReadonlySet<string> = new Set<CaptureAction>(["add", "copy"]);
/**
 * Settings migrations. 1 stored "Add and download media" on templates that
 * used media variables, a preset since removed (it's dropped on reading); 2 was
 * a planned rewrite to `|local`, done by hand instead, so there's none to run.
 */
export const SCHEMA_REVISION = 2;

/** Brings settings saved by older versions up to date: drops the screenshot style and site lists, renames old variables, applies migrations once. */
export function currentSettings(stored: Partial<CaptureSettings>): CaptureSettings {
  const templates = (stored.templates ?? DEFAULT_CAPTURE_SETTINGS.templates).map(renameInTemplate);
  return {
    templates,
    propertyTypes: stored.propertyTypes ?? DEFAULT_CAPTURE_SETTINGS.propertyTypes,
    hideCaptureId: stored.hideCaptureId ?? false,
    schemaRevision: SCHEMA_REVISION,
  };
}

/** Validates a settings body; returns the cleaned settings or an error message. */
export function parseCaptureSettings(body: unknown): CaptureSettings | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  const fields = body as Record<string, unknown>;
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
  const hideCaptureId = fields.hideCaptureId ?? false;
  if (typeof hideCaptureId !== "boolean") return "hideCaptureId must be true or false.";
  return { templates, propertyTypes, hideCaptureId, schemaRevision: SCHEMA_REVISION };
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
  return renameInTemplate({
    schemaVersion: typeof t.schemaVersion === "string" ? t.schemaVersion : "0.1.0",
    name: name.trim(),
    behavior: "create",
    noteNameFormat,
    path: path.trim().replace(/^\/+|\/+$/g, ""),
    noteContentFormat,
    properties,
    triggers,
    ...(t.updateFromSource === false ? { updateFromSource: false } : {}),
    ...(typeof t.onCapture === "string" && CAPTURE_ACTIONS.has(t.onCapture) ? { onCapture: t.onCapture as CaptureAction } : {}),
  });
}
