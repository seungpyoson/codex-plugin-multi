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

test("run --background: emits launched event and terminal meta arrives", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-bg-"));
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "bg task"],
    { cwd }
  );
  try {
    assert.equal(status, 0);
    const ev = JSON.parse(stdout);
    assert.equal(ev.event, "launched");
    assert.ok(ev.job_id);
    assert.equal(ev.target, "claude");
    // Poll for terminal state written by detached worker.
    const stateRoot = path.join(dataDir, "state");
    const deadline = Date.now() + 5000;
    let meta = null;
    while (Date.now() < deadline) {
      for (const dir of readdirSync(stateRoot)) {
        const metaPath = path.join(stateRoot, dir, "jobs", `${ev.job_id}.json`);
        if (existsSync(metaPath)) {
          const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
          if (parsed.status === "completed" || parsed.status === "failed") { meta = parsed; break; }
        }
      }
      if (meta) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(meta, "worker never wrote terminal meta");
    assert.equal(meta.id, ev.job_id);
    assert.ok(["completed", "failed"].includes(meta.status));
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continue --job: resumes a prior session via --resume", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-continue-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "continue-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=rescue", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], { cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir } });
    const { job_id } = JSON.parse(runRes.stdout);
    const contRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "continue", "--job", job_id, "--foreground",
      "--cwd", cwd, "--", "follow-up",
    ], { cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir } });
    assert.equal(contRes.status, 0, contRes.stderr);
    const out = JSON.parse(contRes.stdout);
    assert.notEqual(out.job_id, job_id, "continue must mint a new job_id");
    assert.equal(out.ok, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --isolated --dispose: creates and removes a git worktree", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-iso-"));
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("bash", ["-c", "echo seed > seed && git add seed && git -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--isolated", "--dispose",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review this"],
    { cwd }
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    // Source worktree should still exist; isolated worktree should be disposed.
    const worktreeList = spawnSync("git", ["-C", cwd, "worktree", "list"], { encoding: "utf8" }).stdout;
    // Exactly one entry (the source repo itself) — temp worktree removed.
    assert.equal(worktreeList.trim().split("\n").length, 1, `unexpected worktrees:\n${worktreeList}`);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --isolated without --dispose: worktree persists and path is recorded", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-iso2-"));
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("bash", ["-c", "echo seed > seed && git add seed && git -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
  // Rescue defaults to --no-dispose; use rescue so the test stays short.
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--isolated",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "work"],
    { cwd }
  );
  try {
    assert.equal(status, 0, stderr);
    const { job_id } = JSON.parse(stdout);
    const stateRoot = path.join(dataDir, "state");
    let meta = null;
    for (const dir of readdirSync(stateRoot)) {
      const metaPath = path.join(stateRoot, dir, "jobs", `${job_id}.json`);
      if (existsSync(metaPath)) { meta = JSON.parse(readFileSync(metaPath, "utf8")); break; }
    }
    assert.ok(meta.worktree_path, "worktree_path should be recorded when not disposed");
    assert.ok(existsSync(meta.worktree_path), `recorded worktree ${meta.worktree_path} should exist`);
    // Clean up after assert so the test doesn't leak.
    spawnSync("git", ["-C", cwd, "worktree", "remove", "--force", meta.worktree_path]);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --isolated on a non-git cwd: returns isolation_failed", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-iso3-"));
  // No git init — --isolated should refuse.
  const { stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--isolated",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "x"],
    { cwd }
  );
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /isolated requires a git repository/);
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

test("doctor: returns not_implemented (pre-M10)", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  const { stderr, status, dataDir } = runCompanion(["doctor"], { cwd });
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /later milestone/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ping: returns status=ok with the mock claude binary", () => {
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir() }
  );
  try {
    assert.equal(status, 0, `ping exit ${status}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "ok");
    assert.equal(result.model, "claude-haiku-4-5-20251001");
    assert.ok(result.session_id);
  } finally {
    cleanup(dataDir);
  }
});

test("status: empty workspace returns empty jobs list", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-status-"));
  const { stdout, status, dataDir } = runCompanion(["status", "--cwd", cwd], { cwd });
  try {
    assert.equal(status, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.jobs.length, 0);
    assert.ok(result.workspace_root);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("status: lists a job after a review run", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-status2-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "status2-data-"));
  try {
    // Run a review to seed a job.
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(runRes.status, 0, runRes.stderr);
    const { job_id } = JSON.parse(runRes.stdout);
    // Status should list it.
    const statusRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "status", "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(statusRes.status, 0, statusRes.stderr);
    const statusObj = JSON.parse(statusRes.stdout);
    const match = statusObj.jobs.find((j) => j.id === job_id);
    assert.ok(match, `job ${job_id} not in status output`);
    assert.equal(match.status, "completed");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("result --job: returns meta for a finished job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-result-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "result-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    const { job_id } = JSON.parse(runRes.stdout);
    const resultRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "result", "--job", job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(resultRes.status, 0, resultRes.stderr);
    const meta = JSON.parse(resultRes.stdout);
    assert.equal(meta.id, job_id);
    assert.equal(meta.status, "completed");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("result --job with unknown id: returns not_found", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-result404-"));
  const { stderr, status, dataDir } = runCompanion(
    ["result", "--job", "00000000-0000-4000-8000-000000000000", "--cwd", cwd],
    { cwd }
  );
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /no meta.json/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: already_terminal for a completed job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cancel-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "cancel-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    const { job_id } = JSON.parse(runRes.stdout);
    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(cancelRes.status, 0);
    const response = JSON.parse(cancelRes.stdout);
    assert.equal(response.status, "already_terminal");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
