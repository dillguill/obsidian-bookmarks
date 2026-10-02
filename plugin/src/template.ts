// Templates use Obsidian Web Clipper's JSON format (design §4) and are edited
// on the server's settings page. The plugin renders a subset: plain
// `{{variable}}` and the filters below; anything else passes through unchanged.
// DEFAULT_TEMPLATE mirrors harness/src/template-default.ts.

import type { ClipperTemplate } from "./api";

export type { ClipperTemplate, PropertyType, TemplateProperty } from "./api";

export const URL_VARIABLE = "{{url}}";
export const CAPTURE_ID_VARIABLE = "{{capture_id}}";

export const DEFAULT_TEMPLATE: ClipperTemplate = {
  schemaVersion: "0.1.0",
  name: "Bookmark",
  behavior: "create",
  noteNameFormat: '{{domain|kebab}}-{{title|kebab}}-{{date|date:"YYYY-MM-DD"}}',
  path: "Bookmarks/notes",
  noteContentFormat: "{{screenshot_embed}}\n\n{{content}}",
  properties: [
    { name: "source", value: URL_VARIABLE, type: "text" },
    { name: "title", value: "{{title}}", type: "text" },
    { name: "description", value: "{{description}}", type: "text" },
    { name: "author", value: "{{author}}", type: "text" },
    { name: "domain", value: "{{domain}}", type: "text" },
    { name: "created", value: '{{date|date:"YYYY-MM-DDTHH:mm:ss"}}', type: "datetime" },
    { name: "tags", value: "", type: "multitext" },
    { name: "screenshot", value: "{{screenshot_link}}", type: "text" },
    { name: "capture_id", value: CAPTURE_ID_VARIABLE, type: "text" },
  ],
};

/** Values available to `{{…}}`. Dates are ISO strings. */
export type Variables = Record<string, string>;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Formats an ISO date in local time with moment-style tokens (YYYY MM DD HH mm ss). */
export function formatDate(iso: string, format: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tokens: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => tokens[token] ?? token);
}

function applyFilter(value: string, filter: string): string {
  const match = /^(\w+)(?::(.*))?$/.exec(filter.trim());
  if (!match) return value;
  const [, name, rawArg] = match;
  const arg = rawArg?.trim().replace(/^["']|["']$/g, "");
  switch (name) {
    case "kebab":
      return value
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    case "safe_name":
      return value.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
    case "trim":
      return value.trim();
    case "lower":
      return value.toLowerCase();
    case "upper":
      return value.toUpperCase();
    case "date":
      return arg ? formatDate(value, arg) : value;
    default:
      return value;
  }
}

/** Renders `{{name|filter|filter:"arg"}}` expressions in `text`. */
export function render(text: string, vars: Variables): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (whole, expr: string) => {
    const [name, ...filters] = expr.split("|");
    const key = name!.trim();
    if (!(key in vars)) return whole;
    return filters.reduce((value, filter) => applyFilter(value, filter), vars[key] ?? "");
  });
}

function yamlScalar(value: string): string {
  // JSON strings are valid YAML double-quoted scalars.
  return JSON.stringify(value);
}

/**
 * Renders the frontmatter block. The URL and capture_id properties are
 * required whatever the template says (dedup and idempotency depend on them).
 */
export function renderFrontmatter(template: ClipperTemplate, vars: Variables): string {
  const properties = [...template.properties];
  if (!properties.some((p) => p.value === URL_VARIABLE)) properties.unshift({ name: "source", value: URL_VARIABLE, type: "text" });
  if (!properties.some((p) => p.value === CAPTURE_ID_VARIABLE)) properties.push({ name: "capture_id", value: CAPTURE_ID_VARIABLE, type: "text" });

  const lines = properties.map(({ name, value, type }) => {
    const rendered = render(value, vars).trim();
    const key = /^[\w-]+$/.test(name) ? name : yamlScalar(name);
    switch (type) {
      case "multitext": {
        const items = rendered.split(",").map((item) => item.trim()).filter(Boolean);
        return items.length ? `${key}:\n${items.map((item) => `  - ${yamlScalar(item)}`).join("\n")}` : `${key}: []`;
      }
      case "number":
        return `${key}: ${Number.isFinite(Number(rendered)) && rendered !== "" ? rendered : ""}`;
      case "checkbox":
        return `${key}: ${rendered === "true" ? "true" : "false"}`;
      case "date":
      case "datetime":
        return `${key}: ${/^\d{4}-\d{2}-\d{2}(T[\d:]+)?$/.test(rendered) ? rendered : yamlScalar(rendered)}`;
      default:
        return `${key}: ${yamlScalar(rendered)}`;
    }
  });
  return `---\n${lines.join("\n")}\n---\n`;
}

/** The property name holding the page URL, which the dedup index reads. */
export function urlPropertyName(template: ClipperTemplate): string {
  return template.properties.find((p) => p.value === URL_VARIABLE)?.name ?? "source";
}

export function captureIdPropertyName(template: ClipperTemplate): string {
  return template.properties.find((p) => p.value === CAPTURE_ID_VARIABLE)?.name ?? "capture_id";
}

function triggerMatches(trigger: string, url: string): boolean {
  const t = trigger.trim();
  if (!t || t.startsWith("schema:")) return false; // schema triggers need the page's JSON-LD; not supported yet
  const regex = /^\/(.+)\/([a-z]*)$/.exec(t);
  if (regex) {
    try {
      return new RegExp(regex[1]!, regex[2]).test(url);
    } catch {
      return false;
    }
  }
  return url.startsWith(t);
}

/** The first template with a trigger matching `url`, else the first template (the default). */
export function chooseTemplate(templates: readonly ClipperTemplate[], url: string): ClipperTemplate {
  return templates.find((t) => t.triggers?.some((trigger) => triggerMatches(trigger, url))) ?? templates[0] ?? DEFAULT_TEMPLATE;
}
