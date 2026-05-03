import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

const CANCEL_STATUSES = [
  "signaled",
  "already_terminal",
  "already_dead",
  "cancel_pending",
  "no_pid_info",
  "unverifiable",
  "stale_pid",
];

const CANCEL_ERRORS = [
  "bad_args",
  "not_found",
  "bad_state",
  "signal_failed",
  "cancel_failed",
];

function quotedValuesForField(markdown, field) {
  const values = new Set();
  const pattern = new RegExp(String.raw`${field}:\s*"([^"]+)"`, "g");
  for (const match of markdown.matchAll(pattern)) {
    values.add(match[1]);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
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

test("cancel command docs enumerate the runtime status and error contracts", () => {
  for (const target of ["claude", "gemini"]) {
    const command = readRepoFile(`plugins/${target}/commands/${target}-cancel.md`);

    assert.deepEqual(
      quotedValuesForField(command, "status"),
      [...CANCEL_STATUSES].sort((a, b) => a.localeCompare(b)),
      `${target}-cancel.md must enumerate exactly the status values cmdCancel emits`,
    );
    assert.deepEqual(
      quotedValuesForField(command, "error"),
      [...CANCEL_ERRORS].sort((a, b) => a.localeCompare(b)),
      `${target}-cancel.md must enumerate exactly the error values cmdCancel emits`,
    );
    assert.match(command, /Exit `0`[\s\S]*signaled[\s\S]*already_terminal[\s\S]*already_dead[\s\S]*cancel_pending/);
    assert.match(command, /Exit `1`[\s\S]*bad_args[\s\S]*not_found[\s\S]*bad_state[\s\S]*signal_failed[\s\S]*cancel_failed/);
    assert.match(command, /Exit `2`[\s\S]*no_pid_info[\s\S]*unverifiable[\s\S]*stale_pid/);
    assert.doesNotMatch(command, /state will reconcile/i,
      "already_dead must not promise a reconcile path the runtime does not implement");
  }
});

test("artifact cleanup inventory covers every provider, review mode, and owned artifact class", () => {
  const doc = readRepoFile("docs/artifact-cleanup-inventory.md");

  for (const provider of ["Claude", "Gemini", "Kimi", "DeepSeek", "GLM"]) {
    assert.match(doc, new RegExp(`\\b${provider}\\b`), `missing provider ${provider}`);
  }
  for (const mode of ["review", "adversarial-review", "custom-review", "rescue", "foreground", "background", "continue"]) {
    assert.match(doc, new RegExp(`\\b${mode}\\b`), `missing mode ${mode}`);
  }
  for (const artifact of [
    "state.json",
    "<jobId>.json",
    "<jobId>.json.*.tmp",
    "<jobId>.log",
    "prompt.txt",
    "runtime-options.json",
    "cancel-requested.flag",
    "git-status-before.txt",
    "git-status-after.txt",
    "stdout.log",
    "stderr.log",
    "Containment worktree",
    "Neutral cwd",
    "jobs/<jobId>/meta.json",
    "jobs/<jobId>/meta.json.*.tmp",
  ]) {
    assert.match(doc, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing artifact ${artifact}`);
  }
  assert.match(doc, /does not persist prompt sidecars, copied review bundles, branch-diff files, stdout\/stderr logs, PID records, cancel markers, or subprocess state/);
  assert.match(doc, /retained-history pruning does not signal processes/);
  assert.match(doc, /starttime.*argv0/s);
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

test("review docs expose custom-review, preflight, and blocked-review wording", () => {
  const docs = [
    readRepoFile("plugins/claude/skills/claude-cli-runtime/SKILL.md"),
    readRepoFile("plugins/claude/commands/claude-review.md"),
    readRepoFile("plugins/claude/commands/claude-adversarial-review.md"),
    readRepoFile("plugins/gemini/skills/gemini-delegation/SKILL.md"),
    readRepoFile("plugins/gemini/commands/gemini-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-adversarial-review.md"),
    readRepoFile("plugins/claude/skills/claude-result-handling/SKILL.md"),
  ].join("\n");

  assert.match(docs, /custom-review/);
  assert.match(docs, /preflight/);
  assert.match(docs, /review blocked\s*\/\s*no findings produced/i);
  assert.match(docs, /relative paths/i);
  assert.doesNotMatch(docs, /policy decision rather than a plugin\/runtime failure/i);
});

test("setup docs do not claim unimplemented target version-floor checks", () => {
  const docs = [
    readRepoFile("plugins/claude/commands/claude-setup.md"),
    readRepoFile("plugins/gemini/commands/gemini-setup.md"),
  ].join("\n");

  assert.doesNotMatch(docs, /min-versions\.json/);
  assert.doesNotMatch(docs, /version is below floor/i);
});

test("gemini command docs match background/continue runtime and wired cancel", () => {
  const rescue = readRepoFile("plugins/gemini/commands/gemini-rescue.md");
  const cancel = readRepoFile("plugins/gemini/commands/gemini-cancel.md");

  assert.match(rescue, /--background/);
  assert.match(rescue, /--foreground/);
  assert.doesNotMatch(rescue, /foreground only/i);
  assert.doesNotMatch(rescue, /background support lands/i);

  // Gemini cancel is wired (PR #22 / commit 01f4282) — docs must NOT claim
  // it returns not_implemented or that it's deferred.
  assert.doesNotMatch(cancel, /not_implemented/,
    "gemini cancel is wired; docs must not claim not_implemented");
  assert.doesNotMatch(cancel, /\bdeferred\b/i,
    "gemini cancel is wired; docs must not claim it's deferred");
  assert.doesNotMatch(cancel, /M8 wires background cancel/i);
  // Must enumerate the canonical signaled-success status so operators
  // know cancel is operational.
  assert.match(cancel, /\bsignaled\b/);
});

test("gemini-delegation/SKILL.md describes cancel --job flow (not deferred/not_implemented)", () => {
  const skill = readRepoFile("plugins/gemini/skills/gemini-delegation/SKILL.md");

  assert.doesNotMatch(skill, /not_implemented/,
    "gemini-delegation/SKILL.md must not claim cancel returns not_implemented");
  assert.doesNotMatch(skill, /cancel is deferred/i,
    "gemini-delegation/SKILL.md must not say cancel is deferred");
  assert.doesNotMatch(skill, /cancel.*deferred|deferred.*cancel/i,
    "gemini-delegation/SKILL.md must not describe cancel as deferred");
  assert.match(skill, /cancel.*--job/i,
    "gemini-delegation/SKILL.md must document the `cancel --job` workflow");
});

test("companion preflight file sorting uses an explicit comparator", () => {
  for (const target of ["claude", "gemini"]) {
    const companion = readRepoFile(`plugins/${target}/scripts/${target}-companion.mjs`);

    assert.doesNotMatch(companion, /\.sort\(\)/,
      `${target} companion must not rely on default Array#sort ordering`);
    assert.match(companion, /files\.sort\(comparePathStrings\)/,
      `${target} companion must sort preflight files with an explicit comparator`);
  }
});

test("spec does not reference an unshipped Gemini result-handling skill", () => {
  const spec = readRepoFile("docs/superpowers/specs/2026-04-23-codex-plugin-multi-design.md");

  assert.doesNotMatch(spec, /gemini-result-handling/);
  assert.match(spec, /Gemini result command docs/);
});

test("working-tree privacy docs distinguish git worktree from non-git directories", () => {
  // #16 follow-up 6: the gitignored-file filter only applies inside a git
  // worktree. Make sure operator-facing docs say so explicitly so callers
  // do not assume `.env` is hidden in arbitrary non-git directories.
  const docs = [
    readRepoFile("plugins/claude/skills/claude-cli-runtime/SKILL.md"),
    readRepoFile("plugins/claude/skills/claude-result-handling/SKILL.md"),
    readRepoFile("plugins/gemini/commands/gemini-result.md"),
  ];
  for (const doc of docs) {
    assert.match(
      doc,
      /non-git|inside a git worktree/i,
      "privacy docs must distinguish git from non-git source directories",
    );
  }
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
  assert.doesNotMatch(readme, /Gemini `cancel`.*deferred/i,
    "gemini cancel is wired (PR #22); README must not claim it's deferred");
  assert.match(readme, /docs\/e2e\.md/);
});

test("README documents host-owned pre-launch provider denials as outside companion control", () => {
  const readme = readRepoFile("README.md");

  assert.match(readme, /pre-launch/i);
  assert.match(readme, /host-owned/i);
  assert.match(readme, /cannot emit a JobRecord/i);
  assert.match(readme, /approved provider/i);
  assert.match(readme, /local\/Codex-only review/i);
  assert.match(readme, /https:\/\/github\.com\/seungpyoson\/codex-plugin-multi\/issues\/13/);
});

test("README documents Codex sandbox setup and provider-specific failure modes", () => {
  const readme = readRepoFile("README.md");

  assert.match(readme, /\[sandbox_workspace_write\]/);
  assert.match(readme, /network_access = true/);
  assert.match(readme, /writable_roots/);
  assert.match(readme, /\/Users\/<you>\/\.kimi\/logs/);
  assert.match(readme, /\/Users\/<you>\/\.kimi/);
  assert.match(readme, /one-off escalation/i);
  assert.match(readme, /approve only that command/i);
  assert.match(readme, /danger-full-access|dangerously-bypass-approvals-and-sandbox/i);
  assert.match(readme, /do not make[\s\S]*default/i);
  assert.match(readme, /Gemini CLI.*native.*sandbox|native.*Gemini.*sandbox/i);
  assert.match(readme, /Kimi.*\.kimi/i);
  assert.match(readme, /Direct API reviewers|DeepSeek.*GLM/i);
  assert.match(readme, /selected source content[\s\S]*sent/i);
});
