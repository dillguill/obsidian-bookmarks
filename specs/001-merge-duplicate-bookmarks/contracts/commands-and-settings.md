# Contract: commands, notice and settings

What the user sees and can rely on. Command ids are stable once released
(Obsidian keys hotkeys on them).

## Commands

| Id | Name | Available when | Does |
|---|---|---|---|
| `find-duplicates` | Find duplicate bookmarks | Always | Opens the group list, or shows the notice "No duplicate bookmarks." when no group counts as a duplicate. |
| `merge-duplicates` | Merge duplicates of this note | The active note is a Markdown file whose URL key has two or more notes, Separate or not | Opens the merge view for that group, with saved marks applied. |

## "Already saved" notice

Today's actions are **Open existing · Replace · Save as new**. A
**Merge duplicates** action is added when the URL's group counts as a duplicate.
It opens the merge view for that group.

## Group list

- A searchable list (`SuggestModal`), one entry per duplicate group, sorted by
  the number of notes not marked Separate (most first), then by URL.
- Each entry shows the display URL and the notes' basenames joined with " · ".
  The search matches either.
- Choosing an entry opens the merge view in **queue mode**. After Merge, Save
  or Skip, the next group in the list opens. Closing the merge view ends the
  queue.

## Merge view

Top to bottom:

1. **Title**: the display URL (wraps, never scrolls sideways).
2. **Notes**: one row per note:
   - left: the basename (bold) and the folder plus backlink count (muted), e.g.
     `Clippings · 3 links`;
   - right: a Keep / Merge / Delete / Separate select.
   - The basename opens the note in a new tab when clicked (desktop) or tapped
     (mobile).
3. **Properties**: listed only when there are conflicts. One row per conflict:
   the property name, and a select whose options read `<value> — <note basename>`.
   A single line below gives the count of combined properties, e.g.
   "4 properties combined automatically (tags, aliases, …)".
4. **Unused files**: a toggle, "Remove N files only removed notes use", on by
   default. Shown only when N > 0.
5. **Buttons**:
   - **Skip** (queue mode only).
   - The primary button, whose label follows the state:
     - `Merge 2 notes into “Name”` plus, when they apply, ` · delete 1` and
       ` · remove 3 files`;
     - `Save` when fewer than two notes aren't Separate;
     - disabled when nothing would change.

## Result notice

`Merged 2 notes into “Name”: 1 deleted, 7 links redirected, 3 files removed.`

On a partial failure it says `Merged into “Name”, but couldn't …:` followed by
the step and notes that weren't finished. Details go to the console.

## Settings

A new row is added to the existing settings tab, after "Assets folder":

- **URL property**: a text input with suggestions from the vault's property
  names. The default is `source`. Description: "The property that holds a
  note's web address. Used to find duplicates and to update notes from their
  source."
- When a template saves the URL in a different property, a muted line is added
  under the description: "Template *Name* saves the URL in `prop`; those notes
  are found too." There's one line per such property.
