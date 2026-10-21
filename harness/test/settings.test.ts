import { describe, expect, it } from "vitest";
import { currentSettings, parseCaptureSettings, parseTemplate, SCHEMA_REVISION } from "../src/settings.js";

const template = (over: Record<string, unknown> = {}) => ({ name: "T", noteNameFormat: "{{title}}", path: "Clips", noteContentFormat: "{{content}}", properties: [], ...over });

describe("onCapture", () => {
  it("keeps a known preset and drops anything else", () => {
    expect(parseTemplate(template({ onCapture: "copy" }))).toMatchObject({ onCapture: "copy" });
    expect(parseTemplate(template({ onCapture: "add-media" }))).toMatchObject({ onCapture: "add-media" });
    expect(parseTemplate(template({ onCapture: "shout" }))).not.toHaveProperty("onCapture");
  });
});

describe("the media preset migration", () => {
  const tiktok = template({ name: "TikTok", noteContentFormat: "{{tiktok_embed}}\n\n{{tiktok_save}}" });
  const cover = template({ name: "Cover", properties: [{ name: "cover", value: "[[{{ tiktok_thumbnail }}]]", type: "text" }] });
  const photo = template({ name: "Photo", noteContentFormat: "![[{{tiktok_image_3}}]]" });
  const image = template({ name: "Image", noteContentFormat: "![[{{image_local}}]]" });
  const plain = template({ name: "Plain", noteContentFormat: "{{content}} ![[{{screenshot_page}}]]" });
  const chosen = template({ name: "Chosen", noteContentFormat: "{{tiktok_save}}", onCapture: "add" });

  it("gives templates that saved media when captured the Add and download media preset, once", () => {
    const settings = currentSettings({ templates: [tiktok, cover, photo, image, plain, chosen] as never });
    expect(settings.templates.map((t) => [t.name, t.onCapture])).toEqual([
      ["TikTok", "add-media"],
      ["Cover", "add-media"],
      ["Photo", "add-media"],
      ["Image", "add-media"],
      ["Plain", undefined],
      ["Chosen", "add"],
    ]);
    expect(settings.schemaRevision).toBe(SCHEMA_REVISION);
  });

  it("doesn't run again on settings already migrated", () => {
    const settings = currentSettings({ templates: [tiktok] as never, schemaRevision: 1 });
    expect(settings.templates[0]!.onCapture).toBeUndefined();
  });

  it("applies to a settings body saved before it, and not to one saved after", () => {
    const before = parseCaptureSettings({ templates: [tiktok] });
    expect(typeof before === "string" ? before : before.templates[0]!.onCapture).toBe("add-media");
    const after = parseCaptureSettings({ templates: [tiktok], schemaRevision: 1 });
    expect(typeof after === "string" ? after : after.templates[0]!.onCapture).toBeUndefined();
  });
});
