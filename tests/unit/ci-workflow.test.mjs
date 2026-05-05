import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    "plugins/grok/scripts/grok-web-reviewer.mjs",
    "plugins/grok/scripts/grok-sync-browser-session.mjs",
    "plugins/grok/scripts/lib/git-env.mjs",
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
