import { describe, expect, it } from "vitest";
import type { RenderedNote } from "../src/api.js";
import { oneTikTokPlayer, unwrapWebLinks, withLocalMarks, withLocalTags } from "../src/local-media.js";

const OPEN = "bookmarkslocal5f2c9eopen";
const CLOSE = "bookmarkslocal5f2c9eclose";
const player = '<iframe\nsrc="https://www.tiktok.com/player/v1/1?autoplay=0"\n/>';

describe("withLocalTags", () => {
  it("takes |local out of a tag and wraps its value, wherever it is in the chain", () => {
    expect(withLocalTags("[[{{tiktok_thumbnail|local}}]]")).toBe(`[[${OPEN}{{tiktok_thumbnail}}${CLOSE}]]`);
    expect(withLocalTags("{{ image | local | upper }}")).toBe(`${OPEN}{{image | upper}}${CLOSE}`);
  });

  it("leaves other tags alone", () => {
    expect(withLocalTags("{{image}} {{title|localize}} {{x|replace:\"local\"}}")).toBe("{{image}} {{title|localize}} {{x|replace:\"local\"}}");
  });
});

describe("withLocalMarks", () => {
  const note = (frontmatter: string, content: string): RenderedNote => ({ template: "T", noteName: "n", path: "", frontmatter, content, variables: {} });

  it("lists the marked media and takes the markers out", () => {
    const out = withLocalMarks(
      note(`---\ncover: "[[${OPEN}https://p16.tiktokcdn.com/c.jpeg${CLOSE}]]"\n---\n`, `${OPEN}${player}${CLOSE}\n\n![](${OPEN}https://e.com/a.png${CLOSE})`),
      player,
    );
    expect(out.frontmatter).toBe('---\ncover: "https://p16.tiktokcdn.com/c.jpeg"\n---\n');
    expect(out.content).toBe(`${player}\n\n![](https://e.com/a.png)`);
    expect(out.local).toEqual(["https://p16.tiktokcdn.com/c.jpeg", player, "https://e.com/a.png"]);
  });

  it("leaves a property blank when its marked value can't become one file", () => {
    const out = withLocalMarks(note(`---\nattachments: "[[${OPEN}${player}${CLOSE}]]"\nimage: "${OPEN}https://e.com/a.png${CLOSE}"\n---\n`, ""), player);
    expect(out.frontmatter).toBe('---\nattachments: ""\nimage: "https://e.com/a.png"\n---\n');
    expect(out.local).toEqual(["https://e.com/a.png"]);
  });

  it("doesn't list values that aren't web addresses", () => {
    const out = withLocalMarks(note("", `${OPEN}just text${CLOSE} ${OPEN}${CLOSE}`), "");
    expect(out.content).toBe("just text ");
    expect(out.local).toEqual([]);
  });

  it("shows the player once", () => {
    expect(withLocalMarks(note("", `${player}\n\n${OPEN}${player}${CLOSE}`), player).content).toBe(player);
    expect(oneTikTokPlayer(`a ${player} ${player} b`, player)).toBe(`a ${player} b`);
  });
});

describe("unwrapWebLinks", () => {
  it("turns wikilinks to the web into addresses and images", () => {
    expect(unwrapWebLinks("[[https://e.com/a.png]] ![[https://e.com/b.png]] [[note]]")).toBe("https://e.com/a.png ![](https://e.com/b.png) [[note]]");
  });
});
