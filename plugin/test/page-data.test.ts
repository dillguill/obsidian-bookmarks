import { describe, expect, it } from "vitest";
import { metaValue, schemaValue } from "../src/page-data";
import { render } from "../src/template";

const page = {
  schema: [
    { "@type": "WebApplication", name: "Space", creator: { "@type": "Person", name: "Ada" } },
    {
      "@type": "BreadcrumbList",
      itemListElement: [{ name: "Home" }, { name: "Models" }, { name: "Flux Dev" }],
    },
    { "@type": ["VideoObject", "CreativeWork"], thumbnailUrl: ["https://img/1.jpg", "https://img/2.jpg"], duration: "PT4M2S" },
  ],
  metaTags: { "name:author": "Grace", "property:og:title": "OG Title" },
};

describe("schema variables", () => {
  it("follows typed paths, indexes and wildcards", () => {
    expect(schemaValue("@WebApplication:creator.name", page)).toBe("Ada");
    expect(schemaValue("@BreadcrumbList:itemListElement[2].name", page)).toBe("Flux Dev");
    expect(schemaValue("@BreadcrumbList:itemListElement[*].name", page)).toBe("Home, Models, Flux Dev");
    expect(schemaValue("@VideoObject:thumbnailUrl", page)).toBe("https://img/1.jpg, https://img/2.jpg");
    expect(schemaValue("duration", page)).toBe("PT4M2S");
  });

  it("returns empty for anything missing", () => {
    expect(schemaValue("@Recipe:name", page)).toBe("");
    expect(schemaValue("@WebApplication:creator.email", page)).toBe("");
    expect(schemaValue("@BreadcrumbList:itemListElement[9].name", page)).toBe("");
    expect(schemaValue("name", {})).toBe("");
  });
});

describe("meta variables", () => {
  it("reads name and property tags", () => {
    expect(metaValue("name:author", page)).toBe("Grace");
    expect(metaValue("property:og:title", page)).toBe("OG Title");
    expect(metaValue("name:missing", page)).toBe("");
  });

  it("renders inside templates with filters", () => {
    expect(render("[[{{schema:@WebApplication:creator.name}}]] {{meta:name:author|upper}}", { title: "T" }, page)).toBe("[[Ada]] GRACE");
    expect(render("{{schema:@BreadcrumbList:itemListElement[2].name|kebab}}", {}, page)).toBe("flux-dev");
  });
});
