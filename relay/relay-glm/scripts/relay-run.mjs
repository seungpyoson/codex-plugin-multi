#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claudePluginDataRoot, claudeSessionId } from "./lib/claude-env.mjs";

const PLUGIN_DATA_ENV = "API_REVIEWERS_PLUGIN_DATA";
const SESSION_ID_ENV = null;
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [scriptName, ...args] = process.argv.slice(2);

if (!scriptName || scriptName.includes("/") || scriptName.includes("\\")) {
  console.error("Usage: relay-run.mjs <script-name.mjs> [...args]");
  process.exit(64);
}

const env = { ...process.env };
const pluginDataRoot = claudePluginDataRoot(env);
if (!env[PLUGIN_DATA_ENV] && pluginDataRoot) {
  env[PLUGIN_DATA_ENV] = pluginDataRoot;
}

const sessionId = claudeSessionId(env);
if (SESSION_ID_ENV && !env[SESSION_ID_ENV] && sessionId) {
  env[SESSION_ID_ENV] = sessionId;
}

const result = spawnSync(process.execPath, [join(pluginRoot, "scripts", scriptName), ...args], {
  stdio: "inherit",
  env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
