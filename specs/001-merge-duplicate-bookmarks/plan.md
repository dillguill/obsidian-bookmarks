# Implementation Plan: Merge duplicate bookmarks

**Branch**: `001-merge-duplicate-bookmarks` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-merge-duplicate-bookmarks/spec.md`

## Summary

Find notes that point at the same page using the plugin's existing in-memory
`DedupIndex`. Let the user mark each note Keep / Merge / Delete / Separate,
resolve conflicting properties, and apply the merge:

1. write the kept note's properties and appended bodies;
2. redirect every link to the removed notes;
3. trash the removed notes and the files only they used.

Notes marked Separate are remembered in plugin data. A new **URL property**
setting, with suggestions from the vault's property names, replaces the
hard-coded URL fallbacks, so every URL lookup reads the same properties.

The merge rules are pure functions in `merge.ts`, tested like `enrich.ts`. The
Obsidian side (the modals and the `main.ts` glue) stays thin. The row helpers
are moved out of `enrich-modal.ts`, and the duplicated value helpers
(`isEmpty`, `asList`, `same`) are put in one module so the new code doesn't add
a third copy.

## Technical Context

**Language/Version**: TypeScript ~5.9, ES2022 (bundled by esbuild)

**Primary Dependencies**: `obsidian` API 1.13 (minAppVersion 1.11.4); no new packages

**Storage**: Vault notes (frontmatter + body) and the plugin's `data.json` (`saveData`, synced with the vault)

**Testing**: vitest (`npm test -w plugin`) for the pure modules; manual checks in a test vault for the modal and vault glue (see [quickstart.md](quickstart.md))

**Target Platform**: Obsidian desktop and mobile (`isDesktopOnly: false`)

**Project Type**: Obsidian plugin, part of the existing monorepo (`plugin/`). The server (`harness/`) is untouched.

**Performance Goals**: Duplicate list in under 1 s for 10,000 notes (SC-007). Grouping is a walk over the index (O(indexed notes)). Backlink counts take one pass over `metadataCache.resolvedLinks`.

**Constraints**:
- No vault scan or file reads to find duplicates (FR-004).
- Nothing is trashed before the kept note is written and links are redirected (FR-021).
- Usable at phone width (FR-013).

**Scale/Scope**: About 2,600 notes with a `source` URL in the user's vault. Groups are small (2–10 notes).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

There's no `.specify/memory/constitution.md`. The gates below come from the
design doc (`docs/superpowers/specs/2026-09-18-obsidian-bookmarks-design.md`)
and the code base's conventions.

| Gate | Pre-design | Post-design |
|---|---|---|
| **Plugin is the sole vault writer** (design §2, decision 5). The server never touches notes. | ✅ The merge is entirely in the plugin and needs no server. | ✅ |
| **Dedup key is the normalized URL, computed, not stored** (§4, decision 7) | ✅ Reuses `normalizeUrl` and `DedupIndex`. | ✅ Separate marks are keyed by the normalized URL but don't change it. |
| **Vault logic is Obsidian-free and unit-tested** (`enrich.ts`, `writer.ts` pattern) | ✅ `merge.ts` and `links.ts` are pure. | ✅ See [contracts/merge-module.md](contracts/merge-module.md). |
| **Shared settings live on the server; per-device settings stay local** (§8) | ⚠️ The URL property and Separate marks are vault data, not capture settings. | ✅ Both go in `data.json` (synced with the vault, like `templatesCache`). The server's templates still own their URL property names. See research R6. |
| **No redundant code** (the user's request) | ✅ Reuses `DedupIndex`, `placeContent`, `vaultProperties`, the row helpers and the value helpers. | ✅ The Templater script's scan, folder exclusions, generic modal and conflict footer are dropped. |

## Project Structure

### Documentation (this feature)

```text
specs/001-merge-duplicate-bookmarks/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── commands-and-settings.md   # user-facing contract
│   └── merge-module.md            # pure-module API used by main.ts and tests
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code

```text
plugin/src/
├── values.ts          NEW   isEmpty / asList / same, shared (moved from enrich.ts; enrich-modal's differing isEmpty removed)
├── modal-ui.ts        NEW   rowLine / smallSelect / clipped / preview / sectionHead / iconButton (moved from enrich-modal.ts)
├── merge.ts           NEW   pure: groups, keep ranking, dispositions, property choices (case folding), merged frontmatter, appended body, unused files
├── links.ts           NEW   pure: rewrite link/embed spans in text, rewrite frontmatter link values
├── merge-modal.ts     NEW   DuplicateListModal (SuggestModal of groups) + MergeModal (resolve one group)
├── property-suggest.ts NEW  AbstractInputSuggest over the vault's property names (for the URL property setting)
├── dedup.ts           EDIT  + keyOf(path), paths(key), groups() (groups with more than one note)
├── template.ts        EDIT  + urlPropertyNames(setting, templates): the one ordered list every lookup reads
├── settings.ts        EDIT  + urlProperty, separateNotes; URL property setting with PropertySuggest and template notice
├── enrich.ts          EDIT  import value helpers from values.ts
├── enrich-modal.ts    EDIT  import row helpers from modal-ui.ts
└── main.ts            EDIT  one noteUrl(); index uses it; 2 commands; "Merge duplicates" notice action; applyMerge(); rename keeps marks

plugin/test/
├── merge.test.ts      NEW
├── links.test.ts      NEW
└── dedup.test.ts      NEW   groups / keyOf / rename
```

**Structure Decision**: This is a single-package change inside `plugin/`,
following the existing split. Rules go in pure modules (like `enrich.ts`), the
UI in a modal file (like `enrich-modal.ts`), and the Obsidian calls in
`main.ts`. No server, API or `api.ts` changes, so `API_VERSION` stays the same.

## Phase summary

- **Phase 0** → [research.md](research.md): link rewriting, frontmatter links,
  property suggestions, backlink counts, unused-file detection, where settings
  live, case folding, mobile layout.
- **Phase 1** → [data-model.md](data-model.md),
  [contracts/](contracts/), [quickstart.md](quickstart.md).
- **Phase 2** → `/speckit-tasks`. Suggested order:
  1. values/modal-ui moves (no behaviour change; tests stay green)
  2. URL property setting and a single `noteUrl()`
  3. `DedupIndex` groups
  4. `merge.ts` + `links.ts` with tests
  5. modals
  6. `applyMerge`
  7. Separate marks
  8. notice action
  9. README

## Complexity Tracking

No gate violations. Nothing to justify.
