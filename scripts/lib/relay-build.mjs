import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const RELAY_REPOSITORY = "https://github.com/relay-org/relay";
const RELAY_FOR_CLAUDE_MARKETPLACE = "relay-for-claude";
const RELAY_SHARED_DIRECT_API_RUNTIME = "relay-api-reviewers";
const CODEX_DIRECT_API_RELAY_ENTRYPOINT_COMMAND_RE =
  /node "\$\{CODEX_HOME:-\$HOME\/\.codex\}\/plugins\/cache\/relay-for-codex\/relay-(?:deepseek|glm)\/[^/]+\/scripts\/api-reviewer\.mjs"/g;
const CODEX_DIRECT_API_RELAY_ENTRYPOINT_PATH_RE =
  /\$\{CODEX_HOME:-\$HOME\/\.codex\}\/plugins\/cache\/relay-for-codex\/relay-(?:deepseek|glm)\/[^/]+\/scripts\/api-reviewer\.mjs/g;
const RELAY_PROVIDER_ORDER = Object.freeze(["gemini", "grok", "kimi", "glm", "deepseek"]);
const RELAY_PROVIDER_DEFINITIONS = Object.freeze({
  gemini: {
    sourceProvider: "gemini",
    commandPrefix: "gemini",
    pluginDataEnv: "GEMINI_PLUGIN_DATA",
    sessionIdEnv: "GEMINI_COMPANION_SESSION_ID",
    synthesizeCustomReview: true,
  },
  grok: { sourceProvider: "grok", commandPrefix: "grok", pluginDataEnv: "GROK_PLUGIN_DATA" },
  kimi: {
    sourceProvider: "kimi",
    commandPrefix: "kimi",
    pluginDataEnv: "KIMI_PLUGIN_DATA",
    sessionIdEnv: "KIMI_COMPANION_SESSION_ID",
    synthesizeCustomReview: true,
  },
  glm: {
    sourceProvider: "relay-glm",
    commandPrefix: "glm",
    pluginDataEnv: "API_REVIEWERS_PLUGIN_DATA",
    description: "Delegate code reviews to GLM direct API from within Claude Code.",
  },
  deepseek: {
    sourceProvider: "relay-deepseek",
    commandPrefix: "deepseek",
    pluginDataEnv: "API_REVIEWERS_PLUGIN_DATA",
    description: "Delegate code reviews to DeepSeek direct API from within Claude Code.",
  },
});

export function relayPluginName(provider) {
  return `relay-${provider}`;
}

export function buildRelayPlugin({ provider, repoRoot = process.cwd(), outRoot = join(repoRoot, "relay") }) {
  const definition = RELAY_PROVIDER_DEFINITIONS[provider];
  if (!definition) {
    throw new Error(`unsupported relay provider: ${provider}`);
  }

  const sourceRoot = join(repoRoot, "plugins", definition.sourceProvider);
  const pluginRoot = join(outRoot, relayPluginName(provider));
  rmSync(pluginRoot, { recursive: true, force: true });

  mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
  writeJson(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    renderClaudePluginManifest(readJson(join(sourceRoot, ".codex-plugin", "plugin.json")), {
      provider,
      description: definition.description,
    }),
  );

  copyIfExists(join(sourceRoot, "scripts"), join(pluginRoot, "scripts"));
  copyIfExists(join(sourceRoot, "config"), join(pluginRoot, "config"));
  copyIfExists(join(sourceRoot, "policies"), join(pluginRoot, "policies"));
  copyIfExists(join(sourceRoot, "bin"), join(pluginRoot, "bin"));
  copyIfExists(join(sourceRoot, "LICENSE"), join(pluginRoot, "LICENSE"));
  if (definition.pluginDataEnv === "API_REVIEWERS_PLUGIN_DATA") {
    writeFileSync(join(pluginRoot, "scripts", "api-reviewer.mjs"), renderClaudeDirectApiRuntimeEntrypoint(provider), "utf8");
  }
  writeRelayRunner({ pluginRoot, repoRoot, definition });
  filterRelayConfig({ pluginRoot, provider });

  const commandsRoot = join(pluginRoot, "commands");
  mkdirSync(commandsRoot, { recursive: true });
  const commandPrefix = `${definition.commandPrefix}-`;
  for (const fileName of readdirSync(join(sourceRoot, "commands"))
    .filter((name) => name.endsWith(".md") && name.startsWith(commandPrefix))
    .sort()) {
    const sourceDoc = readFileSync(join(sourceRoot, "commands", fileName), "utf8");
    writeFileSync(
      join(commandsRoot, claudeCommandFileName(fileName, definition.commandPrefix)),
      renderClaudeCommandDoc(sourceDoc),
      "utf8",
    );
  }
  if (definition.synthesizeCustomReview) {
    writeFileSync(
      join(commandsRoot, "custom-review.md"),
      renderClaudeCommandDoc(renderSynthesizedCustomReviewDoc(provider, definition)),
      "utf8",
    );
  }

  return pluginRoot;
}

