import { describe, expect, it } from "vitest";
import {
  appendBodies,
  applyMergedProperties,
  countsAsDuplicate,
  initialDispositions,
  mergeChoices,
  mergePlan,
  rankNotes,
  setDisposition,
  unusedFiles,
  type Disposition,
  type MergeNote,
} from "../src/merge";

function note(path: string, extra: Partial<MergeNote> = {}): MergeNote {
  const basename = path.replace(/^.*\//, "").replace(/\.md$/, "");
  return { path, basename, folder: "", frontmatter: {}, backlinks: 0, hasCaptureId: false, date: null, ctime: 0, ...extra };
}

const paths = (notes: MergeNote[]) => notes.map((n) => n.path);
const keeps = (state: Map<string, Disposition>) => [...state].filter(([, d]) => d === "keep").map(([p]) => p);

describe("rankNotes", () => {
  it("puts the most linked note first", () => {
    expect(paths(rankNotes([note("A.md", { backlinks: 1 }), note("B.md", { backlinks: 3 })]))).toEqual(["B.md", "A.md"]);
  });
  it("breaks ties with a capture id, then the earlier date, then the earlier file", () => {
    expect(paths(rankNotes([note("A.md"), note("B.md", { hasCaptureId: true })]))).toEqual(["B.md", "A.md"]);
    expect(paths(rankNotes([note("A.md", { date: 20 }), note("B.md", { date: 10 })]))).toEqual(["B.md", "A.md"]);
    expect(paths(rankNotes([note("A.md"), note("B.md", { date: 99 })]))).toEqual(["B.md", "A.md"]);
    expect(paths(rankNotes([note("A.md", { ctime: 5 }), note("B.md", { ctime: 1 })]))).toEqual(["B.md", "A.md"]);
  });
});

describe("dispositions", () => {
  const ranked = rankNotes([note("A.md", { backlinks: 2 }), note("B.md", { backlinks: 1 }), note("C.md")]);

  it("keeps the top note and merges the rest, leaving separate notes alone", () => {
    expect([...initialDispositions(ranked, [])]).toEqual([["A.md", "keep"], ["B.md", "merge"], ["C.md", "merge"]]);
    expect([...initialDispositions(ranked, ["A.md"])]).toEqual([["A.md", "separate"], ["B.md", "keep"], ["C.md", "merge"]]);
  });
  it("moves Keep: the old keep note becomes Merge", () => {
    const state = setDisposition(initialDispositions(ranked, []), ranked, "C.md", "keep");
    expect(state.get("A.md")).toBe("merge");
    expect(keeps(state)).toEqual(["C.md"]);
  });
  it("promotes the next note when the keep note is demoted", () => {
    for (const to of ["merge", "delete", "separate"] as const) {
      const state = setDisposition(initialDispositions(ranked, []), ranked, "A.md", to);
      expect(state.get("A.md")).toBe(to);
      expect(keeps(state)).toEqual(["B.md"]);
    }
  });
  it("has no keep note when every note is separate, and makes the first one un-marked Keep", () => {
    let state = initialDispositions(ranked, ["A.md", "B.md", "C.md"]);
    expect(keeps(state)).toEqual([]);
    state = setDisposition(state, ranked, "C.md", "merge");
    expect(state.get("C.md")).toBe("keep");
  });
  it("counts a group as a duplicate while two notes aren't separate", () => {
    expect(countsAsDuplicate(["A", "B", "C", "D"], ["A", "B"])).toBe(true);
    expect(countsAsDuplicate(["A", "B", "C", "D"], ["A", "B", "C"])).toBe(false);
  });
});

describe("mergeChoices", () => {
  const skip = ["source", "capture_id"];
  const none = () => undefined;

  it("folds equal values and values only one note has", () => {
    const notes = [note("A.md", { frontmatter: { title: "X", author: "Ann" } }), note("B.md", { frontmatter: { title: "X" } })];
    expect(mergeChoices(notes, skip, none)).toEqual([
      { name: "title", variants: [], kind: "settled", value: "X" },
      { name: "author", variants: [], kind: "settled", value: "Ann" },
    ]);
  });
  it("combines lists, wrapping single values, each item once in note order", () => {
    const notes = [note("A.md", { frontmatter: { tags: "foo" } }), note("B.md", { frontmatter: { tags: ["bar", "foo", "baz"] } })];
    expect(mergeChoices(notes, skip, none)).toEqual([{ name: "tags", variants: [], kind: "list", value: ["foo", "bar", "baz"] }]);
  });
  it("offers each distinct single value, kept note first, compared by full value", () => {
    const notes = [
      note("A.md", { frontmatter: { status: "read", meta: { a: 1 } } }),
      note("B.md", { frontmatter: { status: "todo", meta: { a: 2 } } }),
      note("C.md", { frontmatter: { status: "read", meta: { a: 1 } } }),
    ];
    expect(mergeChoices(notes, skip, none)).toEqual([
      { name: "status", variants: [], kind: "conflict", options: [{ value: "read", from: "A.md" }, { value: "todo", from: "B.md" }] },
      { name: "meta", variants: [], kind: "conflict", options: [{ value: { a: 1 }, from: "A.md" }, { value: { a: 2 }, from: "B.md" }] },
    ]);
  });
  it("treats names that differ only by case as one property, spelled as the kept note spells it", () => {
    const notes = [note("A.md", { frontmatter: { Exam: 1 } }), note("B.md", { frontmatter: { exam: 2 } })];
    expect(mergeChoices(notes, skip, none)).toEqual([
      { name: "Exam", variants: ["exam"], kind: "conflict", options: [{ value: 1, from: "A.md" }, { value: 2, from: "B.md" }] },
    ]);
  });
  it("uses the vault's usual spelling when the kept note has neither", () => {
    const notes = [note("A.md"), note("B.md", { frontmatter: { SKU: "x" } }), note("C.md", { frontmatter: { sku: "x" } })];
    expect(mergeChoices(notes, skip, (lower) => (lower === "sku" ? "sku" : undefined))).toEqual([
      { name: "sku", variants: ["SKU"], kind: "settled", value: "x" },
    ]);
  });
  it("skips the URL and capture id properties whatever their case", () => {
    const notes = [note("A.md", { frontmatter: { source: "a", Capture_ID: "1" } }), note("B.md", { frontmatter: { Source: "b" } })];
    expect(mergeChoices(notes, skip, none)).toEqual([]);
  });
  it("keeps a property empty everywhere only when the kept note has it", () => {
    expect(mergeChoices([note("A.md", { frontmatter: { notes: null } }), note("B.md", { frontmatter: { notes: "" } })], skip, none)).toEqual([
      { name: "notes", variants: [], kind: "settled", value: null },
    ]);
    expect(mergeChoices([note("A.md"), note("B.md", { frontmatter: { notes: "" } })], skip, none)).toEqual([]);
  });
});

describe("mergePlan", () => {
  const a = note("A.md", { frontmatter: { status: "read", Exam: 1 } });
  const b = note("B.md", { frontmatter: { status: "todo", exam: 2 } });
  const c = note("C.md");
  const d = note("D.md");
  const state = new Map<string, Disposition>([["A.md", "keep"], ["B.md", "merge"], ["C.md", "delete"], ["D.md", "separate"]]);
  const choices = mergeChoices([a, b], [], () => undefined);
  const plan = mergePlan({ notes: [a, b, c, d], state, choices, picks: { status: 1 }, bodies: { "B.md": "Beta", "C.md": "Gamma" } });

  it("sorts the notes by what happens to them", () => {
    expect(plan).toMatchObject({ kept: "A.md", merge: ["B.md"], delete: ["C.md"], separate: ["D.md"] });
  });
  it("sets the picked values and removes other spellings", () => {
    expect(plan.properties).toEqual({ set: { status: "todo", Exam: 1 }, remove: ["exam"] });
  });
  it("keeps only Merge bodies, dropping empty ones, and aliases every removed note", () => {
    expect(plan.bodies).toEqual([{ heading: "B", body: "Beta" }]);
    expect(plan.aliases).toEqual(["B", "C"]);
    const empty = mergePlan({ notes: [a, b], state: new Map([["A.md", "keep"], ["B.md", "merge"]]), choices: [], picks: {}, bodies: { "B.md": "  \n" } });
    expect(empty.bodies).toEqual([]);
  });
  it("has no kept note when only marks change", () => {
    const save = mergePlan({ notes: [a, b], state: new Map([["A.md", "separate"], ["B.md", "separate"]]), choices: [], picks: {}, bodies: {} });
    expect(save).toMatchObject({ kept: null, merge: [], delete: [], separate: ["A.md", "B.md"] });
  });
});

describe("applyMergedProperties", () => {
  it("writes values, drops other spellings and adds aliases once, ignoring case", () => {
    const fm: Record<string, unknown> = { status: "read", exam: 2, aliases: "b" };
    applyMergedProperties(fm, { properties: { set: { status: "todo", Exam: 1 }, remove: ["exam"] }, aliases: ["B", "C"] });
    expect(fm).toEqual({ status: "todo", Exam: 1, aliases: ["b", "C"] });
  });
  it("leaves aliases alone when nothing is added", () => {
    const fm: Record<string, unknown> = { title: "x" };
    applyMergedProperties(fm, { properties: { set: {}, remove: [] }, aliases: [] });
    expect(fm).toEqual({ title: "x" });
  });
});

describe("appendBodies", () => {
  it("adds each body under a heading in order, after the note's own body", () => {
    const text = "---\ntitle: x\n---\nOwn body\n";
    const out = appendBodies(text, { bodies: [{ heading: "A", body: "Alpha" }, { heading: "C", body: "Gamma" }] }, "---\ntitle: x\n---\n".length);
    expect(out).toBe("---\ntitle: x\n---\nOwn body\n\n# A\n\nAlpha\n\n# C\n\nGamma\n");
  });
  it("leaves the note unchanged with nothing to add", () => {
    expect(appendBodies("---\na: 1\n---\nx\n", { bodies: [] }, 12)).toBe("---\na: 1\n---\nx\n");
  });
});

describe("unusedFiles", () => {
  const links: Record<string, string[]> = {
    "A.md": ["a.png", "shared.png", "Other.md"],
    "C.md": ["c.png", "both.png"],
    "D.md": ["both.png"],
    "Other.md": ["shared.png"],
  };
  const linkedBy = (target: string) => Object.keys(links).filter((source) => links[source]!.includes(target));
  const run = (removed: string[], carried: string[] = []) =>
    unusedFiles({ removed, linksFrom: (p) => links[p] ?? [], linkedBy, carried, isNote: (p) => p.endsWith(".md") });

  it("lists files only removed notes use, once each, never notes", () => {
    expect(run(["A.md"])).toEqual(["a.png"]);
    expect(run(["C.md", "D.md"])).toEqual(["c.png", "both.png"]);
  });
  it("keeps files another note uses or the merge carries over", () => {
    expect(run(["C.md"])).toEqual(["c.png"]);
    expect(run(["A.md"], ["a.png"])).toEqual([]);
  });
});
