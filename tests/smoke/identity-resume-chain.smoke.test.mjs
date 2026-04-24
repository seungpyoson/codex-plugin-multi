// Smoke tests: spec §21.1 identity contract on the companion surface.
//
// - Chained `continue` must pass the LATEST claude_session_id to `--resume`
//   (not the companion's job_id for the intermediate job, which is what the
//   legacy-conflated `session_id` field held).
// - `cancel` must refuse to signal when `pid_info.starttime` no longer matches
//   — PID reuse or a hand-edited meta must not redirect the kill.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/claude-mock.mjs");

function seedRepo(cwd) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
  spawnSync("bash", ["-c",
    "echo seed > seed.txt && git add seed.txt && " +
    "git -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
}

function runCompanion(args, { cwd, dataDir, env = {} }) {
  return spawnSync("node", [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_BINARY: MOCK,
      CLAUDE_PLUGIN_DATA: dataDir,
      ...env,
    },
  });
}

function findMetaPath(dataDir, jobId) {
  const stateRoot = path.join(dataDir, "state");
  for (const dir of readdirSync(stateRoot)) {
    const p = path.join(stateRoot, dir, "jobs", `${jobId}.json`);
    if (existsSync(p)) return p;
  }
  throw new Error(`no meta for ${jobId}`);
}

function findStatePath(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  for (const dir of readdirSync(stateRoot)) {
    const p = path.join(stateRoot, dir, "state.json");
    if (existsSync(p)) return p;
  }
  throw new Error("no state.json");
}

