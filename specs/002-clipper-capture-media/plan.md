# Implementation Plan: Clipper-style capture and media download

**Branch**: `002-clipper-capture-media` (stacked on `001-merge-duplicate-bookmarks`) | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-clipper-capture-media/spec.md`

## Summary

The server gains a **preview** capture mode that publishes the rendered note as
soon as the page settles and then **holds the page** for a short time. On the held
page the plugin can:

- re-render with another template;
- ask for the screenshots the final note uses;
- release it.

Both modals are rebuilt on one Web Clipper–style shell using Obsidian's
`metadata-property` markup and the vault's own property types:

- **Capture URL** fills editable fields from the preview and writes exactly what
  the user sees. Screenshot embeds are left out and inserted once their files
  arrive.
- **Update note from source** fetches only on request, never downloads media,
  and absorbs "Capture current bookmark again" and template changes.

Media moves to a separate path:

- a pure scanner finds media in a note;
- images download in the plugin, while TikTok and video sites download through a
  one-at-a-time **media queue** on the server (every video, TikTok included, via
  yt-dlp; only TikTok photo posts load the post in Playwright);
- each success replaces its source in the note.

"Add and download media", the template's new `onCapture` preset and background
captures all reuse that path.

Files follow Obsidian's attachment setting unless the plugin's override is set.

Before any of this, the touched code is cleaned up: `styles.css`, controllers out
of `main.ts`, shared helpers, and dead code removed.

## Technical Context

**Language/Version**: TypeScript ~5.9, ES2022 (plugin bundled by esbuild; harness
NodeNext, Node ≥22.12)

**Primary Dependencies**:
- Plugin: `obsidian` API 1.13.1 (minAppVersion 1.11.4). Uses
  `getAvailablePathForAttachment`, `generateMarkdownLink`, `processFrontMatter`,
  `renameFile`, `requestUrl`, `Menu`, `AbstractInputSuggest`,
  `prepareFuzzySearch`. No new npm packages.
- Harness: Playwright 1.63 (unchanged); new system binaries yt-dlp (pinned release
  binary + SHA-256) and ffmpeg (apt) in the Docker image. No new npm packages.

**Storage**:
- Vault notes and attachments.
- Plugin `data.json`: `attachmentFolder`, `pendingInserts`, plus the existing
  `writtenCaptures`.
- Server SQLite `jobs`: new `mode` and `held_until` columns and a `media` JSON
  column, added with the existing `ALTER TABLE` pattern.
- Server settings: `onCapture` on templates, plus `schemaRevision`.

**Testing**:
- vitest in both workspaces:
  - plugin: `placeholders`, `media`, `fields`, `enrich`;
  - harness: `pool`, `media-queue`, an app routes test extending
    `harness/test/app.test.ts` with a fake engine, and the settings migration.
- Manual checks per [quickstart.md](quickstart.md).

**Target Platform**: Obsidian desktop and mobile (`isDesktopOnly: false`); server
in Docker (linux/amd64, arm64)

**Project Type**: Monorepo: Obsidian plugin (`plugin/`) + capture server
(`harness/`); both change, in lockstep (`API_VERSION` 7 → 8).

**Performance Goals**:
- Preview fields filled ≤5 s for typical pages; note written ≤1 s after Add
  (SC-001).
- Template re-render ≤2 s with no reload (SC-003).
- Media queue: ≥5 s between same-host jobs (SC-006).

**Constraints**:
- No broken links ever written (SC-004).
- No media downloaded unless asked (SC-002).
- At most two new user-facing settings (SC-008): the template's `onCapture` and
  the attachment override.
- At most 3 held pages, 120 s idle TTL, so server memory stays bounded.
- Video cap 300 MB.
- Phone width with no sideways scroll.

**Scale/Scope**: Single user, one server; captures one at a time
interactively, bursts of ~10 from the phone. The user's vault has ~2,600 bookmark
notes.

## Constitution Check

There is no `.specify/memory/constitution.md` in this repo. These gates are taken
from the project's established conventions (`docs/superpowers/specs`, the 001
plan) and checked before and after design:

| Gate | Pre-design | Post-design |
|---|---|---|
| Rules live in Obsidian-free modules with vitest tests; Obsidian glue stays thin | ✅ planned | ✅ `placeholders.ts`, `media.ts`, `fields.ts`, `pool.ts`, `media-queue.ts` |
| Works on Obsidian mobile | ✅ | ✅ images via `requestUrl`; heavy work on server; no Node APIs in plugin |
| Plugin is the sole vault writer; server never touches the vault | ✅ | ✅ server only produces assets; plugin writes |
| Respect user's Obsidian settings over plugin copies | ✅ | ✅ attachment location, link format, property types, rename link updates |
| No hidden note state | ✅ | ⚠️ `pendingInserts` in plugin data. Justified below: a transient delivery queue, not facts about notes |
| SSRF rules apply to every server fetch | ✅ | ✅ `/media` and yt-dlp URLs go through `urlRejection`; documents re-checked as today |
| Plugin and server versions locked | ✅ | ✅ `API_VERSION` 8 |

## Project Structure

### Documentation (this feature)

```text
specs/002-clipper-capture-media/
├── spec.md
├── plan.md                         # this file
├── research.md                     # R1–R11 decisions
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── server-api.md               # preview/render/files/release, /media
│   ├── commands-and-settings.md    # commands, modal shell, settings
│   └── modules.md                  # pure module signatures + test lists
└── checklists/requirements.md
```

### Source Code

```text
plugin/
├── styles.css                      # NEW: all modal styling (replaces inline style)
└── src/
    ├── main.ts                     # setup, settings, index, drain, pending inserts (~300 lines)
    ├── capture-controller.ts       # NEW: Capture URL flow (from main.ts)
    ├── update-controller.ts        # NEW: Update note from source (from main.ts; replaces EnrichSession use)
    ├── merge-controller.ts         # NEW: moved from main.ts, unchanged behaviour
    ├── media-controller.ts         # NEW: Download media, add-media, background media delivery
    ├── clip-modal.ts               # NEW: shared Web Clipper–style shell
    ├── capture-modal.ts            # REWRITTEN on clip-modal
    ├── enrich-modal.ts             # REWRITTEN on clip-modal (drag & heading placement removed)
    ├── media-modal.ts              # NEW: download checklist
    ├── placeholders.ts             # NEW (pure)
    ├── media.ts                    # NEW (pure)
    ├── fields.ts                   # NEW (pure)
    ├── enrich.ts                   # trimmed (ENRICH_FILES, ON_DEMAND_FILES, drag helpers out)
    ├── enrich-session.ts           # DELETED (one held page replaces it)
    ├── writer.ts                   # attachment path via getAvailablePathForAttachment / override
    ├── client.ts                   # render/files/release/media calls
    ├── settings.ts                 # attachment override + migration
    ├── modal-ui.ts                 # shrinks to helpers still used by merge-modal
    ├── source-picker.ts            # generic fuzzy picker (shared with merge's list)
    └── api.ts, url.ts              # mirrored types; siteEntry removed
