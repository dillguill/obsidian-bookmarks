import { describe, expect, it } from "vitest";
import { bookmarkUrl } from "../src/render.js";

describe("bookmarkUrl", () => {
  it("prefers a same-site canonical link and drops tracking and bot-wall params", () => {
    expect(bookmarkUrl({ finalUrl: "https://www.reddit.com/r/ObsidianMD/?solution=9a&js_challenge=1&jsc_token=2&jsc_orig_r=", canonical: null })).toBe(
      "https://www.reddit.com/r/ObsidianMD/",
    );
    expect(bookmarkUrl({ finalUrl: "https://example.com/p?utm_source=x", canonical: "https://example.com/post?fbclid=1" })).toBe("https://example.com/post");
    expect(bookmarkUrl({ finalUrl: "https://example.com/p", canonical: "https://other.example/p" })).toBe("https://example.com/p");
  });
});
