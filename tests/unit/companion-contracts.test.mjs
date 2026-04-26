import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

test("companion sidecar writes use sibling tmp files and rename", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
  ]) {
    const source = readRepoFile(rel);
    const match = /function writeSidecar[\s\S]*?\n}/.exec(source);
    assert.ok(match, `${rel}: missing writeSidecar helper`);
    assert.match(match[0], /renameSync/, `${rel}: writeSidecar must rename a tmp file into place`);
    assert.match(match[0], /\.tmp/, `${rel}: writeSidecar must write a sibling tmp file`);
  }
});

test("gemini companion passes read-only policy only for plan modes", () => {
  const source = readRepoFile("plugins/gemini/scripts/gemini-companion.mjs");
  assert.match(source, /policyPath:\s*profile\.permission_mode\s*===\s*"plan"\s*\?\s*READ_ONLY_POLICY\s*:\s*null/);
});

test("gemini companion surfaces mutation git-status capture failure", () => {
  const source = readRepoFile("plugins/gemini/scripts/gemini-companion.mjs");
  assert.doesNotMatch(source, /catch\s*\{\s*return\s+"";\s*\}/);
  assert.match(source, /mutation_detection_failed/);
});

test("gemini operational lib comments do not refer to Claude as the running target", () => {
  for (const rel of [
    "plugins/gemini/scripts/lib/containment.mjs",
    "plugins/gemini/scripts/lib/scope.mjs",
  ]) {
    const commentLines = readRepoFile(rel)
      .split("\n")
      .filter((line) => line.trimStart().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(commentLines, /\bClaude\b/, `${rel}: comments must describe Gemini/target behavior`);
  }
});

test("gemini target-local files do not use Claude-specific temp prefixes or target prose", () => {
  const combined = [
    readRepoFile("plugins/gemini/scripts/lib/containment.mjs"),
    readRepoFile("plugins/gemini/scripts/lib/mode-profiles.mjs"),
    readRepoFile("plugins/gemini/scripts/lib/identity.mjs"),
  ].join("\n");

  assert.doesNotMatch(combined, /claude-worktree-/);
  assert.doesNotMatch(combined, /Tools Claude/);
  assert.doesNotMatch(combined, /Claude-companion/);
});
