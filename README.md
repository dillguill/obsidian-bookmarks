# obsidian-bookmarks

Save clippings similar to [Karakeep](https://karakeep.app) with rich metadata to Obsidian.

A self-hosted capture server takes full-page screenshots and readable markdown of
links you save from anywhere; an Obsidian plugin drains finished captures into
your vault as deduplicated bookmark notes. See the
[design doc](docs/superpowers/specs/2026-09-18-obsidian-bookmarks-design.md).

## Layout

| Path       | What                                                             |
|------------|------------------------------------------------------------------|
| `plugin/`  | Obsidian plugin (TypeScript + esbuild), the sole vault writer    |
| `harness/` | Capture backend `bookmarks-server` (Node + Playwright), Docker   |
| `specs/`   | Spec Kit feature specs                                           |
| `docs/`    | Design and phase docs                                            |
| `spikes/`  | Feasibility probes                                               |

## Try it locally

1. **Start the server** (Docker):

   ```sh
   cd harness
   cp .env.example .env    # set TZ
   docker compose up --build
   ```

   Open `http://127.0.0.1:8787/` and create your sign-in account with the setup
   code from the server's log (`docker compose logs bookmarks-server`). Then, under
   **API keys**, create a key for each device (say "MacBook" and "iPhone Shortcut").
   Check one: `curl -H "Authorization: Bearer <key>" http://127.0.0.1:8787/health`
   should return `{"status":"ok","apiVersion":6,...}`.

2. **Install the plugin** with [BRAT](https://github.com/TfTHacker/obsidian42-brat):
   in BRAT's settings choose **Add beta plugin** and enter `dillguill/obsidian-bookmarks`.
   BRAT installs the latest release and keeps it updated. To try a local build
   instead:

   ```sh
   npm install
   npm run build -w plugin
   mkdir -p <vault>/.obsidian/plugins/obsidian-bookmarker
   cp plugin/main.js plugin/manifest.json <vault>/.obsidian/plugins/obsidian-bookmarker/
   ```

   Enable **Bookmarker** under Settings → Community plugins, then in its settings set
   the server URL (`http://127.0.0.1:8787`), add the API key (saved in Obsidian's
   secrets on that device), and press **Test**.

3. **Capture from Obsidian**: copy a URL, run **Bookmarks: Capture URL** from the
   command palette (or the ribbon icon). The note opens when the capture finishes,
   with the screenshot embedded at the top. Capturing the same URL again shows
   "Already saved" with **Open existing**, **Replace** (capture again into the
   same note) and **Save as new**. **Bookmarks: Capture current bookmark again**
   refreshes the open note the same way. **Bookmarks: Update note from
   source** fetches the open note's page again (any note with a URL
   property, even one this plugin didn't make) and lets you pick which
   properties to add, replace or add to a list, whether to add the page content,
   and which images to save, placed before or after the note's body or in place of it.
   On a note with a TikTok player, **Save TikTok offline** swaps the player for
   the video (or a carousel's photos) saved in the vault.

4. **Capture from elsewhere** (the phone path): with Obsidian closed, enqueue a URL

   ```sh
   curl -X POST -H "Authorization: Bearer <key>" \
     "http://127.0.0.1:8787/capture?origin=shortcut&url=https://example.com/"
   ```

   then open Obsidian. Finished captures are written on startup and every poll
   interval (60s by default), or straight away with **Bookmarks: Fetch finished
   captures now**. To share from a phone, see
   [Saving bookmarks from your phone](docs/phone-capture.md) (Tailscale plus an
   iOS Shortcut). In a desktop browser, drag **Save to Bookmarks** from the settings
   page (General) to your bookmarks bar and click it on any page.

Sites that block the capture (bot walls, hard paywalls) still get a note with the
link and a "Capture failed" callout but no screenshot, so nothing sent from the phone
is lost. The callout's **Retry capture** link captures the page again into the same
note. Saved links drop tracking params (`utm_*`, `fbclid`…) and the ones bot walls
add (`js_challenge`, `__cf_chl_*`…).

**Settings page.** Open the server in a browser (`http://127.0.0.1:8787/`, or your
Tailscale address from a phone) and sign in with your username and password. The plugin's
settings have an **Open settings page** button too. Everything there is stored on the
server, so every device and every phone Shortcut uses the same settings:

- **API keys**: create a named key for each device or Shortcut, see when each was
  last used, and revoke one without touching the others. A key is shown once, when
  it's made. Tokens in `BOOKMARKS_TOKENS` in `.env` still work too.
  Forgot the password? `docker compose exec bookmarks-server node dist/reset-login.js`
  removes the account (keys stay) so the page offers to create it again.
- **General**: **Hide capture ID** leaves `capture_id` out of new notes; the plugin
  then remembers which captures it wrote, and URL dedup still skips a page that's
  already saved. The browser bookmarklets are here too.
- **Templates**: note name, note location, properties and note content, in Obsidian
  Web Clipper's template format. **Import template** takes a Web Clipper template export or Web Clipper's full
  settings export (only the templates are read). Notes are rendered by
  [Web Clipper's own template engine](https://github.com/obsidianmd/obsidian-clipper)
  running in the server's browser, so filters, logic, `{{schema:…}}`, `{{meta:…}}` and
  `{{selector:…}}` behave as they do in Web Clipper. Prompt (AI) variables,
  `{{highlights}}` and `{{selection}}` come out empty. A template picked at capture
  time wins; otherwise the first template whose trigger (a URL prefix, `/regex/` or
  `schema:@Type`) matches, else the default, top one. Set `TZ` in `.env` so
  `{{date}}` uses your time zone.
- **Screenshots and PDF** are template variables holding the file's vault path:
  `{{screenshot_page}}` (whole page), `{{screenshot_banner}}` (first screen),
  `{{screenshot_mobile}}` (first screen at phone width), `{{screenshot_article}}`
  (main content block only), `{{screenshot_thumbnail}}` (small first screen), each
  also as `_dark` for the site's dark mode (`{{screenshot_page_dark}}`…), and
  `{{pdf_page}}`, plus `{{image_local}}`, the page's `{{image}}` saved in the vault.
  Write
  `![[{{screenshot_page}}]]` to show one or `[[{{screenshot_page}}]]` to link it, in
  the note content or a property. A capture makes only the files its template
  uses. Older templates' `{{screenshot}}`, `{{screenshot_link}}` and
  `{{screenshot_embed}}` are rewritten when loaded or imported.

- **TikTok** posts fill `tiktok_*` variables from the post's own data, since the
  page's title, description and image say little: `{{tiktok_title}}` (caption's
  first line), `{{tiktok_description}}` (whole caption), `{{tiktok_published}}`,
  `{{tiktok_author}}`, `{{tiktok_author_handle}}`, `{{tiktok_id}}`,
  `{{tiktok_embed}}` (a player that plays in the note, or swipes through a photo
  carousel) and `{{tiktok_thumbnail}}` (the cover saved in the vault, since its link
  expires). `{{tiktok_save}}` saves the post in the vault and embeds it, so it
  plays offline: the video (`note-tiktok-video.mp4`, path in `{{tiktok_video}}`)
  or a carousel's photos (paths in `{{tiktok_image_1}}`…, counted by
  `{{tiktok_image_count}}`; `{{tiktok_images}}` embeds only photos). `{{tiktok_transcript}}` is what's said, from TikTok's captions in the
  language spoken, and `{{tiktok_transcript_timestamps}}` the same one line per
  caption with its time (`[0:03] …`); empty when TikTok has no captions, as for
  videos without speech. They're empty on other sites. [docs/templates/tiktok.json](docs/templates/tiktok.json) is a template to import.

Server URL, API key, screenshot folder and poll interval are set per device in the
plugin; the key stays in each device's secret storage.

### Server API

All endpoints need `Authorization: Bearer <key>`, with a key from the settings page's
**API keys** or a token from `BOOKMARKS_TOKENS`. The settings page itself uses a
session cookie from signing in (`/auth/*`); only that session can manage keys
(`GET`/`POST /keys`, `DELETE /keys/:id`) or change the password.

| Endpoint | What |
|---|---|
| `POST /capture` | Enqueue `{url, origin, template?, files?}` (`template` picks one by name; otherwise triggers decide; `files` lists capture files to make even if the template doesn't use them) (JSON, form, plain-text URL, or `?url=`). `?wait=1` holds up to 60s for the result; 202 means still running. Jobs with origin `enrich` are read by id and never listed for delivery. |
| `GET /jobs?status=done,failed` | Finished captures waiting to be written. |
| `GET /jobs/:id` | One job. |
| `GET /jobs/:id/asset/:kind` | Capture output: a screenshot, `pdf_page`, `image_local`, `tiktok_thumbnail` or `tiktok_image_N` named after its variable (only those the template uses), `markdown`, or the rendered `note`. |
| `POST /jobs/:id/delivered` | Plugin ack after writing; blobs are pruned after `BOOKMARKS_RETENTION_DAYS` (an update's blobs right away). |
| `POST /jobs/:id/cancel` | Stops a pending or running capture; it fails as `cancelled` and its result is thrown away. |
| `GET /settings` / `PUT /settings` | Shared settings `{templates, propertyTypes, hideCaptureId}`. |
| `GET /templates` | Template names in order, for a Shortcut's "Choose from List". |
| `GET /ui/` | The settings page (static, no key needed to load it; it signs in with a username and password). |
| `GET /health` | `{status, apiVersion, version}`; the plugin warns when `apiVersion` doesn't match. |

## Development

Requires Node 22.12+.

```sh
npm install
npm run typecheck
npm test
npm run build        # plugin/main.js + harness/dist
```

The capture engine's real-browser tests run when a Chromium is available:
`BOOKMARKS_CHROMIUM_PATH=/path/to/chrome npm test -w harness`. `npm run dev -w harness`
runs the server without Docker (set `BOOKMARKS_CHROMIUM_PATH` if Playwright's
browser isn't installed).

Releasing: `node scripts/set-version.mjs x.y.z`, commit, then push tag `x.y.z`
(no `v`). The release workflow publishes `ghcr.io/dillguill/bookmarks-server:x.y.z`
and a GitHub release with `main.js`, `manifest.json` and a compose file, which BRAT
picks up.

Plugin: `npm run dev -w plugin` rebuilds `plugin/main.js` on change. Symlink or
copy `plugin/` (`main.js`, `manifest.json`) into `<vault>/.obsidian/plugins/bookmarks/`.

Server:

```sh
cd harness
cp .env.example .env    # set TZ
docker compose up --build
```
