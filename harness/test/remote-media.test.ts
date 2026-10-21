import { describe, expect, it } from "vitest";
import { fileMarker, type RenderedNote } from "../src/api.js";
import { noteWithRemoteMedia, oneTikTokPlayer, withRemoteMedia } from "../src/remote-media.js";
import { videoEmbed } from "../src/tiktok.js";

const player = videoEmbed("123");
const media = {
  player,
  images: { tiktok_thumbnail: "https://p16.tiktokcdn.com/cover.jpeg", image_local: "https://example.com/og.png" },
};

describe("withRemoteMedia", () => {
  it("turns an image embed into a web image and a link into the bare address", () => {
    expect(withRemoteMedia(`![[${fileMarker("image_local")}]]`, media)).toBe("![](https://example.com/og.png)");
    expect(withRemoteMedia(`[[${fileMarker("tiktok_thumbnail")}]]`, media)).toBe("https://p16.tiktokcdn.com/cover.jpeg");
    expect(withRemoteMedia(`cover: ${fileMarker("tiktok_thumbnail")}`, media)).toBe("cover: https://p16.tiktokcdn.com/cover.jpeg");
  });

  it("shows the player for the video however it was written", () => {
    expect(withRemoteMedia(`![[${fileMarker("tiktok_video")}]]`, media)).toBe(player);
    expect(withRemoteMedia(`[[${fileMarker("tiktok_video")}]]`, media)).toBe(player);
  });

  it("drops media with no address, brackets and all", () => {
    expect(withRemoteMedia(`a ![[${fileMarker("tiktok_image_3")}]] b [[${fileMarker("tiktok_image_4")}]] c`, media)).toBe("a  b  c");
  });

  it("leaves screenshot markers for the screenshots to fill", () => {
    const text = `![[${fileMarker("screenshot_page")}]]`;
    expect(withRemoteMedia(text, media)).toBe(text);
  });
});

describe("oneTikTokPlayer", () => {
  it("shows the same player once when it comes twice in a row", () => {
    expect(oneTikTokPlayer(`${player}\n\nCaption\n\n${player}`, player)).toBe(`${player}\n\nCaption\n\n${player}`);
    expect(oneTikTokPlayer(`${player}\n\n${player}\n`, player)).toBe(`${player}\n`);
  });
});

describe("noteWithRemoteMedia", () => {
  it("gives frontmatter the bare address and never a player", () => {
    const note: RenderedNote = {
      template: "TikTok",
      noteName: "n",
      path: "",
      frontmatter: `---\nthumbnail: "[[${fileMarker("tiktok_thumbnail")}]]"\nvideo: "[[${fileMarker("tiktok_video")}]]"\n---\n`,
      content: `${player}\n\n![[${fileMarker("tiktok_video")}]]`,
      variables: {},
    };
    const out = noteWithRemoteMedia(note, media);
    expect(out.frontmatter).toBe(`---\nthumbnail: "https://p16.tiktokcdn.com/cover.jpeg"\nvideo: ""\n---\n`);
    expect(out.content).toBe(player);
  });
});
