import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

test("companion sidecar writes use sibling tmp files, rename, and private directories", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readRepoFile(rel);
    const match = /function writeSidecar[\s\S]*?\n}/.exec(source);
    assert.ok(match, `${rel}: missing writeSidecar helper`);
    assert.match(match[0], /renameSync/, `${rel}: writeSidecar must rename a tmp file into place`);
    assert.match(match[0], /\.tmp/, `${rel}: writeSidecar must write a sibling tmp file`);
    assert.match(match[0], /mode:\s*0o700/, `${rel}: writeSidecar must create private job dirs`);
    assert.match(match[0], /chmodSync\(dir,\s*0o700\)/, `${rel}: writeSidecar must tighten existing job dirs`);
  }
});

test("prompt sidecar writes use sibling tmp files and rename", () => {
  const source = readRepoFile("scripts/lib/companion-common.mjs");
  const match = /export function writePromptSidecar[\s\S]*?\n}/.exec(source);
  assert.ok(match, "scripts/lib/companion-common.mjs: missing writePromptSidecar helper");
  assert.match(match[0], /renameSync/, "writePromptSidecar must rename a tmp file into place");
  assert.match(match[0], /\.tmp/, "writePromptSidecar must write a sibling tmp file");
});

test("prompt sidecar write cleanup removes final path after rename failures", () => {
  const source = readRepoFile("scripts/lib/companion-common.mjs");
  const match = /export function writePromptSidecar[\s\S]*?\n}/.exec(source);
  assert.ok(match, "scripts/lib/companion-common.mjs: missing writePromptSidecar helper");
  assert.match(match[0], /let\s+renamed\s*=\s*false/, "writePromptSidecar must track whether rename completed");
  assert.match(match[0], /renamed\s*=\s*true/, "writePromptSidecar must mark successful rename before final hardening");
  assert.match(match[0], /unlinkSync\(renamed\s*\?\s*p\s*:\s*tmpFile\)/,
    "writePromptSidecar must remove prompt.txt, not only the tmp file, if post-rename hardening fails");
});

test("prompt sidecar cleanup is best-effort after a successful read", () => {
  const source = readRepoFile("scripts/lib/companion-common.mjs");
  const match = /export function consumePromptSidecar[\s\S]*?\n}/.exec(source);
  assert.ok(match, "scripts/lib/companion-common.mjs: missing consumePromptSidecar helper");
  assert.match(match[0], /readFileSync\(p,\s*"utf8"\)/, "consumePromptSidecar must read before cleanup");
  assert.match(match[0], /catch\s*\{\s*\/\* best-effort cleanup after the prompt has been read \*\/\s*}/,
    "consumePromptSidecar cleanup must not prevent worker terminalization after a successful read");
});

test("Kimi runtime-options sidecar writes use private directories", () => {
  const source = readRepoFile("plugins/kimi/scripts/kimi-companion.mjs");
  const match = /function writeRuntimeOptionsSidecar[\s\S]*?\n}/.exec(source);
  assert.ok(match, "kimi companion: missing writeRuntimeOptionsSidecar helper");
  assert.match(match[0], /mode:\s*0o700/, "runtime-options sidecar must create private job dirs");
  assert.match(match[0], /chmodSync\(dir,\s*0o700\)/, "runtime-options sidecar must tighten existing job dirs");
});

test("workers distinguish empty prompt sidecars from missing prompt sidecars", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readRepoFile(rel);
    const workerPromptBlock = /let prompt;[\s\S]*?await executeRun/.exec(source)?.[0] ?? "";
    assert.match(workerPromptBlock, /if\s*\(\s*prompt\s*==\s*null\s*\)/, `${rel}: worker must check nullish prompt only`);
    assert.doesNotMatch(workerPromptBlock, /if\s*\(\s*!prompt\s*\)/, `${rel}: worker must not classify empty prompts as missing`);
  }
});

