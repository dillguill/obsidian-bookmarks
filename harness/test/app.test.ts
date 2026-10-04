import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, PageMeta } from "../src/api.js";
import { createApp } from "../src/app.js";
import { BlockedError, type CaptureEngine } from "../src/capture.js";
import type { RenderRequest } from "../src/render.js";
import { JobStore } from "../src/db.js";
import { DEFAULT_TEMPLATE } from "../src/template-default.js";
import { Worker } from "../src/worker.js";

const meta = (url: string): PageMeta => ({
  finalUrl: url,
  canonical: null,
  title: "Example",
  description: "",
  author: "",
  site: "",
  domain: "example.com",
  published: "",
  image: "",
  favicon: "",
  wordCount: 3,
  httpStatus: 200,
  truncated: false,
});

const renders: (RenderRequest | null | undefined)[] = [];
const shot = Buffer.from([0xff, 0xd8, 0xff]);
const engine: CaptureEngine = {
  async capture(url, render) {
    renders.push(render);
    if (url.includes("blocked")) throw new BlockedError("Blocked by site: bot wall", meta(url));
    if (url.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 300));
    const note = url.includes("rendered") ? { template: render!.templateName ?? "Bookmark", noteName: "Hello", path: "Clips", frontmatter: "---\ntitle: \"Hello\"\n---\n", content: "# Hello" } : null;
    // The real engine takes the shots the rendered note's variables ask for.
    if (url.includes("nopic")) return { meta: meta(url), markdown: "# Hello", files: {}, screenshotExt: null, note };
    const files = url.includes("all") ? { screenshot_page: shot, screenshot_banner: shot, screenshot_page_dark: shot, pdf_page: Buffer.from("%PDF-1.4"), image_local: shot, tiktok_video: Buffer.from("mp4") } : { screenshot_page: shot };
    return { meta: meta(url), markdown: "# Hello", files, screenshotExt: "jpg", note };
  },
  async close() {},
};

