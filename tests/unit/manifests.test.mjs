import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_MARKETPLACE_AUTHENTICATION_POLICIES,
  CODEX_MARKETPLACE_INSTALLATION_POLICIES,
} from "../../scripts/lib/codex-marketplace-schema.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESCRIPTION_MAX_LENGTH = 88;
const DELEGATION_PLUGINS = ["claude", "gemini", "kimi"];
const API_REVIEWER_PROVIDERS = ["deepseek", "glm"];
const GROK_WORKFLOWS = ["review", "adversarial-review", "custom-review", "setup"];

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relayPluginName(provider) {
  return `relay-${provider}`;
}

function marketplaceSourcePath(plugin) {
  return plugin.source.path.replace(/^\.\//, "");
}

function assertPickerDescription(skill, rel) {
  const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? "";
  assert.ok(description.length > 0, `${rel} missing description`);
  assert.ok(
    description.length <= DESCRIPTION_MAX_LENGTH,
    `${rel} description too long for picker: ${description.length}`,
  );
}

function assertNoBracketedCliFlagsInShellFences(skill, rel) {
  for (const [, block] of skill.matchAll(/(?:^|\n)[ \t]*```(?:bash|sh|shell)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)) {
    assert.doesNotMatch(block, /\[[^\]\n]*--[a-z0-9-]+[^\]\n]*\]/i, `${rel} has bracketed optional CLI syntax`);
  }
}

function assertNoShellVariablePlaceholdersInShellFences(skill, rel) {
  for (const [, block] of skill.matchAll(/(?:^|\n)[ \t]*```(?:bash|sh|shell)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)) {
    assert.doesNotMatch(block, /"\$(?:PROMPT|FILES|ARGUMENTS|SCOPE_PATHS)"/, `${rel} has shell variable placeholders in copyable commands`);
  }
}

test("bracketed optional flag guard covers sh fenced command blocks", () => {
  assert.throws(
    () => assertNoBracketedCliFlagsInShellFences("```sh\nnode script.mjs [--scope-base REF]\n```", "fixture.md"),
    /fixture\.md has bracketed optional CLI syntax/,
  );
});

test("bracketed optional flag guard covers shell fence labels with trailing whitespace", () => {
  assert.throws(
    () => assertNoBracketedCliFlagsInShellFences("```bash \nnode script.mjs [--scope-base REF]\n```", "fixture.md"),
    /fixture\.md has bracketed optional CLI syntax/,
  );
});

function assertCompanionWorkflowInvocation(skill, plugin, workflow, rel) {
  assertNoBracketedCliFlagsInShellFences(skill, rel);
  if (workflow === "setup") {
    assert.match(skill, new RegExp(`${plugin}-companion\\.mjs"\\s+doctor\\b`), `${rel} missing doctor subcommand`);
    return;
  }

  if (["status", "result", "cancel"].includes(workflow)) {
    assert.match(skill, new RegExp(`${plugin}-companion\\.mjs"\\s+${workflow}\\b`), `${rel} missing ${workflow} subcommand`);
    return;
  }

  assert.match(skill, new RegExp(`${plugin}-companion\\.mjs"\\s+run\\b`), `${rel} missing run subcommand`);
  assert.match(skill, new RegExp(`--mode=${workflow}\\b`), `${rel} missing --mode=${workflow}`);
  if (workflow === "rescue") {
    assert.match(skill, /--background\b/, `${rel} missing --background`);
    // kimi-code has no per-turn step budget; no provider documents a max-step flag.
    assert.doesNotMatch(skill, /--max-steps-per-turn\b/, `${rel} must not document a max-step option (kimi-code has none)`);
  } else {
    assert.match(skill, /--foreground\b/, `${rel} missing --foreground`);
  }
  if (["review", "adversarial-review"].includes(workflow)) {
    assert.match(skill, /--lifecycle-events\s+markdown\b/, `${rel} missing lifecycle markdown option`);
    assert.match(skill, /external_review_launched/, `${rel} missing launch event rendering guidance`);
    assert.match(skill, /--scope-base REF/, `${rel} missing optional --scope-base`);
    assert.match(skill, /`<focus>` is the user's review prompt or focus area/, `${rel} must define focus placeholder`);
    assert.match(skill, /external_review|claude-result-handling/, `${rel} missing external review rendering guidance`);
    // kimi-code has no per-turn step budget; no provider documents a max-step flag.
    assert.doesNotMatch(skill, /--max-steps-per-turn\b/, `${rel} must not document a max-step option (kimi-code has none)`);
  }
}

function assertApiReviewerWorkflowInvocation(skill, provider, workflow, rel) {
  assertNoBracketedCliFlagsInShellFences(skill, rel);
  assert.match(
    skill,
    new RegExp(`api-reviewer\\.mjs"\\s+${workflow === "setup" ? "doctor" : "run"}\\b`),
    `${rel} missing api-reviewer script subcommand`,
  );
  assert.match(skill, new RegExp(`--provider\\s+${provider}\\b`), `${rel} missing --provider ${provider}`);
  if (workflow === "setup") return;

  assert.match(skill, new RegExp(`--mode\\s+${workflow}\\b`), `${rel} missing --mode ${workflow}`);
  assert.doesNotMatch(skill, /--foreground\b/, `${rel} must not document ignored --foreground flag`);
  assert.match(skill, /--lifecycle-events\s+markdown\b/, `${rel} missing lifecycle markdown option`);
  assert.match(skill, /Render lifecycle markdown cards directly\./, `${rel} missing lifecycle markdown rendering guidance`);
  assert.match(skill, /external_review_launched/, `${rel} missing launch event rendering guidance`);
  assert.match(skill, /`error_code`/, `${rel} missing failed JobRecord error_code rendering guidance`);
  assert.match(skill, /`error_message`/, `${rel} missing failed JobRecord error_message rendering guidance`);
  assert.match(skill, /`http_status`/, `${rel} missing failed JobRecord http_status rendering guidance`);
  assert.match(skill, /`suggested_action`/, `${rel} missing failed JobRecord suggested_action rendering guidance`);
  assert.match(skill, /--prompt\s+"<focus>"/, `${rel} missing prompt placeholder`);
  assert.match(skill, /`<focus>` is the user's review prompt or focus area/, `${rel} must define focus placeholder`);
  if (workflow === "custom-review") {
    assert.match(skill, /--scope\s+custom\b/, `${rel} missing custom scope`);
    assert.match(skill, /--scope-paths\b/, `${rel} missing --scope-paths`);
    const scopePaths = skill.match(/--scope-paths\s+"([^"]+)"/)?.[1] ?? "";
    assert.ok(scopePaths.includes(","), `${rel} missing comma-separated scope-path placeholder`);
    assert.doesNotMatch(scopePaths, /[*?]/, `${rel} must not use glob characters in scope-path placeholder`);
    assert.doesNotMatch(scopePaths, /\s/, `${rel} scope-path placeholder must not use space-separated paths`);
    assert.match(skill, /Replace `<file1>,<file2>`/, `${rel} must tell agents to replace scope-path placeholders`);
    assert.match(skill, /comma- or newline-separated concrete relative `--scope-paths`/, `${rel} missing scope-path separator guidance`);
    assert.match(skill, /expand globs before running/i, `${rel} missing glob expansion guidance`);
    assert.match(skill, /external_review.*before the review result/, `${rel} missing external_review rendering guidance`);
  } else {
    assert.match(skill, /--scope\s+branch-diff\b/, `${rel} missing branch-diff scope`);
    assert.match(skill, /--scope-base REF/, `${rel} missing optional --scope-base`);
    assert.match(skill, /external_review.*before the review result/, `${rel} missing external_review rendering guidance`);
  }
}

function assertApiReviewerCommandDoc(command, workflow, rel) {
  assertNoBracketedCliFlagsInShellFences(command, rel);
  assert.doesNotMatch(command, /--foreground\b/, `${rel} must not document ignored --foreground flag`);
  if (workflow !== "setup") {
    assert.match(command, /--lifecycle-events\s+markdown\b/, `${rel} missing lifecycle markdown option`);
    assert.match(command, /Render lifecycle markdown cards directly\./, `${rel} missing lifecycle markdown rendering guidance`);
    assert.match(command, /external_review_launched/, `${rel} missing launch event rendering guidance`);
    assert.match(command, /external_review.*before the review result/, `${rel} missing external_review rendering guidance`);
    assert.match(command, /`error_code`/, `${rel} missing failed JobRecord error_code rendering guidance`);
    assert.match(command, /`error_message`/, `${rel} missing failed JobRecord error_message rendering guidance`);
    assert.match(command, /`http_status`/, `${rel} missing failed JobRecord http_status rendering guidance`);
    assert.match(command, /`suggested_action`/, `${rel} missing failed JobRecord suggested_action rendering guidance`);
  }
  if (["review", "adversarial-review"].includes(workflow)) {
    assert.match(command, /argument-hint:\s*"\[--scope-base REF\] \[review prompt\]"/, `${rel} missing scope-base argument hint`);
    assert.match(command, /`--scope-base REF` before `--prompt`/, `${rel} must route scope-base before prompt`);
    assert.match(command, /remaining prompt text to `--prompt`/, `${rel} must exclude scope-base from prompt text`);
    assert.doesNotMatch(command, /--prompt\s+"\$ARGUMENTS"/, `${rel} must not pass all arguments as prompt`);
  }
  if (workflow === "custom-review") {
    assert.match(command, /--scope\s+custom\b/, `${rel} missing custom scope`);
    assert.match(command, /--scope-paths\s+"<file1>,<file2>"/, `${rel} missing scope-path placeholder`);
    assert.match(command, /\$ARGUMENTS/, `${rel} must describe argument handling`);
    assert.match(command, /--scope-paths <files>/, `${rel} must map scope paths from arguments`);
    assert.match(command, /remaining prompt text to `--prompt`/, `${rel} must exclude scope paths from prompt text`);
    assert.match(command, /Replace `<file1>,<file2>`/, `${rel} must tell agents to replace scope-path placeholders`);
    assert.match(command, /comma- or newline-separated concrete relative paths/, `${rel} missing scope-path separator guidance`);
    assert.match(command, /expand globs before running/i, `${rel} missing glob expansion guidance`);
  }
}

function assertGrokWorkflowInvocation(skill, workflow, rel) {
  assertNoBracketedCliFlagsInShellFences(skill, rel);
  assertNoShellVariablePlaceholdersInShellFences(skill, rel);
  assert.match(skill, /grok-companion\.mjs\s+(setup|doctor|run)\b/, `${rel} missing grok-companion invocation`);
  assert.doesNotMatch(skill, /grok-web-reviewer\.mjs/, `${rel} must expose the generic Grok companion entrypoint`);
  assert.doesNotMatch(skill, /api\.x\.ai/i, `${rel} must not recommend direct xAI API fallback`);
  if (workflow === "setup") {
    assert.match(skill, /grok-companion\.mjs\s+doctor\b/, `${rel} missing doctor subcommand`);
    assert.match(skill, /credential key names only|key names only/i, `${rel} missing credential-name-only guidance`);
    return;
  }

  assert.match(skill, /grok-companion\.mjs\s+run\b/, `${rel} missing run subcommand`);
  assert.match(skill, new RegExp(`--mode\\s+${workflow}\\b`), `${rel} missing --mode ${workflow}`);
  assert.match(skill, /--foreground\b/, `${rel} missing --foreground`);
  assert.match(skill, /--lifecycle-events\s+markdown\b/, `${rel} missing lifecycle markdown option`);
  assert.match(skill, /Render lifecycle markdown cards directly\./, `${rel} missing lifecycle markdown rendering guidance`);
  assert.match(skill, /external_review_launched/, `${rel} missing launch event rendering guidance`);
  assert.match(skill, /`error_code`/, `${rel} missing failed JobRecord error_code rendering guidance`);
  assert.match(skill, /`error_message`/, `${rel} missing failed JobRecord error_message rendering guidance`);
  assert.match(skill, /`http_status`/, `${rel} missing failed JobRecord http_status rendering guidance`);
  assert.match(skill, /`suggested_action`/, `${rel} missing failed JobRecord suggested_action rendering guidance`);
  assert.match(skill, /--prompt\s+"<focus>"/, `${rel} missing prompt placeholder`);
  assert.match(skill, /`<focus>` is the user's review prompt or focus area/, `${rel} must define focus placeholder`);
  assert.match(skill, /session cookies|tunnel API-key|bearer token/i, `${rel} missing secret handling guidance`);
  if (workflow === "custom-review") {
    assert.match(skill, /--scope\s+custom\b/, `${rel} missing custom scope`);
    assert.match(skill, /--scope-paths\s+"<file1>,<file2>"/, `${rel} missing scope-path placeholder`);
    assert.match(skill, /Replace `<file1>,<file2>`/, `${rel} must tell agents to replace scope-path placeholders`);
    assert.match(skill, /comma- or newline-separated concrete relative `--scope-paths`/, `${rel} missing scope-path separator guidance`);
    assert.match(skill, /expand globs before running/i, `${rel} missing glob expansion guidance`);
  } else {
    assert.match(skill, /--scope\s+branch-diff\b/, `${rel} missing branch-diff scope`);
    assert.match(skill, /--scope-base REF/, `${rel} missing optional --scope-base`);
  }
  assert.match(skill, /external_review.*before the review result/, `${rel} missing external_review rendering guidance`);
}

function assertGrokCommandDoc(command, workflow, rel) {
  assertNoBracketedCliFlagsInShellFences(command, rel);
  assertNoShellVariablePlaceholdersInShellFences(command, rel);
  assert.match(command, /grok-companion\.mjs\s+(doctor|run)\b/, `${rel} missing grok-companion command`);
  assert.doesNotMatch(command, /grok-web-reviewer\.mjs/, `${rel} must expose the generic Grok companion entrypoint`);
  assert.match(command, /session cookies|tunnel API keys|bearer token/i, `${rel} missing secret handling guidance`);
  assert.doesNotMatch(command, /api\.x\.ai/i, `${rel} must not recommend direct xAI API fallback`);
  if (workflow === "setup") return;

  assert.match(command, new RegExp(`--mode\\s+${workflow}\\b`), `${rel} missing --mode ${workflow}`);
  assert.match(command, /--foreground\b/, `${rel} missing --foreground`);
  assert.match(command, /--lifecycle-events\s+markdown\b/, `${rel} missing lifecycle markdown option`);
  assert.match(command, /Render lifecycle markdown cards directly\./, `${rel} missing lifecycle markdown rendering guidance`);
  assert.match(command, /external_review_launched/, `${rel} missing launch event rendering guidance`);
  assert.match(command, /external_review.*before the review result/, `${rel} missing external_review rendering guidance`);
  assert.match(command, /`error_code`/, `${rel} missing failed JobRecord error_code rendering guidance`);
  assert.match(command, /`error_message`/, `${rel} missing failed JobRecord error_message rendering guidance`);
  assert.match(command, /`http_status`/, `${rel} missing failed JobRecord http_status rendering guidance`);
  assert.match(command, /`suggested_action`/, `${rel} missing failed JobRecord suggested_action rendering guidance`);
  if (["review", "adversarial-review"].includes(workflow)) {
    assert.match(command, /argument-hint:\s*"\[--scope-base REF\] \[review prompt\]"/, `${rel} missing scope-base argument hint`);
    assert.match(command, /`--scope-base REF` before `--prompt`/, `${rel} must route scope-base before prompt`);
    assert.match(command, /remaining prompt text to `--prompt`/, `${rel} must exclude scope-base from prompt text`);
    assert.doesNotMatch(command, /--prompt\s+"\$ARGUMENTS"/, `${rel} must not pass all arguments as prompt`);
  }
  if (workflow === "custom-review") {
    assert.match(command, /--scope\s+custom\b/, `${rel} missing custom scope`);
    assert.match(command, /--scope-paths\s+"<file1>,<file2>"/, `${rel} missing scope-path placeholder`);
    assert.match(command, /--scope-paths <files>/, `${rel} must map scope paths from arguments`);
    assert.match(command, /remaining prompt text to `--prompt`/, `${rel} must exclude scope paths from prompt text`);
    assert.match(command, /Replace `<file1>,<file2>`/, `${rel} must tell agents to replace scope-path placeholders`);
    assert.match(command, /comma- or newline-separated concrete relative paths/, `${rel} missing scope-path separator guidance`);
    assert.match(command, /expand globs before running/i, `${rel} missing glob expansion guidance`);
  }
}

const DELEGATION_WORKFLOWS = ["review", "adversarial-review", "rescue", "setup", "status", "result", "cancel"];
const API_REVIEWER_WORKFLOWS = ["review", "adversarial-review", "custom-review", "setup"];

test("marketplace.json: valid schema", () => {
  const m = readJson(".agents/plugins/marketplace.json");
  assert.equal(typeof m.name, "string");
  assert.equal(typeof m.interface.displayName, "string");
  assert.ok(Array.isArray(m.plugins));
  assert.ok(m.plugins.length >= 1);
  for (const p of m.plugins) {
    assert.equal(typeof p.name, "string");
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.name), `${p.name} not bare`);
    assert.ok(
      CODEX_MARKETPLACE_INSTALLATION_POLICIES.includes(p.policy.installation),
      `${p.name} has Codex-unsupported installation policy ${p.policy.installation}`,
    );
    assert.ok(CODEX_MARKETPLACE_AUTHENTICATION_POLICIES.includes(p.policy.authentication));
    assert.ok(["local", "git"].includes(p.source.source));
  }
});

test("Codex marketplace policy enums come from one shared schema source", () => {
  assert.deepEqual(CODEX_MARKETPLACE_INSTALLATION_POLICIES, [
    "AVAILABLE",
    "NOT_AVAILABLE",
    "INSTALLED_BY_DEFAULT",
  ]);
  assert.deepEqual(CODEX_MARKETPLACE_AUTHENTICATION_POLICIES, ["ON_INSTALL", "ON_USE"]);

  const linter = readFileSync(path.join(REPO_ROOT, "scripts/ci/check-manifests.mjs"), "utf8");
  assert.match(linter, /CODEX_MARKETPLACE_INSTALLATION_POLICIES/);
  assert.match(linter, /CODEX_MARKETPLACE_AUTHENTICATION_POLICIES/);
  assert.doesNotMatch(linter, /const INSTALLATION_ENUM = \[/);
  assert.doesNotMatch(linter, /const AUTHENTICATION_ENUM = \[/);
});

test("claude plugin.json: valid schema", () => {
  const m = readJson("plugins/claude/.codex-plugin/plugin.json");
  assert.equal(m.name, "relay-claude");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
  assert.ok(m.interface.capabilities.every((c) => ["Interactive", "Read", "Write"].includes(c)));
});

test("gemini plugin.json: valid schema", () => {
  const m = readJson("plugins/gemini/.codex-plugin/plugin.json");
  assert.equal(m.name, "relay-gemini");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
});

test("kimi plugin.json: valid schema", () => {
  const m = readJson("plugins/kimi/.codex-plugin/plugin.json");
  assert.equal(m.name, "relay-kimi");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
});

test("grok plugin.json: valid schema", () => {
  const m = readJson("plugins/grok/.codex-plugin/plugin.json");
  assert.equal(m.name, "relay-grok");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
  assert.match(m.interface.longDescription, /subscription-backed/i);
  assert.doesNotMatch(m.interface.longDescription, /api\.x\.ai/i);
});

test("direct API relay plugin.json files are split by provider", () => {
  for (const provider of API_REVIEWER_PROVIDERS) {
    const root = `plugins/${relayPluginName(provider)}`;
    const m = readJson(`${root}/.codex-plugin/plugin.json`);
    const providers = readJson(`${root}/config/providers.json`);
    assert.equal(m.name, relayPluginName(provider));
    assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
    assert.equal(m.license, "AGPL-3.0-only");
    assert.equal(m.skills, "./skills");
    assert.deepEqual(Object.keys(providers), [provider]);
  }
});

test("direct API relay packages expose api-reviewer bin shims", () => {
  for (const provider of API_REVIEWER_PROVIDERS) {
    const root = `plugins/${relayPluginName(provider)}`;
    const pkg = readJson(`${root}/package.json`);
    assert.deepEqual(pkg.bin, { "api-reviewer": "./bin/api-reviewer" });

    const shimRel = `${root}/bin/api-reviewer`;
    const shimPath = path.join(REPO_ROOT, shimRel);
    assert.equal(existsSync(shimPath), true, `${shimRel} missing`);
    assert.ok((statSync(shimPath).mode & 0o111) !== 0, `${shimRel} must be executable`);
    const shim = readFileSync(shimPath, "utf8");
    assert.match(shim, /^#!\/usr\/bin\/env node/);
    assert.match(shim, /\.\.\/scripts\/api-reviewer\.mjs/);
  }
});

test("direct API relay bin shims resolve from non-repo cwd", () => {
  for (const provider of API_REVIEWER_PROVIDERS) {
    const shimPath = path.join(REPO_ROOT, `plugins/${relayPluginName(provider)}/bin/api-reviewer`);
    const result = spawnSync(process.execPath, [shimPath, "--help"], {
      cwd: tmpdir(),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.commands, ["doctor", "ping", "approval-request", "approval-grant", "run", "result"]);
    assert.deepEqual(parsed.providers, [provider]);
  }
});

test("plugins declared in marketplace match filesystem layout", () => {
  const m = readJson(".agents/plugins/marketplace.json");
  for (const p of m.plugins) {
    const manifest = readJson(`${marketplaceSourcePath(p)}/.codex-plugin/plugin.json`);
    assert.equal(manifest.name, p.name, `${p.name} directory plugin.json name mismatch`);
  }
});

test("claude, gemini, kimi, and grok package non-ping command docs until upstream slash support lands", () => {
  const commands = [
    "review", "adversarial-review", "rescue",
    "setup", "status", "result", "cancel",
  ];
  for (const plugin of DELEGATION_PLUGINS) {
    for (const command of commands) {
      const rel = `plugins/${plugin}/commands/${plugin}-${command}.md`;
      assert.equal(existsSync(path.join(REPO_ROOT, rel)), true, `${rel} missing`);
    }
    const pingRel = `plugins/${plugin}/commands/${plugin}-ping.md`;
    assert.equal(existsSync(path.join(REPO_ROOT, pingRel)), false, `${pingRel} must stay deferred`);
  }
  for (const command of ["review", "adversarial-review", "custom-review", "setup"]) {
    const rel = `plugins/grok/commands/grok-${command}.md`;
    assert.equal(existsSync(path.join(REPO_ROOT, rel)), true, `${rel} missing`);
  }
  assert.equal(existsSync(path.join(REPO_ROOT, "plugins/grok/commands/grok-ping.md")), false);
});

test("claude, gemini, and kimi expose user-invocable skill fallbacks", () => {
  for (const plugin of DELEGATION_PLUGINS) {
    const rel = `plugins/${plugin}/skills/${plugin}-delegation/SKILL.md`;
    const skill = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.match(skill, new RegExp(`name: ${plugin}-delegation`));
    assert.match(skill, /user-invocable: true/);
    assert.match(skill, new RegExp(`${plugin}-companion\\.mjs`));
    assert.match(skill, new RegExp(`${plugin}-companion\\.mjs"\\s+doctor\\b`));
    assertNoBracketedCliFlagsInShellFences(skill, rel);
    assert.match(skill, /--scope-base REF/, `${rel} missing branch-diff base-ref guidance`);
    if (["gemini", "kimi"].includes(plugin)) {
      assert.match(skill, /event:\s*"launched"/, `${rel} must render background launched envelopes`);
      assert.match(skill, /background[\s\S]*external_review/, `${rel} must render background external_review cards`);
    }
    // kimi-code has no per-turn step budget; no delegation skill documents a max-step flag.
    assert.doesNotMatch(skill, /--max-steps-per-turn\b/, `${rel} must not document a max-step option (kimi-code has none)`);
    assertPickerDescription(skill, rel);
  }
});

test("grok exposes a user-invocable skill fallback", () => {
  const rel = "plugins/grok/skills/grok-delegation/SKILL.md";
  const skill = readFileSync(path.join(REPO_ROOT, rel), "utf8");

  assert.match(skill, /^name:\s*grok-delegation$/m);
  assert.match(skill, /^user-invocable:\s*true$/m);
  assert.match(skill, /grok-companion\.mjs/);
  assert.match(skill, /grok-companion\.mjs\s+doctor\b/);
  assert.doesNotMatch(skill, /grok-web-reviewer\.mjs/);
  assert.match(skill, /--mode\s+review\b/);
  assert.match(skill, /--mode\s+adversarial-review\b/);
  assert.match(skill, /--mode\s+custom-review\b/);
  assert.match(skill, /--scope-base REF/);
  assert.match(skill, /Replace `<file1>,<file2>`/, `${rel} must tell agents to replace scope-path placeholders`);
  assert.match(skill, /comma- or newline-separated concrete relative paths/, `${rel} missing scope-path separator guidance`);
  assert.match(skill, /`error_code`/, `${rel} missing failed JobRecord error_code rendering guidance`);
  assert.match(skill, /`error_message`/, `${rel} missing failed JobRecord error_message rendering guidance`);
  assert.match(skill, /`http_status`/, `${rel} missing failed JobRecord http_status rendering guidance`);
  assert.match(skill, /`suggested_action`/, `${rel} missing failed JobRecord suggested_action rendering guidance`);
  assert.match(skill, /external_review.*before the review result/);
  assert.doesNotMatch(skill, /api\.x\.ai/i);
  assert.doesNotMatch(skill, /\bgemini\b/i, `${rel} must not mention Gemini in Grok guidance`);
  assert.doesNotMatch(skill, /\bcancel\b/i, `${rel} must not document unsupported Grok cancel command`);
  assertNoBracketedCliFlagsInShellFences(skill, rel);
  assertNoShellVariablePlaceholdersInShellFences(skill, rel);
  assertPickerDescription(skill, rel);
});

test("provider workflow skills are user-invocable and command-backed", () => {
  for (const plugin of DELEGATION_PLUGINS) {
    for (const workflow of DELEGATION_WORKFLOWS) {
      const skillName = `${plugin}-${workflow}`;
      const rel = `plugins/${plugin}/skills/${skillName}/SKILL.md`;
      const skillPath = path.join(REPO_ROOT, rel);
      assert.equal(existsSync(skillPath), true, `${rel} missing`);
      const skill = readFileSync(skillPath, "utf8");

      assert.match(skill, new RegExp(`^name:\\s*${skillName}$`, "m"));
      assert.match(skill, /^user-invocable:\s*true$/m);
      assertPickerDescription(skill, rel);
      assert.match(skill, new RegExp(`${plugin}-companion\\.mjs`));
      assert.match(skill, new RegExp(`${relayPluginName(plugin)}:${skillName}`));
      assert.match(skill, new RegExp("`<plugin-root>` is `plugins/" + plugin + "`"));
      if (skill.includes("--cwd")) {
        assert.match(skill, /`<workspace>` is /);
        if (["status", "result", "cancel"].includes(workflow)) {
          assert.match(skill, /`<workspace>` is the workspace where the job was launched/);
          if (["result", "cancel"].includes(workflow)) {
            assert.match(skill, /`<job-id>` is the identifier returned by a background launch or listed by the status workflow/);
          }
        } else if (workflow === "rescue") {
          assert.match(skill, /`<workspace>` is the repository where the rescue task should run/);
        } else {
          assert.match(skill, /`<workspace>` is the repository or bundle directory to review/);
        }
      }
      assert.doesNotMatch(skill, /frontmatter name remains/);
      assertCompanionWorkflowInvocation(skill, plugin, workflow, rel);
      const commandRel = `plugins/${plugin}/commands/${skillName}.md`;
      assert.equal(existsSync(path.join(REPO_ROOT, commandRel)), true, `${commandRel} missing`);
      const command = readFileSync(path.join(REPO_ROOT, commandRel), "utf8");
      assertNoBracketedCliFlagsInShellFences(command, commandRel);
      if (["review", "adversarial-review"].includes(workflow)) {
        assert.match(command, /--lifecycle-events\s+markdown\b/, `${commandRel} missing lifecycle markdown option`);
        assert.match(command, /external_review_launched/, `${commandRel} missing launch event rendering guidance`);
        assert.match(command, /external_review.*before/, `${commandRel} missing external_review rendering guidance`);
      }
      assert.match(skill, new RegExp(commandRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
  for (const provider of API_REVIEWER_PROVIDERS) {
    for (const workflow of API_REVIEWER_WORKFLOWS) {
      const skillName = `${provider}-${workflow}`;
      const pluginRoot = `plugins/${relayPluginName(provider)}`;
      const rel = `${pluginRoot}/skills/${skillName}/SKILL.md`;
      const skillPath = path.join(REPO_ROOT, rel);
      assert.equal(existsSync(skillPath), true, `${rel} missing`);
      const skill = readFileSync(skillPath, "utf8");

      assert.match(skill, new RegExp(`^name:\\s*${skillName}$`, "m"));
      assert.match(skill, /^user-invocable:\s*true$/m);
      assertPickerDescription(skill, rel);
      assert.match(skill, /api-reviewer/);
      assert.match(skill, new RegExp(`${relayPluginName(provider)}:${skillName}`));
      assertApiReviewerWorkflowInvocation(skill, provider, workflow, rel);
      const commandRel = `${pluginRoot}/commands/${skillName}.md`;
      assert.equal(existsSync(path.join(REPO_ROOT, commandRel)), true, `${commandRel} missing`);
      const command = readFileSync(path.join(REPO_ROOT, commandRel), "utf8");
      assertApiReviewerCommandDoc(command, workflow, commandRel);
      assert.match(skill, new RegExp(escapeRegExp(`../../commands/${skillName}.md`)));
    }
  }

  for (const workflow of GROK_WORKFLOWS) {
    const skillName = `grok-${workflow}`;
    const rel = `plugins/grok/skills/${skillName}/SKILL.md`;
    const skillPath = path.join(REPO_ROOT, rel);
    assert.equal(existsSync(skillPath), true, `${rel} missing`);
    const skill = readFileSync(skillPath, "utf8");

    assert.match(skill, new RegExp(`^name:\\s*${skillName}$`, "m"));
    assert.match(skill, /^user-invocable:\s*true$/m);
    assertPickerDescription(skill, rel);
    assert.match(skill, /grok-companion\.mjs/);
    assert.doesNotMatch(skill, /grok-web-reviewer\.mjs/);
    assert.match(skill, new RegExp(`relay-grok:${skillName}`));
    assertGrokWorkflowInvocation(skill, workflow, rel);
    const commandRel = `plugins/grok/commands/${skillName}.md`;
    assert.equal(existsSync(path.join(REPO_ROOT, commandRel)), true, `${commandRel} missing`);
    const command = readFileSync(path.join(REPO_ROOT, commandRel), "utf8");
    assertGrokCommandDoc(command, workflow, commandRel);
    assert.match(skill, new RegExp(commandRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("README documents install verification for discoverable delegation skills", () => {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, /Verify skill discovery after installation/);
  assert.match(readme, /codex debug prompt-input 'list skills'/);
  assert.match(readme, /relay-claude:claude-delegation/);
  assert.match(readme, /relay-gemini:gemini-delegation/);
  assert.match(readme, /relay-kimi:kimi-delegation/);
  assert.match(readme, /relay-grok:grok-delegation/);
  assert.match(readme, /relay-deepseek:deepseek-review/);
  assert.match(readme, /relay-glm:glm-review/);
  assert.match(readme, /CODEX_HOME/);
});

test("README documents workflow-specific skill picker UX", () => {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

  assert.match(readme, /<plugin>:<provider-workflow>/);
  assert.match(readme, /workflow-specific skills/);
  assert.match(readme, /slash-command files remain packaged/i);
  assert.match(readme, /advanced `custom-review` and `preflight` flows/);
  assert.match(readme, /remain available through those broad delegation skills/);
  for (const plugin of DELEGATION_PLUGINS) {
    for (const workflow of DELEGATION_WORKFLOWS) {
      const skill = `${relayPluginName(plugin)}:${plugin}-${workflow}`;
      assert.match(readme, new RegExp(`\\b${skill}\\b`), `README missing ${skill}`);
    }
  }
  for (const provider of API_REVIEWER_PROVIDERS) {
    for (const workflow of API_REVIEWER_WORKFLOWS) {
      const skill = `${relayPluginName(provider)}:${provider}-${workflow}`;
      assert.match(readme, new RegExp(`\\b${skill}\\b`), `README missing ${skill}`);
    }
  }
  for (const workflow of GROK_WORKFLOWS) {
    const skill = `relay-grok:grok-${workflow}`;
    assert.match(readme, new RegExp(`\\b${skill}\\b`), `README missing ${skill}`);
  }
});

test("grok-facing docs avoid bracketed optional flags in fenced shell command blocks", () => {
  for (const rel of [
    "README.md",
    "docs/e2e.md",
    "docs/grok-subscription-tunnel.md",
    "plugins/grok/skills/grok-delegation/SKILL.md",
    ...GROK_WORKFLOWS.map((workflow) => `plugins/grok/skills/grok-${workflow}/SKILL.md`),
    ...GROK_WORKFLOWS.map((workflow) => `plugins/grok/commands/grok-${workflow}.md`),
  ]) {
    const doc = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assertNoBracketedCliFlagsInShellFences(doc, rel);
    assertNoShellVariablePlaceholdersInShellFences(doc, rel);
  }
});

test("release docs disclose current Codex slash-command limitation", () => {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const releaseVerification = readFileSync(path.join(REPO_ROOT, "docs/release-verification.md"), "utf8");

  const limitation = /Codex CLI 0\.125\.0 does not currently expose plugin `commands\/\*\.md` files as TUI slash commands/;
  assert.match(readme, limitation);
  assert.match(readme, /user-invocable skill fallback/);
  assert.match(changelog, limitation);
  assert.match(releaseVerification, /Root cause confirmed/);
  assert.match(releaseVerification, /find_builtin_command/);
});

test("release metadata documents v0.1.0 for marketplace plugins", () => {
  const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const rootPackage = readJson("package.json");
  const marketplace = readJson(".agents/plugins/marketplace.json");
  assert.equal(rootPackage.version, "0.1.0");
  for (const plugin of marketplace.plugins) {
    const sourcePath = marketplaceSourcePath(plugin);
    const manifest = readJson(`${sourcePath}/.codex-plugin/plugin.json`);
    const workspacePackage = readJson(`${sourcePath}/package.json`);
    assert.equal(manifest.name, plugin.name);
    assert.equal(manifest.version, "0.1.0");
    assert.equal(workspacePackage.version, manifest.version);
  }

  assert.match(changelog, /## 0\.1\.0/);
  assert.match(changelog, /Features shipped/i);
  assert.match(changelog, /Known limitations/i);
  assert.match(changelog, /Upstream attribution/i);
  assert.match(changelog, /openai\/codex-plugin-cc/);
});