test("background prompt sidecar write failures terminalize queued jobs", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readRepoFile(rel);
    assert.match(
      source,
      /function failBackgroundPromptSidecarWrite[\s\S]*?buildJobRecord[\s\S]*?writeJobFile[\s\S]*?upsertJob[\s\S]*?fail\(/,
      `${rel}: prompt sidecar write failure must produce a terminal failed JobRecord and structured error`,
    );
    assert.match(
      source,
      /try\s*\{\s*writePromptSidecar\(resolveJobsDir\(workspaceRoot\),\s*jobId[\s\S]*?\}\s*catch\s*\(error\)\s*\{\s*failBackgroundPromptSidecarWrite\(workspaceRoot,\s*invocation,\s*error\)/,
      `${rel}: background run must route prompt sidecar write failures through the terminalization helper`,
    );
    assert.match(
      source,
      /try\s*\{\s*writePromptSidecar\(resolveJobsDir\(workspaceRoot\),\s*newJobId_[\s\S]*?\}\s*catch\s*\(error\)\s*\{\s*failBackgroundPromptSidecarWrite\(workspaceRoot,\s*invocation,\s*error\)/,
      `${rel}: background continue must route prompt sidecar write failures through the terminalization helper`,
    );
  }
});

test("background worker spawn cleanup cannot prevent terminalization", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readRepoFile(rel);
    const match = /function failBackgroundWorkerSpawn[\s\S]*?\n}/.exec(source);
    assert.ok(match, `${rel}: missing failBackgroundWorkerSpawn helper`);
    assert.match(
      match[0],
      /try\s*\{\s*consumePromptSidecar\(resolveJobsDir\(workspaceRoot\),\s*invocation\.job_id\);\s*\}\s*catch\s*\{\s*\/\* best-effort prompt sidecar cleanup \*\/\s*}/,
      `${rel}: spawn-failure cleanup must be best-effort before writing the terminal record`,
    );
    assert.match(
      match[0],
      /buildJobRecord[\s\S]*?writeJobFile[\s\S]*?upsertJob[\s\S]*?fail\("spawn_failed"/,
      `${rel}: spawn failures must still produce a terminal failed JobRecord`,
    );
  }
});

test("workers terminalize prompt sidecar consume failures", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readRepoFile(rel);
    const workerPromptBlock = /let prompt;[\s\S]*?if\s*\(\s*prompt\s*==\s*null\s*\)/.exec(source)?.[0] ?? "";
    assert.match(
      workerPromptBlock,
      /try\s*\{\s*prompt\s*=\s*consumePromptSidecar\(resolveJobsDir\(workspaceRoot\),\s*options\.job\);/,
      `${rel}: worker must guard prompt sidecar consumption`,
    );
    assert.match(
      workerPromptBlock,
      /catch\s*\(error\)[\s\S]*?buildJobRecord[\s\S]*?writeJobFile[\s\S]*?upsertJob[\s\S]*?fail\("bad_state"/,
      `${rel}: worker consume failures must write a terminal failed JobRecord`,
    );
  }
});

test("plan-mode pre-run git-status sidecar failures are mutation warnings across companions", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readRepoFile(rel);
    assert.match(
      source,
      /try\s*\{[\s\S]*?writeSidecar\((?:workspaceRoot|invocation\.workspace_root),\s*(?:jobId|invocation\.job_id),\s*"git-status-before\.txt"[\s\S]*?\}\s*catch\s*\(e\)\s*\{[\s\S]*?(?:mutations|context\.mutations)\.push\(mutationDetectionFailure\(e\)/,
      `${rel}: pre-run git-status sidecar failure must be recorded as mutation_detection_failed`,
    );
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
  assert.match(
    source,
    /catch\s*\(e\)\s*\{[\s\S]*?buildJobRecord\(invocation,[\s\S]*?\}, mutations\)/,
    "spawn-failure records after mutation detection starts must preserve accumulated mutations",
  );
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
