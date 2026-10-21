import { describe, expect, it } from "vitest";
import { fileMarker, type ClipperTemplate, type RenderedNote } from "../src/api";
import { emptyFields, fieldsFrom, frontmatterFrom, splitList, vaultTypes, type PropertyField } from "../src/fields";

// A tiny YAML reader for the flat frontmatter these tests use.
const parseYaml = (yaml: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  let list: string | null = null;
  for (const line of yaml.split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) (out[list] as unknown[]).push(JSON.parse(item[1]!));
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    list = pair[2] ? null : pair[1]!;
    out[pair[1]!] = pair[2] ? JSON.parse(pair[2]) : [];
  }
  return out;
};

const template: ClipperTemplate = {
  schemaVersion: "0.1.0",
  name: "Clip",
  behavior: "create",
  noteNameFormat: "{{title}}",
  path: "Clips",
  noteContentFormat: "{{content}}",
  properties: [
    { name: "title", value: "{{title}}", type: "text" },
    { name: "tags", value: "", type: "multitext" },
    { name: "rating", value: "", type: "text" },
    { name: "cover", value: "[[{{screenshot_banner}}]]", type: "text" },
  ],
};

const field = (over: Partial<PropertyField>): PropertyField => ({ name: "x", type: "text", text: "", expression: "", edited: false, ...over });

describe("vaultTypes", () => {
  it("reads Obsidian's types.json, keeping known types", () => {
    expect(vaultTypes('{"types":{"rating":"number","tags":"tags","odd":"color"}}')).toEqual({ rating: "number", tags: "tags" });
  });

  it("is empty when the file is missing or broken", () => {
    expect(vaultTypes(null)).toEqual({});
    expect(vaultTypes("{not json")).toEqual({});
  });
});

describe("fieldsFrom", () => {
  const note: RenderedNote = {
    template: "Clip",
    noteName: "Hello",
    path: "Clips",
    frontmatter: `---\ntitle: "Hello"\ntags:\n  - "a"\n  - "b"\ncover: "[[${fileMarker("screenshot_banner")}]]"\nsource: "https://example.com"\n---\n`,
    content: "",
    variables: {},
  };

  it("lists the template's properties in order, then the ones the server added", () => {
    const fields = fieldsFrom(note, template, { rating: "number" }, parseYaml);
    expect(fields.map((f) => f.name)).toEqual(["title", "tags", "cover", "source"]);
    expect(fields.find((f) => f.name === "tags")).toMatchObject({ type: "multitext", text: "a, b" });
    expect(fields.find((f) => f.name === "cover")).toMatchObject({ text: "[[{{screenshot_banner}}]]", expression: "[[{{screenshot_banner}}]]" });
  });

  it("types a property the vault's way first, then the template's, then as text", () => {
    const fields = emptyFields(template, { rating: "number", title: "text", tags: "tags" });
    expect(fields.map((f) => [f.name, f.type])).toEqual([
      ["title", "text"],
      ["tags", "tags"],
      ["rating", "number"],
      ["cover", "text"],
    ]);
  });
});

describe("splitList", () => {
  it("splits on commas outside links and quotes", () => {
    expect(splitList("a, [[b, c]], d")).toEqual(["a", "[[b, c]]", "d"]);
    expect(splitList('"x, y", z,, ')).toEqual(['"x, y"', "z"]);
  });
});

describe("frontmatterFrom", () => {
  it("types each value", () => {
    expect(
      frontmatterFrom([
        field({ name: "tags", type: "multitext", text: "a, b" }),
        field({ name: "rating", type: "number", text: "4.5" }),
        field({ name: "read", type: "checkbox", text: "true" }),
        field({ name: "day", type: "date", text: "2026-10-18" }),
        field({ name: "at", type: "datetime", text: "2026-10-18T09:30" }),
        field({ name: "title", text: "Hello" }),
      ]),
    ).toEqual({ tags: ["a", "b"], rating: 4.5, read: true, day: "2026-10-18", at: "2026-10-18T09:30", title: "Hello" });
  });

  it("keeps empty properties, empty, as Obsidian does", () => {
    expect(frontmatterFrom([field({ name: "status", text: "  " }), field({ name: "tags", type: "tags", text: "" })])).toEqual({ status: null, tags: null });
  });

  it("leaves a property waiting on a screenshot empty until it arrives", () => {
    expect(frontmatterFrom([field({ name: "cover", text: "[[{{screenshot_banner}}]]" })])).toEqual({ cover: null });
  });

  it("keeps a number that doesn't parse as typed", () => {
    expect(frontmatterFrom([field({ name: "rating", type: "number", text: "four" })])).toEqual({ rating: "four" });
  });
});
