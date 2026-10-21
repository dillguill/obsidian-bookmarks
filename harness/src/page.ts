import type { Page } from "playwright";

export const VIEWPORT = { width: 1280, height: 800 };
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

// networkidle fires before client-side renders that run on timers, so also wait
// until the DOM stops changing for a quiet window (capped).
export async function waitForDomQuiet(page: Page, quietMs = 500, maxMs = 5000): Promise<void> {
  await page.evaluate(
    ({ quiet, max }) =>
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          obs.disconnect();
          clearTimeout(cap);
          resolve();
        };
        const obs = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, quiet);
        });
        obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
        timer = setTimeout(done, quiet);
        const cap = setTimeout(done, max);
      }),
    { quiet: quietMs, max: maxMs },
  );
}

/** Waits (3 s at most each) for the page's images to load; `eager` also loads lazy ones, which print doesn't. */
export async function waitForImages(page: Page, eager = false): Promise<void> {
  await page.evaluate(
    (loadLazy) =>
      Promise.all(
        [...document.images].map((img) => {
          if (loadLazy) img.loading = "eager";
          return img.complete
            ? null
            : new Promise((resolve) => {
                img.onload = img.onerror = resolve;
                setTimeout(resolve, 3000);
              });
        }),
      ),
    eager,
  );
}

/** Hides cookie/consent banners and restores page scrolling before the screenshot. */
export async function hideOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const selectors = [
      "#onetrust-consent-sdk",
      "#CybotCookiebotDialog",
      ".fc-consent-root",
      ".cc-window",
      ".js-consent-banner",
      "[id^='sp_message_container']",
      "#didomi-host",
      "#usercentrics-root",
      "#cookie-banner",
      "#cookie-notice",
    ];
    for (const el of document.querySelectorAll<HTMLElement>(selectors.join(","))) el.style.setProperty("display", "none", "important");
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      const text = el.innerText ?? "";
      if (text.length < 2000 && /\b(cookies?|consent)\b/i.test(text)) el.style.setProperty("display", "none", "important");
    }
    for (const el of [document.documentElement, document.body]) {
      if (getComputedStyle(el).overflow === "hidden") el.style.setProperty("overflow", "visible", "important");
    }
  });
}

/**
 * Some layouts (docs sites, app shells) scroll inside a container, so the page
 * itself is one viewport tall and a full-page screenshot shows one screen.
 * Returns how much taller the viewport must be for the largest such container
 * to fit its content. Growing the viewport, rather than restyling the
 * container, keeps virtualized renderers (Obsidian Publish) drawing.
 */
export async function innerScrollExtra(page: Page): Promise<number> {
  return page.evaluate((viewportHeight) => {
    const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    if (pageHeight > viewportHeight + 50) return 0;
    let best: HTMLElement | null = null;
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const overflowY = getComputedStyle(el).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 50) {
        if (!best || el.scrollHeight * el.clientWidth > best.scrollHeight * best.clientWidth) best = el;
      }
    }
    if (!best || best.clientWidth < window.innerWidth / 3) return 0;
    return best.scrollHeight - best.clientHeight;
  }, VIEWPORT.height);
}

/** Scrolls in viewport steps so lazy images load, within a height and time budget. */
export async function autoScroll(page: Page, maxHeight: number, budgetMs: number): Promise<void> {
  await page.evaluate(
    async ({ max, step, budget }) => {
      const start = performance.now();
      const height = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
      for (let y = 0; y < Math.min(height(), max) && performance.now() - start < budget; y += step) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      window.scrollTo(0, 0);
    },
    { max: maxHeight, step: VIEWPORT.height, budget: budgetMs },
  );
}

/**
 * Gets a loaded page ready for screenshots: grows the viewport for an inner
 * scroller, scrolls so lazy content loads, and waits for images. Returns how
 * much the viewport grew.
 */
export async function prepareForShots(page: Page, maxHeight: number, scrollBudgetMs: number): Promise<number> {
  const extra = await innerScrollExtra(page);
  if (extra > 0) {
    await page.setViewportSize({ width: VIEWPORT.width, height: Math.min(VIEWPORT.height + extra, maxHeight) });
    await waitForDomQuiet(page, 300, 2000);
  }
  await autoScroll(page, maxHeight, scrollBudgetMs);
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  await waitForImages(page);
  return extra;
}
