import { timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { API_VERSION, CAPTURE_FILES, fileExt, type AssetKind, type CaptureFile, type CaptureOrigin, type JobStatus } from "./api.js";
import { passwordProblem, SESSION_DAYS, Throttle, type AuthStore } from "./auth.js";
import type { Config } from "./config.js";
import type { JobStore } from "./db.js";
import { parseCaptureSettings } from "./settings.js";
import { urlRejection } from "./ssrf.js";
import { assetPath, type Worker } from "./worker.js";

export interface AppDeps {
  config: Pick<Config, "tokens" | "dataDir" | "waitCapMs" | "allowPrivateNetworks">;
  store: JobStore;
  auth: AuthStore;
  worker: Worker;
  version: string;
  /** Override for tests; defaults to the DNS-backed SSRF check. */
  rejectUrl?: (url: string) => Promise<string | null>;
}

const ORIGINS: ReadonlySet<string> = new Set<CaptureOrigin>(["plugin", "api", "shortcut", "bookmarklet", "share", "enrich"]);
const FILES: ReadonlySet<string> = new Set<string>(CAPTURE_FILES);
const STATUSES: ReadonlySet<string> = new Set<JobStatus>(["pending", "running", "done", "failed", "delivered"]);
const MAX_BODY = 16 * 1024;
const MAX_SETTINGS_BODY = 512 * 1024;
const JOB_PATH = new RegExp(`^/jobs/([0-9A-Z]{26})(?:/(delivered|cancel|asset/(${[...CAPTURE_FILES, "markdown", "note"].join("|")})))?$`);

// The settings page: static files with no secrets in them, so they're served
// without signing in; the page signs in with a password and calls the API
// with a session cookie.
const UI_DIR = new URL("../ui/", import.meta.url);
const UI_FILES: Record<string, { file: string; type: string }> = {
  "/ui/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/ui/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/ui/save": { file: "save.html", type: "text/html; charset=utf-8" },
  "/ui/save.js": { file: "save.js", type: "text/javascript; charset=utf-8" },
};
const ASSET_TYPES: Record<string, string> = { pdf: "application/pdf", mp4: "video/mp4", jpg: "image/jpeg", png: "image/png" };

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

const SESSION_COOKIE = "bookmarks_session";
/**
 * The settings page sends this with every request. A session cookie counts only
 * alongside it: other sites can't add custom headers to a request without CORS
 * permission, which this server never grants, so they can't use the cookie.
 */
const UI_HEADER = "x-bookmarks-ui";
const KEY_PATH = /^\/keys\/([A-Za-z0-9_-]{1,64})$/;
const MAX_NAME = 100;

function bearer(req: IncomingMessage): string | null {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  return match?.[1] ?? null;
}

function sessionCookie(req: IncomingMessage): string | null {
  if (req.headers[UI_HEADER] !== "1") return null;
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, id: string | null): void {
  // Behind Tailscale Serve or another HTTPS proxy, keep the cookie off plain HTTP.
  const https = req.headers["x-forwarded-proto"] === "https" || "encrypted" in req.socket;
  const attrs = ["HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${id ? SESSION_DAYS * 86400 : 0}`, ...(https ? ["Secure"] : [])];
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${id ?? ""}; ${attrs.join("; ")}`);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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

interface CaptureBody {
  url: string;
  origin: string;
  template: string;
  /** Extra capture files by name (JSON array, or comma-separated in a form or query). */
  files: string[];
}

/** Accepts JSON `{url, origin, template, files}`, a form body, or `?url=` so Shortcuts and curl stay simple. */
async function captureRequest(req: IncomingMessage, query: URLSearchParams): Promise<CaptureBody> {
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
    files: listField(fields.files ?? query.get("files")),
  };
}

function listField(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items.map((item) => String(item).trim()).filter(Boolean);
}

export function createApp(deps: AppDeps): Server {
  const { config, store, worker, auth } = deps;
  const rejectUrl = deps.rejectUrl ?? ((url: string) => urlRejection(url, config.allowPrivateNetworks));
  const throttle = new Throttle();

  /** "key" for a bearer token (from BOOKMARKS_TOKENS or made on the API keys page), "session" for the signed-in settings page. */
  function caller(req: IncomingMessage): "key" | "session" | null {
    const token = bearer(req);
    if (token) return config.tokens.has(token) || auth.useKey(token) ? "key" : null;
    const session = sessionCookie(req);
    return session && auth.touchSession(session) ? "session" : null;
  }

  async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    try {
      const body = JSON.parse(await readBody(req)) as unknown;
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  const text = (value: unknown) => (typeof value === "string" ? value : "");

  /** Sign-in, sign-out and first-run account creation; null when the path isn't one of these. */
  async function handleSession(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void | null> {
    const client = req.socket.remoteAddress ?? "";
    if (path === "/auth" && method === "GET") {
      const username = auth.username();
      const session = sessionCookie(req);
      const signedIn = Boolean(username && session && auth.touchSession(session));
      auth.setupCode(); // logs the code if no account exists yet
      return sendJson(res, 200, { account: Boolean(username), signedIn, username: signedIn ? username : null });
    }
    if (method !== "POST" || !path.startsWith("/auth/")) return null;
    // Same rule as the cookie: only the settings page itself can call these.
    if (req.headers[UI_HEADER] !== "1") return sendJson(res, 403, { error: "forbidden" });

    if (path === "/auth/logout") {
      const session = sessionCookie(req);
      if (session) auth.endSession(session);
      setSessionCookie(req, res, null);
      return sendJson(res, 200, { signedIn: false });
    }
    if (path !== "/auth/login" && path !== "/auth/setup") return null;
    if (throttle.blocked(client)) return sendJson(res, 429, { error: "too_many_attempts", message: "Too many failed attempts. Try again in a few minutes." });
    const body = await jsonBody(req);
    if (!body) return sendJson(res, 400, { error: "bad_request", message: "Body must be JSON." });
    const username = text(body.username).trim();
    const password = text(body.password);

    if (path === "/auth/setup") {
      const code = auth.setupCode();
      if (!code) return sendJson(res, 409, { error: "account_exists", message: "An account already exists. Sign in instead." });
      if (!sameText(text(body.code).trim(), code)) {
        throttle.fail(client);
        return sendJson(res, 401, { error: "bad_setup_code", message: "That setup code isn't right. It's in the server's log." });
      }
      if (!username || username.length > MAX_NAME) return sendJson(res, 400, { error: "bad_request", message: "Choose a username." });
      const problem = passwordProblem(password);
      if (problem) return sendJson(res, 400, { error: "bad_request", message: problem });
      if (!(await auth.createAccount(username, password))) return sendJson(res, 409, { error: "account_exists", message: "An account already exists." });
      throttle.clear(client);
      setSessionCookie(req, res, auth.createSession());
      return sendJson(res, 200, { signedIn: true, username });
    }

    if (!(await auth.verify(username, password))) {
      throttle.fail(client);
      return sendJson(res, 401, { error: "bad_login", message: "Wrong username or password." });
    }
    throttle.clear(client);
    setSessionCookie(req, res, auth.createSession());
    return sendJson(res, 200, { signedIn: true, username });
  }

  /** Password change and API keys: only for the signed-in settings page, so a key can't make more keys. */
  async function handleAccount(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void | null> {
    const isKeys = path === "/keys" || KEY_PATH.test(path);
    if (!isKeys && path !== "/auth/password") return null;
    if (caller(req) !== "session") return sendJson(res, 403, { error: "session_required", message: "Sign in on the settings page to do this." });

    if (path === "/auth/password" && method === "POST") {
      const body = await jsonBody(req);
      if (!body) return sendJson(res, 400, { error: "bad_request", message: "Body must be JSON." });
      if (!(await auth.verify(auth.username() ?? "", text(body.current)))) return sendJson(res, 401, { error: "bad_login", message: "The current password isn't right." });
      const problem = passwordProblem(text(body.password));
      if (problem) return sendJson(res, 400, { error: "bad_request", message: problem });
      await auth.setPassword(text(body.password));
      // Other browsers are signed out; this one gets a fresh session.
      setSessionCookie(req, res, auth.createSession());
      return sendJson(res, 200, { ok: true });
    }
    if (path === "/keys" && method === "GET") return sendJson(res, 200, { keys: auth.listKeys(), envTokens: config.tokens.size });
    if (path === "/keys" && method === "POST") {
      const name = text((await jsonBody(req))?.name).trim();
      if (!name || name.length > MAX_NAME) return sendJson(res, 400, { error: "bad_request", message: "Give the key a name, like the device that will use it." });
      const { key, secret } = auth.createKey(name);
      return sendJson(res, 201, { key, secret });
    }
    const match = KEY_PATH.exec(path);
    if (match && method === "DELETE") {
      if (!auth.revokeKey(match[1]!)) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, { revoked: match[1] });
    }
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && serveUi(res, path)) return;
    if ((await handleSession(req, res, path, method)) !== null) return;
    if ((await handleAccount(req, res, path, method)) !== null) return;
    if (!caller(req)) return sendJson(res, 401, { error: "unauthorized" });

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
      let body: CaptureBody;
      try {
        body = await captureRequest(req, url.searchParams);
      } catch {
        return sendJson(res, 400, { error: "bad_request", message: "Body must be JSON {url, origin}, a form, or plain text." });
      }
      if (!body.url) return sendJson(res, 400, { error: "bad_request", message: "url is required" });
      if (!ORIGINS.has(body.origin)) return sendJson(res, 400, { error: "bad_request", message: `unknown origin ${body.origin}` });
      const unknownFile = body.files.find((name) => !FILES.has(name));
      if (unknownFile) return sendJson(res, 400, { error: "bad_request", message: `unknown capture file ${unknownFile}` });
      const rejection = await rejectUrl(body.url);
      if (rejection) return sendJson(res, 422, { error: "url_rejected", message: rejection });

      if (body.template && !store.getSettings().templates.some((t) => t.name === body.template)) {
        return sendJson(res, 422, { error: "unknown_template", message: `No template named "${body.template}".` });
      }
      const job = store.create(new URL(body.url).toString(), body.origin as CaptureOrigin, body.template || null, body.files as CaptureFile[]);
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

    const jobMatch = JOB_PATH.exec(path);
    if (jobMatch) {
      const [, id, action, kind] = jobMatch as unknown as [string, string, string | undefined, AssetKind | undefined];
      const job = store.get(id);
      if (!job) return sendJson(res, 404, { error: "not_found" });

      if (method === "GET" && !action) return sendJson(res, 200, { job });

      if (method === "POST" && action === "delivered") {
        if (!store.markDelivered(id)) return sendJson(res, 409, { error: "not_finished", message: `job is ${job.status}` });
        // An update's files are read once, by the plugin that asked for them.
        if (job.origin === "enrich") await deps.worker.discard(id);
        return sendJson(res, 200, { job: store.get(id) });
      }

      if (method === "POST" && action === "cancel") {
        if (!(await deps.worker.cancel(id))) return sendJson(res, 409, { error: "finished", message: `job is ${job.status}` });
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
              : ASSET_TYPES[fileExt(kind, job.screenshotExt) ?? "png"] ?? "application/octet-stream";
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
