import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, render, renderFrontmatter, type ClipperTemplate } from "../src/template";

describe("render", () => {
  it("substitutes variables and applies filters", () => {
    const vars = { title: "Héllo, World!", date: "2026-10-02T19:05:09.000Z", domain: "example.com" };
    expect(render("{{domain|kebab}}-{{title|kebab}}", vars)).toBe("example-com-hello-world");
    expect(render('{{date|date:"YYYY-MM-DD"}}', vars)).toMatch(/^2026-10-0[23]$/);
    expect(render("{{title|safe_name}}", { title: 'a/b:c"d' })).toBe("abcd");
  });
  it("leaves unknown variables alone", () => {
    expect(render("{{selection}} {{title}}", { title: "x" })).toBe("{{selection}} x");
  });
});

describe("renderFrontmatter", () => {
  const vars = {
    url: "https://example.com/a",
    title: 'Say "hi"',
    description: "",
    author: "",
    domain: "example.com",
    date: "2026-10-02T19:05:09.000Z",
    screenshot_link: "[[Bookmarks/assets/x.jpg]]",
    capture_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  };

  it("writes typed YAML for the default template", () => {
    const yaml = renderFrontmatter(DEFAULT_TEMPLATE, vars);
    expect(yaml).toContain('source: "https://example.com/a"');
    expect(yaml).toContain('title: "Say \\"hi\\""');
    expect(yaml).toMatch(/created: 2026-10-0\dT\d\d:\d\d:\d\d\n/);
    expect(yaml).toContain("tags: []");
    expect(yaml).toContain('screenshot: "[[Bookmarks/assets/x.jpg]]"');
    expect(yaml).toContain('capture_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV"');
    expect(yaml.startsWith("---\n") && yaml.endsWith("\n---\n")).toBe(true);
  });

  it("adds the URL and capture_id properties when a template drops them", () => {
    const bare: ClipperTemplate = { ...DEFAULT_TEMPLATE, properties: [{ name: "title", value: "{{title}}", type: "text" }] };
    const yaml = renderFrontmatter(bare, vars);
    expect(yaml).toContain('source: "https://example.com/a"');
    expect(yaml).toContain('capture_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV"');
  });
});
