import { createRequire } from "node:module";
import { CAPTURE_FILES, fileMarker, type CaptureFile, type CaptureSettings, type ClipperTemplate, type PageMeta } from "./api.js";
import { cleanUrl } from "./clean-url.js";

const require = createRequire(import.meta.url);
/** Web Clipper's template engine, bundled by scripts/build-clipper.mjs. */
export const CLIPPER_BUNDLE_PATH = require.resolve("../vendor/obsidian-clipper.js");

/** What the page needs to render the note with Web Clipper's engine (clipper/entry.ts). */
export interface RenderRequest {
  templates: ClipperTemplate[];
  templateName: string | null;
  propertyTypes: Record<string, string>;
  extra: Record<string, string>;
}

const URL_VARIABLE = "{{url}}";
const CAPTURE_ID_VARIABLE = "{{capture_id}}";

/**
 * Every note needs its URL property, whatever the template says: dedup reads it.
 * capture_id is added too unless hidden, in which case the plugin tracks it.
 */
export function withRequiredProperties(template: ClipperTemplate, hideCaptureId = false): ClipperTemplate {
  const properties = template.properties.filter((p) => !(hideCaptureId && p.value === CAPTURE_ID_VARIABLE));
  if (!properties.some((p) => p.value === URL_VARIABLE)) properties.unshift({ name: "source", value: URL_VARIABLE, type: "text" });
  if (!hideCaptureId && !properties.some((p) => p.value === CAPTURE_ID_VARIABLE)) properties.push({ name: "capture_id", value: CAPTURE_ID_VARIABLE, type: "text" });
  return { ...template, properties };
}

/** Every capture file's variable, its vault path or empty. Mirrors fileVariables in plugin/src/writer.ts. */
export function fileVariables(paths: Partial<Record<CaptureFile, string | null>>): Record<CaptureFile, string> {
  return Object.fromEntries(CAPTURE_FILES.map((kind) => [kind, paths[kind] ?? ""])) as Record<CaptureFile, string>;
}

export function renderRequest(settings: CaptureSettings, templateName: string | null, captureId: string): RenderRequest {
  return {
    templates: settings.templates.map((t) => withRequiredProperties(t, settings.hideCaptureId)),
    templateName,
    propertyTypes: Object.fromEntries(settings.propertyTypes.map((p) => [p.name, p.type])),
    extra: { capture_id: captureId, ...fileVariables(Object.fromEntries(CAPTURE_FILES.map((kind) => [kind, fileMarker(kind)]))) },
  };
}

function sameSite(a: string, b: string): boolean {
  try {
    const host = (u: string) => new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    return host(a) === host(b);
  } catch {
    return false;
  }
}

/**
 * The URL stored in the note: the canonical link when it stays on the same
 * site, so dedup lookups agree (audit #4), without tracking or bot-wall params.
 * Mirrors bookmarkUrl in plugin/src/writer.ts.
 */
export function bookmarkUrl(meta: Pick<PageMeta, "finalUrl" | "canonical">): string {
  return cleanUrl(meta.canonical && sameSite(meta.canonical, meta.finalUrl) ? meta.canonical : meta.finalUrl);
}
