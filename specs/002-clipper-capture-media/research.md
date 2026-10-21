# Research: Clipper-style capture and media download

Each entry: **Decision**, **Rationale**, **Alternatives considered**. References are
to the code as of `001-merge-duplicate-bookmarks` (b3e61cc).

## Prior art

- **Obsidian Web Clipper** (`obsidianmd/obsidian-clipper`, `src/core/popup.ts`,
  `src/styles/properties.scss`):
  - Layout: template select, note name textarea, collapsible `.metadata-properties`
    (rows are `.metadata-property` > `-key` (`-icon` + label) + `-value` input),
    content textarea, footer (vault, path, split `#clip-btn` + `#more-btn` menu).
  - Load order: rows render empty first (`buildTemplateFieldsSkeleton`), values
    are filled after extraction (`fillTemplateFieldValues`).
  - Values: every value is a text input except checkboxes; lists are
    comma-separated, split wikilink-aware when the frontmatter is generated.
  - Template switching rebuilds every field and loses edits; extraction is
    memoized for about 5 s.
  - Slow optional work (the interpreter) is a separate step.
- **Obsidian `editor:download-attachments`** (app.js, 1.14.4):
  - Finds only `![](http…)` / `data:` image nodes and top-level frontmatter
    strings that are image URLs.
  - Shows a checkbox gallery and downloads one item at a time.
  - Names files from the URL basename, else from `Content-Disposition`, else
    `Image.<ext from MIME>`; saves with `saveAttachment` (the user's attachment
    setting, ` 1`/` 2` suffixes).
  - Rewrites the body with `generateMarkdownLink` in `vault.process`, and
    frontmatter as `[[linktext]]`.
  - No per-item error handling: one failure stops the loop and the note is
    never rewritten.

## R1. Quick read with a held page

**Decision**: a new capture mode, `preview`. The server:
1. loads the page to `domcontentloaded`, waits for `load` (≤10 s) and a short DOM
   quiet period;
2. runs Defuddle and the TikTok item/transcript;
3. renders the note with Web Clipper's engine and publishes `markdown` + `note`;
4. keeps the browser context open in a `PagePool` instead of taking any files.

On the held page the plugin can then:
- **render** again with another template;
- request **files** (screenshots), which first does today's scroll / image wait /
  overlay hiding;
- **release** it.

Held pages expire after 120 s idle (each request refreshes the timer), and at
most 3 are held, oldest released first. A held page does not occupy a worker
slot.

**Rationale**:
- `run()` (`harness/src/capture.ts:475`) already publishes the note before
  screenshots via `progress.page`. The time before it goes to autoScroll and image
  waits (`:502-520`), which only matter for screenshots.
- Web Clipper's engine runs in the live page (`harness/clipper/entry.ts`), so
  re-rendering on the held page keeps selector/schema variables exact without a
  reload (SC-003).
- Holding the page also lets Update from source take an extra screenshot without
  a new page load. Today each extra screenshot is a whole new job
  (`enrich-session.ts:81`).

**Alternatives considered**:
- Re-render in the plugin from `note.variables` with the plugin's own renderer:
  diverges from Web Clipper filters and loses `selector:` variables.
- Cache the HTML and re-render in a fresh page: loses scripts' DOM state, needs a
  reload anyway.
- Keep one job per template switch (today's enrich behaviour): fails SC-003 and
  repeats the page load that causes rate limits.

## R2. Screenshots never block, never dangle

**Decision**:
- **In the modal**, each capture-file marker in the rendered note is shown as its
  template variable token (`{{screenshot_page}}`), so the user sees where it goes
  and can delete it to opt out.
- **On Add**, the plugin:
  1. writes the note with every token removed (and `[[ ]]`/`![[ ]]` around it,
     like `fillFiles`, `writer.ts:104`);
  2. records a **pending insert** per remaining token: capture id, note path, kind,
     and its anchor — for the body, up to 120 chars of text before and after; for
     a property, its name and the template's value expression (e.g.
     `[[{{screenshot_banner}}]]`);
  3. asks the held page for exactly those files.
- **When a file arrives** (through the existing drain), the plugin saves it and
  inserts it with `vault.process` at the before-anchor, else the after-anchor,
  else at the end; properties go through `processFrontMatter`. A failed file
  just drops its pending insert.

Pending inserts live in plugin data next to `writtenCaptures`. They are a
transient delivery queue (cleared on delivery or after the server's retention
period), not facts about the note.

