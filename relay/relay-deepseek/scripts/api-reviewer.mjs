#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "deepseek";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const PROVIDERS_PATH = resolve(PLUGIN_ROOT, "config/providers.json");
const SESSION_APPROVAL_POLICY_PATH = resolve(PLUGIN_ROOT, "config/session-approval.json");
const runtimeCandidates = [
  process.env.RELAY_API_REVIEWERS_RUNTIME,
  resolve(PLUGIN_ROOT, "../api-reviewers/scripts/api-reviewer.mjs"),
  resolve(PLUGIN_ROOT, "../../plugins/api-reviewers/scripts/api-reviewer.mjs"),
  resolve(PLUGIN_ROOT, "../../api-reviewers/0.1.0/scripts/api-reviewer.mjs"),
  resolve(PLUGIN_ROOT, "../../../codex-plugin-multi/api-reviewers/0.1.0/scripts/api-reviewer.mjs"),
].filter(Boolean);

function argProvider(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--provider") return args[i + 1] ?? null;
    if (args[i].startsWith("--provider=")) return args[i].slice("--provider=".length);
  }
  return null;
}

for (const [path, label] of [
  [PROVIDERS_PATH, "this relay plugin's config/providers.json"],
  [SESSION_APPROVAL_POLICY_PATH, "this relay plugin's config/session-approval.json"],
]) {
  if (!existsSync(path)) {
    console.error(`config_error: missing ${label}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const requestedProvider = argProvider(args);
if (requestedProvider && requestedProvider !== PROVIDER) {
  console.error(`bad_args: relay-${PROVIDER} cannot run provider ${JSON.stringify(requestedProvider)}`);
  process.exit(64);
}

const runtime = runtimeCandidates.find((candidate) => existsSync(candidate));
if (!runtime) {
  console.error("api_reviewer_runtime_missing: set RELAY_API_REVIEWERS_RUNTIME or install the shared api-reviewers runtime");
  process.exit(1);
}

const result = spawnSync(process.execPath, [runtime, ...args], {
  env: {
    ...process.env,
    API_REVIEWERS_PROVIDERS_PATH: process.env.API_REVIEWERS_PROVIDERS_PATH ?? PROVIDERS_PATH,
    API_REVIEWERS_SESSION_APPROVAL_POLICY_PATH:
      process.env.API_REVIEWERS_SESSION_APPROVAL_POLICY_PATH ?? SESSION_APPROVAL_POLICY_PATH,
  },
  stdio: "inherit",
});

if (result.error) {
  console.error(`api-reviewer failed to launch: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
