# Obsidian Bookmarks — Design

**Status:** Design approved (2026-09-18), pre-implementation. MVP decisions
added 2026-10-02 (§2, §4, §5.3, §10).
**Author:** Dillon
**Related:** `obsidian-chat` (sibling project; shares the Tailscale/self-host operational style, differs in packaging — see `obsidian-chat/PLAN.md` Phase 6 Docker consideration)

---

## 1. Purpose & positioning

A bookmark manager for Obsidian that **replaces the role of Karakeep** while
**keeping Obsidian Web Clipper** for rich article clipping. Web Clipper stays the
tool for deliberate, high-fidelity article capture; this project owns everything
Web Clipper is underpowered at:

- **Quick capture** of links (low-friction, from anywhere).
- **Headless full-page screenshots** and readable-content archival.
- **Duplication management** across the collection.
- **Remote / mobile capture** that works when Obsidian is closed.
- A clean, browsable **bookmark index** inside Obsidian.

**Product boundary (explicit):** like Karakeep, the backend is self-hosted (a
Docker container). The plugin without the container is *not* a standalone
Web-Clipper replacement, and that is intentional — the target user already
self-hosts (they are replacing Karakeep). Someone who will not run a container
should use Web Clipper.

---

## 2. Architecture

Two components in one monorepo:

```
obsidian-bookmarks/
  plugin/     Obsidian plugin (TypeScript + esbuild) -> plugin/main.js
  harness/    Capture backend, shipped as a Docker image (Node + Playwright)
  specs/      Spec Kit feature specs (spec/plan/tasks per feature)
  docs/       Design + phase docs (this file)
  spikes/     Feasibility probes (e.g. capture fidelity)
```

```
  bookmarks-server (Docker)                     Obsidian plugin (client)
  - Node + Playwright/Chromium                  - sole vault writer
  - capture engine            <--- HTTP + --->  - dedup gate
  - SQLite job queue                SSE         - field-mapping / folders
  - HTTP API + SSE               (token auth)   - settings: server URL + key
  - always-on = the container                   - custom browse view (later)
        ^   ^
        |   +-- phone / bookmarklet / Shortcut -> full capture (has Chromium)
        +------ runs anywhere Docker runs: mini, NAS, VPS, Docker Desktop
```

**Roles**

- **Container (backend):** the *only* thing that runs Chromium. Accepts capture
  jobs from any source, runs them, and stores results (screenshot bytes +
  extracted markdown + metadata) in a durable SQLite-backed queue.
- **Plugin (client):** the *only* thing that writes to the vault. Connects over
  the network (Tailscale / reverse proxy / LAN), drains completed jobs, writes
  notes + attachments, enforces dedup, renders the browse view.

**Why Docker (not a launchd daemon).** An earlier design used a per-OS launchd
daemon (as `obsidian-chat` does). That was rejected for a *distributable* plugin:
it mandates an OS-specific hidden install and (for timely delivery) an always-on
Obsidian. A single Docker image is cross-platform, one-command to run, is the
format Karakeep's own users already expect, and decouples the always-on piece
from Obsidian entirely.

**Why not an always-on Obsidian host (rejected 2026-10-02).** The alternative MVP
was a full plugin that captures in-process (Electron) and receives remote
captures through an HTTP listener in a desktop Obsidian left running on a host.
Rejected because: Electron's `webContents.capturePage` is viewport-only, so
full-page screenshots need an unproven CDP workaround inside Obsidian; Obsidian
mobile has no Electron/Node, so phone captures must reach a desktop host anyway
(the server again, in a GUI app that restarts, updates and sleeps); a headless
Linux host needs Xvfb; and arbitrary-URL browsing would run in the process that
holds the vault. Obsidian's headless Sync client does not run plugins, so it
does not remove the GUI requirement. An always-on Obsidian remains *optional*
as a drainer (§3).

**Why the container is required (no degraded fallback).** A no-server mode
(desktop-only in-plugin capture, lightweight mobile) was explicitly rejected: it
guts the differentiator (server-side headless capture + remote entry points) and
produces a half-working experience. The container is the product's backend, the
way Karakeep's server is.

### 2.1 Component boundaries (independently testable)

1. **Capture engine** — `url -> { screenshot?, markdown, metadata }`. No vault or
   queue knowledge. Pure-ish; the seam where fidelity is tested.
2. **Queue + API** — job lifecycle, no Chromium knowledge.
3. **Plugin writer + UI** — vault + dedup + browse view, no Chromium knowledge.

---

## 3. Delivery model (how results reach the vault)

Chosen approach: **SSE push + poll fallback, plugin as sole writer.**

- Container exposes an HTTP API + a durable queue; jobs move
  `pending -> running -> done -> delivered`.