**Rationale**:
- Meets FR-017–FR-019 without broken links (SC-004), and lets the template stay
  final until Add, so only the files the final note uses are taken.
- The queue has to survive a plugin restart, because a full-page screenshot can
  finish after Obsidian closes.

**Alternatives considered**:
- Reserve paths and write links at once (option A): leaves broken embeds for a
  while; rejected with the user.
- Wait for the screenshots on Add: brings back the slow path.
- Keep an invisible `%% %%` placeholder in the note: hidden state in the user's
  file; rejected.

## R3. Media variables when media isn't downloaded

**Decision**: in `preview` and background captures without media, the media
markers render to their remote forms instead of being made:

| Variable | Rendered as |
|---|---|
| `tiktok_save`, `tiktok_images`, `tiktok_video` | the TikTok player (`tiktok_embed`) |
| `tiktok_thumbnail` | the cover's remote URL |
| `image_local` | the page's `{{image}}` URL |

Download media then works on that note like on any other.

**Rationale**:
- Makes "Add and download media" literally "Add, then Download media", so there
  is one media path to build and test.
- Matches the spec: the note keeps the player or remote links until the files
  arrive.

**Alternatives considered**:
- Leave a placeholder for media: hidden state.
- Drop the media variables from templates: breaks existing templates (FR-033).

**Accepted cost**: a TikTok cover URL in a property expires within hours if media
is never downloaded. Download media lists that cover and fetches it again from
the post.

## R4. Finding and downloading media

**Decision**:
- **Scanning**: a pure `media.ts` scans the note text and frontmatter:
  - the TikTok player (existing `TIKTOK_PLAYER` regex), or a TikTok bookmark URL →
    video or photos, plus cover;
  - YouTube / X / Vimeo / Instagram iframes and `![](url)` embeds, or a bookmark
    URL on those hosts → video;
  - `![alt](http…)` images in the body;
  - frontmatter strings that are image URLs (native extensions list, plus TikTok
    CDN hosts).
  - Plain links are not media.
- **Remote images**: downloaded in the plugin with `requestUrl`, using the
  native naming rules (URL basename → `Content-Disposition` → `Image.<ext>`).
- **TikTok and video sites**: downloaded by a server **media job** (`POST /media`).
  - Media jobs run one at a time, with a 5 s (+0–3 s jitter) pause between two
    jobs for the same site.
  - **Videos, TikTok included, and their covers** run yt-dlp:
    `--no-playlist --max-filesize 300M -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4 --write-thumbnail --convert-thumbnails jpg`,
    in the job directory, with the URL checked by `urlRejection` first. No
    browser page is loaded.
  - **TikTok photo posts** reload the post in Playwright and reuse `tiktokItem`
    and `imageFile`. yt-dlp can't do these (see below).
  - **Telling them apart**: a `/photo/` URL, or a note whose TikTok player came
    from a photo post (the capture recorded `tiktok_image_count`), goes to the
    browser. Anything else goes to yt-dlp, and if yt-dlp reports a slideshow
    (audio-only result, `vcodec: none`), the job falls back to the browser for
    that post.
  - **Removed**: `videoFile` (`capture.ts:409`) and the video download after the
    capture timeout (`capture.ts:461-467`). Capture itself still reads the post
    in the browser for the `tiktok_*` variables.
- **Picker previews**: TikTok's oEmbed `thumbnail_url` (`oembedUrl` exists),
  `i.ytimg.com/vi/<id>/hqdefault.jpg`, and the image itself; none for X/Vimeo.
- **Rewriting**: per success, inside `vault.process`, the item's original source
  text is searched for again (so concurrent edits survive) and replaced:
  - body: `!` + `generateMarkdownLink(file, notePath)`;
  - properties: `[[linktext]]`, as the native command does.
  - A source that has disappeared keeps the file and is reported as "not in the
    note any more".
- **No second copies** (FR-041) needs no record: a replaced source is no longer
  found by the scan.

**Rationale**:
- Images don't need the server (native parity, works offline from it); TikTok
  needs a browser session, and yt-dlp is the maintained tool for the rest.
- One queue on the server is what spaces out requests per site (FR-037, SC-006).

**yt-dlp and TikTok** (checked against `yt_dlp/extractor/tiktok.py` on master
and yt-dlp 2026.08.19):
- Videos are supported, including the anti-bot challenge and format choice; the
  cover comes back as a thumbnail.
