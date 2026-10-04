import { describe, expect, it } from "vitest";
import { fileMarker, type CaptureFile, type RenderedNote } from "../src/api";
import {
  applyProperties,
  ENRICH_FILES,
  enrichChoices,
  fileLabel,
  filesToSave,
  hasTikTokPlayer,
  noteHeadings,
  offlineFiles,
  placeContent,
  placementOrder,
  replaceTikTokPlayer,
  type ContentRow,
  type EnrichSelection,
} from "../src/enrich";

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
const select = (over: Partial<EnrichSelection>): EnrichSelection => ({ properties: {}, content: [], offline: false, ...over });
const pick = (mode: "replace" | "merge", target = "") => ({ mode, target });

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
    const selection = select({
      properties: { title: pick("replace", "title"), description: pick("replace", "summary"), tags: pick("merge", "tags"), screenshot: pick("replace", "screenshot") },
    });
    expect(filesToSave(choices, selection)).toEqual(["screenshot_banner"]);
    applyProperties(frontmatter, choices, selection, saved);
    expect(frontmatter).toEqual({
      source: "https://example.com/a",
      title: "Hello",
      summary: "A page",
      tags: ["read-later", "web", "clip"],
      screenshot: "[[Bookmarks/assets/n-banner.jpg]]",
    });
    applyProperties(frontmatter, choices, select({ properties: { tags: pick("replace", "tags") } }), saved);
    expect(frontmatter.tags).toEqual(["web", "clip"]);
  });

  it("saves the files picked rows and variables use", () => {
    const rows: ContentRow[] = [
      { item: { kind: "file", file: "image_local" }, heading: null, position: "append" },
      { item: { kind: "variable", name: "Template content", value: note.content }, heading: null, position: "append" },
    ];
    expect(filesToSave(choices, select({ content: rows }))).toEqual(["screenshot_banner", "image_local"]);
    expect(filesToSave(choices, select({ content: rows.slice(0, 1) }))).toEqual(["image_local"]);
  });
});

describe("placing content", () => {
  const front = "---\ntitle: x\n---\n";
  const text = `${front}Intro.\n\n## Notes\n\nMine.\n\n### Sub\n\nDeep.\n\n## Links\n\nA link.\n`;
  const saved = { image_local: "a/img.jpg" };
  const row = (body: string, heading: number | null, position: ContentRow["position"]): ContentRow => ({ item: { kind: "text", text: body }, heading, position });

  it("finds headings outside code fences, with their sections", () => {
    const body = text.slice(front.length);
    const headings = noteHeadings(`${body}\n\`\`\`\n# not a heading\n\`\`\`\n`);
    expect(headings.map((h) => [h.level, h.text])).toEqual([[2, "Notes"], [3, "Sub"], [2, "Links"]]);
    expect(body.slice(headings[0]!.start, headings[0]!.end)).toBe("\n\nMine.\n\n### Sub\n\nDeep.\n\n");
  });

  it("prepends and appends to the body and to headings, in list order", () => {
    const out = placeContent(
      text,
      [row("Top.", null, "prepend"), row("First under notes.", 0, "prepend"), row("End of notes.", 0, "append"), row("End of sub.", 1, "append"), row("Bottom.", null, "append"), row("Bottom 2.", null, "append")],
      saved,
      front.length,
    );
    expect(out).toBe(
      `${front}Top.\n\nIntro.\n\n## Notes\n\nFirst under notes.\n\nMine.\n\n### Sub\n\nDeep.\n\nEnd of sub.\n\nEnd of notes.\n\n## Links\n\nA link.\n\nBottom.\n\nBottom 2.\n`,
    );
  });

  it("replaces a section keeping its heading, or the whole body keeping the frontmatter", () => {
    expect(placeContent(text, [row("New links.", 2, "replace")], saved, front.length)).toBe(
      `${front}Intro.\n\n## Notes\n\nMine.\n\n### Sub\n\nDeep.\n\n## Links\n\nNew links.\n`,
    );
    expect(placeContent(text, [row("All new.", null, "replace"), row("Dropped.", 0, "append")], saved, front.length)).toBe(`${front}All new.\n`);
  });

  it("embeds files and leaves the note alone when nothing has text", () => {
    expect(placeContent(`${front}Body.\n`, [{ item: { kind: "file", file: "image_local" }, heading: null, position: "prepend" }], saved, front.length)).toBe(
      `${front}![[a/img.jpg]]\n\nBody.\n`,
    );
    expect(placeContent(text, [{ item: { kind: "file", file: "tiktok_video" }, heading: null, position: "append" }], saved, front.length)).toBe(text);
    expect(placeContent("", [row("New.", null, "prepend")], saved, 0)).toBe("New.\n");
  });

  it("orders placements as their text lands in the note", () => {
    const body = text.slice(front.length);
    const order = placementOrder(
      [
        { heading: null, position: "append" },
        { heading: 0, position: "append" },
        { heading: 1, position: "append" },
        { heading: 0, position: "prepend" },
        { heading: null, position: "prepend" },
      ],
      body,
    );
    expect(order).toEqual([
      { heading: null, position: "prepend" },
      { heading: 0, position: "prepend" },
      { heading: 1, position: "append" },
      { heading: 0, position: "append" },
      { heading: null, position: "append" },
    ]);
  });
});

