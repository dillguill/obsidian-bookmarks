import { describe, expect, it } from "vitest";
import type { PropertyField } from "../src/fields";
import { applyRows, replaceAll, rowsChange, updateBody, updateRows, withMode } from "../src/update";

const fetched = (name: string, text: string, type: PropertyField["type"] = "text"): PropertyField => ({ name, type, text, expression: "", edited: false });
const player = `<iframe\nsrc="https://www.tiktok.com/player/v1/1?autoplay=0"\n/>`;

describe("updateRows", () => {
  const note = { source: "https://x", title: "Old", author: "", tags: ["a"], mine: "kept" };
  const page = [fetched("title", "New"), fetched("author", "Ann"), fetched("tags", "a, b", "multitext"), fetched("published", "2026-10-01", "date")];

  it("lists the note's properties, then the page's new ones, minus the skipped", () => {
    const rows = updateRows(note, page, {}, ["source"]);
    expect(rows.map((r) => r.name)).toEqual(["title", "author", "tags", "mine", "published"]);
  });

  it("fills empty properties, merges lists, and keeps values that differ", () => {
    const rows = Object.fromEntries(updateRows(note, page, { tags: "tags" }).map((r) => [r.name, r]));
    expect(rows.author).toMatchObject({ mode: "replace", text: "Ann" });
    expect(rows.published).toMatchObject({ mode: "replace", current: undefined });
    expect(rows.tags).toMatchObject({ mode: "merge", text: "a, b", type: "tags" });
    expect(rows.title).toMatchObject({ mode: "keep", text: "Old", next: "New" });
    expect(rows.mine).toMatchObject({ mode: "keep", next: null });
  });

  it("before fetching, shows the note as it is", () => {
    expect(updateRows(note, null, {}).every((r) => r.mode === "keep" && r.next === null)).toBe(true);
    expect(rowsChange(updateRows(note, null, {}))).toBe(false);
  });
});

describe("modes", () => {
  const [title] = updateRows({ title: "Old" }, [fetched("title", "New")], {});

  it("shows what the property will hold for each mode", () => {
    expect(withMode(title!, "replace").text).toBe("New");
    expect(withMode(title!, "keep").text).toBe("Old");
    expect(withMode(title!, "edit", "Mine").text).toBe("Mine");
    expect(withMode(title!, "remove").text).toBe("");
    // Two single values can't merge: that's a replace.
    expect(withMode(title!, "merge").mode).toBe("replace");
  });

  it("replaces every property the page gives for Replace whole note", () => {
    const rows = replaceAll(updateRows({ title: "Old", mine: "x" }, [fetched("title", "New")], {}));
    expect(rows.map((r) => [r.name, r.mode])).toEqual([
      ["title", "replace"],
      ["mine", "keep"],
    ]);
  });
});

describe("applyRows", () => {
  it("changes only what the rows say, typed", () => {
    const front: Record<string, unknown> = { title: "Old", tags: ["a"], gone: 1, rating: 2 };
    const rows = updateRows(front, [fetched("title", "New"), fetched("tags", "a, b", "multitext"), fetched("rating", "5", "number")], { rating: "number" });
    const byName = (name: string) => rows.findIndex((r) => r.name === name);
    rows[byName("title")] = withMode(rows[byName("title")]!, "replace");
    rows[byName("rating")] = withMode(rows[byName("rating")]!, "edit", "4");
    rows[byName("gone")] = withMode(rows[byName("gone")]!, "remove");
    applyRows(front, rows);
    expect(front).toEqual({ title: "New", tags: ["a", "b"], rating: 4 });
  });

  it("leaves a property waiting on a screenshot empty", () => {
    const front: Record<string, unknown> = {};
    applyRows(front, updateRows(front, [fetched("cover", "[[{{screenshot_banner}}]]")], {}));
    expect(front).toEqual({ cover: null });
  });
});

describe("updateBody", () => {
  const text = "---\na: 1\n---\nMy notes\n";
  const start = "---\na: 1\n---\n".length;

  it("keeps, appends or replaces the body, leaving the frontmatter", () => {
    expect(updateBody(text, start, "Fetched", "keep")).toBe(text);
    expect(updateBody(text, start, "Fetched", "append")).toBe("---\na: 1\n---\nMy notes\n\nFetched\n");
    expect(updateBody(text, start, "Fetched", "replace")).toBe("---\na: 1\n---\nFetched\n");
  });

  it("doesn't bring the TikTok player back over a post saved as files", () => {
    const saved = "---\na: 1\n---\n![[Bookmarks/assets/n-tiktok-video.mp4]]\n\nCaption\n";
    expect(updateBody(saved, start, `${player}\n\nCaption`, "replace")).toBe("---\na: 1\n---\nCaption\n");
    // A note that still has its player gets the new one.
    expect(updateBody(`---\na: 1\n---\n${player}\n`, start, `${player}\n\nCaption`, "replace")).toBe(`---\na: 1\n---\n${player}\n\nCaption\n`);
  });
});