// Patch a job's record in both the aggregated state.json and the per-job
// meta.json. `cancel` reads from state.json (via listJobs), so both files
// must reflect the tampered shape for the test to exercise the right
// code path.
function patchJob(dataDir, jobId, patch) {
  const metaPath = findMetaPath(dataDir, jobId);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const newMeta = { ...meta, ...patch };
  writeFileSync(metaPath, JSON.stringify(newMeta, null, 2));
  const statePath = findStatePath(dataDir);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const idx = state.jobs.findIndex((j) => j.id === jobId);
  if (idx >= 0) {
    state.jobs[idx] = { ...state.jobs[idx], ...patch };
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  return newMeta;
}

test("continue chain: resume arg is LATEST claude_session_id, not an intermediate job_id", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-chain-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "chain-data-"));
  const resumeSink = path.join(dataDir, "last-resume.txt");
  try {
    seedRepo(cwd);
    // Run 1 — fresh rescue job, companion passes --session-id=job_id_1.
    // Mock echoes back session_id == job_id_1 as claude_session_id.
    const r1 = runCompanion(
      ["run", "--mode=rescue", "--foreground",
        "--model", "claude-haiku-4-5-20251001",
        "--cwd", cwd, "--", "seed"],
      { cwd, dataDir,
        env: { CLAUDE_MOCK_RECORD_RESUME: "1", CLAUDE_MOCK_RESUME_SINK: resumeSink } });
    assert.equal(r1.status, 0, r1.stderr);
    const job1 = JSON.parse(r1.stdout).job_id;
    const meta1 = JSON.parse(readFileSync(findMetaPath(dataDir, job1), "utf8"));
    assert.equal(meta1.job_id, job1, "job_id field present on new-shape record");
    assert.ok(meta1.claude_session_id, "claude_session_id captured from stdout");
    const claudeSid1 = meta1.claude_session_id;
    assert.deepEqual(meta1.resume_chain, [], "fresh run has empty resume_chain");
    // session_id (legacy) must NOT be written on new records (§21.1 forbids
    // using the same UUID for both job_id and session_id).
    assert.equal(meta1.session_id, undefined,
      `legacy session_id must not appear on new records; got ${meta1.session_id}`);

    // Run 2 — continue from job1. Companion mints job_2, passes --resume=<claudeSid1>.
    const r2 = runCompanion(
      ["continue", "--job", job1, "--foreground", "--cwd", cwd, "--", "followup"],
      { cwd, dataDir,
        env: { CLAUDE_MOCK_RECORD_RESUME: "1", CLAUDE_MOCK_RESUME_SINK: resumeSink } });
    assert.equal(r2.status, 0, r2.stderr);
    const job2 = JSON.parse(r2.stdout).job_id;
    assert.notEqual(job2, job1, "continue must mint a new job_id");
    const meta2 = JSON.parse(readFileSync(findMetaPath(dataDir, job2), "utf8"));
    assert.deepEqual(meta2.resume_chain, [claudeSid1],
      "resume_chain on continue should be [priorClaudeSessionId]");
    assert.equal(meta2.parent_job_id, job1);
    // The mock recorded the --resume value it was given. Must be claudeSid1,
    // NOT job2 (the new companion-minted UUID).
    const resumeRecv1 = readFileSync(resumeSink, "utf8").trim();
    assert.equal(resumeRecv1, claudeSid1,
      `first --resume must be claudeSid1=${claudeSid1}; got ${resumeRecv1}`);

    // Run 3 — continue from job2. The resume arg must be job2's
    // claude_session_id — i.e., the echo from run 2 — NOT job2 (the companion
    // UUID) nor claudeSid1 (a dead earlier session). This is finding #6.
    const claudeSid2 = meta2.claude_session_id;
    assert.ok(claudeSid2, "run 2 must have captured claude_session_id");
    const r3 = runCompanion(
      ["continue", "--job", job2, "--foreground", "--cwd", cwd, "--", "third"],
      { cwd, dataDir,
        env: { CLAUDE_MOCK_RECORD_RESUME: "1", CLAUDE_MOCK_RESUME_SINK: resumeSink } });
    assert.equal(r3.status, 0, r3.stderr);
    const job3 = JSON.parse(r3.stdout).job_id;
    const meta3 = JSON.parse(readFileSync(findMetaPath(dataDir, job3), "utf8"));
    assert.deepEqual(meta3.resume_chain, [claudeSid1, claudeSid2],
      "chained continue must accumulate resume_chain newest-last");
    const resumeRecv2 = readFileSync(resumeSink, "utf8").trim();
    assert.equal(resumeRecv2, claudeSid2,
      `chained --resume must be claudeSid2=${claudeSid2}; got ${resumeRecv2} ` +
      `(legacy bug would have used job2=${job2})`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: refuses with stale_pid when pid_info.starttime mismatches", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-stalepid-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "stalepid-data-"));
  try {
    seedRepo(cwd);
    // Run a foreground job so it completes, leaving a full meta on disk.
    const r1 = runCompanion(
      ["run", "--mode=rescue", "--foreground",
        "--model", "claude-haiku-4-5-20251001",
        "--cwd", cwd, "--", "stale-test"],
      { cwd, dataDir });
    assert.equal(r1.status, 0, r1.stderr);
    const jobId = JSON.parse(r1.stdout).job_id;
    const meta0 = JSON.parse(readFileSync(findMetaPath(dataDir, jobId), "utf8"));
    assert.ok(meta0.pid_info, "new record must carry pid_info");
    assert.ok(Number.isInteger(meta0.pid_info.pid) && meta0.pid_info.pid > 0,
      "pid_info.pid is a positive integer");

    // Flip the job back to `running` and point pid_info at the CURRENT
    // process but with a BOGUS starttime. Current test process is definitely
    // alive, so a naive `kill(pid,0)` check would succeed — verifyPidInfo is
    // what must catch the tamper.
    patchJob(dataDir, jobId, {
      status: "running",
      pid_info: {
        pid: process.pid,
        starttime: "Jan 1 00:00:00 1970",
        argv0: meta0.pid_info.argv0 ?? "node",
      },
    });

    const cancelRes = runCompanion(
      ["cancel", "--job", jobId, "--cwd", cwd],
      { cwd, dataDir });
    assert.notEqual(cancelRes.status, 0,
      `cancel must fail on stale_pid; got exit ${cancelRes.status}`);
    assert.match(cancelRes.stderr, /stale_pid/,
      `stderr must mention stale_pid; got: ${cancelRes.stderr}`);
    // Own process is still alive (we'd have crashed otherwise), confirming
    // no SIGTERM was delivered.
    assert.equal(process.killed ?? false, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: no_pid_info on legacy record with no pid_info", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-nopid-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "nopid-data-"));
  try {
    seedRepo(cwd);
    const r1 = runCompanion(
      ["run", "--mode=rescue", "--foreground",
        "--model", "claude-haiku-4-5-20251001",
        "--cwd", cwd, "--", "legacy-test"],
      { cwd, dataDir });
    assert.equal(r1.status, 0, r1.stderr);
    const jobId = JSON.parse(r1.stdout).job_id;
    // Simulate a pre-T7.3 legacy record: running status, no pid_info, bare
    // pid field only. cmdCancel must refuse to signal.
    patchJob(dataDir, jobId, {
      status: "running",
      pid_info: null,
      pid: process.pid, // legacy bare pid (the conflation T7.3 removes)
    });

    const cancelRes = runCompanion(
      ["cancel", "--job", jobId, "--cwd", cwd],
      { cwd, dataDir });
    // Expected: JSON {ok:false, status:"no_pid_info"}, exit 0 or non-zero
    // (brief says "refuse"; any non-signal outcome is acceptable).
    const parsed = JSON.parse(cancelRes.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "no_pid_info");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
