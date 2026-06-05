import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertBuildableOutRoot,
  buildRelayPlugin,
  buildRelaySuite,
  claudeCommandFileName,
  renderClaudeCommandDoc,
  renderClaudePluginManifest,
  relayPluginName,
} from "../../scripts/lib/relay-build.mjs";

function writeStubDirectApiRuntime(pluginRoot) {
  const scriptsRoot = path.join(pluginRoot, "scripts");
  mkdirSync(scriptsRoot, { recursive: true });
  writeFileSync(
    path.join(scriptsRoot, "relay-entrypoint.mjs"),
    "export function runRelayDirectApiEntrypoint({ provider }) { console.log(JSON.stringify({ ok: true, providers: [provider] })); }\n",
    "utf8",
  );
}

function readManifestVersion(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8")).version;
}

test("relayPluginName: prefixes provider plugins for relay", () => {
  assert.equal(relayPluginName("gemini"), "relay-gemini");
  assert.equal(relayPluginName("deepseek"), "relay-deepseek");
});

test("assertBuildableOutRoot: refuses outRoot shapes that would rmSync the source tree", () => {
  // outRoot === repoRoot: rmSync(outRoot) would wipe the repo itself.
  assert.throws(() => assertBuildableOutRoot("/repo", "/repo"), /dedicated build directory/);
  // outRoot === "." resolves to cwd; with repoRoot at cwd it is the same destructive case.
  assert.throws(() => assertBuildableOutRoot(process.cwd(), "."), /dedicated build directory/);
  // outRoot is an ancestor of repoRoot: rmSync(outRoot) would take the repo down with it.
  assert.throws(() => assertBuildableOutRoot("/repo/nested", "/repo"), /dedicated build directory/);
  // path-normalized ancestor (trailing-segment traversal) is rejected just the same.
  assert.throws(() => assertBuildableOutRoot("/repo/nested", "/repo/nested/build/.."), /dedicated build directory/);
  // A dedicated build dir inside the repo, and an out-of-tree sibling, are both allowed.
  assert.doesNotThrow(() => assertBuildableOutRoot("/repo", "/repo/build"));
  assert.doesNotThrow(() => assertBuildableOutRoot("/repo", "/tmp/relay-out"));
});

test("renderClaudePluginManifest: converts Codex manifest to Claude relay plugin manifest", () => {
  const codexManifest = JSON.parse(readFileSync("plugins/gemini/.codex-plugin/plugin.json", "utf8"));
  const manifest = renderClaudePluginManifest(codexManifest, { provider: "gemini" });

  assert.equal(manifest.name, "relay-gemini");
  assert.equal(manifest.description, "Delegate investigation, review, and adversarial review to Gemini CLI from within Claude Code.");
  assert.equal(manifest.repository, "https://github.com/relay-org/relay");
  assert.equal(manifest.homepage, "https://github.com/relay-org/relay");
  assert.equal(manifest.interface, undefined);
  assert.equal(manifest.skills, undefined);
  assert.deepEqual(manifest.author, { name: "relay-maintainer" });
});

test("claudeCommandFileName: strips provider prefix for Claude plugin command namespace", () => {
  assert.equal(claudeCommandFileName("gemini-review.md", "gemini"), "review.md");
  assert.equal(claudeCommandFileName("gemini-adversarial-review.md", "gemini"), "adversarial-review.md");
  assert.equal(claudeCommandFileName("gemini-setup.md", "gemini"), "setup.md");
});

