# Data model: Merge duplicate bookmarks

## Persisted (plugin `data.json`)

Added to `BookmarksSettings` (`plugin/src/settings.ts`):

| Field | Type | Default | Rules |
|---|---|---|---|
| `urlProperty` | `string` | `"source"` | Trimmed and non-empty; an empty value falls back to the default. A change rebuilds the index. |
| `separateNotes` | `Record<string, string[]>` | `{}` | Key: a normalized URL (`normalizeUrl`). Value: vault paths marked Separate. Paths are moved on rename. On save, paths that no longer exist are dropped, as are keys with no paths left (FR-025). |

Both are shared through `data.json` like `templatesCache`. Neither is
per-device.

## In memory

### DedupIndex (existing, extended)

`byUrl: Map<key, Set<path>>` already exists. Added:

- `keyOf(path) → key | null`
- `paths(key) → string[]`
- `groups() → { key, paths }[]`, only keys with more than one path

### DuplicateGroup

| Field | Type | Notes |
|---|---|---|
| `key` | string | normalized URL |
| `url` | string | a display URL (the first note's raw value) |
| `notes` | `MergeNote[]` | every note for the key |

A group **counts as a duplicate** when the notes not in
`separateNotes[key]` number two or more (FR-003).

### MergeNote

| Field | Type | Source |
|---|---|---|
| `path`, `basename`, `folder` | string | `TFile` |
| `frontmatter` | `Record<string, unknown>` | metadata cache |
| `backlinks` | number | R4 |
| `hasCaptureId` | boolean | any template's capture-id property is set |
| `date` | number \| null | first parseable `created` / `date` / `captured` |
| `ctime` | number | `file.stat.ctime` |

### Disposition

`"keep" | "merge" | "delete" | "separate"`

**Invariant (FR-010)**: when two or more notes aren't Separate, exactly one is
`keep`.

| Event | Effect |
|---|---|
| Group opens | Notes in `separateNotes` → `separate`. The rest: the top-ranked (FR-009) → `keep`, others → `merge`. |
| User sets X to `keep` | Previous keep → `merge` |
| User sets the keep note to `merge` / `delete` / `separate` | The next-ranked note that isn't separate → `keep` (if any) |
| User sets X from `separate` to something else, and no note is keep | X → `keep` |
| Fewer than two notes aren't separate | No keep is required; the action is **Save** (marks only) |

Ranking (FR-009): more backlinks, then `hasCaptureId`, then earlier `date`
(null last), then earlier `ctime`.

### PropertyChoice

Built from the Keep and Merge notes only (FR-011). URL and capture-id
properties are excluded (FR-012).

| Field | Type | Notes |
|---|---|---|
| `name` | string | the spelling to write (R8) |
| `variants` | string[] | other spellings to delete from the kept note |
| `kind` | `"settled" \| "list" \| "conflict"` | |
| `value` | unknown | settled: the value; list: the union in note order, deduplicated with `same()` |
| `options` | `{ value, from: path }[]` | conflict only: one per distinct value, in note order |

How the kind is decided:
- **empty everywhere** → omitted, unless the kept note has the property (then
  it's settled with the kept note's empty value) (FR-011b)
- **one distinct non-empty value** → settled
- **any note's value is an array** → list (single values are wrapped with
  `asList`)
- **otherwise** → conflict

The default pick is the kept note's value if it has one, else the first option.

### MergePlan (computed on Merge)

| Field | Type |
|---|---|
| `kept` | path |
| `merge`, `delete`, `separate` | path[] |
| `properties` | `{ set: Record<string, unknown>, remove: string[] }` |
| `aliases` | string[] (removed basenames, excluding any already present, compared case-insensitively) |
| `bodies` | `{ heading: string, body: string }[]` in listed order, with empty bodies dropped |
| `unusedFiles` | path[] (R5), empty when the option is off |

Separate marks are written as `separateNotes[key] = separate paths` (replacing
the old entry for that key). If the key's list ends up empty, the key is
removed.
