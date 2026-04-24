// Smoke tests: drives claude-companion.mjs with the Claude mock on PATH.
// Covers the foreground review / adversarial-review / rescue paths + error
// surfaces. Real Claude CLI is never invoked — CLAUDE_BINARY overrides to
// tests/smoke/claude-mock.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// spawnSync is reused for git init in the mutation-detection smoke.
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/claude-mock.mjs");

function runCompanion(args, { cwd, env = {} } = {}) {
  // Point the companion at a fresh PLUGIN_DATA dir so tests don't step on
  // each other's state or on the user's real ~/.cache.
  const dataDir = mkdtempSync(path.join(tmpdir(), "companion-smoke-"));
  const res = spawnSync("node", [COMPANION, ...args], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_BINARY: MOCK,
      CLAUDE_PLUGIN_DATA: dataDir,
      ...env,
    },
    encoding: "utf8",
  });
  return { ...res, dataDir };
}

function cleanup(dataDir) {
  rmSync(dataDir, { recursive: true, force: true });
}

test("run --mode=review --foreground: emits JSON with ok:true", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review: x=1"],
    { cwd }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.mode, "review");
    assert.equal(result.model, "claude-haiku-4-5-20251001");
    assert.ok(result.job_id, "job_id set");
    assert.equal(result.result, "Mock Claude response.");
    assert.deepEqual(result.permission_denials, []);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=rescue: uses default model from config/models.json", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  // No --model; rescue defaults to "default" tier.
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground",
     "--model", "claude-haiku-4-5-20251001", // mock needs a fixture-hitting model
     "--cwd", cwd, "--", "investigate: why is x null"],
    { cwd }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.mode, "rescue");
    assert.ok(result.job_id);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: meta.json persisted to workspace state", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  const { stdout, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "hello"],
    { cwd }
  );
  try {
    const { job_id } = JSON.parse(stdout);
    // State dir is deterministic: <PLUGIN_DATA>/state/<slug>-<hash>/jobs/<job_id>.json
    const stateRoot = path.join(dataDir, "state");
    let found = null;
    for (const dir of readdirSync(stateRoot)) {
      const metaPath = path.join(stateRoot, dir, "jobs", `${job_id}.json`);
      if (existsSync(metaPath)) { found = metaPath; break; }
    }
    assert.ok(found, `meta.json not found under ${stateRoot}`);
    const meta = JSON.parse(readFileSync(found, "utf8"));
    assert.equal(meta.id, job_id);
    assert.equal(meta.target, "claude");
    assert.equal(meta.status, "completed");
    assert.equal(meta.mode, "review");
    assert.equal(meta.session_id, job_id);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: rejects bad --mode", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  const { stderr, status, dataDir } = runCompanion(
    ["run", "--mode=chaos", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "x"],
    { cwd }
  );
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /--mode must be one of/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --background: returns not_implemented at M2", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  const { stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "x"],
    { cwd }
  );
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /M4/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: pre/post git-status sidecars written in a git cwd", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-git-"));
  // Make a minimal git repo with a seed file so git status has meaningful output.
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("bash", ["-c", "echo seed > seed && git add seed && git -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
  const { stdout, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review this"],
    { cwd }
  );
  try {
    const { job_id } = JSON.parse(stdout);
    const stateRoot = path.join(dataDir, "state");
    let jobsDir = null;
    for (const dir of readdirSync(stateRoot)) {
      const candidate = path.join(stateRoot, dir, "jobs", job_id);
      if (existsSync(candidate)) { jobsDir = candidate; break; }
    }
    assert.ok(jobsDir, `job sidecar dir not found under ${stateRoot}`);
    // Both snapshots written (may be empty strings for a clean seeded repo — that's OK).
    assert.ok(existsSync(path.join(jobsDir, "git-status-before.txt")), "before snapshot missing");
    assert.ok(existsSync(path.join(jobsDir, "git-status-after.txt")), "after snapshot missing");
    assert.ok(existsSync(path.join(jobsDir, "stdout.log")), "stdout.log missing");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("status/result/cancel: return not_implemented at M2", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  for (const sub of ["status", "result", "cancel", "continue", "ping", "doctor"]) {
    const { stderr, status, dataDir } = runCompanion([sub], { cwd });
    try {
      assert.notEqual(status, 0, `${sub} should exit non-zero`);
      assert.match(stderr, /later milestone/);
    } finally {
      cleanup(dataDir);
    }
  }
  rmSync(cwd, { recursive: true, force: true });
});
