# Contract: pure modules (tested with vitest)

Obsidian-free, like `enrich.ts` and `merge.ts`. The controllers call them inside
`vault.process` / `processFrontMatter`.

## `placeholders.ts` (new)

```ts
/** Rendered text with capture-file markers → text with {{kind}} tokens, for the modal. */
export function markersToTokens(text: string): string;

/** Tokens the user left in, in order of appearance. */
export function tokensIn(text: string): CaptureFile[];

/** Removes tokens (and [[ ]]/![[ ]] around them) and records where each one was. */
export function extractTokens(body: string): { body: string; anchors: { kind: CaptureFile; before: string; after: string; embed: boolean }[] };

/** Inserts a saved file's link at its anchor: before-anchor, else after-anchor, else end of note. */
export function insertAt(text: string, anchor: PendingInsert["where"] & { in: "body" }, link: string): string;
```

**Tests**:
- round-trip markers → tokens → extract;
- an anchor still found after edits elsewhere in the note;
- an anchor that is gone → appended at the end;
- two tokens with the same anchor keep their order;
- frontmatter left alone.

## `media.ts` (new)

```ts
export function findMedia(text: string, frontmatter: Record<string, unknown>, bookmarkUrl: string | null): MediaItem[];
export function videoSite(url: string): "youtube" | "x" | "vimeo" | "instagram" | null;
export function imageName(url: string, contentType: string | null, disposition: string | null): { base: string; ext: string };
/** Replaces one item's source with the saved file's link; unchanged (and reports false) when the source is gone. */
export function replaceSource(text: string, item: MediaItem, link: string): { text: string; replaced: boolean };
```

**Tests**:
- TikTok player → video, or photos with N items, plus cover;
- YouTube iframe, `![](https://youtu.be/…)` and a bookmark URL → one item;
- a plain YouTube link → none;
- `![a](https://…/x.webp)` → image;
- a frontmatter image URL → property item;
- a data: URI → image;
- the same URL twice → one item;
- a replaced source is gone after `replaceSource`;
- naming follows the native rules.

## `fields.ts` (new)

```ts
export function vaultTypes(typesJson: string | null): Record<string, PropertyField["type"]>;
export function fieldsFrom(note: RenderedNote, template: ClipperTemplate, types: Record<string, PropertyField["type"]>): PropertyField[];
export function frontmatterFrom(fields: PropertyField[]): Record<string, unknown>;   // typed values for processFrontMatter
export function splitList(text: string): string[];                                   // wikilink-aware, as Web Clipper
```

**Tests**:
- `types.json` parsing, including a missing or invalid file;
- list split with `[[a, b]]` inside;
- number, checkbox and date coercion;
- an empty value is dropped, not written as `""`;
- a screenshot-token property stays out of the frontmatter.

## `enrich.ts` (trimmed)

- **Removed**: `ENRICH_FILES`, `ON_DEMAND_FILES` (screenshots are picked from the
  template's kinds), drag-only helpers (`placementOrder`, `samePlacement` if
  unused) and heading targets.
- **Kept**: `enrichChoices`, `defaultSelection` (now returns `UpdateDraft`),
  `applyProperties`, `replaceTikTokPlayer` (used by `media.ts`'s rewrite), and
  `offlineFiles`, which moves into `media.ts`.
- **New**: `applyBody(text, newBody, mode)` and `replaceAllPreset(choices)`.

## Harness

- **`capture.ts`** splits into:
  - `page.ts`: load, quiet, scroll, overlays, images wait (one helper, used twice
    today);
  - `shots.ts`: screenshots and PDF;
  - `media.ts`: yt-dlp runner (videos and covers, TikTok included), the TikTok
    photo-post fetch with `imageFile`, and the slideshow fallback; `videoFile` is
    deleted.
- **`PagePool`** (`pool.ts`): `hold(jobId, context, page)`, `get`, `release`,
  TTL timer, a max of 3 pages.
- **`MediaQueue`** (`media-queue.ts`): FIFO with concurrency 1 and per-host
  spacing; testable with a fake clock.
