import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { JobStore } from "../src/db.js";
import type { Worker } from "../src/worker.js";

describe("sign-in and API keys", () => {
  let server: Server;
  let base: string;
  let auth: AuthStore;
  let cookie = "";
  const ui = { "x-bookmarks-ui": "1", "content-type": "application/json" };

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, headers: { ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const page = (method: string, path: string, body?: unknown) => call(method, path, body, { ...ui, cookie });
  const remember = (res: Response) => {
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return res;
  };

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    auth = new AuthStore(":memory:");
    const store = new JobStore(":memory:");
    const worker = { kick() {}, waitFor: async () => null } as unknown as Worker;
    server = createApp({
      config: { tokens: new Set(["env-token"]), dataDir: "/nonexistent", waitCapMs: 100, allowPrivateNetworks: false },
      store,
      auth,
      worker,
      version: "0.0.0-test",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.restoreAllMocks();
  });

  it("asks for an account until one is made, with the setup code from the log", async () => {
    expect(await (await call("GET", "/auth")).json()).toEqual({ account: false, signedIn: false, username: null });
    const code = auth.setupCode()!;
    expect(code).toBeTruthy();

    expect((await call("POST", "/auth/setup", { code, username: "dillon", password: "longenough" }, { "content-type": "application/json" })).status).toBe(403);
    expect((await page("POST", "/auth/setup", { code: "wrong", username: "dillon", password: "longenough" })).status).toBe(401);
    expect((await page("POST", "/auth/setup", { code, username: "dillon", password: "short" })).status).toBe(400);

    const res = remember(await page("POST", "/auth/setup", { code, username: "dillon", password: "longenough" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
    expect(auth.setupCode()).toBeNull();
    expect((await page("POST", "/auth/setup", { code, username: "x", password: "longenough" })).status).toBe(409);
  });

  it("uses the session cookie only with the settings page header", async () => {
    expect((await page("GET", "/settings")).status).toBe(200);
    expect((await call("GET", "/settings", undefined, { cookie })).status).toBe(401);
    expect(await (await page("GET", "/auth")).json()).toEqual({ account: true, signedIn: true, username: "dillon" });
  });

  it("signs out and back in", async () => {
    expect((await page("POST", "/auth/logout")).status).toBe(200);
    expect((await page("GET", "/settings")).status).toBe(401);
    expect((await page("POST", "/auth/login", { username: "dillon", password: "wrong-pass" })).status).toBe(401);
    expect(remember(await page("POST", "/auth/login", { username: "dillon", password: "longenough" })).status).toBe(200);
    expect((await page("GET", "/settings")).status).toBe(200);
  });

  it("makes, uses and revokes API keys", async () => {
    const made = await page("POST", "/keys", { name: "Phone" });
    expect(made.status).toBe(201);
    const { key, secret } = (await made.json()) as { key: { id: string; name: string; hint: string }; secret: string };
    expect(secret.startsWith(key.hint)).toBe(true);

    const bearer = { authorization: `Bearer ${secret}` };
    expect((await call("GET", "/health", undefined, bearer)).status).toBe(200);
    expect((await call("GET", "/health", undefined, { authorization: "Bearer env-token" })).status).toBe(200);
    // A key can't manage keys.
    expect((await call("GET", "/keys", undefined, bearer)).status).toBe(403);

    const list = (await (await page("GET", "/keys")).json()) as { keys: Array<{ id: string; lastUsedAt: string | null }>; envTokens: number };
    expect(list.envTokens).toBe(1);
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]!.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(list)).not.toContain(secret);

    expect((await page("DELETE", `/keys/${key.id}`)).status).toBe(200);
    expect((await call("GET", "/health", undefined, bearer)).status).toBe(401);
    expect((await page("DELETE", `/keys/${key.id}`)).status).toBe(404);
  });

  it("changes the password and signs out other sessions", async () => {
    const other = cookie;
    expect((await page("POST", "/auth/password", { current: "wrong-pass", password: "newpassword" })).status).toBe(401);
    expect(remember(await page("POST", "/auth/password", { current: "longenough", password: "newpassword" })).status).toBe(200);
    expect(cookie).not.toBe(other);
    expect((await call("GET", "/settings", undefined, { ...ui, cookie: other })).status).toBe(401);
    expect((await page("GET", "/settings")).status).toBe(200);
  });

  it("turns a client away after too many failed sign-ins", async () => {
    for (let i = 0; i < 10; i++) await page("POST", "/auth/login", { username: "dillon", password: "nope-nope" });
    expect((await page("POST", "/auth/login", { username: "dillon", password: "newpassword" })).status).toBe(429);
  });
});