describe("http app", () => {
  let server: Server;
  let base: string;
  let dataDir: string;
  const auth = { authorization: "Bearer device-a" };

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "bookmarks-test-"));
    const store = new JobStore(join(dataDir, "jobs.sqlite"));
    const worker = new Worker(store, engine, dataDir, 1);
    server = createApp({
      config: { tokens: new Set(["device-a"]), dataDir, waitCapMs: 100, allowPrivateNetworks: false },
      store,
      worker,
      version: "0.0.0-test",
      rejectUrl: async (url) => (url.includes("192.168.") ? "private" : null),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects requests without a valid token", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(401);
    const wrong = await fetch(`${base}/health`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("reports health and API version", async () => {
    const res = await fetch(`${base}/health`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", apiVersion: 6, version: "0.0.0-test" });
  });

  it("captures synchronously with ?wait=1 and serves assets", async () => {
    const res = await post("/capture?wait=1", { url: "https://example.com/a", origin: "plugin" });
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as { job: Job };
    expect(job).toMatchObject({ status: "done", origin: "plugin", screenshotExt: "jpg" });
    expect(job.assets).toEqual(["screenshot_page", "markdown"]);

    const md = await fetch(`${base}/jobs/${job.id}/asset/markdown`, { headers: auth });
    expect(await md.text()).toBe("# Hello");
    const shot = await fetch(`${base}/jobs/${job.id}/asset/screenshot_page`, { headers: auth });
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await shot.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("returns 202 when the wait cap passes first, then the job drains", async () => {
    const res = await post("/capture?wait=1", { url: "https://example.com/slow" });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    await new Promise((resolve) => setTimeout(resolve, 400));
    const list = (await (await fetch(`${base}/jobs?status=done`, { headers: auth })).json()) as { jobs: Job[] };
    expect(list.jobs.map((j) => j.id)).toContain(job.id);
  });

  it("accepts ?url= with no body, for curl and Shortcuts", async () => {
    const res = await fetch(`${base}/capture?url=${encodeURIComponent("https://example.com/q")}&origin=shortcut`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { job: Job }).job.origin).toBe("shortcut");
  });

  it("records blocked pages as failed with the reason", async () => {
    const res = await post("/capture?wait=1", { url: "https://example.com/blocked" });
    const { job } = (await res.json()) as { job: Job };
    expect(job.status).toBe("failed");
    expect(job.error).toContain("Blocked by site");
    expect(job.meta?.title).toBe("Example");
    expect(job.assets).toEqual([]);
  });

  it("shares capture settings, dropping the old screenshot settings", async () => {
    const put = (body: unknown) =>
      fetch(`${base}/settings`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    const initial = (await (await fetch(`${base}/settings`, { headers: auth })).json()) as { settings: unknown };
    const defaults = {
      templates: [DEFAULT_TEMPLATE],
      propertyTypes: DEFAULT_TEMPLATE.properties.map(({ name, type }) => ({ name, type })),
      hideCaptureId: false,
    };
    expect(initial.settings).toEqual(defaults);
    const saved = await put({ screenshotStyle: "banner", bannerSites: ["news.com"], hideCaptureId: true });
    const settings = ((await saved.json()) as { settings: Record<string, unknown> }).settings;
    expect(Object.keys(settings).sort()).toEqual(["hideCaptureId", "propertyTypes", "templates"]);
    expect(settings.hideCaptureId).toBe(true);
    await put({});
  });

  it("serves each capture file as an asset named after its variable", async () => {
    const capture = async (target: string) =>
      ((await (await post("/capture?wait=1", { url: target, origin: "shortcut" })).json()) as { job: Job }).job;
    const all = await capture("https://example.com/all");
    const none = await capture("https://example.com/nopic");
    expect(all.assets).toEqual(["screenshot_page", "screenshot_banner", "screenshot_page_dark", "pdf_page", "image_local", "tiktok_video", "markdown"]);
    expect(none).toMatchObject({ status: "done", assets: ["markdown"], screenshotExt: null });
    const banner = await fetch(`${base}/jobs/${all.id}/asset/screenshot_banner`, { headers: auth });
    expect(banner.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await banner.arrayBuffer())).toEqual(shot);
    for (const kind of ["screenshot_page_dark", "image_local"]) {
      const res = await fetch(`${base}/jobs/${all.id}/asset/${kind}`, { headers: auth });
      expect(res.headers.get("content-type")).toBe("image/jpeg");
    }
    const pdf = await fetch(`${base}/jobs/${all.id}/asset/pdf_page`, { headers: auth });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const video = await fetch(`${base}/jobs/${all.id}/asset/tiktok_video`, { headers: auth });
    expect(video.headers.get("content-type")).toBe("video/mp4");
    expect(await video.text()).toBe("mp4");
    expect((await fetch(`${base}/jobs/${none.id}/asset/screenshot_banner`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/jobs/${all.id}/asset/screenshot_nope`, { headers: auth })).status).toBe(404);
  });

  it("stores templates, accepting Web Clipper exports", async () => {
    const put = (body: unknown) =>
      fetch(`${base}/settings`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ templates: [] })).status).toBe(400);
    expect((await put({ templates: [{ name: "" }] })).status).toBe(400);
    expect((await put({ templates: [{ name: "X", properties: [{ name: "a", value: "b", type: "weird" }] }] })).status).toBe(400);
    expect((await put({ propertyTypes: [{ name: "a", type: "weird" }] })).status).toBe(400);
    const types = await put({ propertyTypes: [{ name: "rating", type: "number" }, { name: "rating", type: "text" }, { name: " read ", type: "checkbox" }] });
    expect(((await types.json()) as { settings: { propertyTypes: unknown } }).settings.propertyTypes).toEqual([
      { name: "rating", type: "number" },
      { name: "read", type: "checkbox" },
    ]);

    const clipperExport = {
      schemaVersion: "0.1.0",
      name: "GitHub",
      behavior: "create",
      noteContentFormat: "{{content}}",
      properties: [{ name: "repo", value: "{{title}}", type: "text" }],
      triggers: ["https://github.com/", " "],
      noteNameFormat: "{{title}}",
      path: "/Clippings/GitHub/",
      context: "",
    };
    const res = await put({ templates: [DEFAULT_TEMPLATE, clipperExport] });
    expect(res.status).toBe(200);
    const { settings } = (await res.json()) as { settings: { templates: Array<Record<string, unknown>> } };
    expect(settings.templates[1]).toEqual({
      schemaVersion: "0.1.0",
      name: "GitHub",
      behavior: "create",
      noteNameFormat: "{{title}}",
      path: "Clippings/GitHub",
      noteContentFormat: "{{content}}",
      properties: [{ name: "repo", value: "{{title}}", type: "text" }],
      triggers: ["https://github.com/"],
    });
    await put({});
  });

  it("records a template chosen at capture time and lists template names", async () => {
    const put = (body: unknown) =>
      fetch(`${base}/settings`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    await put({ templates: [DEFAULT_TEMPLATE, { ...DEFAULT_TEMPLATE, name: "Video" }] });
    const names = (await (await fetch(`${base}/templates`, { headers: auth })).json()) as { templates: string[] };
    expect(names.templates).toEqual(["Bookmark", "Video"]);

    const { job } = (await (await post("/capture", { url: "https://example.com/t", origin: "shortcut", template: "Video" })).json()) as { job: Job };
    expect(job.template).toBe("Video");
    const plain = (await (await post("/capture", { url: "https://example.com/u" })).json()) as { job: Job };
    expect(plain.job.template).toBeNull();
    const bad = await post("/capture", { url: "https://example.com/v", template: "Nope" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toBe("unknown_template");
    await put({});
  });

  it("passes asked-for capture files to the engine and keeps enrich jobs out of the delivery list", async () => {
    const { job } = (await (
      await post("/capture?wait=1", { url: "https://example.com/enrich", origin: "enrich", files: ["image_local", "screenshot_banner"] })
    ).json()) as { job: Job };
    expect(job.status).toBe("done");
    expect(job.files).toEqual(["image_local", "screenshot_banner"]);
    expect(renders.at(-1)!.files).toEqual(["image_local", "screenshot_banner"]);
    const { jobs } = (await (await fetch(`${base}/jobs?status=done,failed,delivered&limit=200`, { headers: auth })).json()) as { jobs: Job[] };
    expect(jobs.some((j) => j.id === job.id)).toBe(false);
    // Still readable by id, for the plugin that asked.
    expect((await fetch(`${base}/jobs/${job.id}`, { headers: auth })).status).toBe(200);
    expect((await post("/capture", { url: "https://example.com/x", files: ["screenshot_huge"] })).status).toBe(400);
  });

  it("renders notes with the shared templates and serves them as the note asset", async () => {
    const custom = { ...DEFAULT_TEMPLATE, name: "Bare", properties: [{ name: "title", value: "{{title}}", type: "text" as const }] };
    await fetch(`${base}/settings`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ templates: [DEFAULT_TEMPLATE, custom], propertyTypes: [{ name: "tags", type: "multitext" }] }),
    });
    const { job } = (await (await post("/capture?wait=1", { url: "https://example.com/rendered", template: "Bare" })).json()) as { job: Job };
    const request = renders.at(-1)!;
    expect(request.templateName).toBe("Bare");
    expect(request.extra.capture_id).toBe(job.id);
    expect(request.propertyTypes.tags).toBe("multitext");
    // URL and capture_id properties are added when a template leaves them out.
    expect(request.templates[1]!.properties.map((p) => p.value)).toEqual(["{{url}}", "{{title}}", "{{capture_id}}"]);

    expect(job.assets).toContain("note");
    const note = await fetch(`${base}/jobs/${job.id}/asset/note`, { headers: auth });
    expect(note.headers.get("content-type")).toContain("application/json");
    expect(await note.json()).toMatchObject({ template: "Bare", noteName: "Hello", path: "Clips" });

    // Hiding capture_id drops it, even from a template that names it.
    await fetch(`${base}/settings`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ templates: [DEFAULT_TEMPLATE], hideCaptureId: true }),
    });
    await post("/capture?wait=1", { url: "https://example.com/rendered-hidden" });
    expect(renders.at(-1)!.templates[0]!.properties.some((p) => p.value === "{{capture_id}}")).toBe(false);
    const bad = await fetch(`${base}/settings`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ hideCaptureId: "yes" }) });
    expect(bad.status).toBe(400);
    await fetch(`${base}/settings`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  });

  it("serves the settings page without a token", async () => {
    const root = await fetch(`${base}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/ui/");
    const page = await fetch(`${base}/ui/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("Bookmarks settings");
    expect((await fetch(`${base}/ui/app.js`)).headers.get("content-type")).toContain("javascript");
    expect(await (await fetch(`${base}/ui/save?url=https://example.com/`)).text()).toContain("Save bookmark");
    expect((await fetch(`${base}/ui/../jobs`)).status).toBe(401);
    expect((await fetch(`${base}/settings`)).status).toBe(401);
  });

  it("validates capture input", async () => {
    expect((await post("/capture", {})).status).toBe(400);
    expect((await post("/capture", { url: "https://example.com", origin: "nope" })).status).toBe(400);
    expect((await post("/capture", { url: "http://192.168.1.1/" })).status).toBe(422);
  });

  it("marks finished jobs delivered and refuses unfinished ones", async () => {
    const { job } = (await (await post("/capture?wait=1", { url: "https://example.com/d" })).json()) as { job: Job };
    const res = await post(`/jobs/${job.id}/delivered`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { job: Job }).job.status).toBe("delivered");
    const done = (await (await fetch(`${base}/jobs?status=done`, { headers: auth })).json()) as { jobs: Job[] };
    expect(done.jobs.map((j) => j.id)).not.toContain(job.id);

    const { job: pending } = (await (await post("/capture", { url: "https://example.com/slow" })).json()) as { job: Job };
    expect((await post(`/jobs/${pending.id}/delivered`)).status).toBe(409);
    expect((await post(`/jobs/01ARZ3NDEKTSV4RRFFQ69G5FAV/delivered`)).status).toBe(404);
  });
});
