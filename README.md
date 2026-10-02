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
   cp .env.example .env    # set BOOKMARKS_TOKENS, e.g. desktop-token,phone-token
   docker compose up --build
   ```

   Check it: `curl -H "Authorization: Bearer desktop-token" http://127.0.0.1:8787/health`
   should return `{"status":"ok","apiVersion":1,...}`.

2. **Install the plugin** into a test vault:

   ```sh
   npm install
   npm run build -w plugin
   mkdir -p <vault>/.obsidian/plugins/bookmarks
   cp plugin/main.js plugin/manifest.json <vault>/.obsidian/plugins/bookmarks/
   ```

   Enable **Bookmarks** under Settings → Community plugins, then in its settings set
   the server URL (`http://127.0.0.1:8787`), add the API token, and press **Test**.

3. **Capture from Obsidian**: copy a URL, run **Bookmarks: Capture URL** from the
   command palette (or the ribbon icon). The note opens when the capture finishes,
   with the screenshot embedded at the top. Capturing the same URL again shows
   "Already saved" with a link to the existing note.

4. **Capture from elsewhere** (the phone path): with Obsidian closed, enqueue a URL

   ```sh
   curl -X POST -H "Authorization: Bearer phone-token" \
     "http://127.0.0.1:8787/capture?origin=shortcut&url=https://example.com/"
   ```

   then open Obsidian. Finished captures are written on startup and every poll
   interval (60s by default), or straight away with **Bookmarks: Fetch finished
   captures now**. To share from a phone, see
   [Saving bookmarks from your phone](docs/phone-capture.md) (Tailscale plus an
   iOS Shortcut).

Sites that block the capture (bot walls, hard paywalls) still get a note with the
link and a "Capture failed" callout but no screenshot, so nothing sent from the phone
is lost.

**Settings page.** Open the server in a browser (`http://127.0.0.1:8787/`, or your
Tailscale address from a phone) and sign in with one of your API tokens. The plugin's
settings have an **Open settings page** button too. Everything there is stored on the
server, so every device and every phone Shortcut uses the same settings:

- **Capture**: screenshot style (full page, banner for the first screen only, or
  none), plus **Sites with banner screenshots** and **Sites without screenshots**
  (one site per line, subdomains included), which override the style.
- **Templates**: note name, note location, properties and note content, in Obsidian
  Web Clipper's template format. **Import template** takes a Web Clipper template export or Web Clipper's full
  settings export (only the templates are read). Schema, meta, selector and prompt
  variables aren't filled yet and come out empty.
  The first template whose trigger (a URL prefix or `/regex/`) matches a capture is
  used; otherwise the default, top one.

Server URL, API token, screenshot folder and poll interval are set per device in the
plugin; the token stays in each device's secret storage.

### Server API

All endpoints need `Authorization: Bearer <token>`.

| Endpoint | What |
|---|---|
| `POST /capture` | Enqueue `{url, origin}` (JSON, form, plain-text URL, or `?url=`). `?wait=1` holds up to 60s for the result; 202 means still running. |
| `GET /jobs?status=done,failed` | Finished captures waiting to be written. |
| `GET /jobs/:id` | One job. |
| `GET /jobs/:id/asset/screenshot` / `markdown` | Capture output. |
| `POST /jobs/:id/delivered` | Plugin ack after writing; blobs are pruned after `BOOKMARKS_RETENTION_DAYS`. |
| `GET /settings` / `PUT /settings` | Shared settings `{screenshotStyle, bannerSites, noScreenshotSites, templates}`. |
| `GET /ui/` | The settings page (static, no token needed to load it; it signs in with one). |
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
runs the server without Docker (set `BOOKMARKS_TOKENS`, and `BOOKMARKS_CHROMIUM_PATH`
if Playwright's browser isn't installed).

Releasing: `node scripts/set-version.mjs x.y.z`, commit, then push tag `x.y.z`
(no `v`). The release workflow publishes `ghcr.io/dillguill/bookmarks-server:x.y.z`
and a GitHub release with `main.js`, `manifest.json` and a compose file.

Plugin: `npm run dev -w plugin` rebuilds `plugin/main.js` on change. Symlink or
copy `plugin/` (`main.js`, `manifest.json`) into `<vault>/.obsidian/plugins/bookmarks/`.

Server:

```sh
cd harness
cp .env.example .env    # set BOOKMARKS_TOKENS
docker compose up --build
```
