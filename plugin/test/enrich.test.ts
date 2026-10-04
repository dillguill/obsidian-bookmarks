import { describe, expect, it } from "vitest";
import { fileMarker, type RenderedNote } from "../src/api";
import { applyProperties, bodyBlock, ENRICH_FILES, enrichChoices, fileLabel, filesToSave, insertBlock, type EnrichSelection } from "../src/enrich";

/** The slice of YAML Web Clipper writes: quoted strings, numbers, empty values and lists of quoted strings. */
function parseYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let list: unknown[] | null = null;
  for (const line of yaml.split("\n")) {
    const item = /^\s+- (.*)$/.exec(line);
    if (item && list) {
      list.push(JSON.parse(item[1]!));
      continue;
    }
    const [, key, value] = /^([^:]+):\s*(.*)$/.exec(line) ?? [];
    if (!key) continue;
    if (value) out[key] = JSON.parse(value);
    else {
      list = [];
      out[key] = list;
    }
  }
  for (const [key, value] of Object.entries(out)) if (Array.isArray(value) && value.length === 0) out[key] = null;
  return out;
}

const banner = fileMarker("screenshot_banner");
const note: RenderedNote = {
  template: "Bookmark",
  noteName: "Hello",
  path: "Bookmarks/notes",
  frontmatter: [
    "---",
    'source: "https://example.com/a"',
    'title: "Hello"',
    'description: "A page"',
    "tags:",
    '  - "web"',
    '  - "clip"',
    `screenshot: "[[${banner}]]"`,
    `page: "[[${fileMarker("screenshot_page")}]]"`,
    "empty:",
    'capture_id: "01JOB"',
    "---",
    "",
  ].join("\n"),
  content: `![[${banner}]]\n\nThe page text.`,
};

const current = { source: "https://example.com/a", title: "Old title", tags: ["read-later"] };
const choices = enrichChoices(note, current, parseYaml, ["screenshot_banner", "image_local"], "capture_id");
const select = (over: Partial<EnrichSelection>): EnrichSelection => ({ properties: {}, body: false, images: [], position: "append", ...over });

describe("enrichChoices", () => {
  it("offers properties that differ, leaving out capture_id, empty ones and ones needing a file that wasn't made", () => {
    expect(choices.properties.map((p) => p.name)).toEqual(["title", "description", "tags", "screenshot"]);
    expect(choices.unchanged).toEqual(["source"]);
    expect(choices.properties.find((p) => p.name === "tags")!.mergeable).toBe(true);
    expect(choices.properties.find((p) => p.name === "title")!.mergeable).toBe(false);
    expect(choices.properties.find((p) => p.name === "description")!.current).toBeUndefined();
    expect(choices.images).toEqual(["screenshot_banner", "image_local"]);
    expect(choices.body).toBe(note.content);
  });
});

describe("applying a selection", () => {
  const saved = { screenshot_banner: "Bookmarks/assets/n-banner.jpg", image_local: "Bookmarks/assets/n-image.jpg" };

  it("adds, replaces and merges properties, filling in file paths", () => {
    const frontmatter: Record<string, unknown> = { ...current, tags: ["read-later", "web"] };
    const selection = select({ properties: { title: "replace", description: "replace", tags: "merge", screenshot: "replace" } });
    expect(filesToSave(choices, selection)).toEqual(["screenshot_banner"]);
    applyProperties(frontmatter, choices, selection, saved);
    expect(frontmatter).toEqual({
      source: "https://example.com/a",
      title: "Hello",
      description: "A page",
      tags: ["read-later", "web", "clip"],
      screenshot: "[[Bookmarks/assets/n-banner.jpg]]",
    });
    applyProperties(frontmatter, choices, select({ properties: { tags: "replace" } }), saved);
    expect(frontmatter.tags).toEqual(["web", "clip"]);
  });

  it("embeds picked images the body doesn't already show, then the body", () => {
    const both = select({ body: true, images: ["screenshot_banner", "image_local"] });
    expect(filesToSave(choices, both)).toEqual(["screenshot_banner", "image_local"]);
    expect(bodyBlock(choices, both, saved)).toBe(
      "![[Bookmarks/assets/n-image.jpg]]\n\n![[Bookmarks/assets/n-banner.jpg]]\n\nThe page text.",
    );
    // Without the body, its banner isn't saved unless picked.
    expect(filesToSave(choices, select({ images: ["image_local"] }))).toEqual(["image_local"]);
    expect(bodyBlock(choices, select({ images: ["image_local"] }), { image_local: saved.image_local })).toBe("![[Bookmarks/assets/n-image.jpg]]");
  });
});

describe("insertBlock", () => {
  const text = "---\ntitle: x\n---\nExisting body.\n";
  const end = "---\ntitle: x\n---\n".length;

  it("appends after the body or prepends after the frontmatter", () => {
    expect(insertBlock(text, "New.", "append", end)).toBe("---\ntitle: x\n---\nExisting body.\n\nNew.\n");
    expect(insertBlock(text, "New.", "prepend", end)).toBe("---\ntitle: x\n---\nNew.\n\nExisting body.\n");
    expect(insertBlock("---\ntitle: x\n---\n", "New.", "prepend", end)).toBe("---\ntitle: x\n---\nNew.\n");
    expect(insertBlock("", "New.", "prepend", 0)).toBe("New.\n");
    expect(insertBlock(text, "", "append", end)).toBe(text);
  });

  it("replaces the body, keeping the frontmatter", () => {
    expect(insertBlock(text, "New.", "replace", end)).toBe("---\ntitle: x\n---\nNew.\n");
    expect(insertBlock("Old body.\n", "New.", "replace", 0)).toBe("New.\n");
    expect(insertBlock(text, "", "replace", end)).toBe(text);
  });
});

describe("TikTok photos", () => {
  it("asks for carousel photos and labels them", () => {
    expect(ENRICH_FILES).toContain("tiktok_image_1");
    expect(fileLabel("tiktok_image_3")).toBe("TikTok photo 3");
    expect(fileLabel("image_local")).toBe("Page image");
  });
});