harness/
├── Dockerfile                      # + ffmpeg, pinned yt-dlp
└── src/
    ├── capture.ts                  # engine orchestration: full vs preview
    ├── page.ts / shots.ts / media.ts   # NEW: split out of capture.ts
    ├── pool.ts                     # NEW: held pages
    ├── media-queue.ts              # NEW
    ├── worker.ts                   # preview publishes + hands page to pool; follow-up media jobs
    ├── app.ts                      # new routes (contracts/server-api.md)
    ├── db.ts                       # mode, held_until, media columns
    ├── settings.ts                 # onCapture, schemaRevision migration
    ├── tiktok.ts                   # remote fallbacks for media variables when not downloading (R3)
    └── api.ts                      # API_VERSION 8 + types
harness/ui/app.js                   # On capture select; read-only property types
.github/workflows/release.yml       # ship plugin/styles.css
```

**Structure Decision**: Both workspaces change. The plugin↔harness shared package
stays a separate PR, so `api.ts` changes are made in both copies, as today. Merge
code moves without behaviour change, so 001's tests guard the move.

## Phase summary

**Phase 0 — research** ([research.md](research.md)). Every unknown is resolved:
- preview + held page (R1);
- screenshot anchors (R2);
- media variable fallbacks (R3);
- media detection and download split (R4);
- yt-dlp packaging (R5);
- attachment path and migration (R6);
- property types from `types.json` (R7);
- `onCapture` and migration (R8);
- the Update rework (R9);
- writing edits via `processFrontMatter` (R10);
- groundwork (R11).

**Phase 1 — design**: [data-model.md](data-model.md); contracts for the
[server API](contracts/server-api.md),
[commands, modals and settings](contracts/commands-and-settings.md) and
[pure modules](contracts/modules.md); [quickstart.md](quickstart.md).

**Suggested build order** (for `/speckit-tasks`), each step shippable as a beta:

1. **Groundwork (R11)**: styles.css, controllers, helpers, dead code. No
   behaviour change; all existing tests pass.
2. **Attachment path + override migration (R6)**, and property types from the
   vault (R7).
3. **Server preview mode, PagePool and the render/files/release routes (R1)**;
   media fallbacks (R3); `API_VERSION` 8.
4. **Capture URL modal on the shell**, plus pending inserts (R2, R10): US1–US3.
5. **Update from source rework (R9)**: US4, US6; recapture removed.
6. **Media**: scanner and plugin images, then server `/media` with TikTok, then
   yt-dlp, then the modal: US5.
7. **`onCapture` preset, migration, add-media action and background follow-up
   jobs (R8)**: US2.4, US7.

## Complexity Tracking

| Exception | Why needed | Simpler alternative rejected because |
|---|---|---|
| `pendingInserts` in plugin data (looks like hidden state) | A screenshot can finish after Obsidian closes; its insertion point must survive a restart | Placeholder comments in the note are hidden state in the user's file; reserving links writes broken embeds; waiting brings back the slow path |
| Held browser pages on the server (`PagePool`) | Template switches without reload (SC-003); screenshots only for the final note; Update's on-demand screenshots without new page loads | Re-rendering in the plugin diverges from Web Clipper's engine and loses `selector:` variables; a new job per switch repeats the page loads that cause rate limits |
| Two download paths (plugin for images, server for TikTok/video) | Images work without the server and on mobile, matching the native command; TikTok needs the page session and video sites need yt-dlp | Server-only adds a server dependency for plain images; plugin-only can't do TikTok sessions or run yt-dlp on mobile |
| Two TikTok paths on the server (yt-dlp for videos, browser for photo posts) | yt-dlp handles TikTok videos without a page load and is maintained against TikTok changes, but can't fetch photo posts | All-yt-dlp can't do photo posts; all-browser loads a page per video and keeps our own video downloader |
| New system binaries in the image (yt-dlp, ffmpeg) | YouTube/X/Vimeo downloads (FR-035) | Re-implementing site extractors is not maintainable; a sidecar adds compose plumbing for one binary |
