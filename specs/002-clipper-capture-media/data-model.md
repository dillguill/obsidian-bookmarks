# Data model: Clipper-style capture and media download

Types are shown as TypeScript-ish shapes. `api.ts` changes are mirrored in
`plugin/src/api.ts` and `harness/src/api.ts`; `API_VERSION` goes 7 → 8.

## ClipperTemplate (changed)

```ts
interface ClipperTemplate {
  // …existing Web Clipper fields, triggers, updateFromSource…
  /** What the capture modal's main button does; missing = "add". Not Web Clipper's format. */
  onCapture?: "add" | "add-media" | "copy";
}
```

- **Validation**: any other value is dropped when the settings are parsed.
- **Migration**: the server sets `"add-media"` once on templates using media
  variables (research R8).

## CaptureSettings (changed)

```ts
interface CaptureSettings {
  templates: ClipperTemplate[];
  /** Pushed from the vault's types.json by the plugin (R7); the server UI shows it as read-only. */
  propertyTypes: PropertyTypeEntry[];
  hideCaptureId?: boolean;
  /** Settings migrations applied so far (R8). */
  schemaRevision?: number;
}
```

## Job (changed)

```ts
type CaptureMode = "full" | "preview";
type JobOrigin = CaptureOrigin | "media";   // "media" jobs never reach drain as bookmarks

interface Job {
  // …existing…
  mode: CaptureMode;               // default "full" (background captures, older plugin calls)
  /** While a preview page is held: when it will be released if untouched. */
  heldUntil: string | null;
  /** media jobs only */
  media?: MediaJobInfo;
}
```

**Lifecycle of a preview job**:

```
pending → running ──note published──▶ held ──files requested──▶ running ──▶ done ──▶ delivered
                                       │  ▲ render (same state)
                                       │  └───────────────┘
                                       ├──release / TTL / pool full──▶ done (no files) ──▶ delivered
                                       └──cancel──▶ failed("cancelled")
```

- `held` is reported as status `running` with `heldUntil` set; there is no new
  status value, so older readers keep working.
- A preview job is drained only if it was Added (the plugin calls `files` or
  `release` with `keep: true`); otherwise it is discarded on release.

## RenderedNote (changed)

- `variables` becomes required.
- The extra variable `{{template}}` (the template's name) becomes available to
  every template.

## PendingInsert (new, plugin data)

```ts
interface PendingInsert {
  captureId: string;
  notePath: string;          // updated on rename, like separate marks (001)
  kind: CaptureFile;
  where:
    | { in: "body"; before: string; after: string; embed: boolean }   // ≤120 chars each side
    | { in: "property"; name: string; expression: string };           // e.g. "[[{{screenshot_banner}}]]"
}
```

- **Stored** as `settings.pendingInserts: PendingInsert[]`.
- **Removed** when its file is inserted, when the job fails or the file is missing
  from the finished job, or when the note is deleted.
- **Rule**: an insert is applied at most once (remove first, then write).

## PropertyField (new, modal state)

```ts
interface PropertyField {
  name: string;
  type: "text" | "multitext" | "number" | "checkbox" | "date" | "datetime" | "tags" | "aliases";
  /** As shown and edited (lists as comma-separated text). */
  text: string;
  /** Template's value expression, for screenshot tokens (R2) and "changed" detection. */
  expression: string;
  edited: boolean;
}
```

- **Type**: from the vault (R7), else the template property's type, else `text`.
- **"Changed" mark** (FR-012): shown when any field has `edited`, the body was
  edited, or the note name or folder changed.

## ClipDraft (new, Capture URL modal state)

```ts
interface ClipDraft {
  url: string;
  template: string;
  jobId: string | null;        // the held preview
  noteName: string;
  properties: PropertyField[];
  body: string;                // capture-file markers shown as {{kind}} tokens
  folder: string;              // starts as the template's path
  action: "add" | "add-media" | "copy" | "new";   // starts as template.onCapture ?? "add"
  existing: string | null;     // path of a note already saved for this URL
}
```

## UpdateDraft (replaces EnrichSelection)

```ts
interface UpdateDraft {
  template: string;
  jobId: string | null;
  properties: Record<string, { mode: "keep" | "replace" | "merge"; target: string; remove?: boolean }>;
  added: PropertyChoice[];                       // from the vault property picker
  body: "keep" | "append" | "replace";
  renameMove: boolean;
  preset: "template" | "replace-all";
}
```

- `merge` is only allowed where either side is a list.
- `remove` is only offered for properties the new template doesn't have.

## MediaItem (new)

```ts
type MediaKind = "tiktok_video" | "tiktok_photo" | "tiktok_cover" | "site_video" | "image";

interface MediaItem {
  kind: MediaKind;
  /** Exact text in the note that the saved file replaces (iframe, ![](…), property value). */
  source: { in: "body"; text: string } | { in: "property"; name: string; value: string };
  /** What to fetch: the post/page URL for server items, the image URL for images. */
  url: string;
  index?: number;              // tiktok_photo N
  preview: string | null;      // thumbnail URL for the picker
  via: "plugin" | "server";
}
```

- **Grouping**: a TikTok post yields either its video or its photos, plus the
  cover; all items for one post share a single server job.
- **Order**: as found in the note; the bookmark URL's items come first.

## MediaJobInfo (new, server)

```ts
interface MediaJobInfo {
  url: string;                                    // post or video page
  want: ("video" | "photos" | "cover")[];
  /** Filled as files are made: asset name → original item, e.g. "media_photo_3". */
  made: { asset: string; kind: MediaKind; index?: number; bytes: number }[];
  errors: { kind: MediaKind; index?: number; message: string }[];
}
```

- **Assets**: `media_video` (mp4), `media_cover` (jpg/png), `media_photo_N`.
  `JOB_PATH` in `app.ts` is extended to serve them.
- **Queue**: concurrency 1; at least 5 s (+0–3 s jitter) between two jobs with
  the same registrable host.

## Settings (plugin, changed)

| Key | Change |
|---|---|
| `assetsFolder` | removed after migration |
| `attachmentFolder` | new, `""` = Obsidian's attachment setting |
| `pendingInserts` | new, see above |
| `propertiesCollapsed` | not a setting: per-device `localStorage` (FR-004) |
