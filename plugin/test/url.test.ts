import { describe, expect, it } from "vitest";
import { findUrl, matchesSiteList, normalizeUrl } from "../src/url";

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

describe("matchesSiteList", () => {
  const sites = ["nytimes.com", "https://www.Reddit.com/r/ObsidianMD", "*.example.org", ""];
  it("matches listed sites and their subdomains", () => {
    expect(matchesSiteList("https://www.nytimes.com/2026/x.html", sites)).toBe(true);
    expect(matchesSiteList("https://cooking.nytimes.com/", sites)).toBe(true);
    expect(matchesSiteList("https://old.reddit.com/", sites)).toBe(true);
    expect(matchesSiteList("https://docs.example.org/", sites)).toBe(true);
  });
  it("doesn't match lookalikes or unlisted sites", () => {
    expect(matchesSiteList("https://notnytimes.com/", sites)).toBe(false);
    expect(matchesSiteList("https://example.com/", sites)).toBe(false);
    expect(matchesSiteList("not a url", sites)).toBe(false);
  });
});
