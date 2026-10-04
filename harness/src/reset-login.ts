// Forgot the settings page password? Run this in the container, then open the
// settings page and create the account again with the setup code from the log:
//   docker compose exec bookmarks-server node dist/reset-login.js
// API keys are kept.
import { join } from "node:path";
import { AuthStore } from "./auth.js";
import { loadConfig } from "./config.js";

const auth = new AuthStore(join(loadConfig().dataDir, "auth.sqlite"));
auth.resetAccount();
auth.close();
console.log("Sign-in account removed. Open the settings page to create it again; the setup code is in the server's log.");
