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
   should return `{"status":"ok","apiVersion":8,...}`.

2. **Install the plugin** with [BRAT](https://github.com/TfTHacker/obsidian42-brat):
   in BRAT's settings choose **Add beta plugin** and enter `dillguill/obsidian-bookmarks`.
   BRAT installs the latest release and keeps it updated. To try a local build
   instead:

   ```sh
   npm install
   npm run build -w plugin
   mkdir -p <vault>/.obsidian/plugins/obsidian-bookmarker
   cp plugin/main.js plugin/manifest.json plugin/styles.css <vault>/.obsidian/plugins/obsidian-bookmarker/
   ```

   Enable **Bookmarker** under Settings → Community plugins, then in its settings set
   the server URL (`http://127.0.0.1:8787`), add the API key (saved in Obsidian's
   secrets on that device), and press **Test**. **URL property** (default `source`)
   is the property that holds a note's web address; type to pick one of your
   vault's properties. Templates' own URL properties are read too.

3. **Capture from Obsidian**: copy a URL, run **Bookmarks: Capture URL** from the
   command palette (or the ribbon icon). Like Obsidian Web Clipper, the window
   reads the page straight away and shows the note the template makes: file
   name, properties (typed the way your vault types them) and body, all
   editable, with **Add property** and a folder to save to. Switching template
   re-renders without loading the page again. **Add to Obsidian** writes exactly
   what you see at once; screenshots the note uses are added a moment later,
   where the template puts them, so the note never links to a missing file.
   The button's menu picks between that and **Copy Markdown** without saving, so
   you can look the note over first; the template's **On capture** setting picks
   the starting one. Media the template marks `|local` (see Templates) is
   downloaded after Add and replaces its web address in the note; to save other
   media for one note, run **Download media for current note** afterwards. A
   page that's already saved says so, with a link to the note.

   **Bookmarks: Update note from source** shows the open note (any note with a
   URL property, even one this plugin didn't make) and fetches its page only when
   you press **Fetch from source**. Each property then shows what the note has and
   what the page gives: keep it, use the page's, merge lists, type your own, or
   remove it; the body can be kept, added to or replaced (with a preview of the
   change). Editing the file name or folder renames or moves the note. **Replace
   whole note** sets everything to the page's version. A template property set to
   `{{template}}` records which template made a note, so the next update opens
   on it.

   **Bookmarks: Download media for current note**, like Obsidian's own Download
   attachments, lists the note's media, each ticked: a TikTok post's video or
   photos and cover, YouTube, X, Vimeo and Instagram videos, images embedded from
   the web, and image addresses in properties. Each one downloaded replaces its
   player, embed or address in the note; one that fails is reported and left as
   it was. Images are fetched by the plugin; posts and videos by the server, one
   at a time with a pause between downloads from one site, through yt-dlp (or the
   browser for TikTok photo posts). Captures only download media marked
   `|local`: otherwise notes show the TikTok player and the web addresses until
   you download.
   Screenshots and downloaded media go where Obsidian's "Default location for new
   attachments" says, unless the plugin's **Attachment folder override** is set.

   **Bookmarks: Find duplicate bookmarks** lists notes that point at the same page
   (http or https, `www.`, tracking params and trailing slashes don't matter), and
   **Merge duplicates of this note** opens the open note's group. Mark each note
   **Keep** (one note survives, under its own name), **Merge** (its properties and
   body go into the kept note), **Delete** or **Separate** (notes that share a URL on
   purpose, such as sections of one page; they're remembered and stop showing up).
   Properties that agree or are lists combine by themselves; for the rest you pick
   a value. Links to the removed notes are pointed at the kept note, their names
   become aliases, and screenshots only they used can be trashed with them. The
   "Already saved" notice offers **Merge duplicates** too when a page has copies.

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
is lost. The callout's **Retry capture** link opens Update from source on that note,
with Replace whole note chosen. A phone capture whose template marks media
`|local` has that media downloaded on the server straight away, and the plugin
puts it in the note when it collects the capture. Saved links drop tracking params (`utm_*`, `fbclid`…) and the ones bot walls
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
  `{{pdf_page}}`.
  Write
  `![[{{screenshot_page}}]]` to show one or `[[{{screenshot_page}}]]` to link it, in
  the note content or a property. A capture makes only the files its template
  uses. Older templates' `{{screenshot}}`, `{{screenshot_link}}` and
  `{{screenshot_embed}}` are rewritten when loaded or imported.
- **Saving media: `|local`.** Media stays where it lives on the web: an image is
  its web address and a TikTok post is the player. Add `|local` to keep a copy in
  the vault instead: the note is written with the web address, then the file is
  downloaded and put in its place, as **Download media** would. Use it last,
  after any other filters: `[[{{tiktok_thumbnail|local}}]]` in a property keeps a
  TikTok cover, `{{tiktok_embed|local}}` the post's video or photos, and
  `![]({{image|local}})` the page's main image. On anything that isn't a web
  address it does nothing, and in a property, which can only link one file, a
  value that isn't a single address (the post's player) comes out blank. Web Clipper itself doesn't know `|local`, so a
  template shared with it gets the plain address. The older `{{image_local}}`,
  `{{tiktok_save}}` and `{{tiktok_image_N}}` are rewritten to their `|local` forms.

- **TikTok** posts fill `tiktok_*` variables from the post's own data, since the
  page's title, description and image say little: `{{tiktok_title}}` (caption's
  first line), `{{tiktok_description}}` (whole caption), `{{tiktok_published}}`,
  `{{tiktok_author}}`, `{{tiktok_author_handle}}`, `{{tiktok_id}}`,
  `{{tiktok_embed}}` (a player that plays in the note, or swipes through a photo
  carousel), `{{tiktok_video}}` and `{{tiktok_images}}` (the same player, only for
  a video or a photo post), `{{tiktok_thumbnail}}` (the cover's web address;
  TikTok's cover links expire within days, so use `|local` to keep it) and
  `{{tiktok_image_count}}`. `{{tiktok_transcript}}` is what's said, from TikTok's captions in the
  language spoken, and `{{tiktok_transcript_timestamps}}` the same one line per
  caption with its time (`[0:03] …`); empty when TikTok has no captions, as for
  videos without speech. They're empty on other sites. [docs/templates/tiktok.json](docs/templates/tiktok.json) is a template to import.

Server URL, API key, attachment folder override and poll interval are set per
device in the plugin; the key stays in each device's secret storage. The plugin
keeps the server's property types in step with the vault's, so phone captures
format values the same way.

**Video downloads and your network.** The server never fetches private-network
addresses (your router, NAS, other tailnet machines) unless
`BOOKMARKS_ALLOW_PRIVATE_NETWORKS=1`. The browser checks every page it loads;
yt-dlp sends every request through a proxy inside the server that checks each
host, connects only to the address it checked, and checks redirects again.
`BOOKMARKS_YTDLP_PATH=` (empty) turns video downloads off. yt-dlp is pinned in
`harness/Dockerfile` with its checksum; bump `YTDLP_VERSION` and both checksums
together when sites change and downloads start failing.

### Server API

All endpoints need `Authorization: Bearer <key>`, with a key from the settings page's
**API keys** or a token from `BOOKMARKS_TOKENS`. The settings page itself uses a
session cookie from signing in (`/auth/*`); only that session can manage keys
(`GET`/`POST /keys`, `DELETE /keys/:id`) or change the password.

| Endpoint | What |
|---|---|
| `POST /capture` | Enqueue `{url, origin, template?, files?}` (`template` picks one by name; otherwise triggers decide; `files` lists capture files to make even if the template doesn't use them) (JSON, form, plain-text URL, or `?url=`). `?wait=1` holds up to 60s for the result; 202 means still running. Jobs with origin `enrich` are read by id and never listed for delivery. `mode: "preview"` (plugin only) publishes the rendered note as soon as the page settles and holds the page open for the calls below. |
| `POST /jobs/:id/render` | `{template}`: renders a held preview with another template, without loading the page again. 410 once the page was let go. |
| `POST /jobs/:id/files` | `{files, finish}`: takes screenshots or the PDF on a held preview's page; with `finish` the job is done afterwards and drain delivers it. |
| `POST /jobs/:id/release` | `{keep}`: lets go of a held page; `keep` when the note was written, else the job is thrown away. Pages are let go after 2 minutes unused. |
| `POST /media` | `{url, want}`: queues a media download (`want`: `video`, `photos`, `cover`). One runs at a time, with a pause between downloads from one site. |
| `GET /jobs?status=done,failed` | Finished captures waiting to be written; `&origin=media` lists media downloads instead. |
| `GET /jobs/:id` | One job. |
| `GET /jobs/:id/asset/:kind` | Capture output: a screenshot or `pdf_page` named after its variable (only those the note uses), `markdown`, or the rendered `note`; a media download's `media_video`, `media_cover` and `media_photo_N`. |
| `POST /jobs/:id/delivered` | Plugin ack after writing; blobs are pruned after `BOOKMARKS_RETENTION_DAYS` (an update's blobs right away). |
| `POST /jobs/:id/cancel` | Stops a pending or running capture; it fails as `cancelled` and its result is thrown away. |
| `GET /settings` / `PUT /settings` | Shared settings `{templates, propertyTypes, hideCaptureId, schemaRevision}`; a template's `onCapture` is `add` or `copy`. |
| `GET /templates` | Template names in order, for a Shortcut's "Choose from List". |
| `GET /ui/` | The settings page (static, no key needed to load it; it signs in with a username and password). |
| `GET /health` | `{status, apiVersion, version, media: {ytdlp}}`; the plugin warns when `apiVersion` doesn't match. `ytdlp` is null when video downloads are off. |

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
