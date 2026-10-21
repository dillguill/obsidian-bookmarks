import type { Page } from "playwright";
import type { CaptureFile } from "./api.js";
import { MOBILE_VIEWPORT, VIEWPORT, waitForDomQuiet, waitForImages } from "./page.js";

const THUMBNAIL_WIDTH = 480;

export type ShotFormat = { type: "jpeg" | "png"; quality?: number };

/**
 * The page as an A4 PDF. Lazy images are loaded first (Chromium doesn't load
 * them for print), and fixed or sticky headers become static so they don't
 * cover text on every page; both only affect print, not later screenshots.
 */
export async function pagePdf(page: Page): Promise<Buffer> {
  await waitForImages(page, true);
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const position = getComputedStyle(el).position;
      if (position === "fixed" || position === "sticky") el.setAttribute("data-bookmarks-pinned", "");
    }
    const style = document.createElement("style");
    style.textContent = "@media print { [data-bookmarks-pinned] { position: static !important; } }";
    document.head.append(style);
  });
  await page.emulateMedia({ media: null });
  return page.pdf({ format: "A4", printBackground: true });
}

/** The first screen scaled down to THUMBNAIL_WIDTH, through CDP since Playwright can't scale a screenshot. */
export async function thumbnail(page: Page, type: "jpeg" | "png"): Promise<Buffer> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: type,
      ...(type === "jpeg" ? { quality: 80 } : {}),
      clip: { x: 0, y: 0, ...VIEWPORT, scale: THUMBNAIL_WIDTH / VIEWPORT.width },
    });
    return Buffer.from(data, "base64");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * The page's main content block: the article/main element with the most text,
 * or a smaller one inside it that holds nearly all of that text. Null when the
 * page has none.
 */
export async function articleShot(page: Page, format: ShotFormat, maxHeight: number): Promise<Buffer | null> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll<HTMLElement>('article, [itemprop="articleBody"], main, [role="main"]')]
      .map((el) => {
        let rect = el.getBoundingClientRect();
        // display: contents (MDN's <main>) has no box of its own; measure what it holds.
        if (rect.width === 0 && rect.height === 0) {
          const range = document.createRange();
          range.selectNodeContents(el);
          rect = range.getBoundingClientRect();
        }
        return { el, rect, text: (el.innerText ?? "").length };
      })
      .filter((b) => b.rect.width >= 200 && b.rect.height >= 200 && b.text > 0)
      .sort((a, b) => b.text - a.text);
    let best = blocks[0];
    if (!best) return null;
    for (const b of blocks) {
      if (b.el !== best.el && best.el.contains(b.el) && b.text >= best.text * 0.8) best = b;
    }
    const { left, top, width, height } = best.rect;
    return { x: Math.max(0, left + window.scrollX), y: Math.max(0, top + window.scrollY), width, height };
  });
  if (!box) return null;
  return page.screenshot({ ...format, fullPage: true, clip: { ...box, height: Math.min(box.height, maxHeight) } });
}

/**
 * Takes the wanted screenshots and PDF: desktop shots in light then dark mode,
 * then phone-width shots last, since the layout reflows at that width.
 * `viewportExtra` is how much the viewport was grown for an inner scroller.
 * Returns whether the full-page shot was cut at `maxHeight`.
 */
export async function takeShots(
  page: Page,
  wanted: ReadonlySet<CaptureFile>,
  options: { format: ShotFormat; maxHeight: number; viewportExtra: number },
  put: (kind: CaptureFile, data: Buffer) => void,
): Promise<{ truncated: boolean }> {
  const { format, maxHeight, viewportExtra } = options;
  let truncated = false;
  // At the original viewport size even if it was grown for an inner scroller.
  const firstScreen = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    return page.screenshot({ ...format, clip: { x: 0, y: 0, ...VIEWPORT } });
  };
  /** Desktop shots in one color scheme; `suffix` is "" or "_dark". */
  const desktopShots = async (suffix: "" | "_dark") => {
    const want = (type: string) => wanted.has(`screenshot_${type}${suffix}` as CaptureFile);
    const set = (type: string, data: Buffer | null) => {
      if (data) put(`screenshot_${type}${suffix}` as CaptureFile, data);
    };
    if (want("banner")) set("banner", await firstScreen());
    if (want("thumbnail")) set("thumbnail", await thumbnail(page, format.type));
    if (want("article")) set("article", await articleShot(page, format, maxHeight));
    if (want("page")) {
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
      truncated = height > maxHeight || VIEWPORT.height + viewportExtra > maxHeight;
      set(
        "page",
        await page.screenshot({
          fullPage: true,
          ...format,
          ...(truncated ? { clip: { x: 0, y: 0, width: VIEWPORT.width, height: maxHeight } } : {}),
        }),
      );
    }
  };
  const mobileShot = async (suffix: "" | "_dark") => {
    if (!wanted.has(`screenshot_mobile${suffix}`)) return;
    await page.evaluate(() => window.scrollTo(0, 0));
    put(`screenshot_mobile${suffix}`, await page.screenshot({ ...format, clip: { x: 0, y: 0, ...MOBILE_VIEWPORT } }));
  };
  const darkMode = async (on: boolean) => {
    await page.emulateMedia({ colorScheme: on ? "dark" : "light" });
    await waitForDomQuiet(page, 300, 2000);
  };
  const anyDark = [...wanted].some((kind) => kind.endsWith("_dark"));

  await desktopShots("");
  if (wanted.has("pdf_page")) put("pdf_page", await pagePdf(page));
  if (anyDark) {
    await darkMode(true);
    await desktopShots("_dark");
  }
  const mobile = wanted.has("screenshot_mobile") || wanted.has("screenshot_mobile_dark");
  if (mobile) {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await waitForDomQuiet(page, 300, 2000);
    // Still in dark mode if any dark shot was wanted, so take that one first.
    if (anyDark) await mobileShot("_dark");
    if (wanted.has("screenshot_mobile")) {
      if (anyDark) await darkMode(false);
      await mobileShot("");
    }
  }
  // A held page can be asked for more shots later, so leave it as it was.
  if (anyDark && !wanted.has("screenshot_mobile")) await darkMode(false);
  if (mobile) await page.setViewportSize({ width: VIEWPORT.width, height: Math.min(VIEWPORT.height + viewportExtra, maxHeight) });
  return { truncated };
}
