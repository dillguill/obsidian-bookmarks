---
description: "Task list for Merge duplicate bookmarks"
---

# Tasks: Merge duplicate bookmarks

**Input**: Design documents from `specs/001-merge-duplicate-bookmarks/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Included. The plan's test matrix ([contracts/merge-module.md](contracts/merge-module.md)) defines vitest cases for the pure modules, following the repo's existing `plugin/test/*.test.ts` pattern. The modal and vault glue are checked by hand with [quickstart.md](quickstart.md).

**Organization**: Tasks are grouped by user story so each story can be built and checked on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1–US5)
- All paths are relative to the repo root. Plugin code is in `plugin/src/`, tests in `plugin/test/`.

## Conventions every task follows

- Match the surrounding code:
  - two-space indent, double quotes, 160-column lines;
  - a one-line `/** … */` doc comment on each exported function;
  - inline styles via `Object.assign(el.style, …)`, as in `enrich-modal.ts`.
- Pure modules (`values.ts`, `merge.ts`, `links.ts`) MUST NOT import `obsidian`.
- Tests use vitest (`import { describe, expect, it } from "vitest"`), like `plugin/test/enrich.test.ts`.
- After each phase run:
  - `npm test -w plugin`
  - `npm run typecheck -w plugin`
  - `npm run build -w plugin`

---

## Phase 1: Setup (shared groundwork, no behaviour change)

**Purpose**: Move the duplicated helpers so the new code reuses them, not copies them. Existing tests must stay green.

- [ ] T001 [P] Create `plugin/src/values.ts` with `isEmpty`, `asList` and `same`, moved from `plugin/src/enrich.ts`. `isEmpty` keeps enrich.ts's semantics (null, undefined, `""`, or an array of only empty values). Export all three. In `plugin/src/enrich.ts`, delete the local copies and import them from `./values`.
- [ ] T002 [P] Create `plugin/src/modal-ui.ts` by moving these module-private helpers out of `plugin/src/enrich-modal.ts`: `preview`, `sectionHead`, `iconButton`, `smallSelect`, `rowLine`, `pulse`, `statusLine`, `placeholderRow`, `clipped`. Export each one unchanged. In `plugin/src/enrich-modal.ts`, import them from `./modal-ui`, delete its local `isEmpty`, and import `isEmpty` from `./values` (depends on T001 only for that import).
- [ ] T003 Run `npm test -w plugin && npm run typecheck -w plugin` and confirm there are no failures and no behaviour change in `plugin/test/enrich.test.ts`.

**Checkpoint**: The helpers are shared. The update modal looks and behaves the same.

---

## Phase 2: Foundational (blocks every story)

**Purpose**: One URL lookup driven by the new URL property setting (FR-002, FR-002a–c), and group queries on the index.

### Tests for Phase 2

- [ ] T004 [P] Create `plugin/test/dedup.test.ts`. Cover:
  - `DedupIndex.groups()` puts `https://www.example.com/page?utm_source=x`, `http://example.com/page/` and `https://example.com/page` in one group;
  - a URL with one note isn't a group;
  - `keyOf(path)` returns the normalized key, and null for unknown paths;
  - `paths(key)` lists every path;
  - `rename` moves a path within its group;
  - `remove` drops it, and the group disappears at one note.
- [ ] T005 [P] Add `describe("urlPropertyNames")` to `plugin/test/template.test.ts`:
  - the setting comes first;
  - each template's `urlPropertyName` is appended;
  - duplicates are removed (`source` + a default template → `["source"]`);
  - an empty setting falls back to `"source"`.

### Implementation for Phase 2

- [ ] T006 [P] In `plugin/src/dedup.ts`, add three methods, each with a doc comment:
  - `keyOf(path: string): string | null` (from `entries`);
  - `paths(key: string): string[]` (from `byUrl`);
  - `groups(): { key: string; paths: string[] }[]` (only keys with more than one path).
