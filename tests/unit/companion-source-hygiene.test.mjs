import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

test("kimi scoped review prompts use the same contract guard as claude and gemini", () => {
  const source = readFileSync(resolvePath("plugins/kimi/scripts/kimi-companion.mjs"), "utf8");
  const match = /function scopedTargetPromptForOrExit[\s\S]*?\n}\n\n\/\/ Mutation-detection/.exec(source);
  assert.ok(match, "expected to find kimi scopedTargetPromptForOrExit");

  assert.match(match[0], /invocation\.mode_profile_name\s*===\s*"rescue"/);
  assert.doesNotMatch(match[0], /profile\.permission_mode\s*!==\s*"plan"/);
});

test("kimi scoped prompt preflight cleanup is unconditional and idempotent", () => {
  const source = readFileSync(resolvePath("plugins/kimi/scripts/kimi-companion.mjs"), "utf8");
  const match = /function scopedTargetPromptForOrExit[\s\S]*?\n}\n\n\/\/ Mutation-detection/.exec(source);
  assert.ok(match, "expected to find kimi scopedTargetPromptForOrExit");

  const directCleanupCalls = match[0].match(/containment\.cleanup\(\)/g) ?? [];
  const wrapperCleanupCalls = match[0].match(/cleanupContainment\(\);/g) ?? [];
  assert.equal(directCleanupCalls.length, 1);
  assert.equal(wrapperCleanupCalls.length, 2);
  assert.match(match[0], /catch\s*\([^)]*\)\s*\{[\s\S]*cleanupContainment\(\);[\s\S]*process\.exit\(2\);/);
  assert.match(match[0], /finally\s*\{\s*cleanupContainment\(\);\s*\}/);
  assert.doesNotMatch(match[0], /disposeEffective/);
});

test("claude and gemini scoped prompt preflight cleanup ignores dispose_effective", () => {
  for (const [name, rel] of [
    ["claude", "plugins/claude/scripts/claude-companion.mjs"],
    ["gemini", "plugins/gemini/scripts/gemini-companion.mjs"],
  ]) {
    const source = readFileSync(resolvePath(rel), "utf8");
    const marker = name === "claude" ? "function isInsidePath" : "// Mutation-detection";
    const match = new RegExp(`function scopedTargetPromptForOrExit[\\s\\S]*?\\n}\\n\\n${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(source);
    assert.ok(match, `expected to find ${name} scopedTargetPromptForOrExit`);

    assert.match(
      match[0],
      /finally\s*\{\s*cleanupScopedPromptExecutionScope\(executionScope\);\s*\}/,
      `${name} scoped prompt preflight must always clean its temporary containment`,
    );
    assert.doesNotMatch(
      match[0],
      /cleanupExecutionResources\(executionScope/,
      `${name} scoped prompt preflight must not use run-lifetime cleanup gated by dispose_effective`,
    );
  }
});

test("companion scoped prompt refactor leaves no dead background scope validators", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readFileSync(resolvePath(rel), "utf8");
    assert.doesNotMatch(source, /function validateBackgroundExecutionScopeOrExit\b/, rel);
  }
});

test("gemini background approval preflight audits prompt source without walking cwd", () => {
  const source = readFileSync(resolvePath("plugins/gemini/scripts/gemini-companion.mjs"), "utf8");
  const matches = [...source.matchAll(/sourceSendApprovalPreflight\(authSelection, invocation, targetPrompt, ([^)]+)\)/g)];
  assert.equal(matches.length, 2, "expected run and continue background approval preflights");
  for (const match of matches) {
    assert.notEqual(match[1].trim(), "cwd", "background source-send preflight must not use cwd as containment fallback");
  }
  assert.doesNotMatch(
    source,
    /reviewAuditManifest\(invocation, targetPrompt, cwd, approvalPreflight\)/,
    "background approval-required audit manifest must not use cwd as containment fallback",
  );
});

test("agy companion uses prompt sidecars, source hashes, and no raw-source diagnostics", () => {
  const source = readFileSync(resolvePath("plugins/agy/scripts/agy-companion.mjs"), "utf8");

  assert.match(source, /writePromptSidecar|consumePromptSidecar|prompt sidecar/i);
  assert.match(source, /buildReviewAuditManifest/);
  assert.match(source, /content_hash/);
  assert.match(source, /import \{ gitEnv, resolveGitBinary \} from "\.\/lib\/git-binary\.mjs";/);
  assert.match(source, /import \{ cleanGitEnv \} from "\.\/lib\/git-env\.mjs";/);
  const gitHelper = /function git[\s\S]*?\n}\n\nfunction realpathOrResolved/.exec(source);
  assert.ok(gitHelper, "expected AGY branch-diff git helper");
  assert.match(gitHelper[0], /spawnSync\(resolveGitBinary\(\{ cwd, workspaceRoot \}\),/);
  assert.match(gitHelper[0], /env:\s*gitEnv\(cleanGitEnv\(\)\)/);
  assert.doesNotMatch(gitHelper[0], /spawnSync\("git"/);
  assert.doesNotMatch(source, /selected_source[\s\S]*content\s*:/);
  assert.doesNotMatch(source, /error_message:\s*[^,\n]*content/i);
});

test("agy state defaults identify the agy adapter", () => {
  const source = readFileSync(resolvePath("plugins/agy/scripts/lib/state.mjs"), "utf8");

  assert.match(source, /pluginDataEnv:\s*"AGY_PLUGIN_DATA"/);
  assert.match(source, /fallbackStateRootDir:\s*path\.join\(os\.tmpdir\(\),\s*"agy-companion"\)/);
  assert.match(source, /sessionIdEnv:\s*"AGY_COMPANION_SESSION_ID"/);
  assert.doesNotMatch(source, /GEMINI_PLUGIN_DATA|GEMINI_COMPANION_SESSION_ID|gemini-companion/);
});
