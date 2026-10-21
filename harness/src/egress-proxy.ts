// A forward proxy that the video downloader (yt-dlp) sends every request
// through, so the private-network rule the browser follows (design §8) holds
// for it too: each host is resolved here, refused if any of its addresses is
// private, and connected to at the address that was checked, so a second DNS
// answer can't point it elsewhere. Redirects are new requests, checked again.

import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";
import { isPrivateAddress, type Resolver } from "./ssrf.js";

export interface EgressProxy {
  /** The proxy's address, for yt-dlp's --proxy. */
  url: string;
  close(): Promise<void>;
}

export interface EgressOptions {
  allowPrivate: boolean;
  resolve?: Resolver;
  /** Which addresses are refused; the private-network check unless a test says otherwise. */
  blocked?: (ip: string) => boolean;
}

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** The address to connect to for a host, or why it's refused. */
async function vet(host: string, options: EgressOptions): Promise<{ ip: string } | { refused: string }> {
  const bare = host.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(bare) ? [bare] : await (options.resolve ?? systemResolver)(bare);
  } catch {
    return { refused: `could not resolve ${bare}` };
  }
  if (!addresses.length) return { refused: `could not resolve ${bare}` };
  const blocked = options.blocked ?? isPrivateAddress;
  // Every address has to pass: a host that also resolves privately could be switched to that one.
  if (!options.allowPrivate && addresses.some(blocked)) return { refused: `${bare} is a private network address` };
  return { ip: addresses[0]! };
}

/** host:port from a CONNECT target, IPv6 brackets kept off the host. */
function target(authority: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  return port > 0 && port < 65536 ? { host: match[1]!.replace(/^\[|\]$/g, ""), port } : null;
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(message);
}

/** Starts the proxy on a free loopback port. */
export async function startEgressProxy(options: EgressOptions): Promise<EgressProxy> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain http:// requests arrive with the whole URL as the path.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return refuse(res, 400, "absolute http URL required");
    }
    if (url.protocol !== "http:") return refuse(res, 400, "only http:// here; https goes through CONNECT");
    void vet(url.hostname, options).then((verdict) => {
      if ("refused" in verdict) return refuse(res, 403, verdict.refused);
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      const upstream = httpRequest({ host: verdict.ip, port: Number(url.port) || 80, method: req.method, path: `${url.pathname}${url.search}`, headers }, (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      });
      upstream.on("error", () => (res.headersSent ? res.destroy() : refuse(res, 502, "upstream failed")));
      req.pipe(upstream);
    });
  });

  // https:// (and anything else tunnelled): CONNECT host:port, then raw bytes both ways.
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const to = target(req.url ?? "");
    if (!to) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    void vet(to.host, options).then((verdict) => {
      if ("refused" in verdict) {
        client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${verdict.refused}`);
        return;
      }
      const upstream = connect(to.port, verdict.ip, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
