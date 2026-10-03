import { describe, expect, it } from "vitest";
import { fileMarker } from "../src/api.js";
import {
  captionTitle,
  idTime,
  itemFromScripts,
  noTikTokVariables,
  oembedItem,
  scriptsFromHtml,
  TIKTOK_VARIABLES,
  tiktokData,
  tiktokPost,
  videoEmbed,
  videoUrl,
} from "../src/tiktok.js";

describe("tiktokPost", () => {
  it("finds video and photo posts", () => {
    expect(tiktokPost("https://www.tiktok.com/@scout2015/video/6718335390845095173?lang=en")).toEqual({ id: "6718335390845095173", handle: "scout2015", kind: "video" });
    expect(tiktokPost("https://m.tiktok.com/@a.b/photo/7382225350710824222")).toEqual({ id: "7382225350710824222", handle: "a.b", kind: "photo" });
  });
  it("gives the /video/ URL, where photo posts keep their data", () => {
    expect(videoUrl({ id: "7309512999826476320", handle: "imarcbast", kind: "photo" })).toBe("https://www.tiktok.com/@imarcbast/video/7309512999826476320");
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
  const post = { id: "6718335390845095173", handle: "scout2015", kind: "video" as const };

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
        tiktok_images: "",
        tiktok_image_count: "",
      },
      cover: ["https://p16.tiktokcdn-us.com/cover.image", "https://p16.tiktokcdn-us.com/origin.image"],
      images: [],
    });
  });

  it("still has the date and embed without item JSON", () => {
    const { variables, cover } = tiktokData(post, null);
    expect(variables.tiktok_published).toBe("2019-07-27T13:32:33.000Z");
    expect(variables.tiktok_embed).toBe(videoEmbed(post.id));
    expect(variables.tiktok_title).toBe("");
    expect(variables.tiktok_author_handle).toBe("scout2015");
    expect(cover).toEqual([]);
  });

  it("lists a photo post's carousel and embeds each saved photo", () => {
    const photo = (name: string) => ({ imageURL: { urlList: [`https://p16.tiktokcdn-us.com/${name}.jpeg`, "https://p19.example/other.jpeg"] } });
    const data = tiktokData(
      { ...post, kind: "photo" },
      { id: post.id, imagePost: { cover: photo("cover"), images: [photo("one"), photo("two")] } },
    );
    expect(data.images).toEqual([
      ["https://p16.tiktokcdn-us.com/one.jpeg", "https://p19.example/other.jpeg"],
      ["https://p16.tiktokcdn-us.com/two.jpeg", "https://p19.example/other.jpeg"],
    ]);
    expect(data.cover).toEqual(["https://p16.tiktokcdn-us.com/cover.jpeg", "https://p19.example/other.jpeg"]);
    expect(data.variables.tiktok_images).toBe(`![[${fileMarker("tiktok_image_1")}]]\n![[${fileMarker("tiktok_image_2")}]]`);
    expect(data.variables.tiktok_image_count).toBe("2");
    // TikTok's player swipes through photo posts too.
    expect(data.variables.tiktok_embed).toBe(videoEmbed(post.id));
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

describe("oembedItem", () => {
  it("reads caption, creator and cover", () => {
    const item = oembedItem({
      title: "Get notified of price drops #iphonetips ",
      author_name: "Stephen Robles",
      author_unique_id: "beardedteacher",
      thumbnail_url: "https://p16.tiktokcdn-us.com/cover.image",
    });
    const { variables, cover } = tiktokData({ id: "7690631809217940767", handle: "beardedteacher", kind: "video" }, item);
    expect(variables).toMatchObject({
      tiktok_title: "Get notified of price drops",
      tiktok_description: "Get notified of price drops #iphonetips",
      tiktok_author: "Stephen Robles",
      tiktok_author_handle: "beardedteacher",
    });
    expect(variables.tiktok_published).toMatch(/^2026-09-28T/);
    expect(cover).toEqual(["https://p16.tiktokcdn-us.com/cover.image"]);
  });
  it("is null for an empty or bad reply", () => {
    expect(oembedItem({})).toBeNull();
    expect(oembedItem("nope")).toBeNull();
  });
});

describe("itemFromScripts", () => {
  const item = { id: "7309512999826476320", desc: "Paris" };
  const html = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: { "webapp.app-context": {}, "webapp.video-detail": { itemInfo: { itemStruct: item } } },
  })}</script></html>`;

  it("finds the post in the hydration JSON of fetched HTML", () => {
    expect(itemFromScripts(scriptsFromHtml(html), item.id)).toEqual(item);
  });
  it("is null for another post, no scripts or bad JSON", () => {
    expect(itemFromScripts(scriptsFromHtml(html), "1")).toBeNull();
    expect(itemFromScripts(scriptsFromHtml("<html></html>"), item.id)).toBeNull();
    expect(itemFromScripts({ universal: "{", sigi: null }, item.id)).toBeNull();
  });
});
