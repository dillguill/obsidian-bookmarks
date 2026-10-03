// Mirrors cleanUrl in plugin/src/url.ts.

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
 * content. Returns `raw` unchanged when
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

