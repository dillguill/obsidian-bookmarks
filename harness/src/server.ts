import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
if (config.tokens.size === 0) {
  console.error("BOOKMARKS_TOKENS is empty; set at least one API token.");
  process.exit(1);
}

createApp(config).listen(config.port, config.host, () => {
  console.log(`bookmarks-server listening on ${config.host}:${config.port}`);
});