export function buildRelaySuite({ repoRoot = process.cwd(), outRoot = join(repoRoot, "relay") } = {}) {
  rmSync(outRoot, { recursive: true, force: true });
  const pluginRoots = RELAY_PROVIDER_ORDER.map((provider) => buildRelayPlugin({ provider, repoRoot, outRoot }));
  const sharedDirectApiRuntimeRoot = buildRelayDirectApiRuntimePlugin({ repoRoot, outRoot });
  writeClaudeRelayMarketplace({ outRoot, pluginRoots, sharedDirectApiRuntimeRoot });
  return pluginRoots;
}

export function renderClaudeRelayMarketplace(
  pluginManifests,
  { hiddenPluginNames = new Set(), sourcePrefix = "." } = {},
) {
  return {
    name: RELAY_FOR_CLAUDE_MARKETPLACE,
    description: "Relay for Claude Code: external-model delegation plugins.",
    owner: { name: "relay-maintainer" },
    plugins: pluginManifests.map((manifest) => {
      const plugin = {
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        source: `${sourcePrefix}/${manifest.name}`,
        author: manifest.author,
      };
      if (hiddenPluginNames.has(manifest.name)) {
        plugin.policy = { installation: "HIDDEN" };
      }
      return plugin;
    }),
  };
}

function writeClaudeRelayMarketplace({ outRoot, pluginRoots, sharedDirectApiRuntimeRoot }) {
  const visibleManifests = pluginRoots.map((pluginRoot) =>
    readJson(join(pluginRoot, ".claude-plugin", "plugin.json"))
  );
  const hiddenManifests = [readJson(join(sharedDirectApiRuntimeRoot, ".claude-plugin", "plugin.json"))];
  // Marketplace root is the parent of the generated plugin dirs (outRoot), so a github/local
  // marketplace source resolves `.claude-plugin/marketplace.json` at the repo root; plugin
  // sources are root-relative `./<outRoot-basename>/<plugin>` (e.g. ./relay/relay-gemini).
  const marketplaceRoot = dirname(outRoot);
  const sourcePrefix = `./${basename(outRoot)}`;
  mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
  writeJson(
    join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    renderClaudeRelayMarketplace([...visibleManifests, ...hiddenManifests], {
      hiddenPluginNames: new Set(hiddenManifests.map((manifest) => manifest.name)),
      sourcePrefix,
    }),
  );
}

