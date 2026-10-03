import { describe, expect, it } from "vitest";
import { bookmarkUrl, screenshotVariables } from "../src/render.js";
import { currentSettings, DEFAULT_CAPTURE_SETTINGS, parseCaptureSettings, renameScreenshotVariables } from "../src/settings.js";

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
  it("offers path, link and embed forms", () => {
    expect(screenshotVariables("a/p.jpg", "")).toEqual({
      screenshot_page: "a/p.jpg",
      screenshot_page_link: "[[a/p.jpg]]",
      screenshot_page_embed: "![[a/p.jpg]]",
      screenshot_banner: "",
      screenshot_banner_link: "",
      screenshot_banner_embed: "",
    });
  });
});

describe("currentSettings", () => {
  it("drops settings saved by older versions", () => {
    const stored = { screenshotStyle: "banner", bannerSites: ["x.com"], noScreenshotSites: [], hideCaptureId: true } as never;
    expect(currentSettings(stored)).toEqual({ ...DEFAULT_CAPTURE_SETTINGS, hideCaptureId: true });
  });
});

describe("renameScreenshotVariables", () => {
  it("renames the old screenshot variables inside tags only", () => {
    expect(renameScreenshotVariables("Screenshot: {{screenshot_embed}} {{ screenshot_link }} {{screenshot|wikilink}}")).toBe(
      "Screenshot: {{screenshot_page_embed}} {{ screenshot_page_link }} {{screenshot_page|wikilink}}",
    );
    expect(renameScreenshotVariables("{% if screenshot %}a screenshot{% endif %}")).toBe("{% if screenshot_page %}a screenshot{% endif %}");
    expect(renameScreenshotVariables("{{screenshot_page}} {{screenshot_banner_link}}")).toBe("{{screenshot_page}} {{screenshot_banner_link}}");
  });

  it("applies to stored and imported templates", () => {
    const old = { ...DEFAULT_CAPTURE_SETTINGS.templates[0]!, noteContentFormat: "{{screenshot_embed}}", properties: [{ name: "screenshot", value: "{{screenshot_link}}", type: "text" as const }] };
    for (const settings of [currentSettings({ templates: [old] }), parseCaptureSettings({ templates: [old] })]) {
      const t = (settings as typeof DEFAULT_CAPTURE_SETTINGS).templates[0]!;
      expect(t.noteContentFormat).toBe("{{screenshot_page_embed}}");
      expect(t.properties[0]).toEqual({ name: "screenshot", value: "{{screenshot_page_link}}", type: "text" });
    }
  });
});
