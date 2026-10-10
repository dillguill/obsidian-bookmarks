# Feature Specification: Merge duplicate bookmarks

**Feature Branch**: `001-merge-duplicate-bookmarks`

**Created**: 2026-10-10

**Status**: Draft

**Input**: User description: "Bring the vault's duplicate-bookmarks Templater script into the plugin: find notes that point at the same page, and merge, delete or keep them apart, without copying the script's code or adding features the plugin already has."

## Background

The vault has a Templater script (`_templater/duplicate-bookmarks`) that groups
notes by an exact `source` string, lets the user mark each note Keep / Merge /
Delete, resolves conflicting properties, appends merged bodies to the kept note,
adds the removed names to `aliases` and trashes the rest. The plugin already
keeps a live index of notes by normalized URL, and "Update note from source"
already knows how to combine properties and place content. The design doc lists
**Merge** as planned dedup work (design §4, decision 7). This feature replaces
the script with a version that:

- finds duplicates the script misses (http vs https, `www.`, tracking params,
  trailing slashes, param order), reading the URL from a property the user picks
  in settings rather than a hard-coded `source`;
- keeps links working after a merge. Aliases don't do this: Obsidian resolves
  links by file name, so `[[Removed note]]` stops resolving once the note is
  trashed;
- cleans up screenshots and other files that only a removed note used;
- remembers notes that share a URL on purpose (one page with several sections,
  each clipped as its own note, like the Brisbane Chen Tai Chi "Skill Knowledge"
  clippings);
- works on a phone.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Merge copies of one page (Priority: P1)

The user has two or more notes for the same page, saved on different days or
devices, or with slightly different URLs. From the active note, they open the
merge view, see every note for that page, pick the note to keep, choose a value
for each property the notes disagree on, and merge. They're left with one note
holding the chosen properties and every merged note's content. Links that
pointed at the removed notes now point at the kept one.

**Why this priority**: This is the core value: one note per page without losing
content or breaking links. It works on its own from the active note, with no
vault-wide list.

**Independent Test**: Create three notes whose URLs differ only by `https`/`http`,
`www.` and a `utm_source` param, with different `tags` and `status`, plus a
fourth note that links to one of the copies. Run the command on one copy, merge
the other two into it, and check the result.

**Acceptance Scenarios**:

1. **Given** the active note shares its normalized URL with other notes, **When**
   the user runs "Merge duplicates of this note", **Then** a view lists every note
   for that URL, with the active note's group ready to resolve.
2. **Given** the active note is the only note for its URL, **When** the user opens
   the command palette, **Then** "Merge duplicates of this note" isn't offered.
3. **Given** the view is open, **Then** one note is marked Keep (see FR-009 for
   which) and the others are marked Merge.
4. **Given** the user marks a different note Keep, **Then** the note that was
   Keep becomes Merge, so exactly one note is always Keep.
5. **Given** notes have the same value for a property, or only one note has it,
   **Then** the property isn't offered as a choice and the kept note ends up with
   that value.
6. **Given** a property is a list in at least one note (e.g. `tags: foo` in one
   and `tags: [bar, baz]` in another), **Then** the kept note gets every item
   once (`[foo, bar, baz]`), without the user choosing.
7. **Given** notes disagree on a single-value property, **Then** the user picks
   one of the existing values, each labelled with the note it comes from, and
   the kept note gets that value. Its type never changes.
8. **Given** the user merges, **Then** each Merge note's body is appended to the
   kept note under a heading with that note's name, in the order the notes are
   listed.
9. **Given** another note links to or embeds a removed note (including links to
   its headings or blocks, and links with display text), **When** the merge
   finishes, **Then** the link points at the kept note at the same heading or
   block. Its visible text is unchanged: a link with no display text gets the
   removed note's name as display text.
10. **Given** the merge finishes, **Then** the removed notes are in Obsidian's
    trash, the removed names are added to the kept note's `aliases`, and a notice
    summarizes what changed.

---

### User Story 2 - Keep notes that share a URL on purpose (Priority: P1)

Some notes share a URL because each holds a different section of one page.
The user marks those notes **Separate**. They're never merged or deleted, and
they stop showing up as duplicates. A real duplicate in the same group can
still be merged.

**Why this priority**: Without it, every intentional group comes back on every
check, which makes the vault-wide list useless and invites a wrong merge. The
user's vault already has such a group.

**Independent Test**: Make four notes with one URL. Mark two Separate, and merge
one of the others into the last. Close the view and check for duplicates again.

**Acceptance Scenarios**:

1. **Given** the view is open, **Then** each note can be marked Keep, Merge,
   Delete or Separate.
