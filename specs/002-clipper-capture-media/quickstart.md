# Quickstart: validating Clipper-style capture and media download

## Prerequisites

- A test vault with the dev plugin linked (`npm run dev -w plugin`).
- A local server (`npm run dev -w harness`), or the Docker image built from this
  branch (`docker compose build`). The Docker image is needed for yt-dlp; check
  `GET /health` shows `apiVersion: 8` and `media.ytdlp`.
- Templates:
  - **Default**, with `{{screenshot_banner}}` in the body;
  - **TikTok**, from `docs/templates/tiktok.json`, edited to use
    `{{tiktok_save}}`, which migration turns into `onCapture: add-media`.
- In the vault, set **Settings → Files and links → Default location for new
  attachments** to "In subfolder under current folder" (`attachments`), and
  leave the plugin's override empty.

## Automated

```sh
npm test            # plugin + harness vitest: placeholders, media, fields, enrich, pool, media-queue
npm run typecheck
```

## Manual scenarios

Each scenario lists its steps, then the expected result. Spec references are in
brackets.

**1. Capture URL fills before Add** [US1, SC-001]
- Copy an article URL, run Capture URL.
- Expect: the URL is prefilled and the rows appear at once; values fill within
  ~5 s.
- Edit a tag and one body line, select Add.
- Expect: the note opens in under 1 s with both edits, and has no banner embed
  yet.

**2. Screenshot arrives later** [US3, SC-004]
- Continuing from 1, wait for the banner screenshot.
- Expect: `attachments/<note>-banner.jpg` exists next to the note, and its embed
  sits where `{{screenshot_banner}}` was. No broken embed was ever shown.
- Repeat, deleting the `{{screenshot_banner}}` token in the modal.
- Expect: no banner screenshot is taken.

**3. Template switch without reload** [FR-010, SC-003]
- Capture a TikTok URL; after it fills, switch to Default.
- Expect: the fields refill in under 2 s, and the server log shows no second
  page load.
- Edit a field, then switch.
- Expect: a confirm prompt.

**4. Presets** [US2]
- Capture a TikTok post.
- Expect: the main button reads "Add and download media".
- Choose Add from the menu.
- Expect: the note has the TikTok player and the server queues no media job.
- Capture another with the default action.
- Expect: the note appears with the player, which is then replaced by the saved
  `.mp4`.

**5. Already saved** [FR-015]
- Capture the same URL again.
- Expect: "Already saved: *name* · Open", and "Save as new" in the menu.

**6. Update from source** [US4, SC-002]
- On an older TikTok note, run Update note from source.
- Expect: current values are shown and nothing is fetched (server log).
- Select Fetch.
- Expect: current → new per row, and no media job or TikTok asset requests.
- Apply a replaced `author` and a kept body.
- Expect: only `author` changes.

**7. Replace body with preview** [FR-025]
- Choose Replace for the body, then Preview changes.
- Expect: a line diff; applying matches the diff.

**8. Change template and rename** [US6]
- Switch the template and tick Rename and move.
- Expect: properties the new template lacks are listed as kept with remove off;
  after applying, the note is renamed and moved, and a backlink in another note
  still resolves.

**9. Retry link** [FR-027]
- Click a failed capture's "Retry capture" link.
- Expect: Update opens with Replace whole note chosen.
- The command palette has no "Capture current bookmark again".

**10. Download media** [US5, SC-005]
- Make a note with a TikTok player, a YouTube iframe, a `![](https://…png)` and
  `cover: https://…jpg`. Run Download media and untick the PNG.
- Expect: the player and iframe are replaced by `![[…mp4]]`, `cover` becomes
  `[[…jpg]]`, and the PNG line is unchanged.
- Run it again.
- Expect: only the PNG is offered.

**10b. TikTok video vs photo post** [R4]
- Run Download media on a TikTok video note, then on a photo-post note.
- Expect: the server log shows yt-dlp (no page load) for the video and its
  cover, and a browser page load for the photos. The photo note gets every
  photo, not an mp3.
- Run it on a photo post saved under a `/video/` URL.
- Expect: yt-dlp reports a slideshow and the job falls back to the browser.
- In the container, `yt-dlp --list-impersonate-targets` lists at least one
  target.

**11. Partial failure** [FR-039]
- Use a private TikTok post plus one good image.
- Expect: the image is replaced, and the Notice names the TikTok failure.

**12. Rate spacing** [SC-006]
- Use "Add and download media" on 10 TikTok URLs quickly.
- Expect: the server log shows media jobs one at a time with ≥5 s between them,
  and all succeed.

**13. Phone capture** [US7]
- With Obsidian closed, share a TikTok post via the Shortcut, then open Obsidian.
- Expect: the note is written first, and the player is replaced once the media
  job's files are delivered.

**14. Attachment migration** [FR-044]
- On a vault with the old `assetsFolder: Bookmarks/assets`, upgrade.
- Expect: the override shows `Bookmarks/assets` and new files still go there.
- On a fresh vault.
- Expect: the override is empty and files follow Obsidian's setting.

**15. Vault property types** [FR-003]
- Set `rating` to Number in Obsidian's Properties view, and use a template with
  `rating`.
- Expect: the modal row shows the number icon and input, and the note's YAML has
  a number. The server UI lists `rating: number` "from your vault".

**16. Mobile** [FR-005, SC-007]
- On a phone (or a narrow window under 400 px), run scenarios 1, 6 and 10.
- Expect: no sideways scroll; the footer wraps; the menu opens.
