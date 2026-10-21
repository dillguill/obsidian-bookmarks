import { describe, expect, it } from "vitest";
import { fileMarker } from "../src/api";
import { extractTokens, insertAll, markersToTokens, tokensIn } from "../src/placeholders";

const link = (name: string) => `[[${name}]]`;
const put = (body: string, items: { kind: string; name: string }[], text = extractTokens(body)) =>
  insertAll(
    text.body,
    items.map(({ kind, name }) => ({ anchor: text.anchors.find((a) => a.kind === kind)!, link: link(name), path: name })),
  );

describe("markersToTokens", () => {
  it("shows each marker as its variable, keeping the brackets around it", () => {
    const text = `![[${fileMarker("screenshot_page")}]] and [[${fileMarker("screenshot_banner")}]]`;
    expect(markersToTokens(text)).toBe("![[{{screenshot_page}}]] and [[{{screenshot_banner}}]]");
    expect(tokensIn(markersToTokens(text))).toEqual(["screenshot_page", "screenshot_banner"]);
  });
});

describe("extractTokens", () => {
  it("takes a token's line out with it, and one blank line beside it", () => {
    const { body, anchors } = extractTokens("# Title\n\n![[{{screenshot_page}}]]\n\nText");
    expect(body).toBe("# Title\n\nText");
    expect(anchors).toEqual([{ in: "body", kind: "screenshot_page", before: "# Title\n\n", after: "Text", form: "embed", line: true, blank: true, order: 0 }]);
  });

  it("takes just the token out of a line with other text, and knows a link from a bare path", () => {
    const { body, anchors } = extractTokens("See [[{{screenshot_banner}}]] or {{pdf_page}}.");
    expect(body).toBe("See  or .");
    expect(anchors.map((a) => [a.kind, a.form, a.line])).toEqual([
      ["screenshot_banner", "link", false],
      ["pdf_page", "bare", false],
    ]);
  });

  it("leaves text without tokens alone", () => {
    expect(extractTokens("Just text\n")).toEqual({ body: "Just text\n", anchors: [] });
  });
});

describe("insertAll", () => {
  it("puts the link back exactly where the token was", () => {
    const body = "# Title\n\n![[{{screenshot_page}}]]\n\nText";
    expect(put(body, [{ kind: "screenshot_page", name: "a.jpg" }])).toBe("# Title\n\n![[a.jpg]]\n\nText");
    expect(put("See [[{{screenshot_banner}}]] here", [{ kind: "screenshot_banner", name: "b.jpg" }])).toBe("See [[b.jpg]] here");
    expect(put("Path: {{pdf_page}}", [{ kind: "pdf_page", name: "c.pdf" }])).toBe("Path: c.pdf");
  });

  it("still finds the spot after edits elsewhere in the note", () => {
    const text = extractTokens("# Title\n\n![[{{screenshot_page}}]]\n\nText");
    const edited = `Added at the top\n\n${text.body}\n\nAnd at the end`;
    const out = insertAll(edited, [{ anchor: text.anchors[0]!, link: link("a.jpg"), path: "a.jpg" }]);
    expect(out).toBe("Added at the top\n\n# Title\n\n![[a.jpg]]\n\nText\n\nAnd at the end");
  });

  it("goes by the text after it when the text before was changed", () => {
    const text = extractTokens("# Title\n\n![[{{screenshot_page}}]]\n\nText");
    const out = insertAll("# Renamed\n\nText", [{ anchor: text.anchors[0]!, link: link("a.jpg"), path: "a.jpg" }]);
    expect(out).toBe("# Renamed\n\n![[a.jpg]]\n\nText");
  });

  it("adds the link at the end when its spot is gone", () => {
    const text = extractTokens("# Title\n\n![[{{screenshot_page}}]]\n\nText");
    const out = insertAll("Something else entirely", [{ anchor: text.anchors[0]!, link: link("a.jpg"), path: "a.jpg" }]);
    expect(out).toBe("Something else entirely\n\n![[a.jpg]]\n");
  });

  it("keeps tokens at the same spot in their order, whatever order the files come in", () => {
    const body = "A\n![[{{screenshot_banner}}]]\n![[{{screenshot_page}}]]\nB";
    expect(extractTokens(body).body).toBe("A\nB");
    const files = [
      { kind: "screenshot_page", name: "page.jpg" },
      { kind: "screenshot_banner", name: "banner.jpg" },
    ];
    expect(put(body, files)).toBe("A\n![[banner.jpg]]\n![[page.jpg]]\nB");
  });

  it("only looks after the frontmatter", () => {
    const text = extractTokens("---\n\n![[{{screenshot_page}}]]\n\n---");
    const note = `---\ntitle: x\n---\n${text.body}`;
    const out = insertAll(note, [{ anchor: text.anchors[0]!, link: link("a.jpg"), path: "a.jpg" }], "---\ntitle: x\n---\n".length);
    expect(out).toBe("---\ntitle: x\n---\n---\n\n![[a.jpg]]\n\n---");
  });
});
