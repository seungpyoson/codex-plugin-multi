import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXTERNAL_REVIEW_KEYS } from "../../scripts/lib/external-review.mjs";

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const workflow = readFileSync(resolve(".github/workflows/pull-request-ci.yml"), "utf8");
const e2eDocs = readFileSync(resolve("docs/e2e.md"), "utf8");
const sonarConfig = readFileSync(resolve(".sonarcloud.properties"), "utf8");

test("package scripts expose per-target smoke commands", () => {
  assert.match(pkg.scripts["smoke:claude"] ?? "", /claude-companion\.smoke\.test\.mjs/);
  assert.match(pkg.scripts["smoke:claude"] ?? "", /identity-resume-chain\.smoke\.test\.mjs/);
  assert.match(pkg.scripts["smoke:gemini"] ?? "", /gemini-companion\.smoke\.test\.mjs/);
  assert.match(pkg.scripts["smoke:kimi"] ?? "", /kimi-companion\.smoke\.test\.mjs/);
  assert.match(pkg.scripts["smoke:grok"] ?? "", /grok-web\.smoke\.test\.mjs/);
  assert.match(pkg.scripts["smoke:api-reviewers"] ?? "", /api-reviewers\.smoke\.test\.mjs/);
});

test("pull-request CI runs unit tests and per-target smoke matrix separately", () => {
  assert.match(workflow, /\n\s+test:\n/);
  assert.match(workflow, /CODEX_PLUGIN_SKIP_SMOKE:\s*"1"/);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(workflow, /compgen/);
  assert.doesNotMatch(workflow, /No unit tests yet/);
  assert.match(workflow, /\n\s+smoke:\n/);
  assert.match(workflow, /target:\s*\[claude,\s*gemini,\s*kimi,\s*grok,\s*api-reviewers\]/);
  assert.match(workflow, /npm run smoke:\$\{\{ matrix\.target \}\}/);
});

test("pull-request CI runs shared-copy sync checks", () => {
  assert.match(pkg.scripts["lint:sync"] ?? "", /sync-codex-env\.mjs --check/);
  assert.match(pkg.scripts["lint:sync"] ?? "", /sync-companion-common\.mjs --check/);
  assert.match(pkg.scripts["lint:sync"] ?? "", /sync-external-review\.mjs --check/);
  assert.match(pkg.scripts["lint:sync"] ?? "", /sync-review-prompt\.mjs --check/);
  assert.match(pkg.scripts["lint:sync"] ?? "", /sync-auth-selection\.mjs --check/);
  assert.match(pkg.scripts["lint:sync"] ?? "", /sync-provider-env\.mjs --check/);
  assert.match(workflow, /npm run lint:sync/);
});

test("pull-request CI runs the enforced coverage gate", () => {
  assert.match(workflow, /COVERAGE_ENFORCE_TARGET:\s*"1"/);
  assert.match(workflow, /Run coverage gate[\s\S]*CODEX_PLUGIN_SKIP_SMOKE:\s*"1"/);
  assert.match(workflow, /npm run test:coverage/);
});