2. **Given** some notes are marked Separate, **When** the user merges, **Then**
   those notes aren't changed, aren't relinked and aren't trashed, and the rest
   of the group merges as usual.
3. **Given** every note in a group, or all but one, is marked Separate, **Then**
   the user can save that choice without merging anything, and the group no
   longer counts as a duplicate.
4. **Given** notes were marked Separate, **When** a new note for that URL is
   added later, **Then** the group counts as a duplicate again and the new note
   is the only one not marked Separate.
5. **Given** a note marked Separate is renamed or moved in Obsidian, **Then** it
   stays marked Separate.
6. **Given** a group no longer counts as a duplicate, **When** the user runs
   "Merge duplicates of this note" on one of its notes, **Then** the view opens
   with the saved marks, and the user can change them.
7. **Given** the choice was saved on one device, **When** the vault syncs to
   another device, **Then** that device also treats the notes as Separate.

---

### User Story 3 - Find every duplicate in the vault (Priority: P2)

The user runs "Find duplicate bookmarks" and sees every group of notes that
share a page, then resolves them one at a time.

**Why this priority**: It finds duplicates the user doesn't know about, but it
needs Stories 1 and 2 to be useful.

**Independent Test**: With three duplicate groups in the vault (one fully marked
Separate), run the command, resolve one group, skip one, and check what's listed
afterwards.

**Acceptance Scenarios**:

1. **Given** the vault has duplicate groups, **When** the user runs "Find duplicate
   bookmarks", **Then** a list shows each group's URL and its notes' names, most
   notes first.
2. **Given** the vault has no duplicate groups, **When** the user runs the
   command, **Then** a notice says so and no view opens.
3. **Given** the list is open, **When** the user picks a group, **Then** it opens
   for resolving as in Story 1. When that group is merged, skipped or saved,
   **Then** the user is taken to the next unresolved group, or the view closes
   after the last one.
4. **Given** the user skips a group, **Then** nothing changes for it, and it's
   listed again next time.

---

### User Story 4 - Delete copies and clean up their files (Priority: P2)

Some copies are junk (a failed capture, an empty note). The user marks them
**Delete**: their content isn't kept, and the screenshots, PDFs and videos only
they used are removed along with them.

**Why this priority**: It keeps the assets folder from filling with files no
note shows. Merge alone covers the main need.

**Independent Test**: Two notes for one URL, each embedding its own screenshot,
plus a third note that also embeds the second note's screenshot. Delete the
second note and check which files remain.

**Acceptance Scenarios**:

1. **Given** a note is marked Delete, **When** the merge finishes, **Then** its
   body isn't added to the kept note, and its links are still redirected to the
   kept note (as in Story 1).
2. **Given** a removed note embeds or links files (images, PDFs, videos) that no
   other note in the vault uses, **Then** the merge button says how many files
   will be removed, and an option to remove them is on by default.
3. **Given** the option is on, **When** the merge finishes, **Then** those files
   are in Obsidian's trash.
4. **Given** another note also uses one of those files, or a Merge note's body
   brings its embed into the kept note, **Then** that file is never removed or
   counted.
5. **Given** the user turns the option off, **Then** no files are removed.

---

### User Story 5 - Resolve duplicates when saving a page again (Priority: P3)

When the user captures a URL that's already in the vault more than once, the
"Already saved" notice also offers **Merge duplicates**, which opens Story 1's
view for that URL.

**Why this priority**: Convenient, but the commands already reach the same view.

**Independent Test**: With two notes for a URL, capture that URL from the Capture
URL command and use the notice.

**Acceptance Scenarios**:

1. **Given** a captured URL already has two or more notes that aren't all marked
   Separate, **Then** the "Already saved" notice has a **Merge duplicates** action
   alongside Open existing, Replace and Save as new.
2. **Given** the URL has a single note, **Then** the notice is unchanged.

### Edge Cases

- **A note for the group changes while the view is open** (edited, renamed,
  deleted or synced in): when the user merges, the merge uses each note's
  current properties and content. If a note in the group no longer exists, the
  user is told and nothing is changed.
