import { describe, expect, it } from "vitest";
import { bookmarkUrl, screenshotVariables } from "../src/render.js";
import { currentSettings, DEFAULT_CAPTURE_SETTINGS } from "../src/settings.js";

describe("bookmarkUrl", () => {
  it("prefers a same-site canonical link and drops tracking and bot-wall params", () => {
    expect(bookmarkUrl({ finalUrl: "https://www.reddit.com/r/ObsidianMD/?solution=9a&js_challenge=1&jsc_token=2&jsc_orig_r=", canonical: null })).toBe(
      "https://www.reddit.com/r/ObsidianMD/",
    );
    expect(bookmarkUrl({ finalUrl: "https://example.com/p?utm_source=x", canonical: "https://example.com/post?fbclid=1" })).toBe("https://example.com/post");
    expect(bookmarkUrl({ finalUrl: "https://example.com/p", canonical: "https://other.example/p" })).toBe("https://example.com/p");
  });
});

describe("screenshotVariables", () => {
  it("offers path, link and embed forms, with the old names meaning the page shot", () => {
    expect(screenshotVariables("a/p.jpg", "")).toEqual({
      screenshot_page: "a/p.jpg",
      screenshot_page_link: "[[a/p.jpg]]",
      screenshot_page_embed: "![[a/p.jpg]]",
      screenshot_banner: "",
      screenshot_banner_link: "",
      screenshot_banner_embed: "",
      screenshot: "a/p.jpg",
      screenshot_link: "[[a/p.jpg]]",
      screenshot_embed: "![[a/p.jpg]]",
    });
  });
});

describe("currentSettings", () => {
  it("drops settings saved by older versions", () => {
    const stored = { screenshotStyle: "banner", bannerSites: ["x.com"], noScreenshotSites: [], hideCaptureId: true } as never;
    expect(currentSettings(stored)).toEqual({ ...DEFAULT_CAPTURE_SETTINGS, hideCaptureId: true });
  });
});
