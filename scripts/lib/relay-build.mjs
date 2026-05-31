import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const RELAY_REPOSITORY = "https://github.com/seungpyoson/relay";
const RELAY_PROVIDER_ORDER = Object.freeze(["gemini", "grok", "kimi", "glm", "deepseek"]);
const RELAY_PROVIDER_DEFINITIONS = Object.freeze({
  gemini: { sourceProvider: "gemini", commandPrefix: "gemini" },
  grok: { sourceProvider: "grok", commandPrefix: "grok" },
  kimi: { sourceProvider: "kimi", commandPrefix: "kimi" },
  glm: {
    sourceProvider: "api-reviewers",
    commandPrefix: "glm",
    description: "Delegate code reviews to GLM direct API from within Claude Code.",
  },
  deepseek: {
    sourceProvider: "api-reviewers",
    commandPrefix: "deepseek",
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

  return pluginRoot;
}

export function buildRelaySuite({ repoRoot = process.cwd(), outRoot = join(repoRoot, "relay") } = {}) {
  return RELAY_PROVIDER_ORDER.map((provider) => buildRelayPlugin({ provider, repoRoot, outRoot }));
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

  return {
    name: relayPluginName(provider),
    ...rest,
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
    .replaceAll('node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/codex-plugin-multi/api-reviewers/0.1.0/scripts/api-reviewer.mjs"', 'node "${CLAUDE_PLUGIN_ROOT}/scripts/api-reviewer.mjs"')
    .replaceAll("${CODEX_HOME:-$HOME/.codex}/plugins/cache/codex-plugin-multi/api-reviewers/0.1.0/scripts/api-reviewer.mjs", "${CLAUDE_PLUGIN_ROOT}/scripts/api-reviewer.mjs")
    .replaceAll('-- "<focus text>"', '--prompt-file "$RELAY_PROMPT_FILE"')
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
      "Use the global installed entrypoint `node \"${CLAUDE_PLUGIN_ROOT}/scripts/api-reviewer.mjs\"`.",
      "Use the relay-local entrypoint `node \"${CLAUDE_PLUGIN_ROOT}/scripts/api-reviewer.mjs\"`.",
    )
    .replaceAll(
      "Do not run bare `api-reviewer`, do not rely on `PATH`, and do not use repository-relative paths such as `plugins/api-reviewers/scripts/api-reviewer.mjs`.",
      "Do not run bare `api-reviewer`, do not rely on `PATH`, and do not use repository-relative paths.",
    )
    .replace(/This command backs `plugins\/[^`]+`\./g, "This command is emitted for the Claude relay plugin.");

  if (rendered.includes('--prompt-file "$RELAY_PROMPT_FILE"')) {
    rendered = rendered.replace(
      "\nRun:\n",
      [
        "\nPrompt payload:",
        "Write the routed focus text to a private temp file (mode 0600), set `RELAY_PROMPT_FILE` to that path, and delete it after the command exits.",
        "",
        "Run:",
        "",
      ].join("\n"),
    );
  }

  return rendered;
}

function rewriteCodexHostDescription(description) {
  return String(description).replaceAll("from within Codex", "from within Claude Code");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

function copyIfExists(source, destination) {
  if (!existsSync(source)) return;
  cpSync(source, destination, { recursive: true, force: true });
}