- **A step fails partway** (e.g. a file can't be trashed): steps already done
  stay done, the remaining notes aren't trashed, and the notice says which notes
  weren't finished. Nothing is ever trashed before the kept note has been
  written and links have been redirected.
- **A removed note links to itself, or to another note being removed**: those
  links end up pointing at the kept note.
- **The kept note links to a removed note**: the link points at the kept note
  itself, at the same heading if there is one.
- **A note has no frontmatter besides the URL**: it can still be merged. Its body
  is appended as usual.
- **A Merge note has an empty body**: no heading is added for it.
- **Notes in the group are in different folders**: the kept note stays where it
  is, with its name.
- **The URL is in different properties in different notes** (the URL property
  setting in some, a template's URL property in others): notes are grouped by
  the normalized URL, whichever property holds it. The kept note's own URL and
  capture id properties are kept, and those properties are never offered as
  choices.
- **The user changes the URL property setting to a property few notes have**:
  notes are grouped by the new property (plus templates' URL properties) at
  once. Notes that only had the old property drop out of dedup until the setting
  is changed back. Separate marks for them are kept, not dropped.
- **Property names that differ only by case** (`sku` in one note, `SKU` in
  another): combined as one property (FR-011a). The vault has a few of these
  today (`exam`/`Exam`, `sku`/`SKU`).
- **A conflicting value is an object or a long string**: it's shown shortened in
  the picker, with the full value on hover or long-press, and compared by its
  full value.
- **A marked note's path is stale in the saved choices** (renamed while the
  plugin was off, or by sync on another device): that note shows up in its group
  again, unmarked. Nothing breaks.
- **Saved choices refer to notes that no longer exist**: they're ignored and
  dropped the next time choices are saved.
- **Two devices save choices at the same time**: the plugin's usual settings
  handling applies. At worst, a note shows up unmarked again.

## Requirements *(mandatory)*

### Functional Requirements

**Finding duplicates**

- **FR-001**: The plugin MUST treat two notes as copies of one page when their
  URLs are the same after the normalization dedup already uses (host case and
  `www.`, scheme, fragment, tracking and bot-wall params, param order, trailing
  slash).
- **FR-002**: The plugin settings MUST have a **URL property** setting: a text
  input that suggests the vault's property names as the user types (like
  Obsidian's own property picker), defaulting to `source`. It's saved in the
  plugin's synced data, so every device uses the same property.
- **FR-002a**: Every lookup of a note's URL MUST read the same properties: the
  URL property setting first, then any template's URL property (so notes the
  plugin writes are always found). This applies to dedup, "Capture current
  bookmark again", "Update note from source" and this feature. The hard-coded
  `url` / `source` / `URL` fallbacks are removed.
- **FR-002b**: Changing the URL property setting MUST re-index the vault right
  away, without a restart.
- **FR-002c**: When a template writes the URL to a different property than the
  setting, the setting MUST say so under the input (e.g. "Template *Recipes*
  saves the URL in `link`; those notes are found too"), so the user knows both
  are read.
- **FR-003**: A group MUST count as a duplicate only while at least two of its
  notes aren't marked Separate.
- **FR-004**: Finding duplicates MUST NOT scan or read note files. It uses the
  index the plugin already keeps up to date.

**Commands and entry points**

- **FR-005**: The plugin MUST add a "Find duplicate bookmarks" command that lists
  every duplicate group (FR-003), or shows a notice when there are none.
- **FR-006**: The plugin MUST add a "Merge duplicates of this note" command,
  offered only when the active note shares its URL with at least one other note.
  It opens even when that group doesn't count as a duplicate (to change saved
  marks).
- **FR-007**: The "Already saved" notice MUST offer **Merge duplicates** when the
  URL's group counts as a duplicate.

**Resolving a group**

- **FR-008**: The view MUST show one row per note, with its name, folder, number
  of notes linking to it, and a Keep / Merge / Delete / Separate choice.
- **FR-009**: The note marked Keep at first MUST be the one most notes link to,
  then one with a capture id, then the one with the earliest date property
  (`created`, `date` or `captured`), then the earliest file creation time. A
  note marked Separate is never marked Keep at first.
- **FR-010**: Exactly one note that isn't Separate MUST be Keep whenever two or
  more notes aren't Separate. Marking another note Keep makes the previous one
  Merge. Marking the Keep note Separate makes the next-ranked note Keep.
- **FR-011**: Properties MUST be combined across the Keep and Merge notes as
  follows: equal values or a value in one note only → that value; a list in any
  note → every item once, in note order, compared by full value; differing
  single values → the user picks one of the existing values. Delete and Separate
  notes' properties are ignored.
- **FR-011a**: Property names that differ only by letter case (`exam` / `Exam`)
  MUST be treated as one property when combining. The kept note's spelling is
  used, or, if the kept note has neither, the spelling most notes in the vault
  use. After the merge, the kept note has only that spelling. Names that differ
  in any other way (`tag` / `tags`, `author` / `authors`) stay separate
  properties.
- **FR-011b**: A property that is empty in every Keep and Merge note MUST be kept
  as an empty property if the kept note has it, and not added if it doesn't.
- **FR-012**: The URL and capture id properties MUST never be offered or changed.
  The kept note keeps its own.
- **FR-013**: The view MUST be usable at phone width: no horizontal scrolling,
  with each note's and property's controls wrapping under their label.
- **FR-014**: The merge button MUST say what will happen, e.g. "Merge 2 notes into
  *Name* · delete 1 · remove 3 unused files". When only Separate marks changed,
  it says "Save".
- **FR-015**: In the vault-wide flow, the view MUST offer **Skip**, which changes
  nothing.

**Applying a merge**

- **FR-016**: The kept note's properties MUST be set to the combined values
  (FR-011), and the removed notes' names (Merge and Delete) added to its
  `aliases` once each, without duplicating existing aliases.
- **FR-017**: Each Merge note's body (without its frontmatter) MUST be appended to
  the kept note under a heading with that note's name, in listed order. Empty
  bodies add nothing.
- **FR-018**: Every link and embed in the vault that resolves to a removed note
  MUST be rewritten to resolve to the kept note. The heading or block it points
  at and the text it shows stay the same. Links inside merged bodies count too.
- **FR-019**: Files that removed notes link to or embed, and that no remaining
  note uses after the merge, MUST be offered for removal. The option is on by
  default and can be turned off for that merge.
- **FR-020**: Removed notes and files MUST go to Obsidian's trash (following the
  user's trash setting), never be deleted outright.
- **FR-021**: The merge MUST run in this order: write the kept note, redirect
  links, then trash notes and files. A failure stops the steps after it, and the
  notice names what wasn't done.
- **FR-022**: When the merge finishes, a notice MUST summarize it (notes merged,
  deleted, links redirected, files removed), and the kept note MUST open.

**Keeping notes separate**

- **FR-023**: Separate marks MUST be saved in the plugin's synced data, keyed by
  the normalized URL, so every device shares them.
- **FR-024**: A saved mark MUST follow its note when the note is renamed or moved
  in Obsidian.
- **FR-025**: Marks for notes that no longer exist MUST be dropped the next time
  marks are saved.

### Key Entities

- **Duplicate group**: the notes whose URLs normalize to the same key, plus that
  key. It counts as a duplicate while two or more notes aren't marked Separate.
- **Disposition**: what happens to a note in a merge: Keep (receives everything;
  exactly one), Merge (body and properties go into the kept note, then it's
  trashed), Delete (trashed, content dropped), Separate (left alone and
  remembered).
- **Property choice**: one property across the Keep and Merge notes. It's either
  settled (equal, only one value, or a list union) or a conflict with one option
  per distinct value, each tied to the note it came from.
- **Separate marks**: the saved list of notes, by normalized URL, that share a
  URL on purpose.
- **Unused file**: a file a removed note links to or embeds that no remaining
  note uses.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every pair of notes whose URLs differ only by scheme, `www.`,
  tracking params, param order, fragment or trailing slash is reported as a
  duplicate. The Templater script reports none of these unless the strings match
  exactly.
- **SC-002**: After a merge, the vault has zero unresolved links that pointed at
  a removed note before the merge.
- **SC-003**: After a merge with file removal on, no file that only the removed
  notes used is left, and no file that any remaining note uses is removed.
- **SC-004**: A group fully marked Separate is listed 0 times in later checks
  until a new note for its URL is added.
- **SC-005**: A two-note merge with no property conflicts takes at most two
  actions after the view opens: confirm the Keep note and press Merge.
- **SC-006**: The whole flow can be completed on a phone without horizontal
  scrolling.
- **SC-007**: The vault-wide list opens in under one second in a vault with
  10,000 notes.
- **SC-008**: The Templater script can be deleted. Nothing it did is lost, except
  its code block of unpicked values, which is deliberately left out.

## Assumptions

- The kept note's file name and location never change. Removed notes' names live
  on in `aliases` (for search and autocomplete) and in redirected links' display
  text.
- The script's code block of property values the user didn't pick is left out.
  Trashed notes keep those values and can be restored from the trash.
- The script's folder exclusions (Journals, attachments, templates, Chat, Inbox)
  aren't carried over. Only notes with a URL property are in the index, and notes
  that share a URL on purpose are marked Separate.
- Groups are resolved one at a time. No bulk "merge all".
- Merged bodies are appended at the end of the kept note. Placing them at a
  heading isn't offered (that's what "Update note from source" does).
- The notes' text and properties are only read from and written to the vault.
  The capture server isn't involved and doesn't need to be reachable.
- Separate marks are stored by note path in plugin data, not as a note property.
  A stale path only means marking a note again (agreed with the user).
- Rewritten links keep the vault's link format (wikilink or Markdown, shortest or
  full path), following the user's Obsidian link settings.
