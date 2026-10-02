import { describe, expect, it } from "vitest";
import { findUrl, normalizeUrl } from "../src/url";

describe("normalizeUrl", () => {
  it("drops www, case, fragment, trailing slash and scheme", () => {
    expect(normalizeUrl("https://WWW.Example.com/Path/#top")).toBe("example.com/Path");
    expect(normalizeUrl("http://example.com/Path")).toBe("example.com/Path");
  });
  it("removes tracking params and sorts the rest", () => {
    expect(normalizeUrl("https://example.com/a?utm_source=x&b=2&fbclid=1&a=1&ref=hn")).toBe("example.com/a?a=1&b=2");
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
