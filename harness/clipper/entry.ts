// Runs Obsidian Web Clipper's own template engine inside the captured page, so
// templates render exactly as they do in Web Clipper (filters, logic, schema,
// meta and selector variables). Mirrors clip() in obsidian-clipper's
// src/api.ts, with two differences: it reads the live DOM rather than parsing
// HTML, and it accepts extra variables ({{capture_id}}, screenshot markers).
// Built by scripts/build-clipper.mjs inside a pinned obsidian-clipper checkout,
// so the relative imports below resolve there, not in this repo.

import DefuddleClass from "defuddle";
import { createMarkdownContent } from "defuddle/full";
import { compileTemplate } from "../src/utils/template-compiler";
import { buildVariables, formatPropertyValue, generateFrontmatter } from "../src/utils/shared";
import { sanitizeFileName } from "../src/utils/string-utils";
import { createAsyncResolver, createSelectorProcessor, matchTemplate } from "../src/api";
import type { Template } from "../src/types/types";

interface ClipPageOptions {
  templates: Template[];
  /** Chosen at capture time; otherwise Web Clipper's trigger matching, else the first template. */
  templateName: string | null;
  url: string;
  extra: Record<string, string>;
  propertyTypes: Record<string, string>;
}

/** Variables left out of the list "Update note from source" offers: raw HTML too large to pick from. */
const BULKY = new Set(["{{fullHtml}}", "{{contentHtml}}", "{{selectionHtml}}"]);

async function clipPage({ templates, templateName, url, extra, propertyTypes }: ClipPageOptions) {
  const doc = document;
  const parsed = new DefuddleClass(doc, { url }).parse();
  const template =
    templates.find((t) => t.name === templateName) ?? matchTemplate(templates, url, parsed.schemaOrgData) ?? templates[0]!;
  const variables = buildVariables({
    title: parsed.title,
    author: parsed.author,
    content: createMarkdownContent(parsed.content, url),
    contentHtml: parsed.content,
    url,
    fullHtml: doc.documentElement.outerHTML,
    description: parsed.description,
    favicon: parsed.favicon,
    image: parsed.image,
    published: parsed.published,
    site: parsed.site,
    language: parsed.language,
    wordCount: parsed.wordCount,
    schemaOrgData: parsed.schemaOrgData,
    metaTags: parsed.metaTags,
    extractedContent: parsed.variables,
  });
  for (const [name, value] of Object.entries(extra)) variables[`{{${name}}}`] = value;

  const compile = (text: string) => compileTemplate(0, text, variables, url, createAsyncResolver(doc), createSelectorProcessor(doc));
  const noteName = sanitizeFileName(await compile(template.noteNameFormat)) || "Untitled";
  const properties = await Promise.all(
    template.properties.map(async (prop) => ({
      name: prop.name,
      value: formatPropertyValue(await compile(prop.value), prop.type || "text", prop.value),
      type: prop.type,
    })),
  );
  const typeMap: Record<string, string> = {};
  for (const prop of template.properties) if (prop.type) typeMap[prop.name] = prop.type;
  Object.assign(typeMap, propertyTypes);

  return {
    template: template.name,
    noteName,
    path: await compile(template.path || ""),
    frontmatter: generateFrontmatter(properties, typeMap),
    content: await compile(template.noteContentFormat),
    variables: Object.fromEntries(Object.entries(variables).filter(([name, value]) => value.trim() && !BULKY.has(name))),
  };
}

(globalThis as { __bookmarksClipper?: unknown }).__bookmarksClipper = { clipPage };
