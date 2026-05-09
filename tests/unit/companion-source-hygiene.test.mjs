import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

test("kimi scoped prompt preflight has one containment cleanup call site", () => {
  const source = readFileSync(resolvePath("plugins/kimi/scripts/kimi-companion.mjs"), "utf8");
  const match = /function scopedTargetPromptForOrExit[\s\S]*?\n}\n\n\/\/ Mutation-detection/.exec(source);
  assert.ok(match, "expected to find kimi scopedTargetPromptForOrExit");

  const cleanupCalls = match[0].match(/containment\.cleanup\(\)/g) ?? [];
  assert.equal(cleanupCalls.length, 1);
});
