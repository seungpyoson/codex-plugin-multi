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
  assert.match(command, /error:\s*"signal_failed"/,
    "signal_failed is emitted through the error envelope, not a status envelope");
  assert.doesNotMatch(command, /status:\s*"signal_failed"/,
    "signal_failed docs must not imply a status field");
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

test("review command docs route --scope-base as a companion flag", () => {
  const docs = [
    readRepoFile("plugins/claude/commands/claude-review.md"),
    readRepoFile("plugins/claude/commands/claude-adversarial-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-adversarial-review.md"),
  ].join("\n");

  assert.match(docs, /pass `--scope-base <ref>` before `--`/i);
  assert.doesNotMatch(docs, /Passed as-is to the companion prompt/i);
});

test("setup docs do not claim unimplemented target version-floor checks", () => {
  const docs = [
    readRepoFile("plugins/claude/commands/claude-setup.md"),
    readRepoFile("plugins/gemini/commands/gemini-setup.md"),
  ].join("\n");

  assert.doesNotMatch(docs, /min-versions\.json/);
  assert.doesNotMatch(docs, /version is below floor/i);
});

test("gemini command docs match background/continue runtime and deferred cancel", () => {
  const rescue = readRepoFile("plugins/gemini/commands/gemini-rescue.md");
  const cancel = readRepoFile("plugins/gemini/commands/gemini-cancel.md");

  assert.match(rescue, /--background/);
  assert.match(rescue, /--foreground/);
  assert.doesNotMatch(rescue, /foreground only/i);
  assert.doesNotMatch(rescue, /background support lands/i);

  assert.match(cancel, /not_implemented/);
  assert.match(cancel, /deferred/i);
  assert.doesNotMatch(cancel, /M8 wires background cancel/i);
});

test("spec does not reference an unshipped Gemini result-handling skill", () => {
  const spec = readRepoFile("docs/superpowers/specs/2026-04-23-codex-plugin-multi-design.md");

  assert.doesNotMatch(spec, /gemini-result-handling/);
  assert.match(spec, /Gemini result command docs/);
});

test("README documents shipped install path, first commands, and safety posture", () => {
  const readme = readRepoFile("README.md");

  assert.doesNotMatch(readme, /M0|M2\+|Planned surface/i);
  assert.match(readme, /codex plugin marketplace add seungpyoson\/codex-plugin-multi/);
  assert.match(readme, /\/plugins/);
  assert.match(readme, /user-invocable skill fallback/);
  assert.match(readme, /Claude delegation skill/);
  assert.match(readme, /Gemini delegation skill/);
  assert.doesNotMatch(readme, /Diagnostic plugin dispatch check/);
  assert.doesNotMatch(readme, /\/claude-ping/);
  assert.doesNotMatch(readme, /\/gemini-ping/);
  assert.match(readme, /\/claude-review/);
  assert.match(readme, /\/gemini-review/);
  assert.match(readme, /\/claude-rescue/);
  assert.match(readme, /\/gemini-rescue/);
  assert.match(readme, /Gemini plan-mode is NOT a sandbox/);
  assert.match(readme, /read-only\.toml/);
  assert.match(readme, /--dispose/);
  assert.match(readme, /Gemini `cancel`.*deferred/i);
  assert.match(readme, /docs\/e2e\.md/);
});