- Photo posts are not: `_VALID_URL` accepts only `/video/` URLs, and a slideshow
  reached through one returns just its music as an mp3 (the extractor's own
  "slideshow audio-only mp3 format" test). The post's image list is never read.

**Alternatives considered**:
- yt-dlp for all of TikTok: impossible for photo posts, as above.
- The browser for all of TikTok (the first draft of this plan): every video
  download loads a page, and we maintain the video download ourselves when TikTok
  changes.
- Download everything in the plugin: CORS-free on desktop, but TikTok needs
  cookies from the page session, and yt-dlp can't run on mobile.
- Call the native command for images: it can't be scoped or report per-item
  failures, and it uses an internal API.

## R5. yt-dlp and ffmpeg in the image

**Decision**:
- ffmpeg from apt (noble).
- yt-dlp pinned as the standalone `yt-dlp_linux` release binary, version and
  SHA-256 passed as build args and checked in the Dockerfile.
- Server config `BOOKMARKS_YTDLP_PATH` (default `yt-dlp` on PATH); `/health`
  reports `media: { ytdlp: version | null }`.
- Without yt-dlp, video items (TikTok videos included) fail with "video downloads
  aren't set up on the server", and the rest still works.
- **To verify when the image is built**: TikTok's challenge may need yt-dlp's
  browser impersonation (curl_cffi). The standalone Linux binary is believed to
  bundle it; check `yt-dlp --list-impersonate-targets` in the container, and
  download one TikTok video, before relying on it.

**Rationale**: a reproducible build; a local dev server without yt-dlp degrades
cleanly.

**Alternatives considered**:
- pip install: pulls in Python packaging, and the version drifts.
- A sidecar container: more compose plumbing for one binary.

## R6. Where files go

**Decision**:
- With no override, every capture file and media file is saved at
  `app.fileManager.getAvailablePathForAttachment(name, notePath)` (public API in
  obsidian 1.13.1 d.ts, `obsidian.d.ts:2967`). That follows "Default location for
  new attachments" and avoids collisions.
- File names stay as today: `<note>-banner.jpg`, `<note>-tiktok-video.mp4`, …
- When the new `attachmentFolder` setting is set, the plugin keeps today's
  `freePath` logic (`writer.ts:137`) in that folder.
- **Migration**: on load, if saved data has `assetsFolder` and no
  `attachmentFolder`, copy it over (an absent `assetsFolder` in saved data from an
  install that never changed it means the old default, `Bookmarks/assets`). New
  installs, with no saved data, start empty. `assetsFolder` is then dropped.
- The setting is renamed to "Attachment folder override". The empty state reads
  "Use Obsidian's attachment setting".

**Rationale**: FR-043–FR-045. Nothing moves for existing users.

**Alternatives considered**: always use Obsidian's setting (moves files for every
existing user); keep the plugin folder as the default (against the agreed
direction).

## R7. Property types from the vault

