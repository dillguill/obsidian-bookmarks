// Sets one lockstep version on the plugin, the server and the root manifest
// Obsidian's community directory reads (design §5.3).
// Usage: node scripts/set-version.mjs 0.1.0
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs x.y.z  (no leading v)");
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

for (const path of ["plugin/package.json", "harness/package.json", "plugin/manifest.json"]) {
  writeJson(path, { ...readJson(path), version });
}
const manifest = readJson("plugin/manifest.json");
writeJson("manifest.json", manifest);
writeJson("plugin/versions.json", { ...readJson("plugin/versions.json"), [version]: manifest.minAppVersion });
console.log(`version set to ${version}; commit, then push tag ${version}`);
