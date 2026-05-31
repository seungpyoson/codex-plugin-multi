import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRelayPlugin,
  buildRelaySuite,
  claudeCommandFileName,
  renderClaudeCommandDoc,
  renderClaudePluginManifest,
  relayPluginName,
} from "../../scripts/lib/relay-build.mjs";

test("relayPluginName: prefixes provider plugins for relay", () => {
  assert.equal(relayPluginName("gemini"), "relay-gemini");
  assert.equal(relayPluginName("deepseek"), "relay-deepseek");
});

test("renderClaudePluginManifest: converts Codex manifest to Claude relay plugin manifest", () => {
  const codexManifest = JSON.parse(readFileSync("plugins/gemini/.codex-plugin/plugin.json", "utf8"));
  const manifest = renderClaudePluginManifest(codexManifest, { provider: "gemini" });

  assert.equal(manifest.name, "relay-gemini");
  assert.equal(manifest.description, "Delegate investigation, review, and adversarial review to Gemini CLI from within Claude Code.");
  assert.equal(manifest.repository, "https://github.com/seungpyoson/relay");
  assert.equal(manifest.homepage, "https://github.com/seungpyoson/relay");
  assert.equal(manifest.interface, undefined);
  assert.equal(manifest.skills, undefined);
  assert.deepEqual(manifest.author, { name: "seungpyoson" });
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
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-suite-"));
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

    const marketplace = JSON.parse(readFileSync(path.join(outRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    assert.equal(marketplace.name, "relay-for-claude");
    assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name).sort(), pluginNames);
    for (const plugin of marketplace.plugins) {
      assert.equal(plugin.source, `./${plugin.name}`);
    }
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
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
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-host-"));
  try {
    for (const pluginRoot of buildRelaySuite({ repoRoot: process.cwd(), outRoot })) {
      for (const fileName of readdirSync(path.join(pluginRoot, "commands"))) {
        const commandDoc = readFileSync(path.join(pluginRoot, "commands", fileName), "utf8");
        assert.doesNotMatch(
          commandDoc,
          /\bCodex\b|CODEX_HOME|CODEX_PLUGIN_MULTI_RUNTIME_DIR|\.codex|plugins\/(?:api-reviewers|grok)|npm run|This command backs|before `--`/,
          `${path.basename(pluginRoot)}/commands/${fileName}`,
        );
      }
    }
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});

test("buildRelaySuite: generated direct API relay runtimes do not leak Codex package paths", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-runtime-host-"));
  try {
    for (const provider of ["glm", "deepseek"]) {
      const pluginRoot = buildRelayPlugin({ provider, repoRoot: process.cwd(), outRoot });
      const runtime = readFileSync(path.join(pluginRoot, "scripts", "api-reviewer.mjs"), "utf8");
      assert.doesNotMatch(runtime, /plugins\/api-reviewers\/config\/providers\.json/, provider);
      assert.match(runtime, /this relay plugin's config\/providers\.json/, provider);
    }
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
});

test("buildRelaySuite: prompt-file commands document private prompt lifecycle", () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), "relay-prompt-"));
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
    rmSync(outRoot, { recursive: true, force: true });
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