function buildRelayDirectApiRuntimePlugin({ repoRoot, outRoot }) {
  const sourceRoot = join(repoRoot, "plugins", "api-reviewers");
  const pluginRoot = join(outRoot, RELAY_SHARED_DIRECT_API_RUNTIME);
  mkdirSync(join(sourceRoot, ".claude-plugin"), { recursive: true });

  const sourceManifest = readJson(join(sourceRoot, ".codex-plugin", "plugin.json"));
  writeJson(join(sourceRoot, ".claude-plugin", "plugin.json"), {
    name: RELAY_SHARED_DIRECT_API_RUNTIME,
    version: sourceManifest.version,
    description: "Shared hidden direct API runtime for Relay Claude Code plugins.",
    author: sourceManifest.author,
    license: sourceManifest.license,
    homepage: RELAY_REPOSITORY,
    repository: RELAY_REPOSITORY,
  });

  rmSync(pluginRoot, { recursive: true, force: true });
  symlinkSync(relative(realpathSync(outRoot), realpathSync(sourceRoot)).replaceAll("\\", "/"), pluginRoot, "dir");
  return pluginRoot;
}

function renderClaudeDirectApiRuntimeEntrypoint(provider) {
  return `#!/usr/bin/env node
const candidates = [
  process.env.RELAY_API_REVIEWERS_ENTRYPOINT,
  new URL("../../relay-api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href,
  new URL("../../api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href,
  new URL("../../../plugins/api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href,
  new URL("../../../relay-api-reviewers/0.1.0/scripts/relay-entrypoint.mjs", import.meta.url).href,
].filter(Boolean);
const helper = await Promise.any(candidates.map((candidate) => import(candidate))).catch(() => null);
if (!helper) { console.error("api_reviewer_entrypoint_missing: install the shared api-reviewers runtime"); process.exit(1); }
helper.runRelayDirectApiEntrypoint({ provider: ${JSON.stringify(provider)}, scriptUrl: import.meta.url });
`;
}

export function renderClaudePluginManifest(codexManifest, { provider, description: descriptionOverride } = {}) {
  const {
    interface: _codexInterface,
    skills: _codexSkills,
    commands: _codexCommands,
    name: _codexName,
    description,
    homepage: _homepage,
    repository: _repository,
    ...rest
  } = codexManifest;
  const relayRest = { ...rest };
  if (Array.isArray(relayRest.keywords)) {
    relayRest.keywords = filterRelayKeywords(relayRest.keywords, provider);
  }

  return {
    name: relayPluginName(provider),
    ...relayRest,
    description: descriptionOverride ?? rewriteCodexHostDescription(description),
    homepage: RELAY_REPOSITORY,
    repository: RELAY_REPOSITORY,
  };
}

export function claudeCommandFileName(fileName, provider) {
  const prefix = `${provider}-`;
  return fileName.startsWith(prefix) ? fileName.slice(prefix.length) : fileName;
}