describe("TikTok photos", () => {
  it("asks for carousel photos and labels them", () => {
    expect(ENRICH_FILES).toContain("tiktok_image_1");
    expect(fileLabel("tiktok_image_3")).toBe("TikTok photo 3");
    expect(fileLabel("image_local")).toBe("Page image");
  });
});

describe("saving TikTok offline", () => {
  const player = `<iframe\nsrc="https://www.tiktok.com/player/v1/7382225350710824222?autoplay=0"\nallow="fullscreen"\nstyle="width:100%;height:50vh;"\n/>`;
  const text = `---\ntitle: x\n---\n${player}\n\nCaption.\n`;

  it("finds the player {{tiktok_embed}} writes", () => {
    expect(hasTikTokPlayer(text)).toBe(true);
    expect(hasTikTokPlayer(`<iframe src="https://www.youtube.com/embed/x"></iframe>`)).toBe(false);
  });

  it("uses the video, else the carousel photos", () => {
    expect(offlineFiles(["tiktok_thumbnail", "tiktok_video"])).toEqual(["tiktok_video"]);
    expect(offlineFiles(["tiktok_image_2", "tiktok_thumbnail", "tiktok_image_1"])).toEqual(["tiktok_image_1", "tiktok_image_2"]);
    expect(offlineFiles(["tiktok_thumbnail"])).toEqual([]);
  });

  it("swaps the player for the saved files", () => {
    expect(replaceTikTokPlayer(text, ["tiktok_video"], { tiktok_video: "a/n-tiktok-video.mp4" })).toBe(
      "---\ntitle: x\n---\n![[a/n-tiktok-video.mp4]]\n\nCaption.\n",
    );
    expect(replaceTikTokPlayer(`<iframe src='https://www.tiktok.com/player/v1/1'></iframe>`, ["tiktok_image_1", "tiktok_image_2"], { tiktok_image_1: "p1.jpg", tiktok_image_2: "p2.jpg" })).toBe(
      "![[p1.jpg]]\n![[p2.jpg]]",
    );
    // Nothing saved: the player stays.
    expect(replaceTikTokPlayer(text, ["tiktok_video"], {})).toBe(text);
  });

  it("saves the offline files", () => {
    const tiktok = { ...choices, images: ["tiktok_video", "tiktok_thumbnail"] as CaptureFile[] };
    const thumb: ContentRow = { item: { kind: "file", file: "tiktok_thumbnail" }, heading: null, position: "append" };
    expect(filesToSave(tiktok, select({ offline: true, content: [thumb] }))).toEqual(["tiktok_video", "tiktok_thumbnail"]);
    expect(filesToSave(tiktok, select({ offline: true }))).toEqual(["tiktok_video"]);
  });
});
