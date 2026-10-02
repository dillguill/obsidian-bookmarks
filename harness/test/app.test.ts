import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, PageMeta } from "../src/api.js";
import { createApp } from "../src/app.js";
import { BlockedError, type CaptureEngine } from "../src/capture.js";
import { JobStore } from "../src/db.js";
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

const engine: CaptureEngine = {
  async capture(url) {
    if (url.includes("blocked")) throw new BlockedError("Blocked by site: bot wall", meta(url));
    if (url.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 300));
    return { meta: meta(url), markdown: "# Hello", screenshot: Buffer.from([0xff, 0xd8, 0xff]), screenshotExt: "jpg" };
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
    expect(await res.json()).toEqual({ status: "ok", apiVersion: 1, version: "0.0.0-test" });
  });

  it("captures synchronously with ?wait=1 and serves assets", async () => {
    const res = await post("/capture?wait=1", { url: "https://example.com/a", origin: "plugin" });
    expect(res.status).toBe(200);
    const { job } = (await res.json()) as { job: Job };
    expect(job).toMatchObject({ status: "done", origin: "plugin", screenshotExt: "jpg" });
    expect(job.assets).toEqual(["screenshot", "markdown"]);

    const md = await fetch(`${base}/jobs/${job.id}/asset/markdown`, { headers: auth });
    expect(await md.text()).toBe("# Hello");
    const shot = await fetch(`${base}/jobs/${job.id}/asset/screenshot`, { headers: auth });
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
