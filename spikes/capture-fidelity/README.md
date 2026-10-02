# Spike 0: capture fidelity

Throwaway probe of the capture stack from design §5.1: Playwright + Chromium,
auto-scroll for lazy content, full-page PNG, Defuddle (run inside the page, on
the live DOM) -> Turndown markdown, plus metadata.

```sh
cd spikes/capture-fidelity
npm install
npm run fixtures &                      # local hard-case pages on :4599
node capture.mjs http://127.0.0.1:4599/lazy http://127.0.0.1:4599/spa \
  http://127.0.0.1:4599/spa-fetch http://127.0.0.1:4599/endless
node capture.mjs https://some.real/article ...   # the real test
```

Outputs land in `out/` (`.png`, `.md`, `.json` per URL, plus `report.json`).
Knobs: `MAX_HEIGHT` (20000), `NAV_TIMEOUT` (30000), `QUIET_MS` (500),
`SETTLE_MAX` (5000), `CHROMIUM_PATH` (use a local Chromium instead of
Playwright's download), `USER_AGENT` (override the `HeadlessChrome` UA).

## Results so far (2026-10-02, local fixtures only)

The cloud environment this ran in blocks outbound web access, so real sites
are still untested. Fixture results, 1280px viewport:

| Fixture | What it checks | Result |
|---|---|---|
| `/lazy` | images that load only when scrolled into view; nav/footer chrome | All 5 images present in the screenshot; nav and footer stripped from markdown; title/description/author/canonical extracted. ~2s. |
| `/spa` | client-side render on a timer | Rendered content captured. ~1.5s. |
| `/spa-fetch` | client-side render after a slow (800ms) API call | Rendered content captured (`networkidle` covers it). ~2.2s. |
| `/endless` | infinite scroll | Stops at `MAX_HEIGHT`, screenshot clipped to 20000px. ~7s. Defuddle finds no article (0 words). |

Findings to carry into the capture engine:

1. **Settle wait.** `load` + `networkidle` + a DOM-quiet window (MutationObserver,
   500ms, capped) before scrolling. Cheap and catches renders `networkidle`
   misses.
2. **Height cap works**, but infinite pages cost the full scroll budget (~7s).
   Worth a time cap on scrolling as well as a height cap.
3. **Non-article pages** (feeds, app pages) give empty markdown. The note should
   still be written with metadata + screenshot; consider a body-text fallback
   below a word threshold.
4. **Markdown images are remote URLs**, not local copies. Fine for the MVP
   (the screenshot is the archive); downloading images is a later option.
5. Defuddle's UMD bundle (`defuddle/full`) injects with `page.addScriptTag`, so
   extraction runs on the real rendered DOM with no jsdom.

## Real sites (2026-10-02, cloud datacenter IP)

16 URLs, 1280px viewport, run once with Playwright's default UA and once with
`USER_AGENT` set to a desktop Chrome string. Screenshots and markdown were
checked by hand.

| Site | Result |
|---|---|
| Wikipedia, paulgraham.com, martinfowler.com, Substack (ACX) | Clean markdown and screenshot. PG and ACX hit the 20000px cap. |
| MDN, GitHub repo | Defuddle injection refused by the page's CSP until the context used `bypassCSP: true`; then clean markdown. |
| Stack Overflow | Full question + answers, but the cookie banner sits on top of the screenshot. Served with HTTP 403 and real content. 52000px page, ~19s. |
| The Verge | Paywall overlay in the screenshot; markdown stops at the paywall (~290 words). ~35s. Body is the scroller, so `documentElement.scrollHeight` reads 800 and lazy content below isn't scrolled into view. |
| Obsidian Docs (Publish) | Markdown fine; screenshot is one viewport because content scrolls inside a container, not the page. |
| Hacker News front page | Fine (list page, metadata + links). |
| YouTube, Reddit, X | Blocked with the default UA (429, "blocked by network security", navigation failure). All load with a browser UA. YouTube gives title + description; Reddit subreddit gives ~0 words (feed page); X markdown picks a reply, not the post itself. |
| Medium, Allrecipes | Cloudflare "Just a moment" challenge with either UA. |
| NYT | 403 with either UA. |

Medium, Allrecipes and NYT also 403 a plain `curl` from this IP, so they may be
blocking the datacenter address rather than the browser; a run from a home
server would tell.

What this changes for the capture server:

1. **Set `bypassCSP: true`** on the browser context, or inject Defuddle via
   `page.evaluate` source. Without it, major sites (GitHub, MDN) fail.
2. **Send a normal desktop UA** (and probably `Accept-Language`). The
   `HeadlessChrome` default is blocked outright by YouTube, Reddit and X.
3. **Detect block/challenge pages** ("Just a moment...", "Attention Required!",
   "You've been blocked", 403/429 with near-empty text) and mark the job
   `blocked` instead of writing a junk note. Don't treat non-2xx as failure on
   its own: Stack Overflow returned 403 with the full page.
4. **Scroll height**: measure `max(documentElement, body)` scrollHeight, and for
   inner-scroller layouts (docs sites, app shells) find the largest scrollable
   element; otherwise the screenshot is one viewport.
5. **Hard time cap per capture** (~20s), not just a height cap: long pages and
   ad-heavy news sites took 18-35s.
6. **Overlays**: hide common cookie/consent/paywall banners before the
   screenshot (a small selector list or a consent-dismiss library). Paywalled
   text is out of scope.
7. **Site-specific extractors** for X (post text from meta/oEmbed) and feed
   pages; Defuddle's generic pick is wrong on X and empty on Reddit listings.
8. **Normalize metadata**: resolve relative favicons (Wikipedia's is
   `/static/...`), and record the final URL and canonical (Wikipedia redirected
   to a different title) for dedup.
9. **Screenshot size**: full-page PNGs reach 3-4.5MB; consider JPEG/WebP for
   the archive copy.
