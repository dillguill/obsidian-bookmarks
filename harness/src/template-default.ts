import type { ClipperTemplate } from "./api.js";

/** The built-in note template; plugin/src/template.ts holds the same one (a plugin test checks they match). */
export const DEFAULT_TEMPLATE: ClipperTemplate = {
  schemaVersion: "0.1.0",
  name: "Bookmark",
  behavior: "create",
  noteNameFormat: '{{domain|kebab}}-{{title|kebab}}-{{date|date:"YYYY-MM-DD"}}',
  path: "Bookmarks/notes",
  noteContentFormat: "{{screenshot_page_embed}}\n\n{{content}}",
  properties: [
    { name: "source", value: "{{url}}", type: "text" },
    { name: "title", value: "{{title}}", type: "text" },
    { name: "description", value: "{{description}}", type: "text" },
    { name: "author", value: "{{author}}", type: "text" },
    { name: "domain", value: "{{domain}}", type: "text" },
    { name: "created", value: '{{date|date:"YYYY-MM-DDTHH:mm:ss"}}', type: "datetime" },
    { name: "tags", value: "", type: "multitext" },
    { name: "screenshot", value: "{{screenshot_page_link}}", type: "text" },
    { name: "capture_id", value: "{{capture_id}}", type: "text" },
  ],
};