- Plugin drains via **SSE** (`GET /events`, `job.done`) while connected, and a
  periodic **poll** (`GET /jobs?status=done`) as fallback (covers SSE drops,
  mobile backgrounding, and time the plugin was closed).
- **In-Obsidian capture** is a synchronous `POST /capture?wait=1` that the plugin
  waits on, then writes — through the *same* write code as a drained job.
- After writing, the plugin `POST /jobs/:id/delivered`; the container prunes on a
  retention policy (the vault holds the canonical copy).
- Because the Mac mini is always on, the user optionally runs **Obsidian on the
  mini** as a continuous drainer, so phone captures land within seconds and sync
  out. Not required — any Obsidian instance drains the queue when it runs.

Rejected alternatives: **poll-only** (laggy, in-Obsidian capture feels slow) and
**container writes to the vault directly** (two writers, sync-timing bugs; breaks
the sole-writer guarantee).

---

## 4. Data model, file layout & dedup

**One note per bookmark**, written by the plugin. The frontmatter is **not a
fixed schema** — it is a user-configurable **field mapping** (Web-Clipper-style):
the plugin defines the data points it can capture, and the user maps each to a
vault property name (reuse existing, rename, point at new, or disable).

Capturable data points and their default targets **for this user's vault**:

| Data point            | Default property        | Net-new? |
|-----------------------|-------------------------|----------|
| Page URL              | `source` (existing)     | no       |
| Title                 | `title`                 | no       |
| Description           | `description`           | no       |
| Author                | `author`                | no       |
| Domain / site         | `domain`                | no       |
| Captured timestamp    | `created`               | no       |
| Tags                  | `tags`                  | no       |
| Read status           | `status`                | no       |
| Screenshot ref        | `screenshot`            | **yes**  |
| Capture id (ULID)     | `capture_id`            | **yes**  |
| Capture origin        | *(off by default)*      | —        |

**Template format: Web Clipper's.** The field mapping is expressed as an
[Obsidian Web Clipper template](https://obsidian.md/help/web-clipper/templates)
(`noteNameFormat`, `path`, `properties`, `noteContentFormat`, triggers), so
users can import their existing Web Clipper templates. The container renders
notes with Web Clipper's own template engine (vendored from its MIT-licensed
repo at a pinned commit, injected into the captured page), so presets,
`meta:`, `schema:`, `selector:`, filters and logic match Web Clipper exactly
and remote captures pick a template by trigger. The plugin only names the
file, saves the screenshot and fills in its path.
Not supported: `highlights`, `selection` (no user in a headless browser),
prompt variables (deferred to the AI phase, Phase 6 in §9), and `behavior` other than
"create new note". Import lists anything it skipped. The URL and `capture_id`
properties are required whatever the template says (dedup and idempotency
depend on them). The MVP ships one built-in default template in this format;
import, triggers and `selector:` follow.

Out of the box for this vault, only `screenshot` and `capture_id` are new
properties; the URL flows into the existing `source` property. (Note: `source`
here is the URL. "Capture origin" — command/share/bookmarklet/api — is a
*different* datum, off by default, so there is no clash.)

The note **body** holds the readable-markdown extraction; the full-page
screenshot is an attachment referenced from frontmatter and embedded at the top
of the body.

**Configurable locations** (settings): the **bookmark notes folder** and the
**assets folder**, both editable. Defaults `Bookmarks/notes` and
`Bookmarks/assets`. Flat `notes/` folder (plays best with the browse view and
Obsidian in general). Filenames `slug(domain)-slug(title)-date`, numeric suffix
on collision.

**Capture output** (agreed): **full-page screenshot** + **readable markdown**.
(Single-file HTML archive and PDF are out of scope for now.)

**Dedup.** Key is the **normalized URL**, computed on the fly from the mapped URL
property and *not persisted*: lowercase host, strip `www.`, drop fragment, remove
tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, ...), sort remaining query
params, trim trailing slash; prefer the page's `<link rel="canonical">` when the
container reports one. The plugin keeps an in-memory `normalizedURL -> notePath`
index, built on load and kept warm via `metadataCache` events.

On capture, before writing:
- **No match** -> write new note.
- **Match (MVP)** -> no new note; a non-blocking Karakeep-style **"Already
  saved"** notice with **Open existing**. Drained jobs (nobody at the screen)
  follow the same rule and never block: the duplicate is skipped, acked, and
  logged.
- **Match (later)** -> the notice gains **Replace** / **Update** (refresh
  screenshot + markdown + captured timestamp, keep tags/status/manual edits) /
  **Merge** options, plus a setting for the default action on drained jobs.

