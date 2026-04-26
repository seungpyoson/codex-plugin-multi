import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, realpathSync,
  writeFileSync, chmodSync, mkdirSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/gemini/scripts/gemini-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/gemini-mock.mjs");

function seedMinimalRepo(cwd) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
  spawnSync("bash", ["-c",
    "echo seed > seed.txt && git add seed.txt && " +
    "git -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
}

function runCompanion(args, { cwd, env = {} } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-smoke-data-"));
  const res = spawnSync("node", [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GEMINI_BINARY: MOCK,
      GEMINI_PLUGIN_DATA: dataDir,
      ...env,
    },
  });
  return { ...res, dataDir };
}

function writeMarkerBinary(dir, markerPath) {
  const binary = path.join(dir, "target-cli");
  writeFileSync(binary, [
    "#!/bin/sh",
    `printf spawned > ${JSON.stringify(markerPath)}`,
    "printf '{\"session_id\":\"22222222-3333-4444-9555-666666666666\",\"response\":\"spawned\"}\\n'",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(binary, 0o755);
  return binary;
}

function writeIndexCorruptingBinary(dir, repoPath) {
  const binary = path.join(dir, "corrupt-index-cli");
  writeFileSync(binary, [
    "#!/bin/sh",
    `printf corrupt > ${JSON.stringify(path.join(repoPath, ".git", "index"))}`,
    "printf '{\"session_id\":\"22222222-3333-4444-9555-666666666666\",\"response\":\"spawned after corrupting index\"}\\n'",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(binary, 0o755);
  return binary;
}

function readStdoutLog(dataDir, jobId) {
  const stateRoot = path.join(dataDir, "state");
  for (const dir of readdirSync(stateRoot)) {
    const p = path.join(stateRoot, dir, "jobs", jobId, "stdout.log");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error(`no stdout.log for ${jobId}`);
}

test("gemini review foreground: policy-first, stdin transport, /tmp cwd, scoped include dir", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-cwd-"));
  seedMinimalRepo(cwd);
  const neutralCwd = realpathSync("/tmp");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review: x=1"],
    { cwd, env: { GEMINI_MOCK_ASSERT_FILE: "seed.txt", GEMINI_MOCK_ASSERT_CWD: neutralCwd } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.target, "gemini");
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Mock Gemini response.");
    assert.equal(record.claude_session_id, null);
    assert.equal(record.gemini_session_id, "22222222-3333-4444-9555-666666666666");
    assert.equal(record.containment, "worktree");
    assert.equal(record.scope, "working-tree");

    const fx = readStdoutLog(dataDir, record.job_id);
    assert.notEqual(fx.t7_cwd, neutralCwd, "Gemini review must not use /tmp itself as the workspace root");
    assert.equal(fx.t7_cwd.startsWith(neutralCwd), true, `Gemini review must run from a neutral temp cwd under ${neutralCwd}; got ${fx.t7_cwd}`);
    assert.equal(existsSync(fx.t7_cwd), false, `neutral Gemini cwd must be cleaned after the run: ${fx.t7_cwd}`);
    assert.equal(fx.t7_include_dirs.includes(fx.t7_cwd), false, "neutral cwd must not be the scoped include directory");
    assert.equal(fx.t7_saw_file, true, `Gemini must receive scoped include dir containing seed.txt; got ${fx.t7_include_dirs}`);
    assert.equal(fx.t7_policy_loaded, true, "Gemini review must pass bundled read-only policy");
    assert.equal(fx.t7_sandbox, true, "Gemini review must pass the sandbox flag");
    assert.equal(fx.t7_skip_trust, true, "Gemini review must pass --skip-trust so plan approval is not downgraded");
    assert.equal(fx.t7_prompt_from_stdin, true, "Gemini prompt must arrive on stdin, not argv");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini review preserves result when pre-run mutation detection is unavailable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-mut-pre-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Mock Gemini response.");
    assert.ok(record.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must be surfaced, got ${JSON.stringify(record.mutations)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini review preserves pre-run mutation detection failure when target spawn fails", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-mut-spawn-fail-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--binary", path.join(cwd, "missing-gemini"), "--cwd", cwd, "--", "review"],
    { cwd },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.ok(record.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must survive spawn failure, got ${JSON.stringify(record.mutations)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini review preserves result when post-run mutation detection is unavailable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-mut-post-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-mut-post-data-"));
  seedMinimalRepo(cwd);
  const binary = writeIndexCorruptingBinary(dataDir, cwd);
  const res = spawnSync("node", [
    COMPANION, "run", "--mode=review", "--foreground",
    "--binary", binary,
    "--cwd", cwd, "--", "review",
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GEMINI_PLUGIN_DATA: dataDir,
    },
  });
  try {
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    const record = JSON.parse(res.stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.result, "spawned after corrupting index");
    assert.ok(record.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must be surfaced, got ${JSON.stringify(record.mutations)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini scope population failure skips target CLI spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-scope-abort-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-scope-abort-data-"));
  const marker = path.join(dataDir, "spawned.marker");
  const binary = writeMarkerBinary(dataDir, marker);
  seedMinimalRepo(cwd);
  mkdirSync(path.join(cwd, "target-dir"));
  writeFileSync(path.join(cwd, "target-dir/file.txt"), "nested\n");
  symlinkSync("target-dir", path.join(cwd, "dir-link"));
  const res = spawnSync("node", [
    COMPANION, "run", "--mode=review", "--foreground",
    "--model", "gemini-3-flash-preview",
    "--cwd", cwd, "--", "focus",
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GEMINI_BINARY: binary,
      GEMINI_PLUGIN_DATA: dataDir,
    },
  });
  try {
    assert.equal(res.status, 2, `exit ${res.status}: ${res.stderr}`);
    const record = JSON.parse(res.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.exit_code, null);
    assert.match(record.error_message, /unsafe_symlink/);
    assert.equal(existsSync(marker), false, "target CLI marker proves Gemini binary was spawned");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini status default includes queued, cancelled, stale, running, completed, and failed jobs", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-status-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-status-data-"));
  seedMinimalRepo(cwd);
  try {
    const previous = process.env.GEMINI_PLUGIN_DATA;
    process.env.GEMINI_PLUGIN_DATA = dataDir;
    const state = await import("../../plugins/gemini/scripts/lib/state.mjs");
    for (const status of ["queued", "cancelled", "stale", "running", "completed", "failed"]) {
      state.upsertJob(cwd, { id: `job-${status}`, status });
    }
    if (previous === undefined) delete process.env.GEMINI_PLUGIN_DATA;
    else process.env.GEMINI_PLUGIN_DATA = previous;

    const res = spawnSync("node", [COMPANION, "status", "--cwd", cwd], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
    });
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.deepEqual(
      parsed.jobs.map((job) => job.status).sort(),
      ["cancelled", "completed", "failed", "queued", "running", "stale"],
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini ping returns ok with the mock gemini binary", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["ping", "--model", "gemini-3-flash-preview"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.model, "gemini-3-flash-preview");
    assert.equal(parsed.session_id, "22222222-3333-4444-9555-666666666666");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
