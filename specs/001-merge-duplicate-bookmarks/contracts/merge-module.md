# Contract: pure modules (`merge.ts`, `links.ts`, `values.ts`)

None of these import `obsidian`, so they run under vitest. `main.ts` builds the
inputs from the caches and applies the outputs with Obsidian's APIs. Signatures
are indicative; names and types will be settled in implementation.

## values.ts (moved, not new behaviour)

```ts
isEmpty(value: unknown): boolean   // null, undefined, "" or an array of only empty values (enrich.ts semantics)
asList(value: unknown): unknown[]
same(a: unknown, b: unknown): boolean
```

`enrich.ts` and `enrich-modal.ts` import these. Their local copies are deleted.

## merge.ts

```ts
type Disposition = "keep" | "merge" | "delete" | "separate";

rankNotes(notes: MergeNote[]): MergeNote[]                         // FR-009 order
initialDispositions(notes: MergeNote[], separate: readonly string[]): Map<string, Disposition>
setDisposition(state: Map<string, Disposition>, ranked: MergeNote[], path: string, to: Disposition): Map<string, Disposition>  // keeps the FR-010 invariant
countsAsDuplicate(paths: readonly string[], separate: readonly string[]): boolean  // FR-003

mergeChoices(
  notes: MergeNote[],                     // Keep and Merge notes, kept note first
  skip: readonly string[],                // URL and capture-id property names (compared case-insensitively)
  spelling: (lower: string) => string | undefined,  // the vault's most common spelling
): PropertyChoice[]

mergePlan(input: {
  notes: MergeNote[]; state: Map<string, Disposition>;
  choices: PropertyChoice[]; picks: Record<string, number>;   // conflict name -> option index
  bodies: Record<string, string>;                              // path -> body without frontmatter
  keptAliases: unknown;
}): MergePlan                                                  // see data-model.md

applyMergedProperties(frontmatter: Record<string, unknown>, plan: MergePlan): void   // mutates, for processFrontMatter
appendBodies(text: string, plan: MergePlan, frontmatterEnd: number): string          // via enrich.placeContent (append rows)

unusedFiles(input: {
  removed: readonly string[];
  linksFrom: (path: string) => readonly string[];   // resolved targets of a note
  linkedBy: (target: string) => readonly string[];  // resolved sources of a target
  carried: readonly string[];                       // targets still referenced after the merge (Merge bodies, chosen values)
  isNote: (path: string) => boolean;
}): string[]
```

## links.ts

```ts
interface Span { start: number; end: number; replacement: string }

spliceSpans(text: string, spans: readonly Span[]): string   // applied from the end, overlapping spans rejected

redirectedLink(ref: { original: string; link: string; displayText?: string; embed: boolean },
               removedBasename: string,
               generate: (subpath: string, alias: string) => string): string
// keeps the subpath and the visible text: an alias if it was written, else the removed basename

redirectFrontmatter(frontmatter: Record<string, unknown>, key: string, original: string, replacement: string): boolean
```

## Test matrix (vitest)

| Area | Cases |
|---|---|
| `DedupIndex.groups` | http/https + www + utm in one group; a single note isn't a group; rename moves a path; remove drops it |
| `urlPropertyNames` | setting first; template names appended; deduplicated |
| `rankNotes` | backlinks win; capture id breaks ties; date; ctime; a null date sorts last |
| `setDisposition` | always one keep; demoting the keep promotes the next; Separate demotes; all Separate → no keep |
| `countsAsDuplicate` | 4 notes with 2 Separate → true; with 3 Separate → false |
| `mergeChoices` | equal folds; a value in one note only settles; `foo` + `[bar, baz]` → list; scalar conflict; object values compared fully; `exam`/`Exam` folded with the kept spelling; vault spelling when the kept note has neither; URL and capture id skipped; empty everywhere (FR-011b) |
| `mergePlan` | aliases deduplicated case-insensitively against existing ones; Delete bodies excluded; empty bodies dropped; separate list returned |
| `appendBodies` | a heading per body in order; frontmatter untouched; exactly one blank line between parts |
| `unusedFiles` | a file linked elsewhere is kept; a file carried by a Merge body is kept; a Markdown target is never included; a file used only by a Delete note is included |
| `spliceSpans` / `redirectedLink` | `[[A]]` → `[[B\|A]]`; `[[A#H\|x]]` → `[[B#H\|x]]`; `![[A]]` keeps the `!`; Markdown links; multiple spans in one line |
| `redirectFrontmatter` | a string value; a list item; a non-matching value left alone |
