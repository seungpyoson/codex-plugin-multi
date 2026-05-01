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

import { fixtureSeedRepo } from "../helpers/fixture-git.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/claude-mock.mjs");

// #16 follow-up 9: fixtureSeedRepo scrubs inherited GIT_* env vars.
function seedRepo(cwd) {
  fixtureSeedRepo(cwd);
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

// NOTE — T7.6 relocations:
//   - "continue chain: resume arg is LATEST ..." (finding #6) → invariants.test.mjs
//   - "cancel: refuses with stale_pid ..." (finding #7)       → invariants.test.mjs
// The legacy-record fallback test below stays here — it exercises a
// different code path (no pid_info present at all) that is not 1:1 with a
// single M6 finding.

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
