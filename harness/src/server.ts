import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { AuthStore } from "./auth.js";
import { PlaywrightEngine } from "./capture.js";
import { loadConfig } from "./config.js";
import { JobStore } from "./db.js";
import { Worker } from "./worker.js";

const config = loadConfig();

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const store = new JobStore(join(config.dataDir, "jobs.sqlite"));
const auth = new AuthStore(join(config.dataDir, "auth.sqlite"));
auth.setupCode(); // logs the code to create the sign-in account, until there is one
const engine = new PlaywrightEngine(config);
const worker = new Worker(store, engine, config.dataDir, config.concurrency);
const server = createApp({ config, store, auth, worker, version });

const prune = () => worker.prune(config.retentionDays).catch((err: unknown) => console.error("prune failed", err));
void prune();
const pruneTimer = setInterval(prune, 60 * 60 * 1000);

server.listen(config.port, config.host, () => {
  console.log(`bookmarks-server ${version} listening on ${config.host}:${config.port}`);
  worker.kick(); // resume jobs left pending by a restart
});

async function shutdown(): Promise<void> {
  clearInterval(pruneTimer);
  worker.stop();
  server.close();
  await engine.close();
  store.close();
  auth.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
