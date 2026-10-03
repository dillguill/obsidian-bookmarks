import { chromium } from "playwright";
const S = "/tmp/claude-0/-home-user-obsidian-bookmarks/b463a870-4b8b-5161-b9bd-275c6520681e/scratchpad/pdf2";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
for (const [name, url] of [["wiki","https://en.wikipedia.org/wiki/Bookmark"],["obs","https://obsidian.md/"],["mdn","https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme"]]) {
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(url, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(4000);
  const info = await p.evaluate(() => [...document.images].filter(i => i.getAttribute("loading")==="lazy").length);
  // fix
  await p.evaluate(() => Promise.all([...document.images].map((img) => { img.loading = "eager"; return img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000); }); })));
  await p.emulateMedia({ media: "print" });
  const pinned = await p.evaluate(() => { let n=0; for (const el of document.querySelectorAll("body *")) { const pos = getComputedStyle(el).position; if (pos === "fixed" || pos === "sticky") { el.style.setProperty("position", "static", "important"); n++; } } return n; });
  const t = Date.now();
  await p.pdf({ path: `${S}/${name}.pdf`, format: "A4", printBackground: true });
  console.log(name, "lazy", info, "pinned", pinned, "pdf ms", Date.now()-t);
  await p.close();
}
await b.close();