The container may do a cheap `GET /precheck?url=` dup hint for early phone-side
warning, but the plugin is the authority.

---

## 5. The container (capture backend)

**5.1 Capture engine** (`url -> { screenshotBytes, markdown, metadata }`)
- **Playwright + bundled headless Chromium** (baked into the image; no
  first-run download). One shared browser, a fresh context per job.
- Per job: navigate (timeout + settle), auto-scroll to trigger lazy images,
  **full-page screenshot** (PNG; optional WebP re-encode), then extract readable
  content via **Defuddle** -> clean HTML -> markdown via **Turndown**. Pull
  metadata (title, description, author, site name, favicon, canonical link).
- Guardrails: per-job timeout, max page-height cap, blocked ad/analytics hosts,
  configurable user-agent, domain allow/deny list. Failures become job status,
  never process crashes.

**5.2 Queue + API** (SQLite via `better-sqlite3`)
- Jobs: `id (ULID)`, `url`, `status`, result blob paths, `error`, `source`,
  timestamps. Screenshot/markdown bytes to files in `data/`; row points at them.
- Single worker, concurrency 1–2 (configurable), so the host is not overwhelmed.
- Endpoints (all bearer-token auth, bound safely):
  - `POST /capture` — enqueue `{url, source}`; `?wait=1` blocks until `done`.
  - `GET /jobs?status=done` — poll fallback.
  - `GET /jobs/:id`, `GET /jobs/:id/asset/:kind` — metadata / screenshot / markdown.
  - `POST /jobs/:id/delivered` — plugin ack; enables pruning.
  - `GET /events` — SSE `job.done` push.
  - `GET /health`, `GET /precheck?url=` — status + cheap dup hint.

**5.3 Packaging**
- One monorepo, two release artifacts from one release workflow, **lockstep
  versions** (same `x.y.z` for plugin and server):
  - **Server:** `ghcr.io/dillguill/bookmarks-server:x.y.z` + `latest`;
    `docker-compose.yml` attached to the GitHub release; `docker compose up`.
  - **Plugin:** Obsidian community directory, which requires `manifest.json` at
    the repo root and a GitHub release tagged exactly `x.y.z` with `main.js` +
    `manifest.json` attached. The release step copies `plugin/manifest.json` to
    the root. BRAT installs betas from the same releases.
- `GET /health` reports an `apiVersion`; the plugin checks it and tells the user
  which side to update on mismatch. Plugin settings show the compose snippet
  and "Test connection", so the plugin is the single starting point.
- Retention: keep delivered results N days, then prune blobs (configurable).

---

## 6. The plugin (client, sole writer)

