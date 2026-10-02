import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("http app", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createApp({ host: "127.0.0.1", port: 0, tokens: new Set(["device-a"]) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("rejects requests without a valid token", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(401);
    const wrong = await fetch(`${base}/health`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("reports health with a valid token", async () => {
    const res = await fetch(`${base}/health`, { headers: { authorization: "Bearer device-a" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
