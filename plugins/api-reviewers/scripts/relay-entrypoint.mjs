import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME_PATH = resolve(SCRIPT_DIR, "api-reviewer.mjs");

function configuredRuntime(env) {
  const value = env.RELAY_API_REVIEWERS_RUNTIME;
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_RUNTIME_PATH;
  return resolve(value);
}

function argProvider(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--provider") return args[i + 1] ?? null;
    if (args[i].startsWith("--provider=")) return args[i].slice("--provider=".length);
  }
  return null;
}

function pluginRoot(scriptUrl) {
  return resolve(dirname(fileURLToPath(scriptUrl)), "..");
}

export function runRelayDirectApiEntrypoint({
  provider,
  scriptUrl,
  args = process.argv.slice(2),
  env = process.env,
} = {}) {
  if (typeof provider !== "string" || provider.trim() === "") {
    throw new TypeError("provider is required");
  }
  if (typeof scriptUrl !== "string" || scriptUrl.trim() === "") {
    throw new TypeError("scriptUrl is required");
  }

  const root = pluginRoot(scriptUrl);
  const providersPath = resolve(root, "config/providers.json");
  const sessionApprovalPolicyPath = resolve(root, "config/session-approval.json");

  for (const [path, label] of [
    [providersPath, "this relay plugin's config/providers.json"],
    [sessionApprovalPolicyPath, "this relay plugin's config/session-approval.json"],
  ]) {
    if (!existsSync(path)) {
      console.error(`config_error: missing ${label}`);
      process.exit(1);
    }
  }

  const requestedProvider = argProvider(args);
  if (requestedProvider && requestedProvider !== provider) {
    console.error(`bad_args: relay-${provider} cannot run provider ${JSON.stringify(requestedProvider)}`);
    process.exit(64);
  }

  const runtime = configuredRuntime(env);
  if (!existsSync(runtime)) {
    console.error("api_reviewer_runtime_missing: set RELAY_API_REVIEWERS_RUNTIME or install the shared api-reviewers runtime");
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [runtime, ...args], {
    env: {
      ...env,
      API_REVIEWERS_PROVIDERS_PATH: env.API_REVIEWERS_PROVIDERS_PATH ?? providersPath,
      API_REVIEWERS_SESSION_APPROVAL_POLICY_PATH:
        env.API_REVIEWERS_SESSION_APPROVAL_POLICY_PATH ?? sessionApprovalPolicyPath,
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
}
