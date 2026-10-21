import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PagePool, type Held } from "../src/pool.js";

const page = () => {
  const held = { closed: 0, close: async () => void held.closed++ };
  return held satisfies Held;
};

describe("PagePool", () => {
  let expired: string[];
  const pool = (max = 3) => new PagePool({ ttlMs: 120_000, max, onExpire: (id) => expired.push(id) });

  beforeEach(() => {
    vi.useFakeTimers();
    expired = [];
  });
  afterEach(() => vi.useRealTimers());

  it("holds, gets and releases a page", async () => {
    const p = pool();
    const a = page();
    expect(p.hold("a", a)).toBe(true);
    expect(p.get("a")).toBe(a);
    expect(await p.release("a")).toBe(true);
    expect(a.closed).toBe(1);
    expect(p.get("a")).toBeNull();
  });

  it("releases a page left idle past the TTL, and get restarts the clock", async () => {
    const p = pool();
    const a = page();
    p.hold("a", a);
    await vi.advanceTimersByTimeAsync(100_000);
    p.get("a");
    await vi.advanceTimersByTimeAsync(100_000);
    expect(a.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(a.closed).toBe(1);
    expect(expired).toEqual(["a"]);
  });

  it("makes room by releasing the page idle longest", async () => {
    const p = pool(3);
    const pages = { a: page(), b: page(), c: page(), d: page() };
    p.hold("a", pages.a);
    await vi.advanceTimersByTimeAsync(10);
    p.hold("b", pages.b);
    await vi.advanceTimersByTimeAsync(10);
    p.hold("c", pages.c);
    p.get("a");
    expect(p.hold("d", pages.d)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(pages.b.closed).toBe(1);
    expect(expired).toEqual(["b"]);
    expect(p.size).toBe(3);
  });

  it("never evicts a busy page, and refuses a new one when every page is busy", async () => {
    const p = pool(1);
    const a = page();
    const b = page();
    p.hold("a", a);
    p.setBusy("a", true);
    expect(p.hold("b", b)).toBe(false);
    expect(b.closed).toBe(1);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(a.closed).toBe(0);
    p.setBusy("a", false);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(a.closed).toBe(1);
  });

  it("releases once, however often it's asked", async () => {
    const p = pool();
    const a = page();
    p.hold("a", a);
    expect(await p.release("a")).toBe(true);
    expect(await p.release("a")).toBe(false);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(a.closed).toBe(1);
    expect(expired).toEqual([]);
  });
});
