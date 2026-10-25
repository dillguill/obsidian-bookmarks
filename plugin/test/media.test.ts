import { describe, expect, it } from "vitest";
import { findMedia, hasTikTokPlayer, imageName, isMarked, replaceSource, replaceTikTokPlayer, videoSite, withoutTikTokPlayer } from "../src/media";

const player = `<iframe\nsrc="https://www.tiktok.com/player/v1/7382225350710824222?autoplay=0"\nallow="fullscreen"\nstyle="width:100%;height:50vh;"\n/>`;
const text = `---\ntitle: x\n---\n${player}\n\nCaption.\n`;

describe("the TikTok player", () => {
  it("is found however {{tiktok_embed}} wrote it", () => {
    expect(hasTikTokPlayer(text)).toBe(true);
    expect(hasTikTokPlayer(`<iframe src="https://www.youtube.com/embed/x"></iframe>`)).toBe(false);
  });

  it("is swapped for the saved files", () => {
    expect(replaceTikTokPlayer(text, ["a/n-tiktok-video.mp4"])).toBe("---\ntitle: x\n---\n![[a/n-tiktok-video.mp4]]\n\nCaption.\n");
    expect(replaceTikTokPlayer(`<iframe src='https://www.tiktok.com/player/v1/1'></iframe>`, ["p1.jpg", "p2.jpg"])).toBe("![[p1.jpg]]\n![[p2.jpg]]");
    // Nothing saved: the player stays.
    expect(replaceTikTokPlayer(text, [])).toBe(text);
  });

  it("can be taken out, leaving the rest", () => {
    expect(withoutTikTokPlayer(`${player}\n\nCaption.\n`)).toBe("Caption.\n");
    expect(withoutTikTokPlayer(`Intro\n\n${player}\n\nCaption.`)).toBe("Intro\n\nCaption.");
  });
});

describe("findMedia", () => {
  const post = "https://www.tiktok.com/@scout/video/7382225350710824222";

  it("finds a TikTok post's video from its player, and its expiring cover in a property", () => {
    const items = findMedia(`${player}\n\nCaption`, { thumbnail: "https://p16-sign.tiktokcdn-us.com/abc~tplv.image?x-expires=1" }, post);
    expect(items.map((i) => [i.kind, i.via, i.source.in])).toEqual([
      ["tiktok_video", "server", "body"],
      ["tiktok_cover", "server", "property"],
    ]);
    expect(items[0]!.url).toBe(post);
  });

  it("calls a photo post's media photos", () => {
    const items = findMedia(player, {}, "https://www.tiktok.com/@scout/photo/7382225350710824222");
    expect(items.map((i) => [i.kind, i.label])).toEqual([["tiktok_photos", "TikTok photos"]]);
  });

  it("goes by the bookmark's URL when the note shows nothing, and not once the post is saved", () => {
    expect(findMedia("Caption", {}, post).map((i) => [i.kind, i.source.in])).toEqual([["tiktok_video", "end"]]);
    expect(findMedia("![[Bookmarks/n-tiktok-video.mp4]]\n\nCaption", {}, post)).toEqual([]);
  });

  it("finds YouTube videos in iframes, image embeds and the bookmark URL, but not in plain links", () => {
    const iframe = '<iframe src="https://www.youtube.com/embed/jNQXAC9IVRw"></iframe>';
    const found = findMedia(`${iframe}\n![](https://youtu.be/abc123def)\nSee [this](https://www.youtube.com/watch?v=zzzzzz)`, {}, null);
    expect(found.map((i) => [i.kind, i.label, i.preview])).toEqual([
      ["site_video", "YouTube video", "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg"],
      ["site_video", "YouTube video", "https://i.ytimg.com/vi/abc123def/hqdefault.jpg"],
    ]);
    expect(findMedia("Notes", {}, "https://www.youtube.com/watch?v=jNQXAC9IVRw").map((i) => [i.kind, i.source.in])).toEqual([["site_video", "end"]]);
  });

  it("finds web images in the body and in properties, data: images too, each once", () => {
    const found = findMedia("![a](https://example.com/x.webp)\n![a](https://example.com/x.webp)\n![dot](data:image/png;base64,AAAA)", { cover: "https://example.com/c.jpg", title: "Not an image", link: "https://example.com/page" }, null);
    expect(found.map((i) => [i.kind, i.source.in, i.label])).toEqual([
      ["image", "body", "x.webp"],
      ["image", "body", "dot"],
      ["image", "property", "c.jpg"],
    ]);
  });

  it("skips what's inside code", () => {
    expect(findMedia("```\n![a](https://example.com/x.png)\n```", {}, null)).toEqual([]);
  });
});

