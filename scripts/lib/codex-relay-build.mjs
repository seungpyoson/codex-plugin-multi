import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIRECT_API_PROVIDERS = Object.freeze(["glm", "deepseek"]);
const REPOSITORY = "https://github.com/seungpyoson/relay";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function codexRelayPluginName(provider) {
  return `relay-${provider}`;
}

function directApiManifest({ provider, displayName, sourceManifest }) {
  return {
    ...sourceManifest,
    name: codexRelayPluginName(provider),
    description: `Delegate code reviews to ${displayName} direct API from within Codex.`,
    homepage: REPOSITORY,
    repository: REPOSITORY,
    keywords: provider === "glm"
      ? ["glm", "zai", "api", "review"]
      : ["deepseek", "api", "review"],
    interface: {
      ...sourceManifest.interface,
      displayName: `Relay ${displayName}`,
      shortDescription: `Delegate to ${displayName} direct API from Codex.`,
      longDescription: `Invoke ${displayName} directly through explicit API-key auth for review, adversarial-review, and custom-review workflows.`,
      defaultPrompt: [
        `Ask ${displayName} to review the current diff`,
        `Ask ${displayName} to review selected files`,
        `Run an adversarial review through ${displayName}`,
      ],
    },
  };
}

function directApiPackage(provider) {
  return {
    name: `@relay/${codexRelayPluginName(provider)}-plugin`,
    version: "0.1.0",
    private: true,
    type: "module",
    license: "AGPL-3.0-only",
    bin: {
      "api-reviewer": "./bin/api-reviewer",
    },
    scripts: {
      smoke: "node --test --test-reporter=spec ../../tests/smoke/api-reviewers.smoke.test.mjs",
    },
  };
}

export function buildCodexDirectApiPlugin({ provider, repoRoot = process.cwd() }) {
  if (!DIRECT_API_PROVIDERS.includes(provider)) {
    throw new Error(`unsupported Codex direct API relay provider: ${provider}`);
  }

  const sourceRoot = join(repoRoot, "plugins", "api-reviewers");
  const pluginRoot = join(repoRoot, "plugins", codexRelayPluginName(provider));
  const providers = readJson(join(sourceRoot, "config", "providers.json"));
  const providerConfig = providers[provider];
  if (!providerConfig) throw new Error(`missing provider config: ${provider}`);

  rmSync(pluginRoot, { recursive: true, force: true });
  mkdirSync(pluginRoot, { recursive: true });
  cpSync(join(sourceRoot, "bin"), join(pluginRoot, "bin"), { recursive: true });
  mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  writeFileSync(
    join(pluginRoot, "scripts", "api-reviewer.mjs"),
    renderDirectApiRuntimeEntrypoint(provider),
    "utf8",
  );
  mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(join(pluginRoot, "commands"), { recursive: true });
  mkdirSync(join(pluginRoot, "config"), { recursive: true });
  mkdirSync(join(pluginRoot, "skills"), { recursive: true });

  const sourceManifest = readJson(join(sourceRoot, ".codex-plugin", "plugin.json"));
  writeJson(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    directApiManifest({ provider, displayName: providerConfig.display_name, sourceManifest }),
  );
  writeJson(join(pluginRoot, "config", "providers.json"), { [provider]: providerConfig });
  cpSync(join(sourceRoot, "config", "session-approval.json"), join(pluginRoot, "config", "session-approval.json"));
  writeJson(join(pluginRoot, "package.json"), directApiPackage(provider));

  return pluginRoot;
}

function renderDirectApiRuntimeEntrypoint(provider) {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = ${JSON.stringify(provider)};
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
    console.error(\`config_error: missing \${label}\`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const requestedProvider = argProvider(args);
if (requestedProvider && requestedProvider !== PROVIDER) {
  console.error(\`bad_args: relay-\${PROVIDER} cannot run provider \${JSON.stringify(requestedProvider)}\`);
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
  console.error(\`api-reviewer failed to launch: \${result.error.message}\`);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
`;
}

export function buildCodexDirectApiSuite({ repoRoot = process.cwd() } = {}) {
  return DIRECT_API_PROVIDERS.map((provider) => buildCodexDirectApiPlugin({ provider, repoRoot }));
}
