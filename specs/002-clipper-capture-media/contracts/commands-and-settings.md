# Contract: commands, modals and settings

## Commands

| id | Name | Available when | Change |
|---|---|---|---|
| `capture-url` | Capture URL | always | new modal (below) |
| `enrich` | Update note from source | active `.md` note with a bookmark URL | new modal; id kept so hotkeys survive |
| `download-media` | Download media for current note | active `.md` note | **new** |
| `recapture` | Capture current bookmark again | — | **removed**; folded into Update as Replace whole note |
| `sync-captures`, `merge-duplicates`, `find-duplicates` | — | unchanged | — |

- The ribbon icon still opens Capture URL.
- `obsidian://bookmarks?action=retry&path=…` opens Update note from source with
  the Replace whole note preset.

## Shared modal shell (`clip-modal.ts`)

Top to bottom, as CSS classes in `styles.css` (`bookmarks-clip-*`):

1. **Header**: template `<select>` (borderless, full width) and the "changed" dot
   (`bookmarks-clip-changed`, `aria-label="Changed from template"`).
2. **URL row** (Capture URL only): text input with a status line under it
   (fetching… / already saved: *name* · Open / error + Retry).
3. **Note name**: auto-growing single-line textarea, Enter blocked.
4. **Properties**: `metadata-properties-heading` with a chevron, then rows using
   Obsidian's `metadata-property` / `metadata-property-key` /
   `metadata-property-icon` / `metadata-property-value` classes.
   - The collapsed state is kept in `localStorage`
     (`bookmarks-properties-collapsed`).
   - Update from source adds to each row a "now: …" line, a keep / replace / merge
     select, and remove (×); plus "+ Add property", using the vault property
     picker.
5. **Body**: textarea filling the rest. Update from source shows a keep / append
   / replace segmented control instead, with a "Preview changes" diff for
   replace.
6. **Footer**:
   - folder input with `AbstractInputSuggest` over vault folders (Capture) or a
     "Rename and move to match template" toggle (Update);
   - split button: main `mod-cta` button plus chevron, whose menu is an Obsidian
     `Menu` with icons.

**States**: Capture URL fetching shows empty rows (no shimmer, as in Web
Clipper); Update before Fetch shows the current values with a Fetch button in
the body area.

**Mobile**: under 400 px the property key column narrows to 7.5em and the
footer wraps the folder above the button. Nothing scrolls sideways.

## Split button actions

| Action | Label | Effect |
|---|---|---|
| `add` | Add | write note (R10), request remaining screenshot files with `finish: true`, open note |
| `add-media` | Add and download media | `add`, then run Download media on the new note with every item ticked and no picker |
| `copy` | Copy markdown | copy `---\n<yaml>\n---\n<body>` (tokens removed); release the page |
| `new` | Save as new | `add` even though the URL is saved (menu only, when `existing`) |

The main button shows `template.onCapture ?? "add"`. The menu lists the others.
The choice is per capture and isn't remembered.

## Update from source actions

- **Main button**: Apply.
- **Menu**: Replace whole note, which sets every property to replace and the body
  to replace, shows the diff, then applies.
- **Cancel / Escape**: closes the modal and releases the page.

## Download media modal

- **Title**: "Download media".
- **List**: one row per media item, each with:
  - a checkbox (ticked);
  - a preview thumbnail (48×48, `object-fit: cover`) or a type icon;
  - the label: "TikTok video", "TikTok photo 3", "TikTok cover", "YouTube video",
    or the image file name;
  - where it is: "In note" / "Property: thumbnail".
- **Footer**: Cancel, Download (`mod-cta`). Progress shows as "Downloading 2 of 5…"
  in the button, with each row getting ✓ or ⚠ (with a reason on hover/tap).
- The modal can be closed while downloading; the work continues, and a closing
  Notice summarizes: "Downloaded 4 of 5. 1 failed: TikTok photo 3 (post
  unavailable)."
- **Nothing found**: Notice "There's no media to download in this note." No
  modal.

## Settings tab

| Setting | Change |
|---|---|
| Assets folder | **replaced** by **Attachment folder override**: empty placeholder "Use Obsidian's attachment setting"; description names the current Obsidian setting; folder suggestions |
| others | unchanged |

## Server settings UI (template editor)

- New select **On capture**: Add / Add and download media / Copy markdown, next to
  "Show in Update from source".
- **Property types**: read-only list, labelled "Synced from your vault's property
  types".