- **Connection & settings:** required = server URL + API token ("Test
  connection"). Plus field-mapping table, notes/assets folder pickers, dedup
  behavior, poll interval. No capture API keys in the plugin.
- **Draining (the SSE+poll design of §3):** SSE for low latency, poll for
  robustness, `delivered` ack after writing. Writes are **idempotent by
  `capture_id`** — a job seen twice (SSE+poll race, two devices) is a no-op.
- **Sole-writer + dedup in one place:** every write (drained or synchronous)
  goes through one `writeBookmark()` path: normalize URL -> check index ->
  new / Open / Re-capture / Add-anyway -> render frontmatter via the field map ->
  save note + screenshot attachment.
- **Commands / entry points (phased):** v1 ships the **in-Obsidian capture
  command** (palette + hotkey, clipboard-aware). Other entry points
  (bookmarklet, iOS Shortcut, mobile share) enqueue to the container and are
  drained by the plugin — so they need no plugin changes to add.
- **Mobile:** thin drainer + capture-trigger; never runs Chromium. Full-fidelity
  capture still happens in the container, so mobile is first-class.
- **Custom browse view (deferred):** a later-phase `ItemView` (screenshot grid,
  property filters, search, quick status/tag edits). **Not** a `.base` file, not
  required for v1.
- **Testability:** `writeBookmark()`, URL normalization, field-map rendering are
  pure functions; the drainer is a thin transport shell around them.

---

## 7. Organization & AI

- **Manual tags + auto metadata** by default (no AI dependency): capture fills
  the mapped metadata properties for filtering/browsing.
- **Opt-in AI auto-tagging** (Phase 6, its own stage): capture can suggest tags/summary via
  a BYOK LLM (reuse `obsidian-chat`'s provider setup style). Off by default,
  per-capture or batch. Adds an AI dependency only when enabled.

---

## 8. Security & auth

- **Transport:** plugin -> container over Tailscale (recommended), a
  TLS reverse proxy, or LAN. Container defaults to a safe bind; docs steer users
  to Tailscale so it is never bare on the WAN.
- **AuthN:** per-device **bearer token**, individually revocable in container
  config. Stored via Obsidian `safeStorage`/keychain — never in `data.json` or
  logs.
- **SSRF (the primary risk):** the container fetches arbitrary user URLs with a
  real browser. Block private/link-local/loopback ranges by default (allowlist
  escape hatch for wanted intranet pages), cap redirects, enforce timeout and
  page-size limits, run Chromium locked down (no extensions/downloads). Lives in
  the capture engine with its own tests.
- **Content trust:** captured HTML/markdown is untrusted; rendered as normal note
  content (Obsidian sandboxes markdown), never executed. Screenshots are inert.
- **Least privilege:** the container has **no vault access** (plugin is sole
  writer); a compromised container can only enqueue/serve capture results, which
  the plugin still dedups and the user can review.

---

## 9. Phasing / roadmap

Each phase is independently useful with a concrete exit.

- **Spike 0 — capture fidelity.** Prove Playwright-in-Docker gives good
  full-page screenshots + Defuddle markdown on real-world sites (SPA, paywall-ish,
  lazy-loaded). Throwaway. *Exit:* confidence in the capture stack.
  *Done 2026-10-02* (16 real sites, `spikes/capture-fidelity/README.md`).
- **Phase 1 — container MVP.** Capture engine + SQLite queue + HTTP API + token
  auth + published image + `docker compose up`. *Exit:* `POST /capture` a URL,
  get screenshot + markdown + metadata. *Done 2026-10-02* (PR #5), except
  the published image, which waits on the first release tag.
- **Phase 2 — plugin MVP (desktop).** Settings (URL/token/field-map/folders),
  `writeBookmark()` + dedup, SSE+poll drainer, in-Obsidian capture command.
  *Exit:* paste a URL in Obsidian -> deduped bookmark note with screenshot +
  readable body in the vault. *Done 2026-10-02* (PR #5), with poll-only
  draining; SSE is deferred.
- **Phase 3 — remote & mobile entry points.** Bookmarklet + iOS Shortcut +
  mobile share -> enqueue to container; mobile plugin drains. *Exit:* capture from
  the phone with Obsidian closed; appears next time Obsidian runs.
- **Phase 4 — the browse view.** Optional custom `ItemView`: screenshot grid,
  property filters, search, quick edits. *Exit:* a clean Karakeep-like browse
  experience inside Obsidian.
- **Phase 5 — power features.** Screenshot backfill for pending captures,
  archival retention/pruning policy, bulk re-capture. (Done 2026-10-02:
  screenshot style setting, full page / banner / none with per-site
  overrides, as server-side shared settings with a settings page; Web Clipper
  template import; notes rendered by Web Clipper's own engine, which brings
  `{{schema:…}}`, `{{meta:…}}`, `{{selector:…}}`, filters and logic.) *Exit:* the Karakeep-replacement feature set is
  complete, without any AI dependency.
- **Phase 6 — AI (opt-in, its own stage).** Kept separate so nothing before it
  needs a model. BYOK provider settings (OpenRouter, Ollama and the like, keys
  stored only on the server), Web Clipper prompt variables (`{{"summary of
  page"}}`), auto-tagging and summaries. Off by default. *Exit:* templates
  that use prompt variables render as they do in Web Clipper.

---

## 10. Key decisions (log)

1. **Positioning:** replace Karakeep, keep Web Clipper.
2. **Backend:** dedicated capture service, shipped as a **Docker image**
   (rejected: per-OS launchd daemon; rejected: no-server degraded mode).
3. **Backend required** — no standalone/degraded fallback.
4. **Data:** one note per bookmark; **configurable field mapping**; only
   `screenshot` + `capture_id` preset; URL -> existing `source` property.
5. **Delivery:** SSE push + poll fallback; **plugin is the sole vault writer**;
   idempotent by `capture_id`.
6. **Capture output:** full-page screenshot + readable markdown.
7. **Dedup:** normalized-URL match (computed, not stored). MVP: non-blocking
   "Already saved" notice, drained duplicates skipped; Replace / Update / Merge
   later (2026-10-02).
8. **Capture stack:** Playwright + Chromium + Defuddle + Turndown; SQLite queue.
9. **Browse UI:** optional custom plugin view, **not** an Obsidian `.base`;
   deferred.
10. **AI tagging:** opt-in, off by default; reuse BYOK provider style.
11. **MVP architecture:** thin plugin + Docker server; always-on Obsidian host
    rejected (§2, 2026-10-02).
12. **Templates:** Web Clipper template format, importable (§4, 2026-10-02).
13. **Shipping:** one monorepo, lockstep versions, GHCR image + community
    plugin release (§5.3, 2026-10-02).
