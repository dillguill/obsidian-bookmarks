import { describe, expect, it } from "vitest";
import { isPrivateAddress, urlRejection } from "../src/ssrf.js";

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "172.32.0.1", "208.80.153.224", "2620:0:860:ed1a::1"])("%s is public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("urlRejection", () => {
  const resolve = async (host: string) => (host === "intranet.test" ? ["10.0.0.5"] : ["93.184.215.14"]);

  it("allows public http(s) URLs", async () => {
    expect(await urlRejection("https://example.com/a", false, resolve)).toBeNull();
  });
  it("rejects other schemes and junk", async () => {
    expect(await urlRejection("file:///etc/passwd", false, resolve)).toMatch(/scheme/);
    expect(await urlRejection("not a url", false, resolve)).toMatch(/invalid/);
  });
  it("rejects hosts that resolve privately unless allowed", async () => {
    expect(await urlRejection("http://intranet.test/", false, resolve)).toMatch(/private/);
    expect(await urlRejection("http://127.0.0.1:8787/health", false, resolve)).toMatch(/private/);
    expect(await urlRejection("http://[::1]/", false, resolve)).toMatch(/private/);
    expect(await urlRejection("http://intranet.test/", true, resolve)).toBeNull();
  });
});
