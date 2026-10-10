# Research: Merge duplicate bookmarks

Each item resolves a question the spec left to planning. All Obsidian API
references were checked against `node_modules/obsidian/obsidian.d.ts` (1.13.1).

## R1. Redirecting links to a removed note (FR-018)

**Decision**: For each removed note, find the notes linking to it from
`metadataCache.resolvedLinks` (source → target → count). In each source, take
the `links` and `embeds` whose `getFirstLinkpathDest(parseLinktext(link).path, source)`
is the removed note. Replace their text spans (`position.start.offset` …
`end.offset`), from the end backwards, with
`fileManager.generateMarkdownLink(kept, source, subpath, alias)`:

- an embed gets a `!` prefix;
- `subpath` is the original `#heading` / `#^block`;
- `alias` is the original display text. A plain `[[Removed]]` gets the removed
  note's basename as its display text, so what the reader sees doesn't change.

The edit is one `vault.process(source, …)` per source note. The span splicing is
a pure function in `links.ts`.

**Rationale**: `generateMarkdownLink` follows the user's link settings
(wikilink or Markdown, shortest or relative path), which covers the spec's
"keep the vault's link format" assumption. Resolving through
`getFirstLinkpathDest` matches Obsidian's own resolution, so links to a
same-named note in another folder aren't touched.

**Alternatives considered**:
- Renaming the removed note onto the kept path, so Obsidian updates links
  itself: impossible, because the path exists.
- Aliases only: these don't resolve links (the original bug).
- A regex over the text for `[[Name]]`: misses Markdown links and relative
  paths, and can hit text inside code.

## R2. Links in frontmatter

**Decision**: `CachedMetadata.frontmatterLinks` gives `{ key, link, original }`
with no position. Rewrite them in `processFrontMatter`: under that key, replace
a string value (or list item) equal to `original` with the new link. Pure helper
in `links.ts`.

**Rationale**: Without positions there's nothing to splice. Matching the exact
original string inside the right key is precise enough, and
`processFrontMatter` is the only safe way to write YAML.

**Alternatives considered**: Splicing raw YAML text (fragile with quoting).

## R3. URL property suggestions (FR-002)

**Decision**: Add `PropertySuggest extends AbstractInputSuggest<string>` (public
since 1.4.10). It's attached to the setting's text input and offers
`plugin.vaultProperties()`, which already exists in `main.ts` and is made public.
Choosing a name saves it and rebuilds the index (FR-002b).

**Rationale**: It reuses the existing property list. `AbstractInputSuggest` is
the public API that Obsidian's own pickers are built on, and it works on mobile.

**Alternatives considered**:
- A dropdown of every property: thousands of entries are unusable on a phone.
- `metadataTypeManager` / `getAllPropertyInfos`: not public API.

## R4. Backlink counts for the Keep ranking (FR-008, FR-009)

**Decision**: One pass over `metadataCache.resolvedLinks` when a group opens,
counting the source notes per target for that group's paths only.

**Rationale**: `getBacklinksForFile` isn't public. A single pass is
O(total links), which is milliseconds at this vault's size, and only runs when
the view opens.

## R5. Files only removed notes use (FR-019)

**Decision**:
- **Candidates**: the non-Markdown targets in `resolvedLinks[removed]` for every
  removed (Merge or Delete) note.
- **Kept**: a candidate is kept if any note outside the removed set links to it
  (from `resolvedLinks`), or if it still appears after the merge. That means it's
  referenced by a Merge note's body (appended to the kept note) or by a property
  value chosen from a Merge note.
- **Counting**: computed when the view renders, so the button can show the
  count. Recomputed at apply time from fresh caches.
- Files go to `fileManager.trashFile`, which follows the user's trash setting
  (FR-020).

**Rationale**: It uses only the link index, so no file reads, and it errs
towards keeping: any reference anywhere keeps the file.

**Alternatives considered**: Only files under the plugin's assets folder. That
would miss pasted images, and the link check already makes it safe.

## R6. Where the URL property and Separate marks live

**Decision**: Both go in `data.json`, beside `templatesCache` and
`writtenCaptures`:

```ts
urlProperty: string;                        // default "source"
separateNotes: Record<string, string[]>;    // normalized URL -> paths
```

**Rationale**:
- These describe the vault, not how pages are captured, so they belong to the
  plugin, not the server.
- `data.json` syncs with the vault (iCloud here), and `onExternalSettingsChange`
  already reloads it.
- Agreed with the user, including that a stale path just means marking a note
  again.

**Alternatives considered**:
- Server-side shared settings: the server has no reason to know vault paths.
- A note property: the user preferred clean notes.

## R7. One URL lookup (FR-002a)

**Decision**: Add `urlPropertyNames(setting, templates)` in `template.ts`. It
returns the setting first, then each template's `urlPropertyName`, deduplicated.
`main.ts` gets one `noteUrl(frontmatter)` that takes the first of those
properties that normalizes to an http(s) URL. That function is used by
`indexFile`, `recapture`, the `recapture` command's check, `enrich` and the
merge. This removes the hard-coded `url` / `source` / `URL` list. The
capture-id property names stay as they are.

**Rationale**: Today there are three slightly different lookups (`indexFile`,
`recapture`, `noteUrl`). FR-002a requires one.

## R8. Case-insensitive property names (FR-011a)

**Decision**: In `mergeChoices`, group frontmatter keys by `key.toLowerCase()`.
The spelling comes from the kept note's key, else the vault's most common
spelling. `main.ts` passes a `spelling(lower)` lookup built from the same pass
as `vaultProperties()`. When applying, the variant keys are deleted from the
kept note before the chosen spelling is set.

**Rationale**: The user's vault has `exam`/`Exam` and `sku`/`SKU`. YAML keys are
case-sensitive, so without this a merge could leave both keys.

## R9. Phone layout (FR-013)

**Decision**: No table. Notes are listed with `rowLine` (name and folder on the
left; disposition `smallSelect` on the right, wrapping underneath on narrow
screens). Each conflicting property gets one `rowLine` with a `smallSelect` of
values labelled `value — note name`. Full values show in the option's `title`,
and the select itself shows the full text on mobile. The group list is a
`SuggestModal`, which is searchable and native on mobile.

**Rationale**: The same pattern as the update modal's mobile rows (PR #29), and
it reuses `modal-ui.ts`.

## R10. Merge order and failure handling (FR-021)

**Decision**: `applyMerge` runs these steps in order and stops at the first
failure, reporting what was done:

1. Re-read the group from the caches; abort if a note is gone.
2. `processFrontMatter(kept)`: combined values, case variants removed, aliases.
3. `vault.process(kept)`: append bodies (the Merge notes' bodies are read with
   `vault.cachedRead` just before).
4. Redirect links in each source note, including the kept note and the Merge
   bodies that are now inside it.
5. Save the Separate marks.
6. Trash the removed notes.
7. Trash the unused files.

Redirecting links before trashing means that if trashing fails, links are
already correct and the removed notes simply still exist.

**Rationale**: Every step that could lose data comes after the steps that
preserve it.
