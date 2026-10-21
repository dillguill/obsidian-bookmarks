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
 * Brings older screenshot variables up to date: {{screenshot}} becomes
 * {{screenshot_page}}, and the {{…_link}}/{{…_embed}} shortcuts become
 * [[{{screenshot_page}}]]/![[{{screenshot_page}}]]. Only text inside {{ }} and
 * {% %} changes, so prose that says "screenshot" is left alone.
 */
export function renameScreenshotVariables(text: string): string {
  return text.replace(/\{\{([\s\S]*?)\}\}|\{%[\s\S]*?%\}/g, (tag, inner: string | undefined) => {
    const simple = inner === undefined ? null : /^\s*screenshot(_page|_banner)?_(link|embed)\s*$/.exec(inner);
    if (simple) return `${simple[2] === "embed" ? "!" : ""}[[{{${base(simple[1])}}}]]`;
    return tag.replace(OLD_SCREENSHOT, (name, kind: string | undefined, form: string | undefined) =>
      kind && !form ? name : base(kind),
    );
  });
}

function renameInTemplate(template: ClipperTemplate): ClipperTemplate {
  return {
    ...template,
    noteNameFormat: renameScreenshotVariables(template.noteNameFormat),
    path: renameScreenshotVariables(template.path),
    noteContentFormat: renameScreenshotVariables(template.noteContentFormat),
    properties: template.properties.map((p) => ({ ...p, value: renameScreenshotVariables(p.value) })),
  };
}

const CAPTURE_ACTIONS: ReadonlySet<string> = new Set<CaptureAction>(["add", "add-media", "copy"]);
/** Settings migrations: 1 gives templates that used media variables the "Add and download media" preset. */
export const SCHEMA_REVISION = 1;
/** Variables that downloaded media when a note was captured, before media moved to "Download media". */
const MEDIA_VARIABLES = /\{\{\s*(tiktok_save|tiktok_images|tiktok_video|tiktok_thumbnail|tiktok_image_\d+|image_local)\b/;

/** A template that saved its page's media when captured keeps doing so: its preset becomes "Add and download media". */
export function withMediaPreset(template: ClipperTemplate): ClipperTemplate {
  if (template.onCapture) return template;
  const text = [template.noteNameFormat, template.path, template.noteContentFormat, ...template.properties.map((p) => p.value)].join("\n");
  return MEDIA_VARIABLES.test(text) ? { ...template, onCapture: "add-media" } : template;
}

/** Brings settings saved by older versions up to date: drops the screenshot style and site lists, renames old variables, applies migrations once. */
export function currentSettings(stored: Partial<CaptureSettings>): CaptureSettings {
  const revision = stored.schemaRevision ?? 0;
  const templates = (stored.templates ?? DEFAULT_CAPTURE_SETTINGS.templates).map(renameInTemplate);
  return {
    templates: revision < 1 ? templates.map(withMediaPreset) : templates,
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
  // A body from before the migration (an old export, an old page) gets it now.
  const revision = typeof fields.schemaRevision === "number" ? fields.schemaRevision : 0;
  return { templates: revision < 1 ? templates.map(withMediaPreset) : templates, propertyTypes, hideCaptureId, schemaRevision: SCHEMA_REVISION };
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