**Decision**:
- **Source**: read `${vault.configDir}/types.json` (`{ "types": { name: type } }`,
  Obsidian's own file) with `vault.adapter.read`, cached and re-read when a modal
  opens.
- **Fallback**: the template property's own `type`, then `text`.
- **Server sync**: `syncShared` pushes the vault's types to the server's
  `propertyTypes`, so phone captures format values the same way. The server UI
  shows them as coming from the vault.
- **Inputs**:

  | Type | Input |
  |---|---|
  | text | text input |
  | multitext, tags, aliases | comma-separated text, split wikilink-aware as Web Clipper does |
  | number | number input |
  | checkbox | checkbox |
  | date | `type=date` |
  | datetime | `type=datetime-local` |

- **Icons** use Obsidian's own Lucide names: text `text`, multitext `list`,
  number `binary`, checkbox `check-square`, date `calendar`, datetime `clock`,
  tags `tags`, aliases `forward`.

**Rationale**:
- `app.metadataTypeManager` is internal (not in obsidian.d.ts); `types.json` is
  the documented-by-use file the Properties view writes.
- Pushing to the server removes the separate list the user maintains (FR-003).

**Alternatives considered**:
- `metadataTypeManager` behind a feature check: internal, can change silently;
  kept only as an optional fast path if `types.json` is missing.
- Native property widgets: not exposed to plugins.

## R8. The "On capture" preset and migration

**Decision**:
- `ClipperTemplate.onCapture?: "add" | "add-media" | "copy"`. Missing means
  `add`. It is not part of Web Clipper's format, like `updateFromSource`.
- Edited in the server settings UI next to "Show in Update from source".
- **Migration** (`parseCaptureSettings`, once, guarded by a settings
  `schemaRevision`): a template whose note name, path, properties or content
  contains `{{tiktok_save}}`, `{{tiktok_images}}`, `{{tiktok_video}}`,
  `{{tiktok_image_N}}`, `{{tiktok_thumbnail}}` or `{{image_local}}` gets
  `onCapture: "add-media"`.
- **Background captures** (`origin` other than `plugin` / `enrich`) whose
  template has `add-media`: the worker queues a media job for the URL right after
  the capture job finishes. The plugin's drain writes the note, then applies the
  media job's files with R4's rewrite.

**Rationale**: FR-031–FR-033, FR-042 and assumption 5b, with a single media path.

## R9. Update from source, reworked

**Decision**:
- **On open**: the modal reads the note's frontmatter and body and picks its
  template, in this order:
  1. the value of a template property whose expression is `{{template}}` (a new
     extra variable, like `{{capture_id}}`, that a template can opt in to);
  2. otherwise `chooseTemplate(templates, url)`.
- **Fetch** starts a `preview` job, with no `ENRICH_FILES` (they are deleted).
- **Other templates** re-render on the held page.
- **Screenshots** are requested on the held page when picked; once the page has
  expired, a picked screenshot starts a new `preview` and then its files.
- **Applying**: property choices as today (`applyProperties`); body keep / append
  / replace, with replace previewed by `diff.ts` (from 001).
- **Rename / move**: `fileManager.renameFile(file, normalizePath(`${folder}/${name}.md`))`,
  using a free name if one is taken.
- **Replace whole note**: a preset over the same selection. The `recapture`
  command is removed, and the `obsidian://bookmarks?action=retry` handler opens
  the modal with this preset.
- **Removed**: drag-and-drop and per-row heading placement. `placeContent` stays
  for append/replace at the body level.

**Rationale**: FR-021–FR-030, Q8/Q9 answers. One held page replaces
`EnrichSession`'s multi-job bookkeeping.

## R10. Writing the edited note

**Decision**:
1. The plugin writes the body exactly as edited (tokens removed per R2) with
   `vault.create`, at a free name in the footer folder.
2. It then sets every property through `processFrontMatter`, with values coerced
   by vault type (lists split, numbers parsed, checkboxes boolean, dates as
   typed).

The writer's server-frontmatter path stays for background captures, which have
no edits.

**Rationale**: Obsidian formats the YAML the way its Properties view does, and
edits can't break YAML quoting.

**Alternatives considered**: `stringifyYaml` into the text by hand — fine, but
`processFrontMatter` already matches Obsidian's formatting.

## R11. Groundwork and code size

**Decision** (from the audit), done first so the new modals are built on it:

- **`plugin/styles.css`**: replaces the inline `style` assignments in
  `modal-ui.ts`, `enrich-modal.ts`, `merge-modal.ts` and `source-picker.ts`. It is
  shipped by the release workflow (`.github/workflows/release.yml:48` adds
  `plugin/styles.css`).
- **New controllers**, which shrink `main.ts` to roughly setup, settings,
  index and drain (~300 lines):
  - `capture-controller.ts` (from `main.ts` 302–371, 891–924);
  - `update-controller.ts` (373–550);
  - `merge-controller.ts` (552–889);
  - `media-controller.ts` (new).
- **Helpers**:
  - `ready()` replaces the three `checkServer` + `syncShared` sequences;
  - `errorText(err)` replaces the nine `instanceof Error` ternaries;
  - `frontmatterOf(file)` replaces the seven `getFileCache()?.frontmatter ?? {}`.
- **Dead code removed**: `siteEntry` (`url.ts:88`); the unused
  `EnrichSession.job` getter (`EnrichSession` itself goes, see R9); the
  `pageVariables` fallback (`main.ts:507`); `RenderedNote.variables` made
  required.
- **Shared pickers**: `SourcePicker` and `DuplicateListModal` share one generic
  fuzzy picker using `prepareFuzzySearch`.

Out of scope: plugin↔harness shared package (separate PR).

**Rationale**: these touch exactly the code the feature rewrites; doing them
first avoids building the new UI on code that is about to change.