- [ ] T007 [P] In `plugin/src/template.ts`, add `export function urlPropertyNames(setting: string, templates: ClipperTemplate[]): string[]`: the trimmed setting (or `"source"` if empty) followed by `templates.map(urlPropertyName)`, deduplicated, order kept.
- [ ] T008 In `plugin/src/settings.ts`, add the settings fields from `data-model.md`:
  - to `BookmarksSettings`: `urlProperty: string` (doc: the property holding a note's web address) and `separateNotes?: Record<string, string[]>` (doc: normalized URL → paths marked Separate);
  - to `DEFAULT_SETTINGS`: `urlProperty: "source"`.
- [ ] T009 [P] Create `plugin/src/property-suggest.ts`: `export class PropertySuggest extends AbstractInputSuggest<string>`.
  - Constructor: `(app, inputEl, names: () => string[], onPick: (name: string) => void)`.
  - `getSuggestions(query)` filters `names()` case-insensitively by substring, with prefix matches first.
  - `renderSuggestion` sets the text.
  - `selectSuggestion` calls `setValue(name)`, `onPick(name)` and `close()`.
- [ ] T010 In `plugin/src/main.ts`, replace the three URL lookups with one:
  - Add `private urlNames(): string[]` returning `urlPropertyNames(this.settings.urlProperty, this.templates)`.
  - Change `noteUrl(file)` to read the first of `urlNames()` whose value is a string that `normalizeUrl` accepts. Drop the hard-coded `"url", "source", "URL"`.
  - `indexFile` uses `noteUrl`'s property list for the URL; the capture-id lookup is unchanged.
  - `recapture()` and the `recapture` command's `checkCallback` use `noteUrl(file)`.
  - `propertyNames()` (used to decide whether to rebuild the index) includes `this.settings.urlProperty`.
  - Make `vaultProperties()` public, as plugin code reads it from `settings.ts`.
- [ ] T011 In `plugin/src/main.ts`, add `rebuildIndex()`: it clears the index by removing every indexed path, or by reassigning a new `DedupIndex` (make `index` non-readonly if needed), then calls `buildIndex()`. Call it from `onExternalSettingsChange` in place of `buildIndex()`.
- [ ] T012 In `plugin/src/settings.ts`, add the **URL property** setting after "Assets folder", per [contracts/commands-and-settings.md](contracts/commands-and-settings.md):
  - a text input with a `PropertySuggest` over `plugin.vaultProperties()`;
  - on pick or blur: trim, fall back to `"source"`, save, call `plugin.rebuildIndex()`, and redraw the description;
  - under the description, one muted line per template whose `urlPropertyName` differs from the setting: "Template *Name* saves the URL in `prop`; those notes are found too."

**Checkpoint**: With the setting changed to `link`, notes with only `source` drop out of dedup at once; changing it back restores them (quickstart scenario 1). Tests pass.

---

## Phase 3: User Story 1 - Merge copies of one page (Priority: P1) 🎯 MVP

**Goal**: From the active note, merge its copies into one note, with combined properties, appended bodies and redirected links.

**Independent Test**: Quickstart scenarios 2–4 and 6 (with every note on Keep/Merge).

### Tests for User Story 1

- [ ] T013 [P] [US1] Create `plugin/test/merge.test.ts` for ranking and dispositions:
  - `rankNotes`: more backlinks first; `hasCaptureId` breaks ties; then earlier `date`, with null last; then earlier `ctime`;
  - `initialDispositions`: the top-ranked note is keep, the rest merge, and notes in `separate` are separate;
  - `setDisposition`: making X keep demotes the old keep to merge; demoting the keep promotes the next-ranked non-separate note; exactly one keep always holds while two or more notes aren't separate.
- [ ] T014 [P] [US1] Add `describe("mergeChoices")` to `plugin/test/merge.test.ts`:
  - equal values fold to settled;
  - a value in one note only is settled;
  - `tags: "foo"` + `tags: ["bar","baz"]` → list `["foo","bar","baz"]` (kept note first);
  - list items are deduplicated with `same`;
  - a scalar conflict gives options in note order, each with `from`;
  - object values are compared fully, not as `[object Object]`;
  - `exam`/`Exam` fold into the kept note's spelling, with the other spelling in `variants`;
  - when the kept note has neither spelling, the `spelling()` result is used;
  - URL and capture-id names are skipped case-insensitively;
  - empty everywhere: omitted, unless the kept note has the key (FR-011b).
- [ ] T015 [P] [US1] Add `describe("mergePlan / applyMergedProperties / appendBodies")` to `plugin/test/merge.test.ts`:
  - the picks choose the conflict values;
  - `remove` lists the variant spellings;
  - aliases get the removed basenames, deduplicated case-insensitively against existing `aliases` (a string or a list);
  - empty bodies are dropped;
  - `appendBodies` adds `# A\n\nAlpha` after the body in listed order, with one blank line between parts and the frontmatter unchanged.
- [ ] T016 [P] [US1] Create `plugin/test/links.test.ts`:
  - `spliceSpans` applies several spans on one line from the end, and throws on overlapping spans;
  - `redirectedLink`, with a fake `generate` that returns `[[B${sub}|${alias}]]`:
    - `[[A]]` → alias `A`;
    - `[[A#H|x]]` → sub `#H`, alias `x`;
    - an embed `![[A]]` keeps the leading `!`;
    - a Markdown link `[x](A.md#H)` keeps `#H` and `x`;
  - `redirectFrontmatter`: a matching string value is replaced, a matching list item is replaced, a non-matching value is untouched, and it returns whether anything changed.

### Implementation for User Story 1

- [ ] T017 [P] [US1] Create `plugin/src/merge.ts` with the types `Disposition`, `MergeNote`, `PropertyChoice` and `MergePlan` from [data-model.md](data-model.md), and implement `rankNotes`, `initialDispositions`, `setDisposition` and `countsAsDuplicate` per [contracts/merge-module.md](contracts/merge-module.md). Make T013 pass.
- [ ] T018 [US1] In `plugin/src/merge.ts`, implement `mergeChoices(notes, skip, spelling)` using `isEmpty`, `asList` and `same` from `./values`. Group keys by `toLowerCase()`, and follow the rules in data-model.md "PropertyChoice". Make T014 pass.
- [ ] T019 [US1] In `plugin/src/merge.ts`, implement three functions:
  - `mergePlan(input)`;
  - `applyMergedProperties(frontmatter, plan)`: delete `plan.properties.remove`, set `plan.properties.set`, and set `aliases` (as a list) when the plan adds any;
  - `appendBodies(text, plan, frontmatterEnd)`: build `{ item: { kind: "text", text: "# " + heading + "\n\n" + body }, heading: null, position: "append" }` rows and pass them to `placeContent` from `./enrich`.

  Make T015 pass.
- [ ] T020 [P] [US1] Create `plugin/src/links.ts` with `spliceSpans`, `redirectedLink` and `redirectFrontmatter` per the contract, using no Obsidian imports. `redirectedLink` takes `{ original, link, displayText, embed }`; subpath = the text from the first `#` in `link`; alias = `displayText` when `original` contains `|` or is a Markdown link `[text](…)`, else `removedBasename`; it returns `(embed ? "!" : "") + generate(subpath, alias)`. Make T016 pass.
- [ ] T021 [US1] Create `plugin/src/merge-modal.ts` with `export class MergeModal extends Modal`.
  - **Constructor**: `(app, group: { url: string; notes: MergeNote[]; separate: string[] }, handlers: { onMerge(plan-inputs), onSkip?(): void, unusedCount(state): number })`. Use `rowLine`, `smallSelect`, `clipped` and `sectionHead` from `./modal-ui`.
  - **Rows and controls**:
    - the title is the URL (`wordBreak: "break-all"`);
    - each note row has the basename (bold; clicking opens it with `app.workspace.openLinkText(path, "", "tab")`), a muted `folder · N links` line, and a select whose options for this story are Keep / Merge;
    - a conflict row has the property name and a select of `preview(value) — basename` options, with the full value in each option's `title`;
    - a muted line counts the automatically combined properties.
  - **Button**: label per the contract (`Merge N notes into “Name”`), disabled when nothing would change.
  - **Recompute**: on every select change, recompute `setDisposition` and `mergeChoices` and redraw the property and button sections only.
- [ ] T022 [US1] In `plugin/src/main.ts`, add `private mergeGroup(key: string): MergeNote[]`. It builds a `MergeNote` per `index.paths(key)` file:
  - `frontmatter` from the cache;
  - `backlinks` from one pass over `metadataCache.resolvedLinks` (count the sources per target in the group);
  - `hasCaptureId` from `this.templates.map(captureIdPropertyName)`;
  - `date` from the first parseable `created` / `date` / `captured` (`window.moment` or `Date.parse`);
  - `ctime` from `file.stat.ctime`.

  Also add `private propertySpelling(): (lower: string) => string | undefined`, which counts key spellings across `getMarkdownFiles()` frontmatter and returns the most common spelling.
- [ ] T023 [US1] In `plugin/src/main.ts`, add `private async applyMerge(key, plan): Promise<void>`, implementing research R10 steps 1–4 and 6 (Separate marks and file removal come in US2 and US4):
  1. Re-resolve the group; abort with a notice if any path in the plan no longer exists.
  2. `processFrontMatter(kept, fm => applyMergedProperties(fm, plan))`.
  3. Read each Merge body (`vault.cachedRead`, sliced at `getFrontMatterInfo().contentStart`), then `vault.process(kept, text => appendBodies(text, plan, getFrontMatterInfo(text).contentStart))`.
  4. For each removed path, collect the sources from `resolvedLinks`, including the kept note. Per source, build spans from the cache's `links` and `embeds` that `getFirstLinkpathDest(parseLinktext(link).path, source)` resolves to a removed file, using `redirectedLink` with `generate = (sub, alias) => fileManager.generateMarkdownLink(keptFile, source, sub, alias)`. Apply them with one `vault.process(source, t => spliceSpans(t, spans))`. Rewrite `frontmatterLinks` with `processFrontMatter` + `redirectFrontmatter`. Count the links redirected.
  6. `fileManager.trashFile` each removed note.

  Stop at the first failure and show the partial-failure notice from the contract. On success, show the result notice and open the kept note.
- [ ] T024 [US1] In `plugin/src/main.ts`, register the command `merge-duplicates` / "Merge duplicates of this note". The `checkCallback` is true when the active file is Markdown and `index.paths(index.keyOf(file.path))` has two or more entries. On run, open `MergeModal` with `mergeGroup(key)`, `settings.separateNotes?.[key] ?? []`, and `onMerge` → `applyMerge`.

**Checkpoint**: Quickstart scenarios 2, 3, 4 and 6 pass with Keep/Merge only. The MVP is usable.

---

## Phase 4: User Story 2 - Keep notes that share a URL on purpose (Priority: P1)

**Goal**: Mark notes Separate, remember the marks across devices and renames, and leave those notes out of duplicate checks.

**Independent Test**: Quickstart scenario 7.

### Tests for User Story 2

- [ ] T025 [P] [US2] Add to `plugin/test/merge.test.ts`:
  - `countsAsDuplicate`: 4 paths with 2 separate → true; 3 separate → false;
  - `setDisposition`: marking every note separate leaves no keep; un-marking one when no keep exists makes it keep;
  - `mergePlan` returns `separate` paths.

### Implementation for User Story 2

- [ ] T026 [US2] In `plugin/src/merge-modal.ts`:
  - add the Separate option to each note's select;
  - when fewer than two notes aren't separate, the primary button reads `Save`;
  - the plan passed to `onMerge` includes the separate paths.
- [ ] T027 [US2] In `plugin/src/main.ts`, add `private async saveSeparate(key: string, paths: string[]): Promise<void>`:
  - set `settings.separateNotes[key] = paths`, or delete the key when the list is empty;
  - prune every key's paths that no longer exist (`vault.getAbstractFileByPath`), removing keys left empty (FR-025);
  - `persist()`.

  Call it in `applyMerge` as step 5 (after redirecting links, before trashing). When the plan has no Merge or Delete notes (a Save), only call `saveSeparate` and show "Saved."
- [ ] T028 [US2] In `plugin/src/main.ts`, update the existing `vault.on("rename")` handler: after `index.rename`, replace `oldPath` with `file.path` in every `settings.separateNotes` list. If anything changed, `persist()` (FR-024).

**Checkpoint**: Quickstart scenario 7 passes.

---

## Phase 5: User Story 3 - Find every duplicate in the vault (Priority: P2)

**Goal**: A vault-wide, searchable list of duplicate groups, resolved one after another.

**Independent Test**: Quickstart scenario 8.

### Implementation for User Story 3

- [ ] T029 [US3] In `plugin/src/merge-modal.ts`, add `export class DuplicateListModal extends SuggestModal<DuplicateGroupEntry>`, where `DuplicateGroupEntry = { key, url, names: string[], active: number }`.
  - Sort by `active` (descending), then by `url`.
  - `getSuggestions` matches every query word against the URL and names (reuse `filterSources`-style matching inline).
  - `renderSuggestion`: the URL in bold with `wordBreak: break-all`, and the names joined by " · " in muted text.
  - `onChooseSuggestion(entry)` calls the handler.
- [ ] T030 [US3] In `plugin/src/merge-modal.ts`, `MergeModal` shows a **Skip** button when `handlers.onSkip` is given. Skip closes the modal and calls `onSkip`.
- [ ] T031 [US3] In `plugin/src/main.ts`, register the command `find-duplicates` / "Find duplicate bookmarks".
  - Build the entries from `index.groups()`, keeping those where `countsAsDuplicate(paths, separateNotes[key] ?? [])`.
  - If there are none: `new Notice("No duplicate bookmarks.")`.
  - Otherwise open `DuplicateListModal`. Choosing an entry opens `MergeModal` in queue mode: after `applyMerge`, Save or Skip, it opens the next entry in the sorted list that still counts as a duplicate.

**Checkpoint**: Quickstart scenario 8 passes.

---

## Phase 6: User Story 4 - Delete copies and clean up their files (Priority: P2)

**Goal**: Delete junk copies without keeping their content, and trash files that only removed notes used.

**Independent Test**: Quickstart scenario 5, then scenario 6 with a Delete note.

### Tests for User Story 4

- [ ] T032 [P] [US4] Add `describe("unusedFiles")` to `plugin/test/merge.test.ts`:
  - a file linked by a note outside the removed set is kept;
  - a file in `carried` is kept;
  - Markdown targets are never included;
  - a file linked only by a Delete note is included;
  - a file linked only by two removed notes is included once.
- [ ] T033 [P] [US4] Add to `plugin/test/merge.test.ts`: `mergePlan` leaves Delete notes' bodies and properties out of `bodies` and `mergeChoices`, but includes their basenames in `aliases`.

### Implementation for User Story 4

- [ ] T034 [US4] In `plugin/src/merge.ts`, implement `unusedFiles(input)` per the contract. Make T032 and T033 pass.
- [ ] T035 [US4] In `plugin/src/merge-modal.ts`:
  - add the Delete option;
  - add the toggle "Remove N files only removed notes use" (on by default, shown only when `handlers.unusedCount(state) > 0`);
  - the button label appends ` · delete N` and ` · remove N files`;
  - the toggle state is passed in the plan inputs.
- [ ] T036 [US4] In `plugin/src/main.ts`, add `private unusedFor(key, state, picks): string[]`, which calls `unusedFiles` with:
  - `linksFrom` = `Object.keys(resolvedLinks[path] ?? {})`;
  - `linkedBy` = sources from one inverted pass;
  - `isNote` = an `.md` extension check;
  - `carried` = the targets in the Merge notes' body `links`/`embeds`, plus the `frontmatterLinks` whose key's chosen value came from that note.

  Pass `state => unusedFor(...).length` as `unusedCount`. In `applyMerge`, add step 7: when the toggle is on, recompute `unusedFor` from the fresh caches and `trashFile` each file, counting them in the result notice.

**Checkpoint**: Quickstart scenarios 5 and 6 pass, including file cleanup. Scenario 11 (failure order) passes.

---

## Phase 7: User Story 5 - Resolve duplicates when saving a page again (Priority: P3)

**Goal**: A **Merge duplicates** action on the "Already saved" notice.

**Independent Test**: Quickstart scenario 9.

### Implementation for User Story 5

- [ ] T037 [US5] In `plugin/src/main.ts`, extract the merge-modal opening from T024 into `private openMerge(key: string, queue?: …)`, and use it from both commands.
- [ ] T038 [US5] In `plugin/src/main.ts` `alreadySavedNotice`, after "Save as new", add `action("Merge duplicates", () => this.openMerge(key))` when `countsAsDuplicate(index.paths(key), separateNotes[key] ?? [])`, where `key = index.keyOf(path)`.

**Checkpoint**: Quickstart scenario 9 passes.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T039 [P] Update `README.md` step 3 ("Capture from Obsidian"):
  - describe **Bookmarks: Find duplicate bookmarks** and **Merge duplicates of this note** (Keep / Merge / Delete / Separate, links redirected, unused files trashed), and the **Merge duplicates** notice action;
  - add **URL property** to the plugin settings sentence.
- [ ] T040 [P] Update `docs/superpowers/specs/2026-09-18-obsidian-bookmarks-design.md`. In §4 "Match (later)" and decision 7, note that Merge shipped (link to `specs/001-merge-duplicate-bookmarks/spec.md`) and that the URL property is a plugin setting.
- [ ] T041 Run `npm test -w plugin && npm run typecheck -w plugin && npm run build -w plugin` and confirm all pass.
- [ ] T042 Walk through every scenario in `specs/001-merge-duplicate-bookmarks/quickstart.md` in a scratch vault, including scenario 10 (phone width). Record any failures as new tasks.
- [ ] T043 Run the "Real vault check" from `quickstart.md`. Once the user confirms the plugin covers it, suggest removing the vault's `_templater/duplicate-bookmarks.md` (the user decides).

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies.
- **Phase 2 (Foundational)**: after Phase 1. Blocks every story.
- **Phase 3 (US1)**: after Phase 2. This is the MVP.
- **Phases 4 (US2), 5 (US3) and 6 (US4)**: after US1, because each adds to `merge-modal.ts` and `applyMerge`. They're independent of each other, but they touch the same files, so do them one after another.
- **Phase 7 (US5)**: after US1. If US2 is done, `countsAsDuplicate` respects the marks; without it, the marks list is just empty.
- **Phase 8 (Polish)**: after the stories you're shipping.

### Within each story

The tests ([P]) are written first and fail; then the pure module (`merge.ts`, `links.ts`), then the modal, then `main.ts` glue.

### Parallel opportunities

- **Phase 1**: T001 ∥ T002 (T002's `isEmpty` import waits on T001).
- **Phase 2**: T004 ∥ T005 ∥ T006 ∥ T007 ∥ T009. Then T008 → T010 → T011 → T012.
- **US1**: T013 ∥ T014 ∥ T015 ∥ T016 (tests); T017 ∥ T020 (separate modules); T018 → T019 after T017. T021 can start after T017; T022 → T023 → T024.
- **US4**: T032 ∥ T033.
- **Polish**: T039 ∥ T040.

## Parallel Example: User Story 1

```text
# Tests together:
T013 merge.test.ts (rank/dispositions)
T014 merge.test.ts (mergeChoices)        # same file: write sequentially or as one edit
T016 links.test.ts

# Pure modules together:
T017 plugin/src/merge.ts
T020 plugin/src/links.ts
```

## Implementation Strategy

### MVP first (User Story 1)

1. Phase 1 → Phase 2 → Phase 3.
2. Stop and check quickstart scenarios 1–4 and 6.
3. This can ship as a release on its own: Keep/Merge, combined properties, redirected links, and the URL property setting.

### Incremental delivery

1. MVP (US1).
2. Add US2 (Separate). Recommended before the first real-vault use, given the Tai Chi group.
3. Add US3 (vault-wide list).
4. Add US4 (Delete and file cleanup).
5. Add US5 (notice action).
6. Polish; release through the usual `scripts/set-version.mjs` flow.

## Notes

- 43 tasks; each `[P]` task touches a different file from the tasks it runs alongside.
- Commit after each task or logical group, on branch `001-merge-duplicate-bookmarks`.
- No server or `api.ts` changes, so `API_VERSION` stays the same.
- Don't port code from `_templater/duplicate-bookmarks.md`. It informed the behaviour only.
