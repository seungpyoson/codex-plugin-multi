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
    skills: "./skills",
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
const helper = await import(process.env.RELAY_API_REVIEWERS_ENTRYPOINT || new URL("../../api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href)
  .catch(() => import(new URL("../../../plugins/api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href))
  .catch(() => import(new URL("../../../api-reviewers/0.1.0/scripts/relay-entrypoint.mjs", import.meta.url).href))
  .catch(() => import(new URL("../../../../codex-plugin-multi/api-reviewers/0.1.0/scripts/relay-entrypoint.mjs", import.meta.url).href));

helper.runRelayDirectApiEntrypoint({ provider: ${JSON.stringify(provider)}, scriptUrl: import.meta.url });
`;
}

export function buildCodexDirectApiSuite({ repoRoot = process.cwd() } = {}) {
  return DIRECT_API_PROVIDERS.map((provider) => buildCodexDirectApiPlugin({ provider, repoRoot }));
}
