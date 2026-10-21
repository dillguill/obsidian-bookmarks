# Contract: server API changes (API_VERSION 8)

All endpoints keep today's bearer-token auth and JSON error shape (`{ error }`).
`/health` reports `apiVersion: 8`. The plugin refuses any other version
(FR-046, existing `checkServer`).

## POST /capture (changed)

The body gains `mode`:

```json
{ "url": "https://…", "origin": "plugin", "template": "TikTok", "files": [], "mode": "preview",
  "propertyTypes": [{ "name": "tags", "type": "multitext" }] }
```

- `mode`: `"full"` (default, today's behaviour) or `"preview"` (research R1).
- `preview` requires `origin` `plugin` or `enrich`; `wait` is ignored for it.
- `propertyTypes` (optional): the vault's types for this render, overriding the
  stored list.
- Reply `202 { job }`. The plugin polls `GET /jobs/:id` until `assets` includes
  `note` (typically 2–5 s), or the job fails.
- `files` with `preview` is rejected (`400`): files are requested on the held page.

## POST /jobs/:id/render (new)

Re-renders a held preview with another template.

- **Request**: `{ "template": "Default" }`
- **200**: `{ "note": RenderedNote }`. The job's `note` asset is replaced and
  `heldUntil` is extended.
- **410**: `{ "error": "page released" }`. The page is no longer held; the plugin
  starts a new preview.
- **404**: unknown job. **409**: the job is not a preview.

## POST /jobs/:id/files (new)

Takes files on the held page.

- **Request**: `{ "files": ["screenshot_page", "screenshot_banner"], "finish": true }`
- **202**: `{ job }`. The files appear in `assets` as they're made; with
  `finish: true` the page is released afterwards and the job becomes `done`, so
  drain delivers it.
- With `finish: false` (Update from source picking a screenshot), the page stays
  held and the job stays `running`.
- Only screenshot/PDF kinds are accepted (`400` otherwise); media goes through
  `/media`.
- **410** as above.

## POST /jobs/:id/release (new)

- **Request**: `{ "keep": false }`
  - `keep: false` (modal closed without Add): the page is released and the job
    discarded.
  - `keep: true` (Added with no files): the job becomes `done`, so drain
    acknowledges it.
- **200** `{}`. Idempotent; releasing an already-released job is `200`.

## POST /media (new)

Queues a media download.

- **Request**:
  ```json
  { "url": "https://www.tiktok.com/@x/video/123", "want": ["video", "cover"], "origin": "plugin" }
  ```
- **202** `{ job }`, with `origin: "media"` and `media: MediaJobInfo`.
- **Validation**:
  - `url` passes `urlRejection` (SSRF);
  - `want` is a non-empty subset of `video` / `photos` / `cover`;
  - video-site URLs need yt-dlp.
- Media jobs are listed by `GET /jobs?origin=media&status=done,failed`. They are
  not returned by the default drain listing.
- **How each item is fetched**:
  - videos (TikTok, YouTube, X, Vimeo, Instagram) and their covers: yt-dlp;
  - TikTok photo posts: the post is loaded in the browser;
  - a TikTok URL that yt-dlp reports as a slideshow falls back to the browser
    within the same job.
- A job is `done` when every wanted item was made or recorded in `media.errors`;
  it is `failed` only if nothing could be fetched at all. Partial success is
  `done` with errors.

## GET /jobs/:id/asset/:kind (changed)

`kind` also accepts `media_video`, `media_cover` and `media_photo_1`…`media_photo_35`.

## Background captures (behaviour)

A `full` capture whose template has `onCapture: "add-media"` and whose origin is
`shortcut` / `bookmarklet` / `share` / `api` queues `POST /media` for the
capture's final URL as soon as it finishes. The capture job's
`media.followUp: <media job id>` lets the plugin's drain match the two.

## PUT /settings (changed)

- Accepts `onCapture` on templates and `schemaRevision`.
- `propertyTypes` is accepted from the plugin's sync. The settings UI no longer
  edits it; it shows the list with "from your vault".
