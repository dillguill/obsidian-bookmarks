import { createRequire } from "node:module";
import { SCREENSHOT_MARKER, type CaptureSettings, type ClipperTemplate, type PageMeta } from "./api.js";

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

/** Every note needs its URL and capture_id properties, whatever the template says: dedup and idempotency read them. */
export function withRequiredProperties(template: ClipperTemplate): ClipperTemplate {
  const properties = [...template.properties];
  if (!properties.some((p) => p.value === URL_VARIABLE)) properties.unshift({ name: "source", value: URL_VARIABLE, type: "text" });
  if (!properties.some((p) => p.value === CAPTURE_ID_VARIABLE)) properties.push({ name: "capture_id", value: CAPTURE_ID_VARIABLE, type: "text" });
  return { ...template, properties };
}

export function renderRequest(settings: CaptureSettings, templateName: string | null, captureId: string): RenderRequest {
  return {
    templates: settings.templates.map(withRequiredProperties),
    templateName,
    propertyTypes: Object.fromEntries(settings.propertyTypes.map((p) => [p.name, p.type])),
    extra: {
      capture_id: captureId,
      screenshot: SCREENSHOT_MARKER,
      screenshot_link: `[[${SCREENSHOT_MARKER}]]`,
      screenshot_embed: `![[${SCREENSHOT_MARKER}]]`,
    },
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

/** The URL stored in the note: the canonical link when it stays on the same site, so dedup lookups agree (audit #4). Mirrors bookmarkUrl in plugin/src/writer.ts. */
export function bookmarkUrl(meta: Pick<PageMeta, "finalUrl" | "canonical">): string {
  return meta.canonical && sameSite(meta.canonical, meta.finalUrl) ? meta.canonical : meta.finalUrl;
}
