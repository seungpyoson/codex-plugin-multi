import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

test("kimi scoped prompt preflight cleanup is unconditional and idempotent", () => {
  const source = readFileSync(resolvePath("plugins/kimi/scripts/kimi-companion.mjs"), "utf8");
  const match = /function scopedTargetPromptForOrExit[\s\S]*?\n}\n\n\/\/ Mutation-detection/.exec(source);
  assert.ok(match, "expected to find kimi scopedTargetPromptForOrExit");

  const cleanupCalls = match[0].match(/containment\.cleanup\(\)/g) ?? [];
  assert.equal(cleanupCalls.length, 1);
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
