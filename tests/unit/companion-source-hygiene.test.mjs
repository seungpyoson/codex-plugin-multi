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
  const reviewPromptSource = readFileSync(resolvePath("plugins/agy/scripts/lib/review-prompt.mjs"), "utf8");

  assert.match(source, /writePromptSidecar|consumePromptSidecar|prompt sidecar/i);
  assert.match(source, /buildReviewAuditManifest/);
  assert.match(reviewPromptSource, /content_hash/);
  assert.match(source, /import \{ setupContainment \} from "\.\/lib\/containment\.mjs";/);
  assert.match(source, /import \{ populateScope \} from "\.\/lib\/scope\.mjs";/);
  assert.match(source, /import \{ diffSourceFiles \} from "\.\/lib\/diff-source\.mjs";/);
  assert.match(source, /populateScope\(profile, cwd, containment\.path,[\s\S]*workspaceRoot/);
  assert.match(source, /includeDirPath:\s*containment\.path/);
  assert.match(source, /catch \(error\) \{\s*if \(containment\) \{ try \{ containment\.cleanup\(\); \} catch/);
  assert.match(source, /fail\("prompt_sidecar_failed"/);
  assert.doesNotMatch(source, /includeDirPath:\s*cwd/);
  assert.doesNotMatch(source, /function git\(/);
  assert.doesNotMatch(source, /selected_source[\s\S]*content\s*:/);
  assert.doesNotMatch(source, /error_message:\s*[^,\n]*content/i);
});

test("agy foreground lifecycle keeps cancel, sidecar, and stale-job parity hooks", () => {
  const source = readFileSync(resolvePath("plugins/agy/scripts/agy-companion.mjs"), "utf8");

  assert.match(source, /import \{ reconcileActiveJobs \} from "\.\/lib\/reconcile\.mjs";/);
  for (const command of ["status", "result", "cancel"]) {
    const start = source.indexOf(`function ${command}(rest)`);
    assert.notEqual(start, -1, `expected ${command} command`);
    const end = source.indexOf("\nfunction ", start + 1);
    const block = source.slice(start, end === -1 ? source.length : end);
    assert.match(block, /reconcileActiveJobs\(workspaceRoot\);/, `${command} must reconcile stale active jobs`);
  }

  const runStart = source.indexOf("async function run(rest)");
  assert.notEqual(runStart, -1, "expected run command");
  const runEnd = source.indexOf("\nfunction ", runStart + 1);
  const runBlock = source.slice(runStart, runEnd === -1 ? source.length : runEnd);
  const setupIndex = runBlock.indexOf("containment = setupContainment");
  const queuedIndex = runBlock.indexOf("const queuedRecord = buildJobRecord(invocation, null, []);");
  const spawnIndex = runBlock.indexOf("execution = await spawnAgy");
  const preSpawnCancelIndex = runBlock.indexOf("if (consumeCancelMarker(workspaceRoot, jobId))");
  assert.ok(queuedIndex !== -1 && queuedIndex < setupIndex, "queued record must be persisted before scope setup");
  assert.ok(preSpawnCancelIndex !== -1 && preSpawnCancelIndex < spawnIndex, "cancel marker must be consumed before spawn");
  assert.match(runBlock, /mutationContext = prepareMutationContext\(invocation\);/);
  assert.match(runBlock, /recordPostRunMutations\(invocation, mutationContext\);/);
  assert.match(runBlock, /withMutationReviewFailure\(reviewAuditManifest, mutationContext\.mutations\)/);

  assert.match(
    source,
    /catch \(error\) \{\s+try \{ consumePromptSidecar\(jobsDir\(workspaceRoot\), jobId\); \} catch \{ \/\* best-effort prompt sidecar cleanup \*\/ \}/,
    "prompt sidecar failure path must attempt best-effort sidecar cleanup",
  );
});

test("agy state defaults identify the agy adapter", () => {
  const source = readFileSync(resolvePath("plugins/agy/scripts/lib/state.mjs"), "utf8");

  assert.match(source, /pluginDataEnv:\s*"AGY_PLUGIN_DATA"/);
  assert.match(source, /fallbackStateRootDir:\s*path\.join\(os\.tmpdir\(\),\s*"agy-companion"\)/);
  assert.match(source, /sessionIdEnv:\s*"AGY_COMPANION_SESSION_ID"/);
  assert.doesNotMatch(source, /GEMINI_PLUGIN_DATA|GEMINI_COMPANION_SESSION_ID|gemini-companion/);
});
