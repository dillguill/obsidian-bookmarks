import { describe, expect, it } from "vitest";
import { collapse, diffLines, diffStats } from "../src/diff";

describe("diffLines", () => {
  it("marks added and removed lines, keeping the rest", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "x" },
      { op: " ", text: "c" },
      { op: "+", text: "d" },
    ]);
  });
  it("handles empty sides", () => {
    expect(diffLines([], ["a"])).toEqual([{ op: "+", text: "a" }]);
    expect(diffLines(["a"], [])).toEqual([{ op: "-", text: "a" }]);
    expect(diffLines([], [])).toEqual([]);
  });
  it("copes with long notes that share most lines", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const after = [...before.slice(0, 2500), "new", ...before.slice(2500), "end"];
    const out = diffLines(before, after);
    expect(diffStats(out)).toEqual({ added: 2, removed: 0 });
  });
});

describe("collapse", () => {
  const lines = (n: number, op: " " | "+" = " ") => Array.from({ length: n }, (_, i) => ({ op, text: `${op}${i}` }));
  it("folds long unchanged runs, keeping context around changes", () => {
    const out = collapse([...lines(10), { op: "+" as const, text: "new" }, ...lines(10)], 3);
    expect(out.map((l) => ("skip" in l ? `skip ${l.skip}` : l.text))).toEqual(["skip 7", " 7", " 8", " 9", "new", " 0", " 1", " 2", "skip 7"]);
  });
  it("keeps short runs as they are", () => {
    expect(collapse([...lines(2), { op: "-" as const, text: "old" }, ...lines(2)], 3)).toHaveLength(5);
  });
});

describe("diffLines on random notes", () => {
  /** Minimum edits by brute force (dynamic programming), to check the diff is shortest. */
  function minEdits(a: string[], b: string[]): number {
    const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    return a.length + b.length - 2 * lcs[0]![0]!;
  }
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  const note = () => Array.from({ length: rand(12) }, () => "abcd"[rand(4)]!);

  it("rebuilds both sides with the fewest edits", () => {
    for (let run = 0; run < 300; run++) {
      const a = note();
      const b = note();
      const out = diffLines(a, b);
      expect(out.filter((l) => l.op !== "+").map((l) => l.text)).toEqual(a);
      expect(out.filter((l) => l.op !== "-").map((l) => l.text)).toEqual(b);
      const { added, removed } = diffStats(out);
      expect(added + removed).toBe(minEdits(a, b));
    }
  });
});
