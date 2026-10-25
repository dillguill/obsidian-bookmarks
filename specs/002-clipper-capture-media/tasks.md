---
description: "Task list for Clipper-style capture and media download"
---

# Tasks: Clipper-style capture and media download

**Input**: Design documents from `specs/002-clipper-capture-media/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Included. [contracts/modules.md](contracts/modules.md) lists the vitest cases for each pure module, and [contracts/server-api.md](contracts/server-api.md) defines the routes tested in `harness/test/app.test.ts`. Modals and vault glue are checked by hand with [quickstart.md](quickstart.md).

**Organization**: Grouped by user story. All five P1 stories come first, but in dependency order (US1 → US3 → US4 → US5 → US2), because US2's "Add and download media" needs US5's media path. P2 stories follow.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: The user story the task belongs to (US1–US7)
- All paths are relative to the repo root.

## Conventions every task follows

- Match the surrounding code:
  - two-space indent, double quotes, 160-column lines;
  - a one-line `/** … */` doc comment on each exported function;
  - comments explain why, not what.
- **New in this feature**: no inline `el.style` for static styling. Use classes in
  `plugin/styles.css`, prefixed `bookmarks-`, with Obsidian CSS variables.
  Dynamic values (drag offsets, computed sizes) may still use `style`.
- Pure modules (`placeholders.ts`, `media.ts`, `fields.ts`, `enrich.ts`, `values.ts`, `merge.ts`, `links.ts`, `diff.ts`) MUST NOT import `obsidian`.
- Harness imports use `.js` suffixes (NodeNext).
- Shared types change in both `plugin/src/api.ts` and `harness/src/api.ts`.
  Keep them identical apart from the existing optional/required differences.
- Tests use vitest, like `plugin/test/enrich.test.ts` and `harness/test/app.test.ts`.
- After each phase run:
  - `npm test`
  - `npm run typecheck`
  - `npm run build`

---

## Phase 1: Setup (groundwork, no behaviour change)

**Purpose**: Clean up the code this feature rewrites (research R11). All existing tests must stay green and the behaviour must be identical.

- [X] T001 Create `plugin/styles.css`. Move every static inline style in `plugin/src/modal-ui.ts`, `plugin/src/enrich-modal.ts`, `plugin/src/merge-modal.ts` and `plugin/src/source-picker.ts` (each `Object.assign(x.style, {...})` and `x.style.prop = …` with constant values) into classes named `bookmarks-<component>-<part>`, and apply them with `cls`/`addClass`. Keep the look identical.
- [X] T002 [P] Ship the stylesheet:
  - in `.github/workflows/release.yml:48`, add `plugin/styles.css` to the `gh release create` file list;
  - in `plugin/esbuild.config.mjs`, if the dev build copies plugin files into a test vault, copy `styles.css` too (otherwise no change).
- [X] T003 [P] Add helpers in a new `plugin/src/errors.ts`:
  - `errorText(err: unknown): string` (`err instanceof Error ? err.message : String(err)`);
  - replace all nine ternaries in `plugin/src/main.ts`, `plugin/src/enrich-session.ts`, `plugin/src/settings.ts` and `plugin/src/merge-modal.ts` (find them with `grep -n "instanceof Error ?" plugin/src`).
- [X] T004 Move the merge flow out of `plugin/src/main.ts`, lines 552–889 (`isDuplicate` through `renameSeparate`), into a new `plugin/src/merge-controller.ts`:
  - export class `MergeController`, constructed with the plugin;
  - `main.ts` keeps only the command registrations and calls the controller;
  - `alreadySavedNotice` calls `controller.open(key)`. No behaviour change.
- [X] T005 Move the Capture URL flow out of `plugin/src/main.ts` (`openCaptureModal`, `openNote`, `alreadySavedNotice`, `captureInteractive`, at lines 302–344 and 891–924) into a new `plugin/src/capture-controller.ts` with class `CaptureController`. No behaviour change.
- [X] T006 Move the update flow out of `plugin/src/main.ts` (`enrich`, `updateTemplates`, `loadEnrich`, `vaultProperties`, `pageVariables`, `applyEnrich`, at lines 373–550) into a new `plugin/src/update-controller.ts` with class `UpdateController`. No behaviour change.
- [X] T007 Add `ready(): Promise<void>` on the plugin in `plugin/src/main.ts`:
  - it runs `checkServer()` and throws on a problem, then `syncShared()` with the existing warn-on-failure;
  - replace the three copies, at old lines 390–392, 904–906 and 935–941. For `drain`, keep its own handling of the version warning.
  - Also add `frontmatterOf(file: TFile): Record<string, unknown>` and use it for every `getFileCache(…)?.frontmatter ?? {}`.
- [X] T008 [P] Remove dead code:
  - `siteEntry` in `plugin/src/url.ts:88-96`;
  - the `job` getter in `plugin/src/enrich-session.ts:37-39`;
  - the `pageVariables` older-server fallback in `plugin/src/update-controller.ts` (from T006): use `note.variables` directly;
  - make `RenderedNote.variables` required in `plugin/src/api.ts` and `harness/src/api.ts`;
  - fix any callers and tests.
- [X] T009 [P] Make one generic picker (done with the existing word filter, not `prepareFuzzySearch`: fuzzy matching over full variable values gave false matches; see `plugin/src/search.ts`):
  - rewrite `plugin/src/source-picker.ts` as `FuzzyPicker<T>` (items, `render(item, el)`, `choose(item)`, placeholder), using Obsidian's `prepareFuzzySearch`;
  - use it for the existing source picker and for `DuplicateListModal` in `plugin/src/merge-modal.ts:452-458`;
  - delete `filterSources` in `plugin/src/enrich.ts:368-375` if nothing else uses it.
- [X] T010 Run `npm test && npm run typecheck && npm run build`, and check `wc -l plugin/src/main.ts` is about 300 lines or fewer. Run quickstart scenarios for merge (001's quickstart) to confirm nothing changed. *(Automated checks pass; `main.ts` is 363 lines. The manual merge check in Obsidian is still to do.)*

**Checkpoint**: Same behaviour, smaller `main.ts`, styles in CSS.

---

## Phase 2: Foundational (blocks every story)

**Purpose**: Shared pieces every story builds on:
- attachment paths (R6);
- vault property types (R7);
- server preview mode with held pages (R1) and remote media fallbacks (R3);
- the API v8 client;
- the shared modal shell;
- the `fields` and `placeholders` modules.

### Tests for Phase 2

- [X] T011 [P] Write `plugin/test/fields.test.ts` per [contracts/modules.md](contracts/modules.md) § `fields.ts`:
  - `vaultTypes` with a valid, a missing (`null`) and an invalid `types.json`;
  - `splitList("a, [[b, c]], d")` → `["a", "[[b, c]]", "d"]`;
  - `frontmatterFrom` coercion: number, checkbox, date, datetime, list, and an empty value dropped;
  - a field whose text is a `{{screenshot_*}}` token is left out;
  - `fieldsFrom` type precedence: vault, then template, then text.
- [X] T012 [P] Write `plugin/test/placeholders.test.ts` per [contracts/modules.md](contracts/modules.md) § `placeholders.ts`:
  - markers → tokens → `extractTokens` round trip, including `![[marker]]` and `[[marker]]` wrappers;
  - `insertAt` with the before-anchor present, only the after-anchor present, and neither (appended at the end);
  - two tokens with the same anchor keep their order;
  - frontmatter is never touched.
- [X] T013 [P] Write `harness/test/pool.test.ts` for `PagePool` with fake contexts and a fake clock:
  - `hold`/`get`/`release`;
  - the TTL expires after 120 s idle, and `get` refreshes it;
  - a 4th `hold` releases the oldest;
  - `release` is idempotent;
  - the release callback runs once.
- [X] T014 [P] Extend `harness/test/app.test.ts` with the routes in [contracts/server-api.md](contracts/server-api.md), using a fake engine that supports preview:
  - `POST /capture` with `mode: "preview"` returns 202, and `assets` gains `note`;
  - preview with `files` returns 400;
  - `POST /jobs/:id/render` returns 200 with a new note, 410 after release, 409 on a full job and 404 on an unknown id;
  - `POST /jobs/:id/files` accepts only screenshot/PDF kinds, and `finish: true` leads to `done`;
  - `POST /jobs/:id/release` with `keep: false` discards the job, `keep: true` makes it `done`, and both are idempotent;
  - `/health` reports `apiVersion: 8`.
- [X] T015 [P] Extend `harness/test/tiktok.test.ts`: with `media: false`, `tiktokData(...)` renders `tiktok_save`, `tiktok_images` and `tiktok_video` as the player embed (`videoEmbed(id)`), and the cover as its remote URL (research R3).
- [X] T016 [P] Extend `plugin/test/writer.test.ts`:
  - with no override, `saveCaptureFiles` asks a new `attachmentPath(name, notePath)` port for each file and writes there;
  - with an override, it uses `freePath` in the override folder as today;
  - existing files are never overwritten.

### Implementation for Phase 2

**Attachments and settings (R6)**

- [X] T017 In `plugin/src/settings.ts`:
  - replace `assetsFolder` with `attachmentFolder: string` (default `""`);
  - add `pendingInserts: PendingInsert[]` (default `[]`; type per [data-model.md](data-model.md));
  - in the settings tab, rename the "Assets folder" setting to "Attachment folder override", with placeholder "Use Obsidian's attachment setting", a description naming the vault's current setting (`app.vault.getConfig("attachmentFolderPath")`, wrapped in `try`, falling back to generic text), and folder suggestions via the existing suggest pattern in `plugin/src/property-suggest.ts`.
- [X] T018 Add the migration in `loadSettings`, `plugin/src/main.ts`:
  - when saved data exists and has no `attachmentFolder`, set `attachmentFolder = saved.assetsFolder ?? "Bookmarks/assets"`;
  - when there is no saved data, leave it `""`;
  - delete `assetsFolder`, then persist.
- [X] T019 In `plugin/src/writer.ts`:
  - add `attachmentPath(name: string, notePath: string): Promise<string>` to `VaultPort`;
  - `saveCaptureFiles(vault, override, files, ext, noteBase, notePath)`:
    - when `override` is `""`, call `vault.attachmentPath(`${base}.${ext}`, notePath)`;
    - otherwise keep `ensureFolder` + `freePath`.
  - In `plugin/src/main.ts`'s `vaultPort()`, implement `attachmentPath` with `this.app.fileManager.getAvailablePathForAttachment(name, notePath)`.
  - Update every caller (deliver, update) to pass the note path. This makes T016 pass.

**Property types (R7)**

- [X] T020 [P] Create `plugin/src/fields.ts` per [contracts/modules.md](contracts/modules.md):
  - `vaultTypes`, `fieldsFrom`, `frontmatterFrom`, `splitList`;
  - a `TYPE_ICONS` map (text `text`, multitext `list`, number `binary`, checkbox `check-square`, date `calendar`, datetime `clock`, tags `tags`, aliases `forward`).
  - Makes T011 pass.
- [X] T021 In `plugin/src/main.ts`:
  - add `propertyTypes(): Promise<Record<string, FieldType>>`, which reads `normalizePath(`${this.app.vault.configDir}/types.json`)` through `vault.adapter.read` (catch → `null`) and parses it with `vaultTypes`;
  - in `syncShared`, push the vault's types to the server as `propertyTypes` entries (one `PUT /settings` only when they differ from what the server returned).

**Server: preview, pool, routes (R1, R3)**

- [X] T022 Split `harness/src/capture.ts` without changing behaviour:
  - page preparation goes to `harness/src/page.ts`: `waitForDomQuiet`, `hideOverlays`, `innerScrollExtra`, `autoScroll`, and a single `waitForImages(page)` helper replacing the two copies at `capture.ts:509-520` and inside `pagePdf`;
  - screenshot/PDF code goes to `harness/src/shots.ts`: `firstScreen`, `thumbnail`, `articleShot`, `pagePdf`, `desktopShots`, `mobileShot`, `darkMode`;
  - `imageFile`, `videoFile`, `tiktokItem`, `tiktokGet` and `tiktokTranscript` go to `harness/src/media.ts`;
  - `capture.ts` keeps the engine. Run `npm test -w harness`.
- [X] T023 [P] Create `harness/src/pool.ts` with `PagePool`:
  - API: `hold(jobId, { context, page, render }, onRelease)`, `get(jobId)` (refreshes the TTL), `release(jobId)`;
  - TTL 120 s, max 3, using an injectable clock;
  - releasing closes the context and calls `onRelease`.
  - Makes T013 pass.
- [X] T024 In `harness/src/api.ts` and `plugin/src/api.ts`:
  - `API_VERSION = 8`;
  - add `CaptureMode`, plus `Job.mode` and `Job.heldUntil`;
  - add `MediaJobInfo`, `MediaKind` and the `media_*` asset kinds (`media_video`, `media_cover`, `media_photo_1`…`media_photo_35`), per [data-model.md](data-model.md);
  - add `ClipperTemplate.onCapture` and `CaptureSettings.schemaRevision`.
- [X] T025 In `harness/src/db.ts`:
  - add the columns `mode TEXT NOT NULL DEFAULT 'full'`, `held_until TEXT` and `media TEXT` with the existing `ALTER TABLE` pattern (`db.ts:68-69`);
  - map them in the row reader;
  - `create(url, origin, template, files, mode = "full")`;
  - add `hold(id, until)` and `unhold(id)`;
  - make `finishedJobs` keep excluding `origin = 'enrich'` and also exclude `origin = 'media'` unless the request asks for it.
- [X] T026 *(also fixes analysis I1: `harness/src/remote-media.ts` swaps wrapped markers, so `[[{{tiktok_thumbnail}}]]` becomes the bare address, not `[[https://…]]`)* In `harness/src/tiktok.ts`, add a `media: boolean` parameter to `tiktokData` (default `true`). When `false`, `tiktok_save`, `tiktok_images` and the `tiktok_video` marker render as `videoEmbed(post.id)`, and `tiktok_thumbnail` / `image_local` resolve to the remote cover / `{{image}}` URLs, not markers (in `harness/src/render.ts` `fileVariables` for preview). Makes T015 pass.
- [X] T027 In `harness/src/capture.ts`, add `preview(url, render, progress): Promise<HeldPage>` on `PlaywrightEngine`:
  1. open the context as in `capture`;
  2. `goto` with `domcontentloaded`, then `load` (≤10 s), then `waitForDomQuiet(page)`; no scroll and no image wait;
  3. run Defuddle and the TikTok item/transcript, and call `tiktokData(post, item, transcript, false)`;
  4. check `blockReason`;
  5. `renderNote` and `progress.page(meta, markdown, note)`;
  6. return `{ context, page, meta, render: (template) => renderNote(page, {...render, templateName: template}, url), files: (kinds) => … }`.
  - `files(kinds)`: `autoScroll`, `waitForImages`, `hideOverlays`, then the `shots.ts` functions for exactly `kinds`, reporting each file through `progress.file`.
  - Add `preview` to the `CaptureEngine` interface and to the test fake engine.
- [X] T028 In `harness/src/worker.ts`:
  - for `job.mode === "preview"`, call `engine.preview`, save `markdown`/`note` as today, then hand the result to `PagePool.hold` with `store.hold(id, now+120s)`, and free the worker slot (`run` returns);
  - on pool release without Add (`release keep:false`), or on TTL, discard the job (`worker.discard`).
  - Add methods `render(id, template)`, `files(id, kinds, finish)` and `release(id, keep)`. They throw a typed `Gone` error when the pool has no page, and `files` with `finish` marks the job `done` and releases the page after the last file.
- [X] T029 In `harness/src/app.ts` *(done without the per-request `propertyTypes` override: T021 already syncs the vault's types to the server before every capture)*:
  - accept `mode` and `propertyTypes` in `captureRequest` (`app.ts:130-150`), rejecting `files` with preview (400) and preview from origins other than `plugin`/`enrich`;
  - pass `propertyTypes` into `renderRequest` (`harness/src/render.ts:38`) to override the stored list for that render;
  - add routes `POST /jobs/:id/render`, `/files` and `/release` per [contracts/server-api.md](contracts/server-api.md), mapping `Gone` → 410, a non-preview job → 409 and unknown → 404, and extend `JOB_PATH` (`app.ts:28`) for them;
  - report `apiVersion: 8`.
  - Makes T014 pass.
- [X] T030 In `plugin/src/client.ts`:
  - `capture(url, origin, wait, template, files, mode = "full", propertyTypes?)`;
  - new methods `render(id, template): Promise<RenderedNote>`, `files(id, kinds, finish)` and `release(id, keep)`;
  - map HTTP 410 to a `PageGone` error class exported from `client.ts`.

**Modal shell and placeholders**

- [X] T031 [P] Create `plugin/src/placeholders.ts` per [contracts/modules.md](contracts/modules.md): `markersToTokens`, `tokensIn`, `extractTokens` (removal mirrors `fillFiles` in `plugin/src/writer.ts:104`) and `insertAll` *(one pass per job, so tokens at the same spot keep their order)*. Makes T012 pass.
- [X] T032 *(rows use the plugin's own `bookmarks-property*` classes, styled with Obsidian's metadata CSS variables, rather than Obsidian's internal `metadata-property` classes, whose native rules expect the real Properties view)* Create `plugin/src/clip-modal.ts`, the shared shell per [contracts/commands-and-settings.md](contracts/commands-and-settings.md) § Shared modal shell. `ClipModal extends Modal` with protected builders:
  - `header(templates, value, onChange)`: borderless select plus the "changed" dot;
  - `urlRow(value, onInput)`: input plus status line, with `status(text, kind)`;
  - `nameField()`: auto-grow textarea, Enter blocked;
  - `propertiesSection()`: a heading with chevron that toggles the `bookmarks-properties-collapsed` `localStorage` key inside try/catch, plus `renderFields(fields, extras?)` drawing `metadata-property` rows with `setIcon(TYPE_ICONS[type])` and an input per type (research R7 table); `extras(row, field)` lets Update add controls;
  - `bodyField()`: textarea filling the rest;
  - `footer({ folder | toggle, actions, main })`: split button with a `Menu` for the other actions;
  - `setChanged(on)`.
  - Add the matching `.bookmarks-clip-*` styles in `plugin/styles.css`, including the under-400 px rules (key column 7.5em, footer wraps).
- [X] T033 [P] Create `plugin/src/folder-suggest.ts`: `FolderSuggest extends AbstractInputSuggest<TFolder>` over `app.vault.getAllFolders()`, for the footer folder field and the T017 override setting.

**Checkpoint**: The server can preview, re-render, take files and release; the plugin has the client, shell, fields and placeholders. No user-visible change yet.

---

## Phase 3: User Story 1 - Capture a page by seeing and editing its note first (Priority: P1) 🎯 MVP

**Goal**: Capture URL shows the template's fields filled from a quick read, editable, and Add writes exactly that note at once.

**Independent Test**: Quickstart scenarios 1, 3 and 5. With an article URL on the clipboard, run Capture URL, edit one property and one body line, select Add, and check the note has both edits and appears without waiting.

### Tests for User Story 1

- [X] T034 [P] [US1] Extend `plugin/test/writer.test.ts` with `writeEditedNote(port, draft)`:
  - the body is written as given, with tokens removed;
  - properties are set through a fake `processFrontMatter` with typed values;
  - a free name is chosen when the name is taken;
  - the folder comes from the draft;
  - the capture id property is set unless `hideCaptureId`;
  - the index is updated.

### Implementation for User Story 1

- [X] T035 [US1] In `plugin/src/writer.ts`, add `writeEditedNote(vault, draft, opts)` per research R10:
  1. pick a free path in `draft.folder` from `draft.noteName`;
  2. `vault.createNote(path, body)` with `extractTokens(draft.body).body`;
  3. then `vault.setFrontmatter(path, frontmatterFrom(draft.properties) + capture id)`, a new `VaultPort` method implemented in `main.ts` with `fileManager.processFrontMatter`;
  4. `index.set(path, url)`.
  - Return `{ path, anchors }`. Makes T034 pass.
- [X] T036 [US1] Rewrite `plugin/src/capture-modal.ts` as `CaptureModal extends ClipModal`, with state `ClipDraft` ([data-model.md](data-model.md)):
  - `onOpen` builds header, URL row, name, properties, body and footer;
  - the template is preselected with `chooseTemplate(templates, url)` (URL rules only) and its property rows are drawn from `template.properties` with empty values;
  - handlers: `onFetch(url, template)`, `onTemplate(name)`, `onAction(action, draft)`, `onClose()`;
  - public methods `filled(note, fields)`, `failed(message)`, `existing(path, name)`;
  - every edit sets `field.edited` and `setChanged(true)`;
  - switching template with edits present asks with a confirm modal first.
- [X] T037 [US1] In `plugin/src/capture-controller.ts`, replace `captureInteractive` for the modal path:
  - **open**: read the clipboard with `findUrl`; if the URL is valid, start fetching right away; while the user types, fetch 600 ms after the last keystroke, or at once on paste or Enter.
  - **fetch**:
    1. `ready()`;
    2. `client.capture(url, "plugin", false, template, [], "preview", vaultTypes)`;
    3. poll `client.job` every 500 ms until `assets` includes `note` (30 s cap);
    4. `assetText(id, "note")`;
    5. `fieldsFrom`, then `markersToTokens` on the body and the property texts;
    6. `modal.filled(...)`.
  - **Changing URL**: `client.release(oldId, false)` before the new fetch.
  - **Template switch**: `client.render(id, name)`; on `PageGone`, show "Fetching the page again…" and start a new preview.
  - **Duplicate**: `index.findByUrl(url)` → `modal.existing(path, basename)`, with an Open link.
  - **Failure**: `modal.failed(errorText(err))`, with Retry and a link-only Add that writes `{{url}}` as the note via the existing fallback in `writeBookmark`.
- [X] T038 [US1] *(also analysis D1: the capture is remembered before the server is told to finish; U3: a preview with no note yet is cancelled, not released; C1: the first read sends no template unless the user picked one, so the server's Web Clipper matching applies schema rules too)* In `plugin/src/capture-controller.ts`, implement the `add` action:
  1. `writeEditedNote`;
  2. if `tokensIn(draft.body)` plus the property tokens is non-empty, `client.files(id, kinds, true)`; else `client.release(id, true)`;
  3. `rememberCapture(id, path)`;
  4. open the note.
  - Pending inserts are wired in US3, so until then any requested files are ignored on delivery (guard in `deliver`, T046).
  - `onClose` without Add → `client.release(id, false)`.
- [X] T039 [US1] In `plugin/src/main.ts`, point the `capture-url` command and the ribbon icon at the new controller. Remove the old `CaptureModal` usage. Keep `captureInteractive` only for the duplicate notice's Replace/Save as new until US2 and US4 replace them.

**Checkpoint**: US1 works end to end; quickstart scenarios 1, 3 and 5 pass (screenshots aren't embedded yet).

*Notes from implementing: Copy Markdown and Add are the actions; "Save as new" was dropped because on a page already saved, Add saves another note anyway, and the status line names the saved one with an Open link (FR-014). Empty properties are written empty (`status:`), not left out, so a template's blank placeholders stay in the note.*

---

## Phase 4: User Story 3 - Screenshots arrive without slowing capture (Priority: P1)

**Goal**: Screenshots the final note uses are taken after Add and embedded only once saved.

**Independent Test**: Quickstart scenario 2.

### Implementation for User Story 3

- [X] T040 [US3] In `plugin/src/capture-controller.ts`'s `add` action, after `writeEditedNote` returns `anchors`, append one `PendingInsert` per anchor to `settings.pendingInserts`, then persist:
  - body anchors: `{ in: "body", before, after, embed }`;
  - property tokens: `{ in: "property", name, expression }`, from the field's template expression.
  - Do this before calling `client.files`.
- [X] T041 [US3] *(plus analysis U1: `plugin.watch(id)` follows a just-added capture and delivers it as soon as it's done, so screenshots don't wait for the next poll)* In `plugin/src/main.ts` `deliver(job)`, when `writtenCaptures[job.id]` exists and `pendingInserts` has entries for `job.id`:
  1. for each entry whose kind is in `job.assets`: download it, `saveCaptureFiles(...)` into the note's attachment location, remove the entry and persist, then:
     - body entries: `vault.process(file, (t) => insertAt(t, where, link))`, where `link` = `(embed ? "!" : "") + fileManager.generateMarkdownLink(saved, notePath)`;
     - property entries: `processFrontMatter`, setting `name` to the expression with the token replaced by the file's link text;
  2. drop entries whose kind is missing from a finished job;
  3. acknowledge with `client.delivered`.
  - Skip `writeBookmark` for these jobs: the note already exists.
- [X] T042 [US3] Keep `pendingInserts` paths current:
  - on vault `rename`, update `notePath` (next to `renameSeparate` in `main.ts`);
  - on `delete`, drop the entries;
  - in `drain`, drop entries older than the server's retention, or whose job returns 404.
- [X] T043 [US3] In `harness/src/shots.ts`/`capture.ts`, confirm `files(kinds)` (T027) scrolls (`autoScroll` + `waitForImages`) before full-page shots, so lazy content is in them (FR-020). Add a fake-engine assertion in `harness/test/capture.test.ts` that the scroll runs before `screenshot_page`.

**Checkpoint**: US1 + US3: notes are written at once; screenshots appear later and never as broken links.

---

## Phase 5: User Story 4 - Update a note from its source, on demand (Priority: P1)

**Goal**: Update note from source opens on the note's current values, fetches only on Fetch, never downloads media, and offers Replace whole note.

**Independent Test**: Quickstart scenarios 6, 7 and 9.

### Tests for User Story 4

- [X] T044 *(done as `plugin/test/update.test.ts` against the new pure `update.ts`; the old enrich tests went with enrich.ts)* [P] [US4] Update `plugin/test/enrich.test.ts`:
  - remove the tests for `ENRICH_FILES`, `ON_DEMAND_FILES` and drag/heading placement;
  - add tests for `defaultSelection` returning an `UpdateDraft` (replace when empty, merge lists, keep equal values);
  - `applyBody(text, newBody, "keep" | "append" | "replace")` keeps the frontmatter;
  - `replaceAllPreset(choices)` sets every property to replace and the body to replace.

### Implementation for User Story 4

- [X] T045 *(enrich.ts, enrich-modal.ts and enrich-session.ts are deleted: update logic is in `update.ts`, the TikTok player helpers in `media.ts`, and merge appends bodies itself)* [US4] In `plugin/src/enrich.ts`:
  - delete `ENRICH_FILES` and `ON_DEMAND_FILES` (`enrich.ts:14-23`) and the heading/drag-only helpers (`placementOrder`, `samePlacement`, heading targets in `placeContent` if unused after this task);
  - add `applyBody` and `replaceAllPreset`;
  - change `defaultSelection` to return `UpdateDraft` ([data-model.md](data-model.md)).
  - Makes T044 pass.
- [X] T046 *(as `plugin/src/update-modal.ts`; each row's input shows what the note will hold, with a keep / use the page's / merge choice under it)* [US4] Rewrite `plugin/src/enrich-modal.ts` as `UpdateModal extends ClipModal`:
  - **On open**: the header holds the templates (`updateTemplates`); the name and properties show the note's current values from `frontmatterOf(file)`; the body area shows a **Fetch** button and the current body (read-only preview).
  - **After `filled(...)`**: each row gets, via `extras`, a "now: …" line, a keep/replace/merge select (merge only when either side is a list), and remove (×); "+ Add property" opens `FuzzyPicker` over `vaultProperties()`. The body area becomes a keep/append/replace segmented control, with "Preview changes" rendering `diff.ts` output (reuse the merge preview's diff rendering in `plugin/src/merge-modal.ts`).
  - **Footer**: main button Apply; menu with Replace whole note.
  - **Screenshot picks**: picking a screenshot variable calls `onFiles([kind])`.
  - Delete the drag code (`startDrag`, the `⋮⋮` handle, `allPlacements`).
- [X] T047 [US4] Rewrite the flow in `plugin/src/update-controller.ts` on the held page:
  - **open**: open the modal; nothing is fetched.
  - **Fetch**:
    1. `ready()`;
    2. a `preview` capture with the chosen template;
    3. wait for `note`;
    4. `enrichChoices(note, frontmatter, parseYaml, CAPTURE_FILES, captureIdPropertyName(template))`;
    5. `modal.filled`.
  - **Template switch**: `client.render`, falling back to a new preview on `PageGone`.
  - **Screenshot pick**: `client.files(id, [kind], false)`, polling until it's in `assets`; on `PageGone`, start a new preview, then files.
  - **Apply**:
    - properties via `processFrontMatter(applyProperties(...))`;
    - body via `vault.process(applyBody(...))`;
    - picked screenshot files saved with `saveCaptureFiles` and linked;
    - then `client.release(id, false)`.
  - **Cancel**: `release(id, false)`.
  - Delete `plugin/src/enrich-session.ts` and its imports.
- [X] T048 [US4] Fold recapture in:
  - in `plugin/src/main.ts`, remove the `recapture` command (`main.ts:62-71`) and the `recapture` method;
  - change the `obsidian://bookmarks?action=retry` handler (`main.ts:96-98`) to `updateController.open(file, { preset: "replace-all" })`, which opens Update with Replace whole note selected and fetches immediately;
  - update `retryLink` docs in `plugin/src/writer.ts` if they mention recapture;
  - the duplicate notice's **Replace** action also opens Update with `replace-all`.

**Checkpoint**: US4 works; no media is requested by updates (check the server log for the absence of TikTok media requests).

---

## Phase 6: User Story 5 - Download a note's media as its own command (Priority: P1)

**Goal**: A Download media command, modelled on Obsidian's native one, covering TikTok, video sites, remote images and property image URLs, with per-item errors.

**Independent Test**: Quickstart scenarios 10, 10b, 11 and 12.

### Tests for User Story 5

- [X] T049 [P] [US5] Write `plugin/test/media.test.ts` per [contracts/modules.md](contracts/modules.md) § `media.ts`:
  - finding: a TikTok player → video, or N photos, plus cover; a YouTube iframe, `![](https://youtu.be/x)` and a bookmark URL → one `site_video`; a plain YouTube link → none; `![a](https://h/x.webp)` → image; a frontmatter image URL → property item; a data: URI → image; the same URL twice → one item;
  - replacing: `replaceSource` replaces an item and reports `false` when its source is gone;
  - naming: `imageName` follows the native rules (URL basename, then `Content-Disposition`, then `Image.<ext>`);
  - `videoSite` mapping for youtube/youtu.be/x.com/twitter.com/vimeo/instagram.
- [X] T050 [P] [US5] Write `harness/test/media-queue.test.ts` with a fake clock:
  - FIFO order with concurrency 1;
  - ≥5 s between two jobs for the same registrable host (`tiktok.com` vs `www.tiktok.com` counts as the same), and no wait for different hosts;
  - jitter stays within 0–3 s;
  - a failing job doesn't stop the queue.
- [X] T051 [P] [US5] Extend `harness/test/app.test.ts` for `POST /media`:
  - 202 with `origin: "media"`;
  - SSRF-rejected URLs → 400;
  - an empty or invalid `want` → 400;
  - video items without yt-dlp → the job is `done` with an error per item;
  - partial success is `done` with `media.errors`;
  - `GET /jobs?origin=media` lists it and the default drain listing doesn't;
  - `media_*` assets are served.

### Implementation for User Story 5

- [X] T052 [P] [US5] Create `plugin/src/media.ts` per [contracts/modules.md](contracts/modules.md):
  - `findMedia`, `videoSite`, `imageName`, `replaceSource`;
  - move `TIKTOK_PLAYER`, `hasTikTokPlayer`, `offlineFiles` and `replaceTikTokPlayer` here from `plugin/src/enrich.ts`, and update imports.
  - Image-URL test: the native extensions `bmp png jpg jpeg gif svg webp avif`, plus TikTok CDN hosts (`tiktokcdn`).
  - Makes T049 pass.
- [X] T053 [P] [US5] Create `harness/src/media-queue.ts`: `MediaQueue` with `enqueue(job)` and an injectable clock/random; it runs one job at a time and spaces same-host jobs by 5 s plus 0–3 s jitter (host via `new URL().hostname` minus a leading `www.`/`m.`/`vm.`). Makes T050 pass.
- [X] T054 [US5] *(with analysis I2 resolved as option A: every yt-dlp request goes through `harness/src/egress-proxy.ts`, which resolves each host, refuses private addresses and connects to the checked address; yt-dlp is forced onto its native downloader so ffmpeg never fetches anything)* In `harness/src/media.ts`, add `runYtDlp(url, dir, { ytdlpPath, maxBytes })`:
  - `execFile` with the args from research R4 (`--no-playlist --max-filesize 300M -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4 --write-thumbnail --convert-thumbnails jpg -o "media_video.%(ext)s" --print-json`), with a timeout of 10 min;
  - parse the JSON line;
  - when `vcodec === "none"` (a TikTok slideshow), return `{ slideshow: true }` and delete the mp3;
  - otherwise return the video and cover paths.
  - Check `urlRejection(url, allowPrivateNetworks)` first.
  - Add `ytdlpVersion()` for `/health`.
- [X] T055 [US5] *(as `PlaywrightEngine.tiktokPhotos`; full captures also stopped downloading media and now render it as the player and web addresses, the render half of T073)* In `harness/src/media.ts`, add `tiktokPhotos(engine, url, want)`:
  - load the post in a fresh context (reusing `PlaywrightEngine`'s browser), then `tiktokItem`;
  - `imageFile` for each photo and the cover, named `media_photo_N` / `media_cover`.
  - Delete `videoFile` and the post-timeout video download in `capture.ts` (old lines 461–467): full captures no longer download the TikTok video. Background media follows in US7.
- [X] T056 [US5] In `harness/src/worker.ts` and `harness/src/app.ts`:
  - add `POST /media` per [contracts/server-api.md](contracts/server-api.md): create a job (`origin: "media"`, `media: { url, want, made: [], errors: [] }`) and `MediaQueue.enqueue`;
  - the queue runner, for each job:
    - TikTok `/photo/` URLs, or `want` including `photos` → `tiktokPhotos`;
    - otherwise → `runYtDlp`, and on `slideshow` → `tiktokPhotos`;
    - record each file as an asset plus `made`, and each failure in `errors` (a video over the cap: "larger than 300 MB");
    - finish `done` unless nothing was made and there were errors → `failed`.
  - Extend `JOB_PATH` and `GET /jobs` with `origin=media`.
  - `/health` gains `media: { ytdlp }`.
  - Config `BOOKMARKS_YTDLP_PATH` goes in `harness/src/config.ts`.
  - Makes T051 pass.
- [X] T057 [US5] *(yt-dlp 2026.08.19, checksums verified at build; `--list-impersonate-targets` lists curl_cffi targets, so TikTok impersonation is available)* In `harness/Dockerfile`'s runtime stage:
  - `apt-get install -y --no-install-recommends ffmpeg`;
  - download `yt-dlp_linux` (and `yt-dlp_linux_aarch64` for arm64, via `TARGETARCH`) from the GitHub release named by `ARG YTDLP_VERSION`, check it against `ARG YTDLP_SHA256_AMD64` / `ARG YTDLP_SHA256_ARM64` with `sha256sum -c`, and install it to `/usr/local/bin/yt-dlp`;
  - set the defaults to the current release and its checksums;
  - add a build-time `RUN yt-dlp --version && yt-dlp --list-impersonate-targets`;
  - record the impersonation output in the PR.
- [X] T058 [US5] Add `requestMedia(url, want)` and `mediaJobs()` in `plugin/src/client.ts`.
- [X] T059 [US5] Create `plugin/src/media-modal.ts`, `MediaModal extends Modal`, per [contracts/commands-and-settings.md](contracts/commands-and-settings.md) § Download media modal:
  - one row per item: checkbox, 48 px preview `img` (or `setIcon` type icon), label, location;
  - footer: Cancel, and Download (`mod-cta`) showing "Downloading N of M…";
  - per-row ✓/⚠ with the reason in `aria-label`;
  - it can close mid-run.
  - Styles go in `plugin/styles.css` (`bookmarks-media-*`).
- [X] T060 [US5] Create `plugin/src/media-controller.ts`.
  - **`download(file, items?)`**:
    1. `findMedia(text, frontmatterOf(file), noteUrl(file))`;
    2. if there are none, show the Notice "There's no media to download in this note.";
    3. otherwise open `MediaModal` (skipped when `items` is passed, for "Add and download media").
  - **Plugin items (images)**, one at a time: `requestUrl`, `imageName`, `saveCaptureFiles`-style save with `attachmentPath`, then `vault.process(replaceSource)` with `"!" + generateMarkdownLink(saved, file.path)` in the body, or `processFrontMatter` with `[[linktext]]` for properties.
  - **Server items**: grouped per post; one `requestMedia` per group, polled every 2 s; each `media_*` asset downloaded and replaced the same way as it completes; for a TikTok player, a video uses `replaceTikTokPlayer` (from `media.ts`) and photos join their embeds.
  - **Summary**: the closing Notice says "Downloaded X of Y." and lists each failure with its reason.
  - Previews: TikTok cover via the oEmbed `thumbnail_url` (`oembedUrl`, mirrored in the plugin), YouTube via `https://i.ytimg.com/vi/<id>/hqdefault.jpg`, images themselves.
- [X] T061 [US5] In `plugin/src/main.ts`, register `download-media` ("Download media for current note"), with a `checkCallback` that's true for an active `.md` file, calling `mediaController.download(file)`.
- [X] T062 [US5] Remove the old "Save TikTok offline" toggle and its plumbing (`offline` in `UpdateDraft`/modal, `offlineFiles` use in `update-controller.ts`): Download media replaces it.

**Checkpoint**: Download media works on its own; quickstart scenarios 10, 10b, 11 and 12 pass.

---

## Phase 7: User Story 2 - Choose what Add does, with the template's preset (Priority: P1)

**Goal**: A split Add button whose default comes from the template's `onCapture`, with Add / Add and download media / Copy markdown / Save as new.

**Independent Test**: Quickstart scenario 4 (the "Add" half) and FR-014 menu contents.

### Tests for User Story 2

- [X] T063 [P] [US2] Extend `harness/test/render.test.ts` (or a new `harness/test/settings.test.ts`):
  - `parseCaptureSettings` keeps a valid `onCapture` and drops an invalid one;
  - the migration sets `"add-media"` on templates using `{{tiktok_save}}`, `{{tiktok_images}}`, `{{tiktok_video}}`, `{{tiktok_image_N}}`, `{{tiktok_thumbnail}}` or `{{image_local}}` in any field;
  - it runs once (`schemaRevision`) and leaves other templates alone.

### Implementation for User Story 2

- [X] T064 [US2] *(later reversed at the user's request: migration 2 takes the preset back from templates migration 1 gave it, so every template starts on "Add to Obsidian"; `docs/templates/tiktok.json` no longer sets it)* In `harness/src/settings.ts`, parse and keep `onCapture` (`"add" | "add-media" | "copy"`), add `schemaRevision`, and run the migration from research R8 once when `schemaRevision < 1`. Makes T063 pass.
- [X] T065 [P] [US2] *(property types stay editable, with a note that the plugin keeps them in step with the vault; the plugin now merges, keeping types only the server knows, instead of replacing the list)* In `harness/ui/app.js` and `harness/ui/index.html`:
  - add an **On capture** select (Add / Add and download media / Copy markdown) beside the `t-update` checkbox (`app.js:416`, `:516`); a missing value means Add;
  - make the property-types list read-only, labelled "Synced from your vault's property types".
- [X] T066 [US2] *(the "add-media" action is removed by T088)* In `plugin/src/capture-modal.ts`:
  - the footer main action is `template.onCapture ?? "add"`, re-evaluated on template switch;
  - the menu lists the other two, plus **Save as new** when `existing`;
  - the folder field uses `FolderSuggest` (T033) and starts as the template's rendered `note.path` (or `template.path` before fetch).
- [X] T067 [US2] *(`add-media` is removed by T088)* In `plugin/src/capture-controller.ts`, implement the remaining actions:
  - `copy`: `navigator.clipboard.writeText("---\n" + stringifyYaml(frontmatterFrom(fields)) + "---\n" + extractTokens(body).body)`, a Notice "Copied", then `release(id, false)`;
  - `new`: `add` regardless of `existing`;
  - `add-media`: `add`, then `mediaController.download(file, findMedia(...))`, with no picker and every item.
  - Remove the now-unused `captureInteractive` modal path, keeping only what `drain` needs.

**Checkpoint**: Quickstart scenario 4 passes.

---

## Phase 8: User Story 6 - Change a note's template (Priority: P2)

**Goal**: Switching template in Update keeps unknown properties unless removed, can rename and move the note, and never restores a replaced TikTok player.

**Independent Test**: Quickstart scenario 8.

### Implementation for User Story 6

- [X] T068 [US6] *(done in `render.ts` alone: `withTemplateName` writes each template's name in place of `{{template}}` before rendering, so the Web Clipper bundle needed no rebuild; filters on it aren't supported)* In `harness/src/render.ts` and `harness/clipper/entry.ts`, add the extra variable `{{template}}` (the template's name) next to `{{capture_id}}`, so a template can opt in with a property like `template: {{template}}`. Rebuild the clipper bundle with `scripts/build-clipper.mjs` if `entry.ts` changes (otherwise pass it via `render.extra` only, without touching `entry.ts`).
- [X] T069 [US6] In `plugin/src/update-controller.ts`, pick the note's template on open:
  1. find a template property whose value expression is exactly `{{template}}`, and use the note's value of that property if it names a template;
  2. else `chooseTemplate(templates, url)`.
- [X] T070 *(any row's × marks it to be removed, with × again to keep it, rather than a switch only on properties the template lacks)* [US6] In `plugin/src/enrich-modal.ts` (`UpdateModal`) and `plugin/src/enrich.ts`, when the selected template differs from the note's:
  - list the note's properties that the new template lacks as kept rows, each with a remove switch (off);
  - `applyProperties` deletes only those with `remove: true`.
  - Add a test to `plugin/test/enrich.test.ts`.
- [X] T071 *(done through the modal's File name and folder fields, prefilled with the note's own, plus a "Use that" link when the template would name or place it differently, instead of a separate toggle)* [US6] Add the footer toggle "Rename and move to match the template" (off). On apply, compute the path `normalizePath(`${note.path}/${note.noteName}.md`)`, add ` 2`, ` 3`, … if it's taken, and call `app.fileManager.renameFile(file, path)` after the content changes.
- [X] T072 [US6] In `plugin/src/enrich.ts` `applyBody`, with `replace`/`append`: if the current body has no TikTok player but has embeds of saved media files (`![[…tiktok-video.mp4]]` or photo files from `media.ts`) and the new body has a player, keep the saved embeds in place of the player (FR-030). Add a test in `plugin/test/enrich.test.ts`.

**Checkpoint**: Quickstart scenario 8 passes.

---

## Phase 9: User Story 7 - Captures from the phone follow the template's preset (Priority: P2)

**Goal**: A background capture whose template is "Add and download media" queues its media on the server straight away, and the plugin applies it after writing the note.

**Independent Test**: Quickstart scenario 13.

### Implementation for User Story 7

- [X] T073 [US7] *(the `onCapture` check is replaced by local marks in T086)* In `harness/src/worker.ts`:
  - render `full` captures with `tiktokData(..., false)`, so the media variables become the player and remote URLs (no media in captures);
  - when such a job finishes, its origin is `shortcut` / `bookmarklet` / `share` / `api`, and its template's `onCapture === "add-media"`, enqueue a media job for `meta.finalUrl` (`want`: video or photos, plus cover) and store `media: { followUp: <id> }` on the capture job.
  - Add a test in `harness/test/app.test.ts` with the fake engine.
- [X] T074 [US7] *(not kept in memory: each follow-up media job records `forCapture`, and every drain lists finished media jobs and puts each into its capture's note, so a restart loses nothing)* In `plugin/src/main.ts` `drain`, after `deliver` writes a job that has `media.followUp`:
  - remember `{ followUp, notePath }` in memory;
  - on each drain, check `mediaJobs()` for finished follow-ups and call `mediaController.apply(file, mediaJob)`, which uses the same replace logic as T060 without the modal;
  - follow-ups still running stay queued for the next poll;
  - acknowledge (`delivered`) the media job after applying.
- [X] T075 [US7] Confirm drained notes keep the TikTok player until the follow-up applies: no marker is left in the note. Add a test in `plugin/test/writer.test.ts`: a rendered note with no media markers writes as-is.

**Checkpoint**: Quickstart scenario 13 passes.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T076 [P] Delete leftovers:
  - `plugin/src/modal-ui.ts` helpers no longer used (keep only what `merge-modal.ts` uses);
  - `smallSelect`/`placeholderRow` if unused;
  - `ON_DEMAND_FILES` references;
  - `{{tiktok_save}}` docs that promise capture-time video.
- [X] T077 [P] *(`onCapture: "add-media"` superseded by T091)* Update the docs:
  - `README.md`: commands list (Download media; recapture removed), attachment setting, `onCapture`;
  - `docs/phone-capture.md`: background media follows the template preset;
  - `docs/templates/tiktok.json`: add `"onCapture": "add-media"`.
- [ ] T078 [P] Mobile pass on `plugin/styles.css`: check both modals and the media list at 360 px wide (quickstart 16); fix overflow; make the footer wrap; keep tap targets ≥ 32 px.
- [ ] T079 Run all of [quickstart.md](quickstart.md) on desktop and a phone. Record results, plus the T057 impersonation output, in the PR description.
- [ ] T080 Run `npm test && npm run typecheck && npm run build`. Bump the version with `node scripts/set-version.mjs <next beta>` only when releasing.

---

## Phase 11: User Story 8 - Say which media is kept locally, in the template (Priority: P1)

**Goal**: One rule for local media: the `|local` filter. Removes "Add and download media", the guessed `captureAction` default, both preset migrations and the media-variable regex lists (FR-031, FR-033, FR-047–FR-051). Supersedes the "add-media" parts of T063, T064, T066, T067, T073 and T077.

**Independent Test**: Spec User Story 8; then User Story 7 with `{{tiktok_thumbnail|local}}`.

### Tests for User Story 8

- [X] T081 [P] [US8] *(as `harness/test/local-media.test.ts` for the filter and markers, plus `tiktok.test.ts` and `capture.test.ts`; list filters dropped with FR-048)* `harness/test/render.test.ts`: each media variable renders its web address (the TikTok video as the player); with `|local` it renders a local media marker carrying the kind and address; `|local` on plain text or a page link leaves it unchanged; `{{tiktok_images|first|local}}` and `|slice` mark only the chosen photos; `{{tiktok_media}}` is the video or the photos by post kind.
- [X] T082 [P] [US8] `harness/test/settings.test.ts`: the FR-050 rewrite (`image_local`, `tiktok_save`, `tiktok_image_N`, templates that relied on `tiktok_video`/`tiktok_images` saving, stored `"add-media"`) runs once at the next `schemaRevision`, and leaves `|local` templates alone. Replace the migration 1/2 cases.
- [X] T083 [P] [US8] `harness/test/app.test.ts`: a background capture whose rendered note has local marks queues one media job wanting exactly those kinds, with the addresses read at capture; one with no marks queues none.

### Implementation for User Story 8

- [X] T084 [US8] *(no new shared module: the media capture files are gone from `CAPTURE_FILES`, `media_*` stay the server's asset names, and every regex list went with `captureAction`)* Shared media table (one module, imported by `harness/src/api.ts` and `plugin/src/api.ts` copies): each media kind (`cover`, `video`, `photo`, `image`) with its file suffix (FR-051) and extension. Replace `SAVES_MEDIA`, `MEDIA_VARIABLES`, `MEDIA_FILES`, the `tiktok_thumbnail`/`tiktok_video`/`tiktok_image_N`/`image_local` capture files and `media_cover`/`media_video`/`media_photo_N` with it.
- [X] T085 [US8] *(in `harness/src/local-media.ts`: `|local` is taken out of the template text before Web Clipper's engine runs, as `{{template}}` is, so the bundle needed no rebuild; no `{{tiktok_media}}`, see FR-048)* `harness/src/render.ts`: register `local` as a filter in the Web Clipper renderer. It turns a media value (FR-047) into a local media marker and records `{ kind, url, index }` on the render result; anything else passes through. Add `{{tiktok_media}}`; drop `tiktok_save`, `tiktok_image_N`, `image_local` from `harness/src/tiktok.ts` and `harness/src/capture.ts`. Makes T081 pass.
- [X] T086 [US8] *(`localWants` picks the server's part; cover-only skips the video download with yt-dlp's `--skip-download`, and a photo post's cover skips its photos)* `harness/src/worker.ts`: `followUp` queues a media job from the render result's local marks (kinds plus captured addresses) instead of `captureAction`/`mediaWanted(url)`; the media job tries each captured address first and reads the post again only if it fails (FR-049). Makes T083 pass.
- [X] T087 [US8] *(the one-time `|local` migration was dropped at the user's request; `schemaRevision` 2 runs nothing, and the server's templates were edited by hand)* `harness/src/settings.ts`: the FR-050 rewrite as the next migration; drop `withoutMediaPreset` and `"add-media"` from `CAPTURE_ACTIONS`, reading a stored one as no preset. `harness/ui/app.js`/`index.html`: On capture offers Add / Copy markdown only. Makes T082 pass.
- [X] T088 [US8] *(the note is written as shown, with web addresses, so no pending media inserts were needed: `MediaController.saveLocal` downloads the kept items afterwards, a TikTok cover from its captured address first)* Plugin: the note is written with each local marker shown as its web address (or the player) and remembered as a pending media insert, like screenshots; `capture-controller.ts` queues those marks after Add and `media-controller.ts` swaps each address for the saved file as it arrives. Remove the `add-media` action and `captureAction` from `capture-modal.ts`, `clip-modal.ts` and `api.ts`; Copy markdown writes the web addresses.
- [X] T089 [US8] *(dropped at the user's request: a "Save in the vault" list was built, then removed; the template's `|local` alone decides, and Download media covers one-off saves)* `plugin/src/capture-modal.ts`: a "local" switch on each field holding a media value, on when it carries a local mark; toggling adds or removes the mark for this capture only. Styles in `plugin/styles.css`.
- [X] T090 [US8] `plugin/src/media.ts` / `media-controller.ts`: Download media names files by the shared table (FR-051) and treats a saved `<note>-cover` like any other saved file, so it isn't offered again (FR-041).
- [X] T091 [P] [US8] *(the unknown-filter check is recorded as an assumption; not tried in the Web Clipper extension)* Docs: `README.md` and `docs/phone-capture.md` describe `|local` and the media variables; `docs/templates/tiktok.json` uses `[[{{tiktok_thumbnail|local}}]]` for `thumbnail` and keeps `{{tiktok_embed}}` as the player. Check how the official Web Clipper treats an unknown filter and record it in the spec's Assumptions.

**Checkpoint**: Spec User Stories 7 and 8 pass; `npm test && npm run typecheck && npm run build`.

---

## Dependencies & Execution Order

### Phase dependencies

| Phase | Depends on |
|---|---|
| Setup (1) | nothing |
| Foundational (2) | Setup. Within it: T022 before T027; T023 + T025 before T028; T024 before T025, T029 and T030; T020 before T021 and T032 |
| US1 (3) | Foundational |
| US3 (4) | US1 (it extends the `add` action) |
| US4 (5) | Foundational (shell, preview, client); independent of US1/US3 apart from shared files |
| US5 (6) | Foundational; independent of US1–US4 |
| US2 (7) | US1 (modal and controller) and US5 (for `add-media`) |
| US6 (8) | US4 |
| US7 (9) | US5 and US2 (`onCapture` parsing, T064) |
| Polish (10) | all stories wanted |

### Within each story

- Tests before implementation where listed (write them, see them fail, then implement).
- Pure modules before controllers before modals' wiring in `main.ts`.

### Parallel opportunities

- **Setup**: T002, T003, T008 and T009 in parallel after T001; T004–T006 one after another (all edit `main.ts`).
- **Foundational**:
  - all tests T011–T016 in parallel;
  - T020, T023, T031 and T033 in parallel;
  - the server track (T022–T029) and the plugin track (T017–T021, T030–T033) can run side by side.
- **After Foundational**: US4 and US5 can be built alongside US1 → US3 by different people or agents. They touch separate controllers and modals; coordinate edits to `main.ts` command registration.

---

## Parallel Example: User Story 5

```text
# Tests together:
T049 plugin/test/media.test.ts
T050 harness/test/media-queue.test.ts
T051 harness/test/app.test.ts (POST /media)

# Then pure modules together:
T052 plugin/src/media.ts
T053 harness/src/media-queue.ts

# Then server (T054 → T055 → T056, T057 any time) alongside plugin (T058 → T059 → T060 → T061)
```

---

## Implementation Strategy

### MVP first (User Story 1)

1. Phase 1 Setup, then Phase 2 Foundational.
2. Phase 3 (US1): Capture URL with live, editable fields; the note is written at once.
3. **Stop and validate** with quickstart scenarios 1, 3 and 5, then ship a beta. Screenshots wait for US3, which should ship in the same beta if the template uses them.

### Incremental delivery

1. US1 + US3: the new capture flow (beta).
2. US4: Update from source on demand, with recapture folded in (beta).
3. US5: Download media (beta). The Docker image now includes yt-dlp and ffmpeg.
4. US2: presets and "Add and download media" (beta).
5. US6, then US7 (beta each), then Polish, then release.

## Notes

- `main.ts` command registration is the main shared edit point. Do it last in each story.
- Plugin and server ship in lockstep (`API_VERSION` 8). A beta with the plugin's
  Phase 2 needs the matching server image.
- Commit after each task or logical group, with the attribution trailer from
  the session settings.
