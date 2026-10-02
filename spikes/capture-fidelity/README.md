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
Playwright's download).

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

Still to do before calling the stack proven: run against ~15 real sites
(news, Medium/Substack, GitHub, YouTube, docs sites, a paywalled site, a
cookie-wall site) and look at the screenshots and markdown by hand.
