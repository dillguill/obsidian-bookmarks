import { describe, expect, it } from "vitest";
import { currentSettings, parseCaptureSettings, parseTemplate, renameVariables, SCHEMA_REVISION } from "../src/settings.js";

const template = (over: Record<string, unknown> = {}) => ({ name: "T", noteNameFormat: "{{title}}", path: "Clips", noteContentFormat: "{{content}}", properties: [], ...over });

describe("onCapture", () => {
  it("keeps a known preset and drops anything else, including the removed media preset", () => {
    expect(parseTemplate(template({ onCapture: "copy" }))).toMatchObject({ onCapture: "copy" });
    expect(parseTemplate(template({ onCapture: "add-media" }))).not.toHaveProperty("onCapture");
    expect(parseTemplate(template({ onCapture: "shout" }))).not.toHaveProperty("onCapture");
  });
});

describe("renameVariables", () => {
  it("rewrites media variables that always saved a file to their |local form", () => {
    expect(renameVariables("![]({{image_local}}) {{ image_local|upper }}")).toBe("![]({{image|local}}) {{image|local|upper }}");
    expect(renameVariables("![[{{tiktok_save}}]]\n{{tiktok_image_1}} [[{{tiktok_image_12}}]]")).toBe("{{tiktok_embed|local}}\n{{tiktok_images|local}} {{tiktok_images|local}}");
    expect(renameVariables("{{tiktok_thumbnail}} {{image}}")).toBe("{{tiktok_thumbnail}} {{image}}");
  });
});

describe("stored templates", () => {
  it("are left as they are: no migration adds |local", () => {
    const tiktok = template({ name: "TikTok", noteContentFormat: "{{tiktok_embed}}\n{{tiktok_images}}", properties: [{ name: "cover", value: "[[{{tiktok_thumbnail}}]]", type: "text" }] });
    const settings = currentSettings({ templates: [tiktok] as never, schemaRevision: 1 });
    expect(settings.templates[0]!.noteContentFormat).toBe("{{tiktok_embed}}\n{{tiktok_images}}");
    expect(settings.templates[0]!.properties[0]!.value).toBe("[[{{tiktok_thumbnail}}]]");
    expect(settings.schemaRevision).toBe(SCHEMA_REVISION);
    const parsed = parseCaptureSettings({ templates: [tiktok] });
    expect(typeof parsed === "string" ? parsed : parsed.templates[0]!.properties[0]!.value).toBe("[[{{tiktok_thumbnail}}]]");
  });
});
