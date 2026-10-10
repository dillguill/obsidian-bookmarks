# Quickstart: validating "Merge duplicate bookmarks"

## Automated

```sh
npm install
npm test -w plugin        # includes merge.test.ts, links.test.ts, dedup.test.ts
npm run typecheck -w plugin
npm run build -w plugin
```

Expected: everything passes. The test matrix is in
[contracts/merge-module.md](contracts/merge-module.md).

## Manual (test vault)

**Setup**: Use a scratch vault, not the real one. Copy `plugin/main.js` and
`manifest.json` into `<vault>/.obsidian/plugins/obsidian-bookmarker/`, enable
the plugin and open its settings. The server isn't needed for this feature.

Fixture notes (all frontmatter `source:`):

| Note | source | Other |
|---|---|---|
| `A.md` | `https://www.example.com/page?utm_source=x` | `tags: foo`, `status: read`, body "Alpha", embeds `![[a.png]]` |
| `B.md` | `http://example.com/page/` | `tags: [bar]`, `status: todo`, `Exam: 1`, body "Beta", embeds `![[b.png]]` |
| `C.md` | `https://example.com/page` | `exam: 2`, body "Gamma", embeds `![[c.png]]` |
| `Linker.md` | — | `[[B]]`, `[[C#Heading\|see C]]`, `![[B]]` |
| `Linker2.md` | — | `[[B]]` (so `B` has the most notes linking to it) |
| `Other.md` | — | `![[c.png]]` |
| `S1.md`, `S2.md`, `S3.md` | `https://section.example/page` | intentional group |

Plus `a.png`, `b.png`, `c.png`.

### Scenarios

1. **URL property setting (FR-002)**: In settings, type `sou` in URL property;
   `source` is suggested. Change it to `link` and run "Find duplicate
   bookmarks": "No duplicate bookmarks." Change it back to `source`: both groups
   are listed. No restart needed.
2. **Grouping (US1, SC-001)**: Open `A`; "Merge duplicates of this note" is in
   the palette. Open `Linker`; the command isn't offered.
3. **Default Keep (FR-009)**: Open the merge view from `A`. `B` is Keep (most
   links), and `A` and `C` are Merge.
4. **Properties (FR-011, FR-011a)**:
   - `tags` isn't asked about, and the summary line mentions it.
   - `status` shows `read — A` and `todo — B`.
   - `exam` / `Exam` show as one property with `1 — B` and `2 — C`.
5. **Delete + files (US4)**: Set `C` to Delete. The button reads
   `Merge 2 notes into “B” · delete 1`. There's no file toggle, because
   `c.png` is used by `Other`. Set `A` to Delete too: the toggle appears for one
   file (`a.png`). Set `A` back to Merge.
6. **Apply (US1)**: Pick `status: read` and `Exam: 2` and press Merge. Expect:
   - `B` has `tags: [bar, foo]`, `status: read`, one `Exam: 2` key,
     `aliases: [A, C]`, its body "Beta", then `# A` with "Alpha" and `![[a.png]]`;
     there's no `# C`.
   - `Linker` reads `[[B|B]]` (or `[[B]]`), `[[B#Heading|see C]]`, `![[B]]`.
     None of its links are unresolved (SC-002).
   - `A.md` and `C.md` are in `.trash`. `c.png` is still there (used by
     `Other`).
   - `B` opens, and the notice gives the counts.
7. **Separate (US2)**: Open `S1`, mark all three notes Separate and press Save.
   "Find duplicate bookmarks" no longer lists the group (SC-004). Rename `S2`;
   it's still marked (check `data.json` → `separateNotes`). Add `S4.md` with the
   same source: the group is listed again, with only `S4` unmarked.
8. **Queue (US3)**: With two groups listed, pick the first and press Skip; the
   second opens. Close it; nothing changed.
9. **Notice (US5)**: With a duplicate group present, capture its URL with
   "Capture URL" (needs the server). The "Already saved" notice has
   **Merge duplicates**.
10. **Phone (FR-013, SC-006)**: Repeat 3–6 in the mobile app, or with the
    desktop window narrowed below 400 px: nothing scrolls sideways, and the
    selects wrap under the names.
11. **Failure order (FR-021)**: Make `C.md` read-only on disk, then merge. The
    kept note is written and links are redirected; the notice says `C` couldn't
    be trashed; `C` still exists.

## Real vault check

After the scratch vault passes, run "Find duplicate bookmarks" in the real
vault. Check that the Brisbane Chen Tai Chi clippings appear as one group.
Mark the section notes Separate, and look at `Rooting – initial stage (August
2011)`, which carries the "Skill Knowledge" title.
