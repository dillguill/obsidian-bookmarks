import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.js";

// "public.test" stands for a public site (served locally here); "private.test" resolves into the private range.
const resolve = async (host: string) => (host === "public.test" ? ["127.0.0.1"] : host === "private.test" ? ["10.0.0.5"] : host === "both.test" ? ["127.0.0.1", "10.0.0.6"] : []);
const blocked = (ip: string) => ip.startsWith("10.");

/** A GET through the proxy as a plain-http proxy request. */
function viaProxy(proxy: EgressProxy, url: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(proxy.url);
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** The proxy's reply line to a CONNECT. */
function tunnel(proxy: EgressProxy, authority: string): Promise<string> {
  const { port } = new URL(proxy.url);
  return new Promise((done, fail) => {
    const socket = connect(Number(port), "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`));
    socket.once("data", (data) => {
      done(data.toString().split("\r\n")[0]!);
      socket.destroy();
    });
    socket.on("error", fail);
  });
}

describe("egress proxy", () => {
  let site: Server;
  let sitePort: number;
  let proxy: EgressProxy;

  beforeAll(async () => {
    site = createServer((req, res) => {
      if (req.url === "/hop") {
        // A redirect into the private network: the follow-up request is checked too.
        res.writeHead(302, { location: "http://private.test/secret" });
        return res.end();
      }
      res.end(`hello ${req.headers.host}`);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    sitePort = (site.address() as AddressInfo).port;
    proxy = await startEgressProxy({ allowPrivate: false, resolve, blocked });
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise((r) => site.close(r));
  });

  it("forwards plain http to public hosts, with their own Host header", async () => {
    expect(await viaProxy(proxy, `http://public.test:${sitePort}/x`)).toEqual({ status: 200, body: `hello public.test:${sitePort}` });
  });

  it("refuses private hosts, and hosts with any private address", async () => {
    expect((await viaProxy(proxy, "http://private.test/secret")).status).toBe(403);
    expect((await viaProxy(proxy, `http://both.test:${sitePort}/`)).status).toBe(403);
    expect((await viaProxy(proxy, "http://nowhere.test/")).status).toBe(403);
  });

  it("checks where a redirect goes, as a request of its own", async () => {
    const hop = await viaProxy(proxy, `http://public.test:${sitePort}/hop`);
    expect(hop.status).toBe(302);
    expect((await viaProxy(proxy, "http://private.test/secret")).status).toBe(403);
  });

  it("tunnels CONNECT to public hosts and refuses private ones", async () => {
    expect(await tunnel(proxy, `public.test:${sitePort}`)).toBe("HTTP/1.1 200 Connection Established");
    expect(await tunnel(proxy, "private.test:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await tunnel(proxy, "no-port")).toBe("HTTP/1.1 400 Bad Request");
  });

  it("refuses loopback by its own address when private networks aren't allowed", async () => {
    const strict = await startEgressProxy({ allowPrivate: false });
    try {
      expect((await viaProxy(strict, `http://127.0.0.1:${sitePort}/`)).status).toBe(403);
      expect(await tunnel(strict, `127.0.0.1:${sitePort}`)).toBe("HTTP/1.1 403 Forbidden");
      expect(await tunnel(strict, "[::1]:443")).toBe("HTTP/1.1 403 Forbidden");
    } finally {
      await strict.close();
    }
  });
});
