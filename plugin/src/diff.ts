// Line diffs for previewing a merge, git style. Kept free of Obsidian so it can be tested.

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

/** Past this many differences a diff is shown as replaced outright, to keep previews quick. */
const MAX_EDITS = 4000;

/** The lines of `after` against `before`: kept, added or removed, in order. */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  // Merges mostly append, so trimming what both share first leaves little to compare.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endA = before.length;
  let endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA--;
    endB--;
  }
  const head = before.slice(0, start).map((text): DiffLine => ({ op: " ", text }));
  const tail = before.slice(endA).map((text): DiffLine => ({ op: " ", text }));
  const a = before.slice(start, endA);
  const b = after.slice(start, endB);
  return [...head, ...middle(a, b), ...tail];
}

/** Myers' diff (as git uses): cost grows with the number of changes, not the length of the notes. */
function middle(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v: Int32Array = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return [...a.map((text): DiffLine => ({ op: "-", text })), ...b.map((text): DiffLine => ({ op: "+", text }))];
  trace.push(v);
  // Walk back through the saved frontiers to recover the edits.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) out.push({ op: " ", text: a[--x]! }), y--;
    if (d > 0) {
      if (x === prevX) out.push({ op: "+", text: b[--y]! });
      else out.push({ op: "-", text: a[--x]! });
    }
  }
  return out.reverse();
}

/** Lines added and removed. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.op === "+").length, removed: lines.filter((l) => l.op === "-").length };
}

/** A diff with unchanged runs longer than the context folded into a count, keeping `context` lines next to each change. */
export function collapse(lines: readonly DiffLine[], context = 3): (DiffLine | { skip: number })[] {
  const out: (DiffLine | { skip: number })[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.op !== " ") {
      out.push(lines[i++]!);
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end]!.op === " ") end++;
    const keepBefore = i === 0 ? 0 : context;
    const keepAfter = end === lines.length ? 0 : context;
    if (end - i > keepBefore + keepAfter) {
      out.push(...lines.slice(i, i + keepBefore), { skip: end - i - keepBefore - keepAfter }, ...lines.slice(end - keepAfter, end));
    } else out.push(...lines.slice(i, end));
    i = end;
  }
  return out;
}
