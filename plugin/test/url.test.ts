import { describe, expect, it } from "vitest";
import { cleanUrl, findUrl, normalizeUrl } from "../src/url";

describe("normalizeUrl", () => {
  it("drops www, case, fragment, trailing slash and scheme", () => {
    expect(normalizeUrl("https://WWW.Example.com/Path/#top")).toBe("example.com/Path");
    expect(normalizeUrl("http://example.com/Path")).toBe("example.com/Path");
  });
  it("removes tracking params and sorts the rest", () => {
    expect(normalizeUrl("https://example.com/a?utm_source=x&b=2&fbclid=1&a=1&ref=hn")).toBe("example.com/a?a=1&b=2");
    expect(normalizeUrl("https://reddit.com/r/x/?js_challenge=1&jsc_token=2")).toBe("reddit.com/r/x");
  });
  it("keeps non-default ports and rejects non-web URLs", () => {
    expect(normalizeUrl("https://example.com:8443/")).toBe("example.com:8443");
    expect(normalizeUrl("https://example.com:443/")).toBe("example.com");
    expect(normalizeUrl("obsidian://open?vault=x")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("findUrl", () => {
  it("pulls the first URL out of clipboard text", () => {
    expect(findUrl("look at https://example.com/a?b=1). thanks")).toBe("https://example.com/a?b=1");
    expect(findUrl("no links here")).toBeNull();
  });
});

describe("cleanUrl", () => {
  it("drops tracking and bot-wall params and text fragments", () => {
    expect(
      cleanUrl("https://www.reddit.com/r/ObsidianMD/?solution=9ad&js_challenge=1&jsc_token=28&jsc_orig_r="),
    ).toBe("https://www.reddit.com/r/ObsidianMD/");
    expect(cleanUrl("https://example.com/a?id=4&utm_source=x&fbclid=1#:~:text=hello")).toBe("https://example.com/a?id=4");
    expect(cleanUrl("https://example.com/a?__cf_chl_tk=abc&page=2#intro")).toBe("https://example.com/a?page=2#intro");
  });
  it("keeps ref and leaves clean URLs untouched", () => {
    expect(cleanUrl("https://github.com/o/r/blob/x.md?ref=main")).toBe("https://github.com/o/r/blob/x.md?ref=main");
    expect(cleanUrl("https://Example.com")).toBe("https://Example.com");
    expect(cleanUrl("not a url")).toBe("not a url");
  });
});
