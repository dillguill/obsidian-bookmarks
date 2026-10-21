import { describe, expect, it } from "vitest";
import { MediaQueue, SITE_GAP_MS, siteOf } from "../src/media-queue.js";

const tiktok = (id: string) => ({ id, url: `https://www.tiktok.com/@a/video/${id}` });

describe("siteOf", () => {
  it("treats www., m. and vm. hosts as one site", () => {
    expect(siteOf("https://www.tiktok.com/x")).toBe("tiktok.com");
    expect(siteOf("https://vm.tiktok.com/x")).toBe("tiktok.com");
    expect(siteOf("https://m.youtube.com/watch?v=1")).toBe("youtube.com");
  });
});

describe("MediaQueue", () => {
  it("runs the oldest first", () => {
    const queue = new MediaQueue(() => 0);
    expect(queue.next([tiktok("1"), tiktok("2")], 0)).toEqual({ run: tiktok("1") });
    expect(queue.next([], 0)).toBeNull();
  });

  it("rests a site after a download, and lets another site go meanwhile", () => {
    const queue = new MediaQueue(() => 0);
    queue.finished(tiktok("1").url, 1000);
    const youtube = { id: "y", url: "https://www.youtube.com/watch?v=1" };
    expect(queue.next([tiktok("2"), youtube], 1000)).toEqual({ run: youtube });
    expect(queue.next([tiktok("2")], 1000)).toEqual({ waitMs: SITE_GAP_MS });
    expect(queue.next([tiktok("2")], 1000 + SITE_GAP_MS)).toEqual({ run: tiktok("2") });
  });

  it("adds up to three seconds of jitter to the rest", () => {
    const most = new MediaQueue(() => 1);
    most.finished(tiktok("1").url, 0);
    expect(most.next([tiktok("2")], 0)).toEqual({ waitMs: SITE_GAP_MS + 3000 });
    const some = new MediaQueue(() => 0.5);
    some.finished(tiktok("1").url, 0);
    expect(some.next([tiktok("2")], 0)).toEqual({ waitMs: SITE_GAP_MS + 1500 });
  });

  it("keeps going after a failed download: a failure rests the site like any other", () => {
    const queue = new MediaQueue(() => 0);
    queue.finished(tiktok("1").url, 0);
    expect(queue.next([tiktok("2")], SITE_GAP_MS)).toEqual({ run: tiktok("2") });
  });
});
