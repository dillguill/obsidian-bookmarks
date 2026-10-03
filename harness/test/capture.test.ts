import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BANNER_MARKER, SCREENSHOT_MARKER } from "../src/api.js";
import { blockReason, PlaywrightEngine } from "../src/capture.js";
import { renderRequest } from "../src/render.js";
import { DEFAULT_CAPTURE_SETTINGS } from "../src/settings.js";

describe("blockReason", () => {
  const page = (title: string, wordCount: number, httpStatus: number | null = 200) => ({ title, wordCount, httpStatus });

  it("flags challenge titles", () => {
    expect(blockReason(page("Just a moment...", 7, 403), "")).toMatch(/challenge/);
    expect(blockReason(page("Attention Required! | Cloudflare", 103, 403), "")).toMatch(/challenge/);
  });
  it("flags bot walls by text on thin pages", () => {
    expect(blockReason(page("reddit", 26), "You've been blocked by network security.")).toBe("bot wall");
  });
  it("flags error statuses with no content", () => {
    expect(blockReason(page("nytimes.com", 0, 403), "")).toMatch(/HTTP 403/);
  });
  it("keeps real pages served with an error status", () => {
    // Stack Overflow served the full question with HTTP 403 in Spike 0.
    expect(blockReason(page("Why is processing a sorted array faster", 3504, 403), "")).toBeNull();
    expect(blockReason(page("r/ObsidianMD", 0, 200), "")).toBeNull();
  });
});

// Real-browser check; runs only when a Chromium is available (CI has none).
const chromiumPath = process.env.BOOKMARKS_CHROMIUM_PATH;
describe.skipIf(!chromiumPath)("PlaywrightEngine", () => {
  let server: Server;
  let base: string;
  const engine = new PlaywrightEngine({
    captureTimeoutMs: 30_000,
    scrollBudgetMs: 5000,
    maxHeight: 20_000,
    userAgent: "test-agent",
    screenshotFormat: "jpeg",
    allowPrivateNetworks: true,
    chromiumPath,
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-security-policy": "script-src 'none'" });
      if (req.url === "/inner") {
        res.end(`<html><head><title>Inner</title></head><body style="margin:0;height:100vh;overflow:hidden">
          <main style="height:100vh;overflow:auto"><article>${"<p>Inner scrolling paragraph with plenty of words in it.</p>".repeat(200)}</article></main></body></html>`);
        return;
      }
      res.end(`<html><head><title>Article</title><link rel="icon" href="/fav.ico">
        <meta name="author" content="Grace"><meta property="og:title" content="Article">
        <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList","itemListElement":[{"name":"Home"},{"name":"Docs"}]}]}</script>
        <script type="application/ld+json">{ not json</script></head><body>
        <div id="onetrust-consent-sdk" style="position:fixed;bottom:0">We use cookies</div>
        <article><h1>Article</h1>${"<p>Some readable words for the extractor to find here.</p>".repeat(40)}</article></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await engine.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it("extracts markdown despite a strict CSP and resolves the favicon", async () => {
    const result = await engine.capture(`${base}/`);
    expect(result.meta.title).toBe("Article");
    expect(result.meta.favicon).toBe(`${base}/fav.ico`);
    expect(result.markdown).toContain("Some readable words");
    expect(result.meta.metaTags).toMatchObject({ "name:author": "Grace", "property:og:title": "Article" });
    expect(result.meta.schema).toContainEqual({ "@type": "BreadcrumbList", itemListElement: [{ name: "Home" }, { name: "Docs" }] });
    expect(result.screenshotExt).toBe("jpg");
    expect(result.screenshot!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("renders the note with Web Clipper's engine: schema, meta, selectors, filters and logic", async () => {
    const template = {
      ...DEFAULT_CAPTURE_SETTINGS.templates[0]!,
      name: "Docs",
      triggers: ["schema:@BreadcrumbList"],
      noteNameFormat: "{{title|lower}} by {{meta:name:author}}",
      path: "Clips/{{domain}}",
      noteContentFormat: '{% if schema:@BreadcrumbList:itemListElement[1].name == "Docs" %}In docs{% endif %}\n{{selector:h1}}\n{{screenshot_embed}}',
      properties: [{ name: "crumbs", value: "{{schema:@BreadcrumbList:itemListElement[*].name|join}}", type: "multitext" as const }],
    };
    const settings = { ...DEFAULT_CAPTURE_SETTINGS, templates: [DEFAULT_CAPTURE_SETTINGS.templates[0]!, template] };
    const result = await engine.capture(`${base}/`, renderRequest(settings, null, "01JOB"));
    const note = result.note!;
    expect(note.template).toBe("Docs");
    expect(note.noteName).toBe("article by Grace");
    expect(note.path).toBe("Clips/127.0.0.1");
    expect(note.content).toBe(`In docs\nArticle\n![[${SCREENSHOT_MARKER}]]`);
    expect(note.frontmatter).toContain('crumbs:\n  - "Home"\n  - "Docs"');
    expect(note.frontmatter).toContain(`capture_id: "01JOB"`);
    expect(note.frontmatter).toContain(`source: "${base}/"`);
    expect(result.screenshot).not.toBeNull();
    expect(result.banner).toBeNull();
  });

  it("captures inner-scroll layouts at full height", async () => {
    const result = await engine.capture(`${base}/inner`);
    // JPEG height lives in the SOF0 marker; just check it's well past one viewport.
    const sof = result.screenshot!.indexOf(Buffer.from([0xff, 0xc0]));
    expect(result.screenshot!.readUInt16BE(sof + 5)).toBeGreaterThan(2000);
  });

  /** A render request whose only template has this content and no properties. */
  const withContent = (noteContentFormat: string) =>
    renderRequest({ ...DEFAULT_CAPTURE_SETTINGS, templates: [{ ...DEFAULT_CAPTURE_SETTINGS.templates[0]!, noteContentFormat, properties: [] }] }, null, "01JOB");

  it("captures only the first screen for {{screenshot_banner}}", async () => {
    const result = await engine.capture(`${base}/inner`, withContent("{{screenshot_banner_embed}}"));
    expect(result.screenshot).toBeNull();
    const sof = result.banner!.indexOf(Buffer.from([0xff, 0xc0]));
    expect(result.banner!.readUInt16BE(sof + 5)).toBe(800);
    expect(result.banner!.readUInt16BE(sof + 7)).toBe(1280);
    expect(result.note!.content).toBe(`![[${BANNER_MARKER}]]`);
  });

  it("takes both shots when the template uses both", async () => {
    const result = await engine.capture(`${base}/inner`, withContent("{{screenshot_banner}} {{screenshot_page_link}}"));
    expect(result.banner).not.toBeNull();
    expect(result.screenshot).not.toBeNull();
    expect(result.note!.content).toBe(`${BANNER_MARKER} [[${SCREENSHOT_MARKER}]]`);
  });

  it("skips screenshots the template doesn't use but keeps the text", async () => {
    const result = await engine.capture(`${base}/`, withContent("{{content}}"));
    expect(result.screenshot).toBeNull();
    expect(result.banner).toBeNull();
    expect(result.screenshotExt).toBeNull();
    expect(result.markdown).toContain("Some readable words");
  });
});
