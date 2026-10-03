import { describe, expect, it } from "vitest";
import { captionTitle, idTime, noTikTokVariables, TIKTOK_VARIABLES, tiktokData, tiktokPost, videoEmbed } from "../src/tiktok.js";

describe("tiktokPost", () => {
  it("finds video and photo posts", () => {
    expect(tiktokPost("https://www.tiktok.com/@scout2015/video/6718335390845095173?lang=en")).toEqual({ id: "6718335390845095173", kind: "video" });
    expect(tiktokPost("https://m.tiktok.com/@a.b/photo/7382225350710824222")).toEqual({ id: "7382225350710824222", kind: "photo" });
  });
  it("ignores other pages", () => {
    expect(tiktokPost("https://www.tiktok.com/@scout2015")).toBeNull();
    expect(tiktokPost("https://nottiktok.com/@a/video/1")).toBeNull();
    expect(tiktokPost("not a url")).toBeNull();
  });
});

describe("idTime", () => {
  it("reads the upload time from the id", () => {
    // Seconds before the post's createTime (13:32:38).
    expect(idTime("6718335390845095173")?.toISOString()).toBe("2019-07-27T13:32:33.000Z");
    expect(idTime("12")).toBeNull();
  });
});

describe("captionTitle", () => {
  it("drops trailing hashtags and later lines", () => {
    expect(captionTitle("Scramble up ur name & I’ll try to guess it😍❤️ #foryoupage #petsoftiktok")).toBe("Scramble up ur name & I’ll try to guess it😍❤️");
    expect(captionTitle("\nFirst line #inline tag\nsecond")).toBe("First line #inline tag");
  });
  it("cuts long captions at a word", () => {
    const title = captionTitle(`${"word ".repeat(40)}end`);
    expect(title.length).toBeLessThanOrEqual(101);
    expect(title).toMatch(/word…$/);
  });
});

describe("tiktokData", () => {
  const post = { id: "6718335390845095173", kind: "video" as const };

  it("reads the post's item JSON", () => {
    const data = tiktokData(post, {
      id: post.id,
      desc: "Scramble up ur name #foryoupage",
      createTime: 1564234358,
      author: { uniqueId: "scout2015", nickname: "Scout, Suki & Stella" },
      video: { cover: "https://p16.tiktokcdn-us.com/cover.image", originCover: "https://p16.tiktokcdn-us.com/origin.image" },
    });
    expect(data).toEqual({
      variables: {
        tiktok_id: post.id,
        tiktok_title: "Scramble up ur name",
        tiktok_description: "Scramble up ur name #foryoupage",
        tiktok_published: "2019-07-27T13:32:38.000Z",
        tiktok_author: "Scout, Suki & Stella",
        tiktok_author_handle: "scout2015",
        tiktok_embed: videoEmbed(post.id),
      },
      cover: "https://p16.tiktokcdn-us.com/cover.image",
    });
  });

  it("still has the date and embed without item JSON", () => {
    const { variables, cover } = tiktokData(post, null);
    expect(variables.tiktok_published).toBe("2019-07-27T13:32:33.000Z");
    expect(variables.tiktok_embed).toBe(videoEmbed(post.id));
    expect(variables.tiktok_title).toBe("");
    expect(cover).toBe("");
  });

  it("has no embed for photo posts", () => {
    expect(tiktokData({ ...post, kind: "photo" }, null).variables.tiktok_embed).toBe("");
  });
});

describe("noTikTokVariables", () => {
  it("has every TikTok variable, empty", () => {
    expect(noTikTokVariables()).toEqual(Object.fromEntries(TIKTOK_VARIABLES.map((name) => [name, ""])));
  });
});

describe("videoEmbed", () => {
  it("is TikTok's v1 player without autoplay", () => {
    expect(videoEmbed("7382225350710824222")).toBe(
      '<iframe\nsrc="https://www.tiktok.com/player/v1/7382225350710824222?autoplay=0"\nallow="fullscreen"\nstyle="width:100%;height:50vh;"\n/>',
    );
  });
});
