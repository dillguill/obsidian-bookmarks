// Spike 0: capture a URL the way the container will (design §5.1) and report
// what came out. Usage: node capture.mjs <url> [<url> ...]
// Writes out/<n>-<host>.{png,md,json}. Set CHROMIUM_PATH to use a local build.
import { chromium } from 'playwright';
import TurndownService from 'turndown';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const DEFUDDLE = require.resolve('defuddle/full');
const VIEWPORT = { width: 1280, height: 800 };
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT ?? 20000);
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT ?? 30000);
// Headless Chromium's default UA says "HeadlessChrome", which some sites block.
const USER_AGENT = process.env.USER_AGENT || undefined;

// networkidle fires before client-side renders that run on timers, so also wait
// until the DOM stops changing for QUIET_MS (capped at SETTLE_MAX).
const QUIET_MS = Number(process.env.QUIET_MS ?? 500);
const SETTLE_MAX = Number(process.env.SETTLE_MAX ?? 5000);
function waitForDomQuiet(page) {
  return page.evaluate(({ quiet, max }) => new Promise((resolve) => {
    const start = performance.now();
    let timer;
    const done = () => { obs.disconnect(); clearTimeout(cap); resolve(Math.round(performance.now() - start)); };
    const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
    obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    timer = setTimeout(done, quiet);
    const cap = setTimeout(done, max);
  }), { quiet: QUIET_MS, max: SETTLE_MAX });
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('usage: node capture.mjs <url> [<url> ...]');
  process.exit(1);
}

await mkdir('out', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const rows = [];

for (const [i, url] of urls.entries()) {
  const t0 = Date.now();
  const name = `out/${i + 1}-${new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_')}`;
  // bypassCSP: strict CSPs (GitHub, MDN) otherwise refuse the injected Defuddle script.
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: false, bypassCSP: true, userAgent: USER_AGENT });
  const page = await context.newPage();
  const row = { url };
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    row.status = res?.status();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    row.settleMs = await waitForDomQuiet(page);

    // Scroll to the bottom in viewport steps so lazy images and infinite lists
    // load, stopping at MAX_HEIGHT.
    row.scrollSteps = await page.evaluate(async ({ max, step }) => {
      let steps = 0;
      for (let y = 0; y < Math.min(document.documentElement.scrollHeight, max); y += step) {
        window.scrollTo(0, y);
        steps++;
        await new Promise((r) => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
      return steps;
    }, { max: MAX_HEIGHT, step: VIEWPORT.height });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => Promise.all([...document.images].map((img) =>
      img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000); }))));

    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    row.pageHeight = height;
    row.truncated = height > MAX_HEIGHT;
    const shot = row.truncated
      ? await page.screenshot({ clip: { x: 0, y: 0, width: VIEWPORT.width, height: MAX_HEIGHT }, fullPage: true })
      : await page.screenshot({ fullPage: true });
    await writeFile(`${name}.png`, shot);
    row.screenshotKB = Math.round(shot.length / 1024);
    row.brokenImages = await page.evaluate(() =>
      [...document.images].filter((img) => img.complete && img.naturalWidth === 0 && img.src).length);

    await page.addScriptTag({ path: DEFUDDLE });
    const parsed = await page.evaluate((u) => {
      const r = new window.Defuddle(document, { url: u }).parse();
      return {
        title: r.title, description: r.description, author: r.author, site: r.site,
        published: r.published, image: r.image, favicon: r.favicon, domain: r.domain,
        wordCount: r.wordCount, content: r.content,
        canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
      };
    }, url);
    const markdown = turndown.turndown(parsed.content ?? '');
    const { content, ...meta } = parsed;
    await writeFile(`${name}.md`, markdown);
    await writeFile(`${name}.json`, JSON.stringify(meta, null, 2));
    Object.assign(row, { title: meta.title, wordCount: meta.wordCount, markdownChars: markdown.length });
  } catch (err) {
    row.error = String(err?.message ?? err).split('\n')[0];
  } finally {
    row.ms = Date.now() - t0;
    rows.push(row);
    await context.close();
  }
}

await browser.close();
console.table(rows.map(({ url, title, ...r }) => ({ url: url.slice(0, 50), ...r })));
await writeFile('out/report.json', JSON.stringify(rows, null, 2));
