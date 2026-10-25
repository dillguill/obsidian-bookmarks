import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, PageMeta } from "../src/api.js";
import { createApp } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
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
/** What the real engine would list as marked `|local`, by template. */
const LOCAL: Record<string, string[]> = {
  Post: ['<iframe src="https://www.tiktok.com/player/v1/7300000000000000009?autoplay=0" />'],
  Cover: ["https://p16.tiktokcdn.com/cover.jpeg"],
  Image: ["https://example.com/a.png"],
};
const shot = Buffer.from([0xff, 0xd8, 0xff]);
const engine: CaptureEngine = {
  async capture(url, render, progress) {
    renders.push(render);
    if (url.includes("progress")) {
      // Text first, then a screenshot a while later.
      progress?.page(meta(url), "# Hello", null);
      await new Promise((resolve) => setTimeout(resolve, 300));
      progress?.file("screenshot_page", shot, "jpg");
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { meta: meta(url), markdown: "# Hello", files: { screenshot_page: shot }, screenshotExt: "jpg", note: null };
    }
    if (url.includes("blocked")) throw new BlockedError("Blocked by site: bot wall", meta(url));
    if (url.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 300));
    const local = LOCAL[render?.templateName ?? ""];
    const note =
      url.includes("rendered") || local
        ? { template: render!.templateName ?? "Bookmark", noteName: "Hello", path: "Clips", frontmatter: "---\ntitle: \"Hello\"\n---\n", content: "# Hello", variables: {}, ...(local ? { local } : {}) }
        : null;
    // The real engine takes the shots the rendered note's variables ask for.
    if (url.includes("nopic")) return { meta: meta(url), markdown: "# Hello", files: {}, screenshotExt: null, note };
    const files = url.includes("all") ? { screenshot_page: shot, screenshot_banner: shot, screenshot_page_dark: shot, pdf_page: Buffer.from("%PDF-1.4") } : { screenshot_page: shot };
    return { meta: meta(url), markdown: "# Hello", files, screenshotExt: "jpg", note };
  },
  async preview(url, render) {
    renders.push(render);
    if (url.includes("blocked")) throw new BlockedError("Blocked by site: bot wall", meta(url));
    const noteFor = (template: string) => ({ template, noteName: "Hello", path: "Clips", frontmatter: `---\ntemplate: "${template}"\n---\n`, content: "# Hello", variables: {} });
    return {
      meta: meta(url),
      markdown: "# Hello",
      note: noteFor(render.templateName ?? "Bookmark"),
      render: async (template) => noteFor(template),
      files: async (kinds, put) => {
        shotsTaken.push(...kinds);
        for (const kind of kinds) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          put(kind, shot, "jpg");
        }
        return { screenshotExt: "jpg" };
      },
      close: async () => void heldClosed++,
    };
  },
  async tiktokPhotos(url, want) {
    if (url.includes("gone")) throw new Error("the post is unavailable (deleted, private or behind a login)");
    return { photos: want.photos ? [shot, shot] : [], cover: want.cover ? shot : null, ext: "jpg" };
  },
  async close() {},
};
const shotsTaken: string[] = [];
let heldClosed = 0;

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
    // No rest between downloads from one site here; media-queue.test.ts covers it.
    const worker = new Worker(store, engine, dataDir, 1, { ytdlpPath: null, allowPrivateNetworks: false, siteGapMs: 0 });
    server = createApp({
      config: { tokens: new Set(["device-a"]), dataDir, waitCapMs: 100, allowPrivateNetworks: false },
      store,
      auth: new AuthStore(":memory:"),
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
    expect(await res.json()).toEqual({ status: "ok", apiVersion: 9, version: "0.0.0-test", media: { ytdlp: null } });
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
    let { job } = (await res.json()) as { job: Job };
    // The wait cap is short, so a busy runner can answer before the job settles.
    for (let i = 0; i < 50 && (job.status === "pending" || job.status === "running"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = ((await (await fetch(`${base}/jobs/${job.id}`, { headers: auth })).json()) as { job: Job }).job;
    }
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
      schemaRevision: 2,
    };
    expect(initial.settings).toEqual(defaults);
    const saved = await put({ screenshotStyle: "banner", bannerSites: ["news.com"], hideCaptureId: true });
    const settings = ((await saved.json()) as { settings: Record<string, unknown> }).settings;
    expect(Object.keys(settings).sort()).toEqual(["hideCaptureId", "propertyTypes", "schemaRevision", "templates"]);
    expect(settings.hideCaptureId).toBe(true);
    await put({});
  });

  it("serves each capture file as an asset named after its variable", async () => {
    const capture = async (target: string) =>
      ((await (await post("/capture?wait=1", { url: target, origin: "shortcut" })).json()) as { job: Job }).job;
    const all = await capture("https://example.com/all");
    const none = await capture("https://example.com/nopic");
    expect(all.assets).toEqual(["screenshot_page", "screenshot_banner", "screenshot_page_dark", "pdf_page", "markdown"]);
    expect(none).toMatchObject({ status: "done", assets: ["markdown"], screenshotExt: null });
    const banner = await fetch(`${base}/jobs/${all.id}/asset/screenshot_banner`, { headers: auth });
    expect(banner.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await banner.arrayBuffer())).toEqual(shot);
    for (const kind of ["screenshot_page_dark"]) {
      const res = await fetch(`${base}/jobs/${all.id}/asset/${kind}`, { headers: auth });
      expect(res.headers.get("content-type")).toBe("image/jpeg");
    }
    const pdf = await fetch(`${base}/jobs/${all.id}/asset/pdf_page`, { headers: auth });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
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
      await post("/capture?wait=1", { url: "https://example.com/enrich", origin: "enrich", files: ["pdf_page", "screenshot_banner"] })
    ).json()) as { job: Job };
    expect(job.status).toBe("done");
    expect(job.files).toEqual(["pdf_page", "screenshot_banner"]);
    expect(renders.at(-1)!.files).toEqual(["pdf_page", "screenshot_banner"]);
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

  it("lists assets as they're made, so a running job's text can be read early", async () => {
    const { job } = (await (await post("/capture", { url: "https://example.com/progress", origin: "enrich" })).json()) as { job: Job };
    const get = async () => ((await (await fetch(`${base}/jobs/${job.id}`, { headers: auth })).json()) as { job: Job }).job;
    let now = await get();
    for (let i = 0; i < 50 && !now.assets.includes("markdown"); i++) now = await new Promise((r) => setTimeout(r, 20)).then(get);
    expect(now.status).toBe("running");
    expect(now.assets).toEqual(["markdown"]);
    expect((await fetch(`${base}/jobs/${job.id}/asset/markdown`, { headers: auth })).status).toBe(200);
    for (let i = 0; i < 100 && now.status === "running"; i++) now = await new Promise((r) => setTimeout(r, 20)).then(get);
    expect(now.status).toBe("done");
    expect(now.assets).toEqual(["markdown", "screenshot_page"]);
    // Collecting an update drops its files right away.
    await post(`/jobs/${job.id}/delivered`);
    expect((await get()).assets).toEqual([]);
  });

  it("cancels unfinished jobs and throws their result away", async () => {
    const { job } = (await (await post("/capture", { url: "https://example.com/progress", origin: "enrich" })).json()) as { job: Job };
    const res = await post(`/jobs/${job.id}/cancel`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { job: Job }).job).toMatchObject({ status: "failed", error: "cancelled", assets: [] });
    await new Promise((r) => setTimeout(r, 800));
    const after = ((await (await fetch(`${base}/jobs/${job.id}`, { headers: auth })).json()) as { job: Job }).job;
    expect(after).toMatchObject({ status: "failed", error: "cancelled", assets: [] });
    expect((await post(`/jobs/${job.id}/cancel`)).status).toBe(409);
  });

  describe("previews", () => {
    const getJob = async (id: string) => ((await (await fetch(`${base}/jobs/${id}`, { headers: auth })).json()) as { job: Job }).job;
    /** Starts a preview and waits for its note. */
    const preview = async (path = "a", template?: string) => {
      const res = await post("/capture", { url: `https://example.com/preview-${path}`, origin: "plugin", mode: "preview", ...(template ? { template } : {}) });
      expect(res.status).toBe(202);
      let { job } = (await res.json()) as { job: Job };
      for (let i = 0; i < 100 && !job.assets.includes("note") && job.status !== "failed"; i++) job = await new Promise((r) => setTimeout(r, 20)).then(() => getJob(job.id));
      return job;
    };
    const listed = async () => ((await (await fetch(`${base}/jobs?status=done,failed`, { headers: auth })).json()) as { jobs: Job[] }).jobs.map((j) => j.id);

    it("publishes the note and holds the page", async () => {
      const job = await preview("held");
      expect(job).toMatchObject({ status: "running", mode: "preview" });
      expect(job.heldUntil).not.toBeNull();
      expect(job.assets).toEqual(["markdown", "note"]);
      await post(`/jobs/${job.id}/release`, { keep: false });
    });

    it("rejects files on a preview and previews from other origins", async () => {
      expect((await post("/capture", { url: "https://example.com/x", origin: "plugin", mode: "preview", files: ["screenshot_page"] })).status).toBe(400);
      expect((await post("/capture", { url: "https://example.com/x", origin: "shortcut", mode: "preview" })).status).toBe(400);
      expect((await post("/capture", { url: "https://example.com/x", origin: "plugin", mode: "sideways" })).status).toBe(400);
    });

    it("renders a held page with another template", async () => {
      const job = await preview("render");
      const res = await post(`/jobs/${job.id}/render`, { template: "Bookmark" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { note: { template: string } }).note.template).toBe("Bookmark");
      expect((await post(`/jobs/${job.id}/render`, { template: "Nope" })).status).toBe(422);
      await post(`/jobs/${job.id}/release`, { keep: false });
    });

    it("takes only screenshot and PDF files, then finishes and is delivered", async () => {
      const job = await preview("files");
      expect((await post(`/jobs/${job.id}/files`, { files: ["media_video"] })).status).toBe(400);
      expect((await post(`/jobs/${job.id}/files`, { files: [] })).status).toBe(400);
      expect((await post(`/jobs/${job.id}/files`, { files: ["screenshot_page", "screenshot_banner"], finish: true })).status).toBe(202);
      let now = await getJob(job.id);
      for (let i = 0; i < 100 && now.status === "running"; i++) now = await new Promise((r) => setTimeout(r, 20)).then(() => getJob(job.id));
      expect(now).toMatchObject({ status: "done", screenshotExt: "jpg", heldUntil: null });
      expect(now.assets).toEqual(["markdown", "note", "screenshot_page", "screenshot_banner"]);
      expect(await listed()).toContain(job.id);
      expect((await post(`/jobs/${job.id}/render`, { template: "Bookmark" })).status).toBe(410);
    });

    it("keeps the page held after files without finish", async () => {
      const job = await preview("more");
      await post(`/jobs/${job.id}/files`, { files: ["screenshot_mobile"], finish: false });
      let now = await getJob(job.id);
      for (let i = 0; i < 100 && !now.assets.includes("screenshot_mobile"); i++) now = await new Promise((r) => setTimeout(r, 20)).then(() => getJob(job.id));
      await new Promise((r) => setTimeout(r, 50));
      now = await getJob(job.id);
      expect(now.status).toBe("running");
      expect((await post(`/jobs/${job.id}/render`, { template: "Bookmark" })).status).toBe(200);
      await post(`/jobs/${job.id}/release`, { keep: false });
    });

    it("throws away a released preview, and keeps one that was added", async () => {
      const closed = heldClosed;
      const dropped = await preview("drop");
      expect((await post(`/jobs/${dropped.id}/release`, { keep: false })).status).toBe(200);
      expect(await getJob(dropped.id)).toMatchObject({ status: "failed", error: "cancelled", assets: [] });
      expect(heldClosed).toBe(closed + 1);
      expect(await listed()).not.toContain(dropped.id);
      // Releasing again is fine.
      expect((await post(`/jobs/${dropped.id}/release`, { keep: false })).status).toBe(200);
      expect((await post(`/jobs/${dropped.id}/render`, { template: "Bookmark" })).status).toBe(410);

      const kept = await preview("keep");
      expect((await post(`/jobs/${kept.id}/release`, { keep: true })).status).toBe(200);
      expect(await getJob(kept.id)).toMatchObject({ status: "done", assets: ["markdown", "note"] });
      expect(await listed()).toContain(kept.id);
    });

    it("leaves a blocked preview out of delivery", async () => {
      const job = await preview("blocked");
      expect(job).toMatchObject({ status: "failed", mode: "preview" });
      expect(job.error).toContain("Blocked by site");
      expect(await listed()).not.toContain(job.id);
    });

    it("refuses page actions on a capture that isn't a preview", async () => {
      const { job } = (await (await post("/capture?wait=1", { url: "https://example.com/full" })).json()) as { job: Job };
      expect((await post(`/jobs/${job.id}/render`, { template: "Bookmark" })).status).toBe(409);
      expect((await post(`/jobs/${job.id}/release`, { keep: false })).status).toBe(409);
    });
  });

  describe("media downloads", () => {
    const getJob = async (id: string) => ((await (await fetch(`${base}/jobs/${id}`, { headers: auth })).json()) as { job: Job }).job;
    const settle = async (job: Job) => {
      let now = job;
      for (let i = 0; i < 200 && (now.status === "pending" || now.status === "running"); i++) now = await new Promise((r) => setTimeout(r, 25)).then(() => getJob(job.id));
      return now;
    };
    const media = async (body: unknown) => {
      const res = await post("/media", body);
      return { status: res.status, job: res.status === 202 ? ((await res.json()) as { job: Job }).job : null };
    };

    it("validates what it's asked for", async () => {
      expect((await media({ url: "https://www.tiktok.com/@a/photo/1" })).status).toBe(400);
      expect((await media({ url: "https://www.tiktok.com/@a/photo/1", want: ["music"] })).status).toBe(400);
      expect((await media({ want: ["video"] })).status).toBe(400);
      expect((await media({ url: "http://192.168.1.10/x", want: ["video"] })).status).toBe(422);
    });

    it("downloads a TikTok photo post's photos and cover, listed only for media", async () => {
      const { status, job } = await media({ url: "https://www.tiktok.com/@a/photo/7300000000000000000", want: ["photos", "cover"] });
      expect(status).toBe(202);
      expect(job).toMatchObject({ origin: "media", status: "pending" });
      const done = await settle(job!);
      expect(done).toMatchObject({ status: "done", screenshotExt: "jpg" });
      expect(done.assets).toEqual(["media_photo_1", "media_photo_2", "media_cover"]);
      expect(done.media!.made.map((m) => [m.asset, m.want])).toEqual([
        ["media_photo_1", "photos"],
        ["media_photo_2", "photos"],
        ["media_cover", "cover"],
      ]);
      const photo = await fetch(`${base}/jobs/${job!.id}/asset/media_photo_2`, { headers: auth });
      expect(photo.headers.get("content-type")).toBe("image/jpeg");
      const lists = async (q: string) => ((await (await fetch(`${base}/jobs?status=done${q}`, { headers: auth })).json()) as { jobs: Job[] }).jobs.map((j) => j.id);
      expect(await lists("&origin=media")).toContain(job!.id);
      expect(await lists("")).not.toContain(job!.id);
      // Collected once: its files go.
      await post(`/jobs/${job!.id}/delivered`);
      expect((await getJob(job!.id)).assets).toEqual([]);
    });

    it("says why a video can't be downloaded without yt-dlp, and fails when nothing came", async () => {
      const { job } = await media({ url: "https://www.youtube.com/watch?v=1", want: ["video", "cover"] });
      const done = await settle(job!);
      expect(done.status).toBe("failed");
      expect(done.media!.errors.map((e) => e.want)).toEqual(["video", "cover"]);
      expect(done.error).toContain("yt-dlp");
    });

    it("queues a phone capture's media marked |local, and only that", async () => {
      const put = (body: unknown) => fetch(`${base}/settings`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
      await put({ templates: ["Post", "Cover", "Image", "Plain"].map((name) => ({ name, properties: [] })), schemaRevision: 2 });
      try {
        const capture = async (url: string, template: string) => ((await (await post("/capture?wait=1", { url, origin: "shortcut", template })).json()) as { job: Job }).job;
        const followUp = async (url: string, template: string) => {
          const shared = await capture(url, template);
          const id = (await getJob(shared.id)).media?.followUp;
          return id ? { shared, media: await settle(await getJob(id)) } : null;
        };
        const photos = await followUp("https://www.tiktok.com/@a/photo/7300000000000000009", "Post");
        expect(photos!.media).toMatchObject({ origin: "media", status: "done" });
        expect(photos!.media.media).toMatchObject({ forCapture: photos!.shared.id, want: ["photos"], local: LOCAL.Post });
        expect(photos!.media.assets).toEqual(["media_photo_1", "media_photo_2"]);
        // Just the cover of a photo post: no photos downloaded.
        const cover = await followUp("https://www.tiktok.com/@a/photo/7300000000000000012", "Cover");
        expect(cover!.media.media).toMatchObject({ want: ["cover"] });
        expect(cover!.media.assets).toEqual(["media_cover"]);
        // An image is the plugin's to fetch: the job only lists it.
        const image = await followUp("https://example.com/page", "Image");
        expect(image!.media).toMatchObject({ status: "done", assets: [] });
        expect(image!.media.media).toMatchObject({ want: [], local: LOCAL.Image });
        // Nothing marked, or the plugin's own capture: nothing queued.
        expect(await followUp("https://www.tiktok.com/@a/photo/7300000000000000010", "Plain")).toBeNull();
        const own = ((await (await post("/capture?wait=1", { url: "https://www.tiktok.com/@a/photo/7300000000000000011", origin: "plugin", template: "Post" })).json()) as { job: Job }).job;
        expect((await getJob(own.id)).media).toBeNull();
      } finally {
        await put({});
      }
    });

    it("records a post that's gone", async () => {
      const { job } = await media({ url: "https://www.tiktok.com/@a/photo/7300000000000000001?gone=1", want: ["photos"] });
      const done = await settle(job!);
      expect(done).toMatchObject({ status: "failed" });
      expect(done.media!.errors[0]!.message).toContain("unavailable");
    });
  });
});