test("Sonar CPD excludes intentional packaging and entrypoint copies", () => {
  for (const path of [
    "scripts/lib/external-review.mjs",
    "plugins/claude/scripts/lib/external-review.mjs",
    "plugins/gemini/scripts/lib/external-review.mjs",
    "plugins/kimi/scripts/lib/external-review.mjs",
    "plugins/grok/scripts/lib/external-review.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
    "plugins/grok/scripts/grok-sync-browser-session.mjs",
    "plugins/grok/scripts/lib/git-env.mjs",
    "plugins/api-reviewers/scripts/lib/git-binary.mjs",
    "plugins/claude/scripts/lib/git-binary.mjs",
    "plugins/gemini/scripts/lib/git-binary.mjs",
    "plugins/grok/scripts/lib/git-binary.mjs",
    "plugins/kimi/scripts/lib/git-binary.mjs",
    "plugins/api-reviewers/scripts/lib/git-env.mjs",
    "scripts/lib/review-prompt.mjs",
    "plugins/api-reviewers/scripts/lib/review-prompt.mjs",
    "plugins/claude/scripts/lib/review-prompt.mjs",
    "plugins/gemini/scripts/lib/review-prompt.mjs",
    "plugins/grok/scripts/lib/review-prompt.mjs",
    "plugins/kimi/scripts/lib/review-prompt.mjs",
    "plugins/claude/scripts/lib/mode-profiles.mjs",
    "plugins/gemini/scripts/lib/mode-profiles.mjs",
    "plugins/kimi/scripts/lib/mode-profiles.mjs",
  ]) {
    assert.match(sonarConfig, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Grok lifecycle smoke tests clean up owned temp directories", () => {
  const smoke = readFileSync(resolve("tests/smoke/grok-web.smoke.test.mjs"), "utf8");
  for (const testName of [
    "run rejects invalid lifecycle event mode as bad args",
    "custom-review lifecycle jsonl suppresses launch event on scope failure",
  ]) {
    const start = smoke.indexOf(`test("${testName}"`);
    assert.notEqual(start, -1, `${testName} not found`);
    const next = smoke.indexOf("\ntest(", start + 1);
    const block = smoke.slice(start, next === -1 ? smoke.length : next);
    assert.match(block, /finally\s*\{[\s\S]*rmTree\(cwd\);[\s\S]*rmTree\(dataDir\);[\s\S]*\}/, `${testName} must clean cwd and dataDir in finally`);
  }
});

test("standalone lifecycle smoke tests guard launch event shape against shared helper", () => {
  for (const rel of [
    "tests/smoke/api-reviewers.smoke.test.mjs",
    "tests/smoke/grok-web.smoke.test.mjs",
  ]) {
    const smoke = readFileSync(resolve(rel), "utf8");
    assert.match(smoke, /externalReviewLaunchedEvent/, `${rel} must compare launch events with shared helper`);
  }
});

test("grok external_review shapes are runtime-guarded", () => {
  const source = readFileSync(resolve("plugins/grok/scripts/grok-web-reviewer.mjs"), "utf8");
  assert.match(source, /EXTERNAL_REVIEW_KEYS/, "Grok must use the canonical external_review key order");
  const grokCopy = readFileSync(resolve("plugins/grok/scripts/lib/external-review.mjs"), "utf8");
  const localKeys = grokCopy.match(/export const EXTERNAL_REVIEW_KEYS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(localKeys, "Grok external_review keys must be statically inspectable from its packaged shared copy");
  assert.deepEqual([...localKeys[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]), [...EXTERNAL_REVIEW_KEYS],
    "Grok external_review keys must stay in parity with the shared key order");
  assert.match(source, /function freezeExternalReview/, "Grok must validate external_review key drift");
  assert.match(source, /return freezeExternalReview\(\{[\s\S]*source_content_transmission[\s\S]*disclosure/s,
    "Grok launch external_review builder must freeze the generated review object");
  assert.match(source, /function buildTerminalExternalReview/, "Grok terminal external_review must use a named builder");
  assert.match(source, /external_review: buildTerminalExternalReview\(/,
    "Grok terminal JobRecord must freeze the generated review object");
});

test("standalone external_review builders tolerate missing scopeInfo defensively", () => {
  for (const rel of [
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    const launchStart = source.indexOf("function buildLaunchExternalReview");
    assert.notEqual(launchStart, -1, `${rel} must define buildLaunchExternalReview`);
    const launchEnd = source.indexOf("\nfunction ", launchStart + 1);
    const launchBlock = source.slice(launchStart, launchEnd === -1 ? source.length : launchEnd);
    assert.match(launchBlock, /scope:\s*scopeInfo\?\.scope\s*\?\?\s*null/,
      `${rel} launch external_review must not assume scopeInfo exists`);
    assert.match(launchBlock, /scope_base:\s*scopeInfo\?\.scope_base\s*\?\?\s*null/,
      `${rel} launch external_review must not assume scopeInfo scope_base exists`);
    assert.match(launchBlock, /scope_paths:\s*scopeInfo\?\.scope_paths\s*\?\?\s*null/,
      `${rel} launch external_review must not assume scopeInfo scope_paths exists`);
  }

  const grok = readFileSync(resolve("plugins/grok/scripts/grok-web-reviewer.mjs"), "utf8");
  const terminalStart = grok.indexOf("function buildTerminalExternalReview");
  assert.notEqual(terminalStart, -1, "Grok must define buildTerminalExternalReview");
  const terminalEnd = grok.indexOf("\nfunction ", terminalStart + 1);
  const terminalBlock = grok.slice(terminalStart, terminalEnd === -1 ? grok.length : terminalEnd);
  assert.match(terminalBlock, /scope:\s*scopeInfo\?\.scope\s*\?\?\s*null/,
    "Grok terminal external_review must not assume scopeInfo exists");
  assert.match(terminalBlock, /scope_base:\s*scopeInfo\?\.scope_base\s*\?\?\s*null/,
    "Grok terminal external_review must not assume scopeInfo scope_base exists");
  assert.match(terminalBlock, /scope_paths:\s*scopeInfo\?\.scope_paths\s*\?\?\s*null/,
    "Grok terminal external_review must not assume scopeInfo scope_paths exists");
});

test("grok terminal JobRecord shape is runtime-guarded", () => {
  const source = readFileSync(resolve("plugins/grok/scripts/grok-web-reviewer.mjs"), "utf8");
  assert.match(source, /GROK_EXPECTED_KEYS/, "Grok must define the canonical JobRecord key order");
  assert.match(source, /function freezeRecord/, "Grok must validate terminal JobRecord key drift");
  assert.match(source, /return freezeRecord\(\{[\s\S]*schema_version: SCHEMA_VERSION,[\s\S]*\}\);/,
    "Grok buildRecord must freeze the generated terminal JobRecord");
});

test("companion background launch events use shared helper", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    assert.match(source, /externalReviewBackgroundLaunchedEvent/, `${rel} must use the shared background launch helper`);
    const launches = [...source.matchAll(/const launched = externalReviewBackgroundLaunchedEvent/g)];
    assert.equal(launches.length, 2, `${rel} must render run and continue background launch events`);
    for (const launch of launches) {
      const block = source.slice(launch.index, launch.index + 400);
      assert.match(block, /printLifecycleJson\(launched, lifecycleEvents\)/,
        `${rel} must render background launch events through printLifecycleJson`);
    }
  }
});

test("foreground launch events use shared lifecycle renderer when opted in", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    assert.doesNotMatch(source, /printJsonLine\(externalReviewLaunchedEvent/,
      `${rel} must not bypass printLifecycleJson for foreground launch events`);
    assert.match(source, /if \(foreground && lifecycleEvents\) \{[\s\S]*printLifecycleJson\(\s*externalReviewLaunchedEvent/s,
      `${rel} must render opted-in foreground launch events through printLifecycleJson`);
  }

  for (const rel of [
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    const launch = source.indexOf('event: "external_review_launched"');
    assert.notEqual(launch, -1, `${rel} must emit foreground launch events when opted in`);
    const block = source.slice(Math.max(0, launch - 180), launch + 500);
    assert.match(block, /if \(lifecycleEvents\) \{[\s\S]*printLifecycleJson\(\{/s,
      `${rel} must render opted-in foreground launch events through printLifecycleJson`);
  }
});

test("companion foreground cancelled terminal records exit cleanly", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    assert.match(source,
      /process\.exit\(finalRecord\.status === "completed" \|\| finalRecord\.status === "cancelled" \? 0 : 2\);/,
      `${rel} must preserve cancelled as a clean foreground terminal exit`);
  }
});

test("companion mutation-detection git calls use safe git resolver", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    assert.match(source, /import \{ gitEnv, resolveGitBinary \} from "\.\/lib\/git-binary\.mjs";/,
      `${rel} must use the shared safe git resolver`);

    const gitCallStart = source.indexOf(rel.includes("claude") ? "function tryGit" : "function gitStatus");
    assert.notEqual(gitCallStart, -1, `${rel} must define mutation-detection git helper`);
    const gitCallEnd = source.indexOf("\nfunction ", gitCallStart + 1);
    const gitCallBlock = source.slice(gitCallStart, gitCallEnd === -1 ? source.length : gitCallEnd);
    assert.match(gitCallBlock, /execFileSync\(resolveGitBinary\(\{ cwd, workspaceRoot \}\),/,
      `${rel} mutation-detection git helper must use the safe git resolver with the authoritative workspace root`);
    assert.match(gitCallBlock, /env:\s*gitEnv\(cleanGitEnv\(\)\)/,
      `${rel} mutation-detection git helper must not inherit caller PATH`);
    assert.doesNotMatch(gitCallBlock, /env:\s*cleanGitEnv\(\)/,
      `${rel} mutation-detection git helper must use the safe PATH wrapper`);
  }
});

test("scope population git calls use authoritative workspace root", () => {
  for (const rel of [
    "plugins/claude/scripts/lib/scope.mjs",
    "plugins/gemini/scripts/lib/scope.mjs",
    "plugins/kimi/scripts/lib/scope.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    assert.match(source, /import \{ GIT_BINARY_ENV, gitEnv, resolveGitBinary \} from "\.\/git-binary\.mjs";/,
      `${rel} must use the shared safe git resolver`);
    assert.match(source, /const workspaceRoot = runtimeInputs\.workspaceRoot \?\? null;/,
      `${rel} populateScope must read the caller's authoritative workspace root`);
    assert.match(source, /resolveGitBinary\(\{ cwd: sourceCwd, workspaceRoot \}\)/,
      `${rel} git helpers must pass workspaceRoot to the safe resolver`);
    assert.match(source, /writeGitBlobToFile\(ctx\.gitRoot, object, dst, mode, rel, ctx\.workspaceRoot\)/,
      `${rel} git blob materialization must retain the authoritative workspace root`);
  }

  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    assert.match(source, /populateScope\(profile,[\s\S]*workspaceRoot/s,
      `${rel} must pass workspaceRoot into scope population`);
  }
});

test("direct reviewer branch-diff git calls use safe git resolver", () => {
  for (const rel of [
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    assert.match(source, /import \{ gitEnv, resolveGitBinary \} from "\.\/lib\/git-binary\.mjs";/,
      `${rel} must use the shared safe git resolver`);
    assert.match(source, /runCommand\(resolveGitBinary\(\{ cwd, workspaceRoot: options\.workspaceRoot \}\),[\s\S]*env:\s*gitEnv\(cleanGitEnv\(\)\)/s,
      `${rel} branch-diff git calls must use the safe resolver and not inherit caller PATH`);
  }
});

test("direct API reviewer launch gating and execution share preflight validation", () => {
  const source = readFileSync(resolve("plugins/api-reviewers/scripts/api-reviewer.mjs"), "utf8");
  assert.match(source, /function validateDirectApiRunPreflight/, "api reviewer must centralize preflight validation");
  const usages = [...source.matchAll(/validateDirectApiRunPreflight\(/g)];
  assert.equal(usages.length, 3, "api reviewer must use one shared helper from cmdRun and callProvider");

  const cmdRunStart = source.indexOf("async function cmdRun");
  assert.notEqual(cmdRunStart, -1, "cmdRun must exist");
  const cmdRunBlock = source.slice(cmdRunStart, source.indexOf("\nasync function", cmdRunStart + 1));
  assert.match(cmdRunBlock, /validateDirectApiRunPreflight\(cfg, provider, process\.env\)/,
    "cmdRun launch gating must use the shared preflight helper before emitting lifecycle events");

  const callProviderStart = source.indexOf("async function callProvider");
  assert.notEqual(callProviderStart, -1, "callProvider must exist");
  const callProviderBlock = source.slice(callProviderStart, source.indexOf("\nfunction ", callProviderStart + 1));
  assert.match(callProviderBlock, /validateDirectApiRunPreflight\(cfg, provider, env\)/,
    "callProvider must use the same preflight helper as launch gating");
});

test("companion continue commands accept lifecycle events", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readFileSync(resolve(rel), "utf8");
    const start = source.indexOf("async function cmdContinue");
    assert.notEqual(start, -1, `${rel} must define cmdContinue`);
    const end = source.indexOf("\nasync function", start + 1);
    const block = source.slice(start, end === -1 ? source.length : end);
    assert.match(block, /"lifecycle-events"/, `${rel} continue must parse --lifecycle-events`);
    assert.match(block, /parseLifecycleEventsMode/, `${rel} continue must validate --lifecycle-events`);
    assert.match(block, /printLifecycleJson|printJsonLine/, `${rel} continue must honor lifecycle output mode`);
  }
});

test("manual E2E scripts are opt-in and documented", () => {
  assert.match(pkg.scripts["e2e:claude"] ?? "", /tests\/e2e\/claude\.e2e\.test\.mjs/);
  assert.match(pkg.scripts["e2e:gemini"] ?? "", /tests\/e2e\/gemini\.e2e\.test\.mjs/);
  assert.match(pkg.scripts["e2e:kimi"] ?? "", /tests\/e2e\/kimi\.e2e\.test\.mjs/);
  assert.match(pkg.scripts["e2e:grok"] ?? "", /tests\/e2e\/grok\.e2e\.test\.mjs/);
  assert.match(e2eDocs, /CLAUDE_LIVE_E2E=1 npm run e2e:claude/);
  assert.match(e2eDocs, /GEMINI_LIVE_E2E=1 npm run e2e:gemini/);
  assert.match(e2eDocs, /KIMI_LIVE_E2E=1 npm run e2e:kimi/);
  assert.match(e2eDocs, /GROK_LIVE_E2E=1 npm run e2e:grok/);
  assert.match(e2eDocs, /skipped test/);
});
