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
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(key.toLowerCase()))
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
