import { describe, expect, it } from "vitest";
import { imageLink, redirectFrontmatter, redirectedLink, spliceSpans } from "../src/links";

describe("spliceSpans", () => {
  it("replaces several spans on one line", () => {
    const text = "see [[A]] and [[A#H]].";
    expect(spliceSpans(text, [{ start: 4, end: 9, replacement: "[[B|A]]" }, { start: 14, end: 21, replacement: "[[B#H|A > H]]" }])).toBe(
      "see [[B|A]] and [[B#H|A > H]].",
    );
  });
  it("refuses overlapping spans", () => {
    expect(() => spliceSpans("abcdef", [{ start: 0, end: 3, replacement: "x" }, { start: 2, end: 4, replacement: "y" }])).toThrow();
  });
});

describe("redirectedLink", () => {
  const generate = (subpath: string, alias: string) => `[[B${subpath}${alias ? `|${alias}` : ""}]]`;

  it("keeps the text a plain link showed", () => {
    expect(redirectedLink({ original: "[[A]]", link: "A", displayText: "A", embed: false }, "A", generate)).toBe("[[B|A]]");
    expect(redirectedLink({ original: "[[A#H]]", link: "A#H", displayText: "A > H", embed: false }, "A", generate)).toBe("[[B#H|A > H]]");
  });
  it("keeps a written display text and the heading or block", () => {
    expect(redirectedLink({ original: "[[A#H|x]]", link: "A#H", displayText: "x", embed: false }, "A", generate)).toBe("[[B#H|x]]");
    expect(redirectedLink({ original: "[[A#^b1]]", link: "A#^b1", displayText: "A > ^b1", embed: false }, "A", generate)).toBe("[[B#^b1|A > ^b1]]");
  });
  it("keeps Markdown link text", () => {
    expect(redirectedLink({ original: "[x](A.md#H)", link: "A.md#H", displayText: "x", embed: false }, "A", generate)).toBe("[[B#H|x]]");
  });
  it("keeps embeds embedded, without adding a display text", () => {
    expect(redirectedLink({ original: "![[A]]", link: "A", displayText: "A", embed: true }, "A", generate)).toBe("![[B]]");
    expect(redirectedLink({ original: "![[A|200]]", link: "A", displayText: "200", embed: true }, "A", generate)).toBe("![[B|200]]");
  });
  it("falls back to the removed note's name without a display text", () => {
    expect(redirectedLink({ original: "[[A]]", link: "A", embed: false }, "A", generate)).toBe("[[B|A]]");
  });
});

describe("redirectFrontmatter", () => {
  it("replaces a matching value or list item and says so", () => {
    const fm: Record<string, unknown> = { related: "[[A]]", see: ["[[X]]", "[[A]]"] };
    expect(redirectFrontmatter(fm, "related", "[[A]]", "[[B|A]]")).toBe(true);
    expect(redirectFrontmatter(fm, "see", "[[A]]", "[[B|A]]")).toBe(true);
    expect(fm).toEqual({ related: "[[B|A]]", see: ["[[X]]", "[[B|A]]"] });
  });
  it("leaves other values alone", () => {
    const fm: Record<string, unknown> = { related: "[[C]]" };
    expect(redirectFrontmatter(fm, "related", "[[A]]", "[[B|A]]")).toBe(false);
    expect(redirectFrontmatter(fm, "missing", "[[A]]", "[[B|A]]")).toBe(false);
    expect(fm).toEqual({ related: "[[C]]" });
  });
});

describe("imageLink", () => {
  it("finds images linked from the vault", () => {
    expect(imageLink("[[_attachments/a b.jpg]]")).toEqual({ vault: "_attachments/a b.jpg" });
    expect(imageLink("![[shot.PNG|200]]")).toEqual({ vault: "shot.PNG" });
    expect(imageLink("![alt](assets/x.webp)")).toEqual({ vault: "assets/x.webp" });
    expect(imageLink("assets/plain.png")).toEqual({ vault: "assets/plain.png" });
    expect(imageLink("![](my%20shots/a.jpg)")).toEqual({ vault: "my shots/a.jpg" });
  });
  it("takes web addresses as possible images", () => {
    expect(imageLink("https://example.com/cover")).toEqual({ url: "https://example.com/cover" });
    expect(imageLink("![x](https://example.com/a.png)")).toEqual({ url: "https://example.com/a.png" });
  });
  it("ignores everything else", () => {
    expect(imageLink("[[Some note]]")).toBeNull();
    expect(imageLink("AI Tinkerers: The Global")).toBeNull();
    expect(imageLink(["[[a.png]]"])).toBeNull();
    expect(imageLink(3)).toBeNull();
  });
});