describe("isMarked", () => {
  const post = "https://www.tiktok.com/@a/video/7382225350710824222";
  const player = '<iframe src="https://www.tiktok.com/player/v1/7382225350710824222?autoplay=0" />';
  const cover = "https://p16.tiktokcdn.com/cover.jpeg";

  it("picks out the items a template marked |local, and no others", () => {
    const items = findMedia(`${player}\n\n![](https://e.com/a.png)`, { cover }, post);
    expect(items.filter((i) => isMarked(i, [cover])).map((i) => i.kind)).toEqual(["tiktok_cover"]);
    expect(items.filter((i) => isMarked(i, [player])).map((i) => i.kind)).toEqual(["tiktok_video"]);
    expect(items.filter((i) => isMarked(i, ["https://e.com/a.png"])).map((i) => i.kind)).toEqual(["image"]);
    expect(items.filter((i) => isMarked(i, []))).toEqual([]);
  });

  it("takes a marked property address as an image even without an image's extension", () => {
    expect(findMedia("", { image: "https://e.com/og?id=1" }, null)).toEqual([]);
    expect(findMedia("", { image: "https://e.com/og?id=1" }, null, ["https://e.com/og?id=1"]).map((i) => i.kind)).toEqual(["image"]);
    // Never the bookmark's own address.
    expect(findMedia("", { source: "https://e.com/page" }, "https://e.com/page", ["https://e.com/page"])).toEqual([]);
  });
});

describe("videoSite", () => {
  it("knows the video sites' video addresses", () => {
    expect(videoSite("https://m.youtube.com/watch?v=1")).toBe("youtube");
    expect(videoSite("https://www.youtube.com/shorts/abc")).toBe("youtube");
    expect(videoSite("https://youtu.be/abcdef1")).toBe("youtube");
    expect(videoSite("https://twitter.com/a/status/123")).toBe("x");
    expect(videoSite("https://x.com/a/status/123")).toBe("x");
    expect(videoSite("https://player.vimeo.com/video/42")).toBe("vimeo");
    expect(videoSite("https://www.instagram.com/reel/Cx1/")).toBe("instagram");
    expect(videoSite("https://www.youtube.com/@channel")).toBeNull();
    expect(videoSite("https://example.com/watch?v=1")).toBeNull();
  });
});

describe("imageName", () => {
  it("names a file the way Obsidian's own download does", () => {
    expect(imageName("https://example.com/a/photo.JPG?w=2", null, null)).toEqual({ base: "photo", ext: "jpg" });
    expect(imageName("https://example.com/img?id=1", "image/webp", 'attachment; filename="cat.png"')).toEqual({ base: "cat", ext: "png" });
    expect(imageName("https://example.com/img?id=1", "image/webp; charset=x", null)).toEqual({ base: "Image", ext: "webp" });
    expect(imageName("data:image/png;base64,AAAA", null, null)).toEqual({ base: "Image", ext: "png" });
    expect(imageName("https://example.com/noext", null, null)).toEqual({ base: "Image", ext: "jpg" });
  });
});

describe("replaceSource", () => {
  it("puts the saved files where the item was, or at the end", () => {
    expect(replaceSource(`A\n${player}\nB`, { in: "body", text: player }, ["![[v.mp4]]"])).toEqual({ text: "A\n![[v.mp4]]\nB", replaced: true });
    expect(replaceSource("A", { in: "body", text: player }, ["![[p1.jpg]]", "![[p2.jpg]]"])).toEqual({ text: "A", replaced: false });
    expect(replaceSource("A\n", { in: "end" }, ["![[p1.jpg]]", "![[p2.jpg]]"]).text).toBe("A\n\n![[p1.jpg]]\n![[p2.jpg]]\n");
  });
});

