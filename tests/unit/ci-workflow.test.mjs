import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const workflow = readFileSync(resolve(".github/workflows/pull-request-ci.yml"), "utf8");

test("package scripts expose per-target smoke commands", () => {
  assert.match(pkg.scripts["smoke:claude"] ?? "", /claude-companion\.smoke\.test\.mjs/);
  assert.match(pkg.scripts["smoke:claude"] ?? "", /identity-resume-chain\.smoke\.test\.mjs/);
  assert.match(pkg.scripts["smoke:gemini"] ?? "", /gemini-companion\.smoke\.test\.mjs/);
});

test("pull-request CI runs unit tests and per-target smoke matrix separately", () => {
  assert.match(workflow, /\n\s+test:\n/);
  assert.match(workflow, /CODEX_PLUGIN_SKIP_SMOKE:\s*"1"/);
  assert.match(workflow, /\n\s+smoke:\n/);
  assert.match(workflow, /target:\s*\[claude,\s*gemini\]/);
  assert.match(workflow, /npm run smoke:\$\{\{ matrix\.target \}\}/);
});
