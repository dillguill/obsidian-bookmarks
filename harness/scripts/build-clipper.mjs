// Rebuilds vendor/obsidian-clipper.js: Obsidian Web Clipper's template engine
// (MIT), bundled with clipper/entry.ts for injection into captured pages.
// Web Clipper isn't published to npm, so this checks out a pinned commit.
// Bump CLIPPER_COMMIT to update, run `npm run build:clipper -w harness`, and
// commit the result.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIPPER_REPO = "https://github.com/obsidianmd/obsidian-clipper.git";
const CLIPPER_COMMIT = "6d56d618b00bd970aa738d6a7a61edee27783e81"; // 1.7.1

const harness = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "obsidian-clipper-"));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: "inherit" });
try {
  run("git", ["init", "-q"]);
  run("git", ["fetch", "-q", "--depth", "1", CLIPPER_REPO, CLIPPER_COMMIT]);
  run("git", ["checkout", "-q", "FETCH_HEAD"]);
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  mkdirSync(join(work, "bookmarks"));
  copyFileSync(join(harness, "clipper/entry.ts"), join(work, "bookmarks/entry.ts"));
  const { build } = await import(join(work, "node_modules/esbuild/lib/main.js"));
  const outfile = join(work, "out.js");
  await build({
    entryPoints: [join(work, "bookmarks/entry.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: true,
    outfile,
    define: { DEBUG_MODE: "false" },
    alias: { "webextension-polyfill": join(work, "src/utils/cli-stubs.ts") },
    logLevel: "warning",
  });
  const license = readFileSync(join(work, "LICENSE"), "utf8").trim();
  const header = `/*! Obsidian Web Clipper template engine, ${CLIPPER_REPO.replace(/\.git$/, "")} @ ${CLIPPER_COMMIT}\n${license}\n*/\n`;
  writeFileSync(join(harness, "vendor/obsidian-clipper.js"), header + readFileSync(outfile, "utf8"));
  console.log("wrote vendor/obsidian-clipper.js");
} finally {
  rmSync(work, { recursive: true, force: true });
}
