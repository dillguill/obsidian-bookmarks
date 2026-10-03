import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTURE_FILES, fileMarker } from "../src/api.js";
import { blockReason, filesWanted, PlaywrightEngine } from "../src/capture.js";
import { renderRequest } from "../src/render.js";
import { DEFAULT_CAPTURE_SETTINGS } from "../src/settings.js";

describe("filesWanted", () => {
  const note = (content: string) => ({ template: "T", noteName: "n", path: "", frontmatter: "", content });

  it("adds files asked for by name to the ones the note uses", () => {
    expect([...filesWanted(note(`![[${fileMarker("screenshot_banner")}]]`))]).toEqual(["screenshot_banner"]);
    expect([...filesWanted(note(`![[${fileMarker("screenshot_banner")}]]`), ["image_local", "screenshot_page"])].sort()).toEqual([
      "image_local",
      "screenshot_banner",
      "screenshot_page",
    ]);
  });
});

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

/** A 40×20 red PNG. */
const COVER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJElEQVR4nO3NMQ0AAAwEofdvupVxCwk7uy3RrGKxWCwWi8WJB336HQ594lo5AAAAAElFTkSuQmCC",
  "base64",
);

/** Width and height from a JPEG's SOF0 marker. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  return { width: jpeg.readUInt16BE(sof + 7), height: jpeg.readUInt16BE(sof + 5) };
}

// Real-browser check; runs only when a Chromium is available (CI has none).
const chromiumPath = process.env.BOOKMARKS_CHROMIUM_PATH;
describe.skipIf(!chromiumPath)("PlaywrightEngine", () => {
  let server: Server;
  let base: string;
  const options = {
    captureTimeoutMs: 30_000,
    scrollBudgetMs: 5000,
    maxHeight: 20_000,
    userAgent: "test-agent",
    screenshotFormat: "jpeg" as const,
    allowPrivateNetworks: true,
    chromiumPath,
  };
  const engine = new PlaywrightEngine(options);

  const requested: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      requested.push(req.url ?? "");
      if (req.url === "/far.png") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/cover.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(COVER_PNG);
        return;
      }
      if (req.url === "/print") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><head><title>Print</title></head><body><article>${"<p>Words to print on the page.</p>".repeat(40)}</article>
          <img loading="lazy" src="/far.png" style="display:block;width:10px;height:10px;margin-top:20000px"></body></html>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "content-security-policy": "script-src 'none'" });
      if (req.url === "/layout") {
        res.end(`<html><head><title>Layout</title><meta property="og:image" content="/cover.png"><style>body{margin:0;background:#fff}@media (prefers-color-scheme: dark){body{background:#000;color:#fff}}</style></head>
          <body><nav style="height:120px">Nav</nav><div style="display:flex"><aside style="width:300px">Side</aside>
          <main style="display:contents"><article style="width:600px">${"<p>Article words for the main content block.</p>".repeat(60)}</article></main></div></body></html>`);
        return;
      }
      if (req.url === "/bare") {
        res.end(`<html><head><title>Bare</title></head><body><div>${"<p>Words in a plain div, no article or main.</p>".repeat(40)}</div></body></html>`);
        return;
      }
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
    expect(result.files.screenshot_page!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("renders the note with Web Clipper's engine: schema, meta, selectors, filters and logic", async () => {
    const template = {
      ...DEFAULT_CAPTURE_SETTINGS.templates[0]!,
      name: "Docs",
      triggers: ["schema:@BreadcrumbList"],
      noteNameFormat: "{{title|lower}} by {{meta:name:author}}",
      path: "Clips/{{domain}}",
      noteContentFormat: '{% if schema:@BreadcrumbList:itemListElement[1].name == "Docs" %}In docs{% endif %}\n{{selector:h1}}\n![[{{screenshot_page}}]]',
      properties: [{ name: "crumbs", value: "{{schema:@BreadcrumbList:itemListElement[*].name|join}}", type: "multitext" as const }],
    };
    const settings = { ...DEFAULT_CAPTURE_SETTINGS, templates: [DEFAULT_CAPTURE_SETTINGS.templates[0]!, template] };
    const result = await engine.capture(`${base}/`, renderRequest(settings, null, "01JOB"));
    const note = result.note!;
    expect(note.template).toBe("Docs");
    expect(note.noteName).toBe("article by Grace");
    expect(note.path).toBe("Clips/127.0.0.1");
    expect(note.content).toBe(`In docs\nArticle\n![[${fileMarker("screenshot_page")}]]`);
    expect(note.frontmatter).toContain('crumbs:\n  - "Home"\n  - "Docs"');
    expect(note.frontmatter).toContain(`capture_id: "01JOB"`);
    expect(note.frontmatter).toContain(`source: "${base}/"`);
    expect(Object.keys(result.files)).toEqual(["screenshot_page"]);
  });

  it("captures inner-scroll layouts at full height", async () => {
    const result = await engine.capture(`${base}/inner`);
    // JPEG height lives in the SOF0 marker; just check it's well past one viewport.
    expect(jpegSize(result.files.screenshot_page!).height).toBeGreaterThan(2000);
  });

  /** A render request whose only template has this content and no properties. */
  const withContent = (noteContentFormat: string) =>
    renderRequest({ ...DEFAULT_CAPTURE_SETTINGS, templates: [{ ...DEFAULT_CAPTURE_SETTINGS.templates[0]!, noteContentFormat, properties: [] }] }, null, "01JOB");

  it("captures only the first screen for {{screenshot_banner}}", async () => {
    const result = await engine.capture(`${base}/inner`, withContent("![[{{screenshot_banner}}]]"));
    expect(Object.keys(result.files)).toEqual(["screenshot_banner"]);
    expect(jpegSize(result.files.screenshot_banner!)).toEqual({ width: 1280, height: 800 });
    expect(result.note!.content).toBe(`![[${fileMarker("screenshot_banner")}]]`);
  });

  it("makes every capture file the template uses, light and dark", async () => {
    const content = CAPTURE_FILES.map((kind) => `{{${kind}}}`).join(" ");
    const { files } = await engine.capture(`${base}/layout`, withContent(content));
    // Everything but the TikTok files, which only TikTok posts have.
    expect(Object.keys(files).sort()).toEqual(CAPTURE_FILES.filter((kind) => !kind.startsWith("tiktok_")).sort());
    expect(jpegSize(files.screenshot_mobile!)).toEqual({ width: 390, height: 844 });
    expect(jpegSize(files.screenshot_thumbnail!)).toEqual({ width: 480, height: 300 });
    expect(jpegSize(files.screenshot_article!).width).toBe(600);
    for (const type of ["page", "banner", "mobile", "article", "thumbnail"] as const) {
      const [light, dark] = [files[`screenshot_${type}`]!, files[`screenshot_${type}_dark`]!];
      expect(jpegSize(dark)).toEqual(jpegSize(light));
      expect(dark.equals(light)).toBe(false);
    }
    expect(files.pdf_page!.subarray(0, 4).toString()).toBe("%PDF");
    // The PNG og:image comes out at its own size, in the screenshot format.
    expect(jpegSize(files.image_local!)).toEqual({ width: 40, height: 20 });
  });

  it("loads lazy images before printing the PDF", async () => {
    // maxHeight stops the scroll before the image, so only the PDF step loads it.
    const short = new PlaywrightEngine({ ...options, maxHeight: 2000 });
    try {
      const { files } = await short.capture(`${base}/print`, withContent("{{pdf_page}}"));
      expect(files.pdf_page!.subarray(0, 4).toString()).toBe("%PDF");
      expect(requested).toContain("/far.png");
    } finally {
      await short.close();
    }
  }, 30_000);

  it("leaves out the article shot when the page has no main content block", async () => {
    const result = await engine.capture(`${base}/bare`, withContent("![[{{screenshot_article}}]]"));
    expect(result.files).toEqual({});
    expect(result.screenshotExt).toBeNull();
  });

  it("skips screenshots the template doesn't use but keeps the text", async () => {
    const result = await engine.capture(`${base}/`, withContent("{{content}}"));
    expect(result.files).toEqual({});
    expect(result.screenshotExt).toBeNull();
    expect(result.markdown).toContain("Some readable words");
  });

  it("also makes capture files asked for by name", async () => {
    const result = await engine.capture(`${base}/`, { ...withContent("{{content}}"), files: ["screenshot_banner", "screenshot_thumbnail"] });
    expect(Object.keys(result.files).sort()).toEqual(["screenshot_banner", "screenshot_thumbnail"]);
    expect(result.screenshotExt).toBe("jpg");
  });
});
