import type { CaptureSettings, ScreenshotStyle } from "./api.js";

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = { screenshotStyle: "full", bannerSites: [], noScreenshotSites: [] };

const STYLES: ReadonlySet<string> = new Set<ScreenshotStyle>(["full", "banner", "none"]);
const MAX_SITES = 500;

/** "https://www.NYTimes.com/x" -> "nytimes.com"; mirrors plugin/src/url.ts. */
export function siteEntry(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/[/?#:].*$/, "");
}

function matchesSite(url: string, sites: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/** Screenshot style for a URL: "no screenshot" sites win over banner sites, which win over the default. */
export function screenshotStyleFor(url: string, settings: CaptureSettings): ScreenshotStyle {
  if (matchesSite(url, settings.noScreenshotSites)) return "none";
  if (matchesSite(url, settings.bannerSites)) return "banner";
  return settings.screenshotStyle;
}

/** Validates a settings body; returns the cleaned settings or an error message. */
export function parseCaptureSettings(body: unknown): CaptureSettings | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  const fields = body as Record<string, unknown>;
  const style = fields.screenshotStyle ?? DEFAULT_CAPTURE_SETTINGS.screenshotStyle;
  if (typeof style !== "string" || !STYLES.has(style)) return "screenshotStyle must be full, banner or none.";
  const sites = (key: string): string[] | string => {
    const value = fields[key] ?? [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return `${key} must be a list of sites.`;
    if (value.length > MAX_SITES) return `${key} has more than ${MAX_SITES} sites.`;
    return [...new Set((value as string[]).map(siteEntry).filter(Boolean))];
  };
  const bannerSites = sites("bannerSites");
  if (typeof bannerSites === "string") return bannerSites;
  const noScreenshotSites = sites("noScreenshotSites");
  if (typeof noScreenshotSites === "string") return noScreenshotSites;
  return { screenshotStyle: style as ScreenshotStyle, bannerSites, noScreenshotSites };
}