export function renderClaudeCommandDoc(codexDoc) {
  let rendered = codexDoc
    .replaceAll("<plugin-root>", "${CLAUDE_PLUGIN_ROOT}")
    .replaceAll("node plugins/grok/scripts/grok-companion.mjs", 'node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs"')
    .replace(CODEX_DIRECT_API_RELAY_ENTRYPOINT_COMMAND_RE, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/api-reviewer.mjs"')
    .replace(CODEX_DIRECT_API_RELAY_ENTRYPOINT_PATH_RE, "${CLAUDE_PLUGIN_ROOT}/scripts/api-reviewer.mjs")
    .replaceAll('-- "<focus text>"', '--prompt-file "$RELAY_PROMPT_FILE"')
    .replaceAll('-- "<prompt text>"', '--prompt-file "$RELAY_PROMPT_FILE"')
    .replaceAll('-- "$ARGUMENTS"', '--prompt-file "$RELAY_PROMPT_FILE"')
    .replaceAll('--prompt "<prompt text>"', '--prompt-file "$RELAY_PROMPT_FILE"')
    .replaceAll(
      "If present, pass `--scope-base REF` before `--`; pass the remaining focus text after `--`.",
      "If present, pass `--scope-base REF` as a CLI flag; write the remaining focus text to the private prompt file referenced by `RELAY_PROMPT_FILE`.",
    )
    .replaceAll(
      "Route `--scope-base REF` before `--prompt` and pass the remaining prompt text to `--prompt`.",
      "Route `--scope-base REF` before `--prompt-file` and write the remaining prompt text to the private prompt file referenced by `RELAY_PROMPT_FILE`.",
    )
    .replaceAll(
      "Route `--scope-paths <files>` before `--prompt` and pass the remaining prompt text to `--prompt`.",
      "Route `--scope-paths <files>` before `--prompt-file` and write the remaining prompt text to the private prompt file referenced by `RELAY_PROMPT_FILE`.",
    )
    .replaceAll(
      "Route `--max-steps-per-turn N` before `--`; `N` must be a positive integer.",
      "Route `--max-steps-per-turn N` as a CLI flag before `--prompt-file`; `N` must be a positive integer.",
    )
    .replaceAll(
      "If the user provides a step budget, add `--max-steps-per-turn N` before `--`; `N` must be a positive integer.",
      "If the user provides a step budget, add `--max-steps-per-turn N` as a CLI flag before `--prompt-file`; `N` must be a positive integer.",
    )
    .replaceAll(
      "Use the global installed entrypoint `node \"${CLAUDE_PLUGIN_ROOT}/scripts/api-reviewer.mjs\"`.",
      "Use the relay-local entrypoint `node \"${CLAUDE_PLUGIN_ROOT}/scripts/api-reviewer.mjs\"`.",
    )
    .replace(
      /Do not run bare `api-reviewer`, do not rely on `PATH`, and do not use repository-relative paths such as `plugins\/relay-(?:deepseek|glm)\/scripts\/api-reviewer\.mjs`\./g,
      "Do not run bare `api-reviewer`, do not rely on `PATH`, and do not use repository-relative paths.",
    )
    .replaceAll("RELAY_RUNTIME_DIR", "CLAUDE_PLUGIN_DATA")
    .replaceAll(
      "After installation or cache refresh, start a fresh Codex session so plugin skills are discoverable.",
      "After installation or cache refresh, start a fresh Claude Code session so plugin commands are discoverable.",
    )
    .replace(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([^"`\s]+\.mjs)"/g, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/relay-run.mjs" $1')
    .replace(/This command backs `[^`]+`\./g, "This command is emitted for the Claude relay plugin.")
    .replaceAll(
      "use `npm run grok:repair-session`, which pins explicit `--transport web`",
      "use `node \"${CLAUDE_PLUGIN_ROOT}/scripts/relay-run.mjs\" grok-web-reviewer.mjs repair --transport web`, which pins explicit `--transport web`",
    )
    .replaceAll(
      "run `npm run grok:repair-session -- --approve-browser-session-sync`",
      "run `node \"${CLAUDE_PLUGIN_ROOT}/scripts/relay-run.mjs\" grok-web-reviewer.mjs repair --transport web --approve-browser-session-sync`",
    );

  if (rendered.includes('--prompt-file "$RELAY_PROMPT_FILE"')) {
    rendered = insertPromptPayloadGuidance(rendered);
  }

  return rendered;
}

function rewriteCodexHostDescription(description) {
  return String(description).replaceAll("from within Codex", "from within Claude Code");
}

function filterRelayKeywords(keywords, provider) {
  const allowed = {
    deepseek: new Set(["deepseek", "api", "review"]),
    glm: new Set(["glm", "zai", "api", "review"]),
  }[provider];
  return allowed ? keywords.filter((keyword) => allowed.has(keyword)) : keywords;
}

function filterRelayConfig({ pluginRoot, provider }) {
  if (!["deepseek", "glm"].includes(provider)) return;

  const providersPath = join(pluginRoot, "config", "providers.json");
  if (!existsSync(providersPath)) return;

  const providers = readJson(providersPath);
  if (!providers[provider]) {
    throw new Error(`provider config missing ${provider}`);
  }
  writeJson(providersPath, { [provider]: providers[provider] });
}

function writeRelayRunner({ pluginRoot, repoRoot, definition }) {
  const scriptsRoot = join(pluginRoot, "scripts");
  const scriptsLibRoot = join(scriptsRoot, "lib");
  mkdirSync(scriptsLibRoot, { recursive: true });
  copyIfExists(join(repoRoot, "scripts", "lib", "claude-env.mjs"), join(scriptsLibRoot, "claude-env.mjs"));
  writeFileSync(join(scriptsRoot, "relay-run.mjs"), renderRelayRunner(definition), "utf8");
}

function renderRelayRunner(definition) {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claudePluginDataRoot, claudeSessionId } from "./lib/claude-env.mjs";

const PLUGIN_DATA_ENV = ${JSON.stringify(definition.pluginDataEnv)};
const SESSION_ID_ENV = ${JSON.stringify(definition.sessionIdEnv ?? null)};
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [scriptName, ...args] = process.argv.slice(2);

if (!scriptName || scriptName.includes("/") || scriptName.includes("\\\\")) {
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
`;
}

function renderSynthesizedCustomReviewDoc(provider, definition) {
  const displayName = providerDisplayName(provider);
  const timeoutEnv = `${provider.toUpperCase()}_REVIEW_TIMEOUT_MS`;
  return `---
description: Ask ${displayName} to review explicit files.
argument-hint: "--scope-paths <files> [--timeout-ms MS] [review prompt]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

# ${displayName} Custom Review

EXTERNAL_MODEL_CONTRACT_VERSION=1

\`$ARGUMENTS\` is required \`--scope-paths <files>\`, optional \`--timeout-ms MS\`, and review prompt text.
Route \`--scope-paths <files>\` before \`--prompt-file\` and write the remaining prompt text to the private prompt file referenced by \`RELAY_PROMPT_FILE\`.
Review timeout defaults to 900000 ms. Use \`--timeout-ms <ms>\` or \`${timeoutEnv}\`; the effective value is persisted in \`review_metadata.audit_manifest.request.timeout_ms\`.

Run:

- \`node "<plugin-root>/scripts/${definition.commandPrefix}-companion.mjs" run --mode=custom-review --scope custom --scope-paths "<file1>,<file2>" --foreground --lifecycle-events markdown -- "<prompt text>"\`

## Review Contract
This is a review-only contract.
Do not fix findings, apply patches, edit files, or start rescue work from a review result.
Preserve the caller's review text verbatim after routing documented flags.
Return the runtime output verbatim; do not summarize or rewrite findings.
If there is no substantive result or structured output, report review blocked / no findings produced.
Render lifecycle markdown cards directly.

## Scope Safety
Use custom-review only for explicit file bundles. Scope validation must complete before selected source is sent.
If concrete files or --scope-paths are already known, do not run branch-diff first; use custom-review with those paths and the original prompt.

## Secret Safety
Do not print raw OAuth tokens, API-key values, session cookies, tunnel API keys, bearer tokens, or raw secret values.
Credential diagnostics may show key names only.
`;
}

function insertPromptPayloadGuidance(rendered) {
  if (rendered.includes("Prompt payload:")) return rendered;

  const block = "\nPrompt payload:\nWrite the routed focus text to a private temp file (mode 0600), set `RELAY_PROMPT_FILE` to that path, and delete it after the command exits.\n\n";
  if (rendered.includes("\nRun:\n")) {
    return rendered.replace("\nRun:\n", `${block}Run:\n`);
  }

  const inlineRunIndex = rendered.indexOf("\nRun `node ");
  if (inlineRunIndex !== -1) {
    return `${rendered.slice(0, inlineRunIndex)}${block}${rendered.slice(inlineRunIndex)}`;
  }

  const commandBulletIndex = rendered.indexOf("\n- `node ");
  if (commandBulletIndex !== -1) {
    return `${rendered.slice(0, commandBulletIndex)}${block}${rendered.slice(commandBulletIndex)}`;
  }

  return `${rendered.trimEnd()}${block}\n`;
}

function providerDisplayName(provider) {
  if (provider === "glm") return "GLM";
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyIfExists(source, destination) {
  if (!existsSync(source)) return;
  cpSync(source, destination, { recursive: true, force: true });
}
