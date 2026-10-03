import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { API_VERSION, type AssetKind, type CaptureOrigin, type JobStatus } from "./api.js";
import type { Config } from "./config.js";
import type { JobStore } from "./db.js";
import { parseCaptureSettings } from "./settings.js";
import { urlRejection } from "./ssrf.js";
import { assetPath, type Worker } from "./worker.js";

export interface AppDeps {
  config: Pick<Config, "tokens" | "dataDir" | "waitCapMs" | "allowPrivateNetworks">;
  store: JobStore;
  worker: Worker;
  version: string;
  /** Override for tests; defaults to the DNS-backed SSRF check. */
  rejectUrl?: (url: string) => Promise<string | null>;
}

const ORIGINS: ReadonlySet<string> = new Set<CaptureOrigin>(["plugin", "api", "shortcut", "bookmarklet", "share"]);
const STATUSES: ReadonlySet<string> = new Set<JobStatus>(["pending", "running", "done", "failed", "delivered"]);
const MAX_BODY = 16 * 1024;
const MAX_SETTINGS_BODY = 512 * 1024;

// The settings page: static files with no secrets in them, so they're served
// without a token; the page signs in and calls the API with a bearer token.
const UI_DIR = new URL("../ui/", import.meta.url);
const UI_FILES: Record<string, { file: string; type: string }> = {
  "/ui/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/ui/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/ui/save": { file: "save.html", type: "text/html; charset=utf-8" },
  "/ui/save.js": { file: "save.js", type: "text/javascript; charset=utf-8" },
};
const UI_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

function serveUi(res: ServerResponse, path: string): boolean {
  if (path === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (path === "/" || path === "/ui") {
    res.writeHead(302, { location: "/ui/" });
    res.end();
    return true;
  }
  const entry = UI_FILES[path];
  if (!entry) return false;
  res.writeHead(200, { "content-type": entry.type, ...UI_HEADERS });
  res.end(readFileSync(new URL(entry.file, UI_DIR)));
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage, tokens: ReadonlySet<string>): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] !== undefined && tokens.has(match[1]);
}

async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Accepts JSON `{url, origin, template}`, a form body, or `?url=` so Shortcuts and curl stay simple. */
async function captureRequest(req: IncomingMessage, query: URLSearchParams): Promise<{ url: string; origin: string; template: string }> {
  const raw = await readBody(req);
  const type = req.headers["content-type"] ?? "";
  let fields: Record<string, unknown> = {};
  if (raw.trim()) {
    if (type.includes("application/x-www-form-urlencoded")) fields = Object.fromEntries(new URLSearchParams(raw));
    else if (type.includes("text/plain")) fields = { url: raw.trim() };
    else fields = JSON.parse(raw) as Record<string, unknown>;
  }
  return {
    url: String(fields.url ?? query.get("url") ?? "").trim(),
    origin: String(fields.origin ?? query.get("origin") ?? "api"),
    template: String(fields.template ?? query.get("template") ?? "").trim(),
  };
}

export function createApp(deps: AppDeps): Server {
  const { config, store, worker } = deps;
  const rejectUrl = deps.rejectUrl ?? ((url: string) => urlRejection(url, config.allowPrivateNetworks));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && serveUi(res, path)) return;
    if (!isAuthorized(req, config.tokens)) return sendJson(res, 401, { error: "unauthorized" });

    if (method === "GET" && path === "/health") {
      return sendJson(res, 200, { status: "ok", apiVersion: API_VERSION, version: deps.version });
    }

    if (path === "/settings" && method === "GET") return sendJson(res, 200, { settings: store.getSettings() });

    // Template names in order, for a Shortcut's "Choose from List".
    if (path === "/templates" && method === "GET") {
      return sendJson(res, 200, { templates: store.getSettings().templates.map((t) => t.name) });
    }

    if (path === "/settings" && method === "PUT") {
      let parsed: ReturnType<typeof parseCaptureSettings>;
      try {
        parsed = parseCaptureSettings(JSON.parse(await readBody(req, MAX_SETTINGS_BODY)));
      } catch {
        return sendJson(res, 400, { error: "bad_request", message: "Body must be JSON capture settings." });
      }
      if (typeof parsed === "string") return sendJson(res, 400, { error: "bad_request", message: parsed });
      store.saveSettings(parsed);
      return sendJson(res, 200, { settings: parsed });
    }

    if (method === "POST" && path === "/capture") {
      let body: { url: string; origin: string; template: string };
      try {
        body = await captureRequest(req, url.searchParams);
      } catch {
        return sendJson(res, 400, { error: "bad_request", message: "Body must be JSON {url, origin}, a form, or plain text." });
      }
      if (!body.url) return sendJson(res, 400, { error: "bad_request", message: "url is required" });
      if (!ORIGINS.has(body.origin)) return sendJson(res, 400, { error: "bad_request", message: `unknown origin ${body.origin}` });
      const rejection = await rejectUrl(body.url);
      if (rejection) return sendJson(res, 422, { error: "url_rejected", message: rejection });

      if (body.template && !store.getSettings().templates.some((t) => t.name === body.template)) {
        return sendJson(res, 422, { error: "unknown_template", message: `No template named "${body.template}".` });
      }
      const job = store.create(new URL(body.url).toString(), body.origin as CaptureOrigin, body.template || null);
      worker.kick();
      if (url.searchParams.get("wait") !== "1") return sendJson(res, 202, { job });
      const settled = await worker.waitFor(job.id, config.waitCapMs);
      const done = settled && settled.status !== "pending" && settled.status !== "running";
      return sendJson(res, done ? 200 : 202, { job: settled ?? job });
    }

    if (method === "GET" && path === "/jobs") {
      const statuses = (url.searchParams.get("status") ?? "done").split(",").filter((s) => STATUSES.has(s)) as JobStatus[];
      if (statuses.length === 0) return sendJson(res, 400, { error: "bad_request", message: "unknown status" });
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
      return sendJson(res, 200, { jobs: store.list(statuses, limit) });
    }

    const jobMatch = /^\/jobs\/([0-9A-Z]{26})(?:\/(delivered|asset\/(screenshot_[a-z]+|pdf_page|markdown|note)))?$/.exec(path);
    if (jobMatch) {
      const [, id, action, kind] = jobMatch as unknown as [string, string, string | undefined, AssetKind | undefined];
      const job = store.get(id);
      if (!job) return sendJson(res, 404, { error: "not_found" });

      if (method === "GET" && !action) return sendJson(res, 200, { job });

      if (method === "POST" && action === "delivered") {
        if (!store.markDelivered(id)) return sendJson(res, 409, { error: "not_finished", message: `job is ${job.status}` });
        return sendJson(res, 200, { job: store.get(id) });
      }

      if (method === "GET" && kind) {
        if (!job.assets.includes(kind)) return sendJson(res, 404, { error: "no_asset" });
        const file = assetPath(config.dataDir, id, kind, job.screenshotExt);
        const info = await stat(file).catch(() => null);
        if (!info) return sendJson(res, 404, { error: "no_asset" });
        const contentType =
          kind === "markdown"
            ? "text/markdown; charset=utf-8"
            : kind === "note"
              ? "application/json; charset=utf-8"
              : kind === "pdf_page"
                ? "application/pdf"
                : job.screenshotExt === "jpg" ? "image/jpeg" : "image/png";
        res.writeHead(200, { "content-type": contentType, "content-length": info.size });
        createReadStream(file).pipe(res);
        return;
      }
    }

    sendJson(res, 404, { error: "not_found" });
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    });
  });
}