test("renderClaudeCommandDoc: uses Claude plugin root env and keeps Codex command token out", () => {
  const codexDoc = readFileSync("plugins/gemini/commands/gemini-review.md", "utf8");
  const rendered = renderClaudeCommandDoc(codexDoc);

  assert.match(rendered, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/relay-run\.mjs" gemini-companion\.mjs/);
  assert.doesNotMatch(rendered, /<plugin-root>/);
});

test("renderClaudeCommandDoc: routes focus payload outside inline shell argv", () => {
  const codexDoc = readFileSync("plugins/gemini/commands/gemini-review.md", "utf8");
  const rendered = renderClaudeCommandDoc(codexDoc);

  assert.match(rendered, /private temp file/);
  assert.match(rendered, /--prompt-file "\$RELAY_PROMPT_FILE"/);
  assert.doesNotMatch(rendered, /-- "<focus text>"/);
  assert.doesNotMatch(rendered, /pass the remaining focus text after `--`/);
  assert.doesNotMatch(rendered, /plugins\/gemini\/skills/);
});

test("renderClaudeCommandDoc: rewrites direct API relay cache paths for any package version", () => {
  const codexDoc = [
    "Run `node \"${CODEX_HOME:-$HOME/.codex}/plugins/cache/relay-for-codex/relay-glm/2.3.4/scripts/api-reviewer.mjs\" doctor --provider glm`.",
    "Use `${CODEX_HOME:-$HOME/.codex}/plugins/cache/relay-for-codex/relay-deepseek/2.3.4-beta.1/scripts/api-reviewer.mjs` locally.",
  ].join("\n");
  const rendered = renderClaudeCommandDoc(codexDoc);

  assert.match(rendered, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/relay-run\.mjs" api-reviewer\.mjs doctor --provider glm/);
  assert.match(rendered, /`\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/api-reviewer\.mjs` locally/);
  assert.doesNotMatch(rendered, /CODEX_HOME|plugins\/cache\/relay|2\.3\.4/);
});

test("buildRelayPlugin: emits relay-gemini Claude plugin tree", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-build-"));
  try {
    const pluginRoot = buildRelayPlugin({ provider: "gemini", repoRoot: process.cwd(), outRoot });

    assert.equal(pluginRoot, path.join(outRoot, "relay-gemini"));
    assert.equal(existsSync(path.join(pluginRoot, ".claude-plugin", "plugin.json")), true);
    assert.equal(existsSync(path.join(pluginRoot, ".codex-plugin")), false);

    const manifest = JSON.parse(readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "relay-gemini");
    assert.equal(manifest.interface, undefined);
    assert.equal(manifest.skills, undefined);

    assert.deepEqual(readdirSync(path.join(pluginRoot, "commands")).sort(), [
      "adversarial-review.md",
      "cancel.md",
      "custom-review.md",
      "rescue.md",
      "result.md",
      "review.md",
      "setup.md",
      "status.md",
    ]);

    const reviewDoc = readFileSync(path.join(pluginRoot, "commands", "review.md"), "utf8");
    assert.match(reviewDoc, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/relay-run\.mjs" gemini-companion\.mjs/);
    assert.match(reviewDoc, /--prompt-file "\$RELAY_PROMPT_FILE"/);
    assert.doesNotMatch(reviewDoc, /<plugin-root>|-- "<focus text>"/);

    const customReviewDoc = readFileSync(path.join(pluginRoot, "commands", "custom-review.md"), "utf8");
    assert.match(customReviewDoc, /--mode=custom-review/);
    assert.match(customReviewDoc, /--scope-paths "<file1>,<file2>"/);
    assert.match(customReviewDoc, /--prompt-file "\$RELAY_PROMPT_FILE"/);

    const relayRun = readFileSync(path.join(pluginRoot, "scripts", "relay-run.mjs"), "utf8");
    assert.match(relayRun, /GEMINI_PLUGIN_DATA/);
    assert.match(relayRun, /claudePluginDataRoot/);
    const claudeEnv = readFileSync(path.join(pluginRoot, "scripts", "lib", "claude-env.mjs"), "utf8");
    assert.match(claudeEnv, /CLAUDE_PLUGIN_DATA/);
    assert.equal(existsSync(path.join(pluginRoot, "scripts", "gemini-companion.mjs")), true);
    assert.equal(existsSync(path.join(pluginRoot, "scripts", "lib", "gemini.mjs")), true);
    assert.equal(existsSync(path.join(pluginRoot, "config", "models.json")), true);
    assert.equal(existsSync(path.join(pluginRoot, "policies", "read-only.toml")), true);
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});

test("buildRelaySuite: emits the full Claude relay provider suite without relay-claude", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "relay-suite-"));
  const outRoot = path.join(tmpRoot, "relay");
  try {
    const pluginRoots = buildRelaySuite({ repoRoot: process.cwd(), outRoot });
    const pluginNames = pluginRoots.map((root) => path.basename(root)).sort();

    assert.deepEqual(pluginNames, [
      "relay-deepseek",
      "relay-gemini",
      "relay-glm",
      "relay-grok",
      "relay-kimi",
    ]);
    assert.equal(existsSync(path.join(outRoot, "relay-claude")), false);

    const marketplace = JSON.parse(readFileSync(path.join(tmpRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    // The manifest lives at the marketplace root (dirname(outRoot)); the pre-relocation location
    // under outRoot must be absent so a github source never resolves a stale subdir manifest.
    assert.equal(existsSync(path.join(outRoot, ".claude-plugin", "marketplace.json")), false);
    const publicPlugins = marketplace.plugins.filter((plugin) => plugin.policy?.installation !== "HIDDEN");
    const hiddenPlugins = marketplace.plugins.filter((plugin) => plugin.policy?.installation === "HIDDEN");
    assert.equal(marketplace.name, "relay-for-claude");
    assert.deepEqual(publicPlugins.map((plugin) => plugin.name).sort(), pluginNames);
    assert.deepEqual(hiddenPlugins.map((plugin) => plugin.name), ["relay-api-reviewers"]);
    assert.equal(hiddenPlugins[0].source, "./relay/relay-api-reviewers");
    assert.equal(
      existsSync(path.resolve(tmpRoot, hiddenPlugins[0].source, ".claude-plugin", "plugin.json")),
      true,
    );
    assert.equal(existsSync(path.join(outRoot, "relay-api-reviewers")), true);
    assert.equal(lstatSync(path.join(outRoot, "relay-api-reviewers")).isSymbolicLink(), true);
    for (const plugin of publicPlugins) {
      assert.equal(plugin.source, `./relay/${plugin.name}`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("buildRelaySuite: removes stale generated relay provider directories", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "relay-suite-stale-"));
  const outRoot = path.join(tmpRoot, "relay");
  try {
    writeStubDirectApiRuntime(path.join(outRoot, "relay-old-provider"));

    buildRelaySuite({ repoRoot: process.cwd(), outRoot });

    assert.equal(existsSync(path.join(outRoot, "relay-old-provider")), false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("buildRelayPlugin: direct API wrapper reports contracted missing entrypoint", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-api-missing-"));
  try {
    const pluginRoot = buildRelayPlugin({ provider: "glm", repoRoot: process.cwd(), outRoot });
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "api-reviewer.mjs"), "--help"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /api_reviewer_entrypoint_missing/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});

test("buildRelayPlugin: direct API wrapper resolves sibling relay-api-reviewers runtime", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-api-sibling-"));
  try {
    const pluginRoot = buildRelayPlugin({ provider: "glm", repoRoot: process.cwd(), outRoot });
    writeStubDirectApiRuntime(path.join(outRoot, "relay-api-reviewers"));

    const result = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "api-reviewer.mjs"), "--help"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"ok":true/);
    assert.match(result.stdout, /"providers":\["glm"\]/);
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});

test("buildRelayPlugin: direct API wrapper resolves installed relay-api-reviewers cache runtime", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-api-cache-source-"));
  const cacheRoot = mkdtempSync(path.join(tmpdir(), "relay-api-cache-"));
  try {
    const pluginRoot = buildRelayPlugin({ provider: "glm", repoRoot: process.cwd(), outRoot });
    const pluginVersion = readManifestVersion(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
    const sharedRuntimeVersion = readManifestVersion("plugins/api-reviewers/.claude-plugin/plugin.json");
    const installedPluginRoot = path.join(cacheRoot, "relay-for-claude", "relay-glm", pluginVersion);
    cpSync(pluginRoot, installedPluginRoot, { recursive: true });
    writeStubDirectApiRuntime(path.join(cacheRoot, "relay-for-claude", "relay-api-reviewers", sharedRuntimeVersion));

    const result = spawnSync(process.execPath, [path.join(installedPluginRoot, "scripts", "api-reviewer.mjs"), "--help"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"ok":true/);
    assert.match(result.stdout, /"providers":\["glm"\]/);
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("buildRelayPlugin: Claude direct API wrapper stays relay-local", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-api-local-wrapper-"));
  try {
    const pluginRoot = buildRelayPlugin({ provider: "glm", repoRoot: process.cwd(), outRoot });
    const wrapper = readFileSync(path.join(pluginRoot, "scripts", "api-reviewer.mjs"), "utf8");

    assert.match(wrapper, /relay-api-reviewers/);
    assert.doesNotMatch(wrapper, /relay-for-codex|CODEX_HOME|\.codex/);
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});

test("generated direct API relay wrappers run against the shared source runtime", () => {
  for (const provider of ["glm", "deepseek"]) {
    const result = spawnSync(
      process.execPath,
      [path.join("relay", `relay-${provider}`, "scripts", "api-reviewer.mjs"), "--help"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"ok": true/);
    assert.match(result.stdout, new RegExp(`"providers": \\[\\s*"${provider}"\\s*\\]`));
  }
});

test("buildRelayPlugin: filters split direct API relay commands by provider", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-api-"));
  try {
    const glmRoot = buildRelayPlugin({ provider: "glm", repoRoot: process.cwd(), outRoot });
    const deepseekRoot = buildRelayPlugin({ provider: "deepseek", repoRoot: process.cwd(), outRoot });

    assert.deepEqual(readdirSync(path.join(glmRoot, "commands")).sort(), [
      "adversarial-review.md",
      "custom-review.md",
      "review.md",
      "setup.md",
    ]);
    assert.deepEqual(readdirSync(path.join(deepseekRoot, "commands")).sort(), [
      "adversarial-review.md",
      "custom-review.md",
      "review.md",
      "setup.md",
    ]);

    const glmReview = readFileSync(path.join(glmRoot, "commands", "review.md"), "utf8");
    assert.match(glmReview, /--provider glm/);
    assert.doesNotMatch(glmReview, /--provider deepseek/);

    const glmProviders = JSON.parse(readFileSync(path.join(glmRoot, "config", "providers.json"), "utf8"));
    const deepseekProviders = JSON.parse(readFileSync(path.join(deepseekRoot, "config", "providers.json"), "utf8"));
    assert.deepEqual(Object.keys(glmProviders), ["glm"]);
    assert.deepEqual(Object.keys(deepseekProviders), ["deepseek"]);

    const glmManifest = JSON.parse(readFileSync(path.join(glmRoot, ".claude-plugin", "plugin.json"), "utf8"));
    const deepseekManifest = JSON.parse(readFileSync(path.join(deepseekRoot, ".claude-plugin", "plugin.json"), "utf8"));
    assert.deepEqual(glmManifest.keywords, ["glm", "zai", "api", "review"]);
    assert.deepEqual(deepseekManifest.keywords, ["deepseek", "api", "review"]);
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});

test("renderClaudeCommandDoc: rewrites relay command paths and prompt transport for all provider styles", () => {
  const docs = [
    "plugins/grok/commands/grok-review.md",
    "plugins/kimi/commands/kimi-review.md",
    "plugins/kimi/commands/kimi-rescue.md",
    "plugins/relay-glm/commands/glm-review.md",
  ].map((file) => renderClaudeCommandDoc(readFileSync(file, "utf8")));

  for (const rendered of docs) {
    assert.match(rendered, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/relay-run\.mjs"/);
    assert.match(rendered, /--prompt-file "\$RELAY_PROMPT_FILE"/);
    assert.doesNotMatch(rendered, /CODEX_HOME|\.codex|node plugins\/|<plugin-root>|-- "<focus text>"|-- "\$ARGUMENTS"|--prompt "<prompt text>"/);
  }
});

test("buildRelaySuite: generated relay commands do not leak Codex host contracts", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "relay-host-"));
  const outRoot = path.join(tmpRoot, "relay");
  try {
    for (const pluginRoot of buildRelaySuite({ repoRoot: process.cwd(), outRoot })) {
      for (const fileName of readdirSync(path.join(pluginRoot, "commands"))) {
        const commandDoc = readFileSync(path.join(pluginRoot, "commands", fileName), "utf8");
        assert.doesNotMatch(
          commandDoc,
          /\bCodex\b|CODEX_HOME|RELAY_RUNTIME_DIR|\.codex|plugins\/(?:api-reviewers|grok)|npm run|This command backs|before `--`/,
          `${path.basename(pluginRoot)}/commands/${fileName}`,
        );
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("buildRelaySuite: generated direct API relay runtimes do not leak Codex package paths", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-runtime-host-"));
  try {
    const sharedEntrypoint = readFileSync("plugins/api-reviewers/scripts/relay-entrypoint.mjs", "utf8");
    assert.match(sharedEntrypoint, /this relay plugin's config\/providers\.json/);

    for (const provider of ["glm", "deepseek"]) {
      const pluginRoot = buildRelayPlugin({ provider, repoRoot: process.cwd(), outRoot });
      const runtime = readFileSync(path.join(pluginRoot, "scripts", "api-reviewer.mjs"), "utf8");
      assert.doesNotMatch(runtime, /plugins\/api-reviewers\/config\/providers\.json/, provider);
    }
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});

test("Codex split direct API relay plugins delegate to one shared runtime copy", () => {
  const sharedEntrypoint = readFileSync("plugins/api-reviewers/scripts/relay-entrypoint.mjs", "utf8");
  assert.match(sharedEntrypoint, /RELAY_API_REVIEWERS_RUNTIME/);
  assert.match(sharedEntrypoint, /API_REVIEWERS_PROVIDERS_PATH/);

  for (const provider of ["glm", "deepseek"]) {
    const pluginRoot = path.join("plugins", `relay-${provider}`);
    const runtime = readFileSync(path.join(pluginRoot, "scripts", "api-reviewer.mjs"), "utf8");

    assert.match(runtime, /relay-entrypoint\.mjs/, provider);
    assert.ok(runtime.split("\n").length <= 60, provider);
    assert.match(runtime, /api_reviewer_entrypoint_missing/, provider);
    assert.doesNotMatch(runtime, /async function runCommand|function buildRecord|async function loadProviders/, provider);
    assert.doesNotMatch(runtime, /spawnSync|runtimeCandidates|function argProvider/, provider);
    assert.equal(existsSync(path.join(pluginRoot, "scripts", "lib")), false, provider);
  }
});

test("buildRelaySuite: prompt-file commands document private prompt lifecycle", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "relay-prompt-"));
  const outRoot = path.join(tmpRoot, "relay");
  try {
    for (const pluginRoot of buildRelaySuite({ repoRoot: process.cwd(), outRoot })) {
      for (const fileName of readdirSync(path.join(pluginRoot, "commands"))) {
        const commandDoc = readFileSync(path.join(pluginRoot, "commands", fileName), "utf8");
        if (!commandDoc.includes('--prompt-file "$RELAY_PROMPT_FILE"')) continue;

        assert.match(commandDoc, /Prompt payload:/, `${path.basename(pluginRoot)}/commands/${fileName}`);
        assert.match(commandDoc, /private temp file/, `${path.basename(pluginRoot)}/commands/${fileName}`);
        assert.match(commandDoc, /mode 0600/, `${path.basename(pluginRoot)}/commands/${fileName}`);
        assert.match(commandDoc, /delete it after the command exits/, `${path.basename(pluginRoot)}/commands/${fileName}`);
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("buildRelayPlugin: emits custom-review commands when docs route explicit file bundles", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-custom-"));
  try {
    for (const provider of ["gemini", "kimi"]) {
      const pluginRoot = buildRelayPlugin({ provider, repoRoot: process.cwd(), outRoot });
      const commands = readdirSync(path.join(pluginRoot, "commands")).sort();
      assert.ok(commands.includes("custom-review.md"));

      const customReviewDoc = readFileSync(path.join(pluginRoot, "commands", "custom-review.md"), "utf8");
      assert.match(customReviewDoc, /custom-review/);
      assert.match(customReviewDoc, /--scope-paths "<file1>,<file2>"/);
      assert.match(customReviewDoc, /--prompt-file "\$RELAY_PROMPT_FILE"/);
      assert.match(customReviewDoc, new RegExp(`relay-run\\.mjs" ${provider}-companion\\.mjs`));
    }
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});
