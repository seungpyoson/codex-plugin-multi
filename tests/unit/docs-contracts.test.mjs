import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

test("claude cancel docs reject foreground cancel and direct users to Ctrl+C", () => {
  const command = readRepoFile("plugins/claude/commands/claude-cancel.md");
  const runtime = readRepoFile("plugins/claude/skills/claude-cli-runtime/SKILL.md");
  const combined = `${command}\n${runtime}`;

  assert.match(combined, /background job/i);
  assert.match(combined, /foreground/i);
  assert.match(combined, /Ctrl\+C/i);
  assert.doesNotMatch(combined, /foreground[^.\n]*(SIGTERM|SIGKILL|cancel)/i,
    "foreground cancellation must not be documented as companion signaling");
});

test("claude review command docs use current mutation schema fields", () => {
  const docs = [
    readRepoFile("plugins/claude/commands/claude-review.md"),
    readRepoFile("plugins/claude/commands/claude-adversarial-review.md"),
  ].join("\n");

  assert.match(docs, /mutations/i);
  assert.doesNotMatch(docs, /warning:\s*"mutation_detected"/);
  assert.doesNotMatch(docs, /mutated_files/);
});

test("review command docs advertise --scope-base, not legacy --base", () => {
  const docs = [
    readRepoFile("plugins/claude/commands/claude-review.md"),
    readRepoFile("plugins/claude/commands/claude-adversarial-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-adversarial-review.md"),
  ].join("\n");

  assert.match(docs, /--scope-base <ref>/);
  assert.doesNotMatch(docs, /--base <ref>/);
});

test("spec does not reference an unshipped Gemini result-handling skill", () => {
  const spec = readRepoFile("docs/superpowers/specs/2026-04-23-codex-plugin-multi-design.md");

  assert.doesNotMatch(spec, /gemini-result-handling/);
  assert.match(spec, /Gemini result command docs/);
});
