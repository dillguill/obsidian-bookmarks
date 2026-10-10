import { describe, expect, it } from "vitest";
import { DedupIndex } from "../src/dedup";

function index(): DedupIndex {
  const i = new DedupIndex();
  i.set("A.md", "https://www.example.com/page?utm_source=x", null);
  i.set("B.md", "http://example.com/page/", null);
  i.set("C.md", "https://example.com/page", "cap-1");
  i.set("Solo.md", "https://other.example/", null);
  return i;
}

describe("DedupIndex groups", () => {
  it("groups copies of one page whatever their scheme, www, tracking params or trailing slash", () => {
    expect(index().groups()).toEqual([{ key: "example.com/page", paths: ["A.md", "B.md", "C.md"] }]);
  });
  it("gives a note's key, and null for notes it doesn't hold", () => {
    const i = index();
    expect(i.keyOf("B.md")).toBe("example.com/page");
    expect(i.keyOf("Nope.md")).toBeNull();
    expect(i.paths("example.com/page")).toEqual(["A.md", "B.md", "C.md"]);
    expect(i.paths("missing")).toEqual([]);
  });
  it("follows renames", () => {
    const i = index();
    i.rename("B.md", "Folder/B.md");
    expect(i.paths("example.com/page")).toEqual(["A.md", "C.md", "Folder/B.md"]);
    expect(i.keyOf("Folder/B.md")).toBe("example.com/page");
  });
  it("drops a group once only one note is left", () => {
    const i = index();
    i.remove("A.md");
    i.remove("B.md");
    expect(i.groups()).toEqual([]);
    expect(i.paths("example.com/page")).toEqual(["C.md"]);
  });
});
