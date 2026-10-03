// Query params that identify a click, not a page (design §4).
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "si",
  "ref",
  "ref_src",
  "ref_url",
  "_hsenc",
  "_hsmi",
  "yclid",
  "twclid",
  "srsltid",
]);

// Query params bot walls add when they redirect back to the page (Reddit, Cloudflare).
const CHALLENGE_PARAMS = new Set(["solution", "js_challenge", "jsc_token", "jsc_orig_r"]);

function isJunkParam(key: string, keepRef = false): boolean {
  const k = key.toLowerCase();
  if (keepRef && k === "ref") return false;
  return k.startsWith("utm_") || k.startsWith("__cf_chl_") || TRACKING_PARAMS.has(k) || CHALLENGE_PARAMS.has(k);
}

/**
 * The URL to save: tracking and bot-wall params and text fragments removed,
 * everything else as is. `ref` stays, since some sites (GitHub) use it for
 * content. Mirrored in harness/src/clean-url.ts. Returns `raw` unchanged when
 * it isn't a URL.
 */
export function cleanUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw;
  }
  const junk = [...url.searchParams.keys()].filter((key) => isJunkParam(key, true));
  const hash = url.hash.replace(/:~:text=.*$/, "").replace(/^#$/, "");
  // Leave clean URLs exactly as given rather than re-serialized.
  if (junk.length === 0 && hash === url.hash) return raw.trim();
  for (const key of junk) url.searchParams.delete(key);
  url.hash = hash;
  return url.toString().replace(/#$/, "");
}

/**
 * Dedup key for a URL: lowercase host without `www.`, no fragment, no tracking
 * params, remaining params sorted, no trailing slash. Returns null for
 * anything that isn't an http(s) URL.
 */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port && url.port !== (url.protocol === "https:" ? "443" : "80") ? `:${url.port}` : "";
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !isJunkParam(key))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  // Scheme is dropped so http and https copies of a page match.
  return `${host}${port}${path}${query}`;
}

/** First http(s) URL in `text`, for the clipboard-aware capture command. */
export function findUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (!match) return null;
  const candidate = match[0].replace(/[),.;!?]+$/, "");
  return normalizeUrl(candidate) ? candidate : null;
}

/** "https://www.NYTimes.com/x" -> "nytimes.com", for entries in a site list. */
export function siteEntry(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/[/?#:].*$/, "");
}
