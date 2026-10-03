import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE as SERVER_DEFAULT_TEMPLATE } from "../../harness/src/template-default";
import { DEFAULT_TEMPLATE, render, renderFrontmatter, type ClipperTemplate, chooseTemplate } from "../src/template";

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
    screenshot_page_link: "[[Bookmarks/assets/x.jpg]]",
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

describe("Web Clipper variables", () => {
  it("renders variables that need the live page or an LLM as empty", () => {
    const vars = { title: "T", author: "A" };
    expect(render("[[{{schema:@WebApplication:creator.name}}]]", vars)).toBe("[[]]");
    expect(render('{{meta:name:author}}|{{"summary of page"}}|{{selectorHtml:article[data-x*="y"]|markdown}}', vars)).toBe("||");
    expect(render('{{author|split:", "|wikilink|join}}', vars)).toBe("A");
    expect(render("{{unknown}}", vars)).toBe("{{unknown}}");
  });
});

describe("chooseTemplate", () => {
  const named = (name: string, triggers?: string[]) => ({ ...DEFAULT_TEMPLATE, name, triggers });
  const templates = [named("Default"), named("GitHub", ["https://github.com/"]), named("Video", ["/youtube\\.com\\/watch/i", "schema:@VideoObject"])];

  it("picks the first template whose trigger matches", () => {
    expect(chooseTemplate(templates, "https://github.com/dillguill/x").name).toBe("GitHub");
    expect(chooseTemplate(templates, "https://www.YouTube.com/watch?v=1").name).toBe("Video");
  });

  it("matches schema.org triggers against the captured page", () => {
    const recipe = [named("Default"), named("Recipe", ["schema:@Recipe"]), named("Rated", ["schema:@Product:aggregateRating.ratingValue"])];
    const page = { schema: [{ "@type": "Recipe", name: "Soup" }] };
    expect(chooseTemplate(recipe, "https://food.example/soup", page).name).toBe("Recipe");
    expect(chooseTemplate(recipe, "https://food.example/soup").name).toBe("Default");
    expect(chooseTemplate(recipe, "https://shop.example/x", { schema: [{ "@type": "Product" }] }).name).toBe("Default");
    expect(chooseTemplate(recipe, "https://shop.example/x", { schema: [{ "@type": "Product", aggregateRating: { ratingValue: 4 } }] }).name).toBe("Rated");
  });

  it("falls back to the first template, then the built-in one", () => {
    expect(chooseTemplate(templates, "https://example.com/").name).toBe("Default");
    expect(chooseTemplate([], "https://example.com/")).toBe(DEFAULT_TEMPLATE);
    expect(chooseTemplate([named("Bad", ["/(/"])], "https://example.com/").name).toBe("Bad");
  });

  it("matches the server's built-in template", () => {
    expect(DEFAULT_TEMPLATE).toEqual(SERVER_DEFAULT_TEMPLATE);
  });
});
