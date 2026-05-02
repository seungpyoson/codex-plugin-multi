// PR #21 adversarial review BLOCKER 1 + 2:
//   1. Finalization fallback was unconditional — a state.json failure
//      would clobber a successful meta.json with status=failed.
//   2. Reconcile read meta=running, classified stale, then wrote stale
//      meta — clobbering a worker's terminal completed meta that landed
//      in the read-then-write window.
//
// Both are race classes: two writers for the same (cwd, jobId). The fix
// is commitJobRecord (atomic meta + state under one lock acquisition)
// and commitJobRecordsIfActive (batched CAS reads inside one lock, abort
// if no longer active).

import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  configureState,
  getStateConfig,
  commitJobRecord,
  commitJobRecordsIfActive,
  upsertJob,
  writeJobFile,
  readJobFileById,
  resolveJobFile,
  resolveStateFile,
  listJobs,
} from "../../plugins/claude/scripts/lib/state.mjs";
import {
  configureState as configureGeminiState,
  getStateConfig as getGeminiStateConfig,
  commitJobRecord as commitGeminiJobRecord,
  commitJobRecordsIfActive as commitGeminiRecordsIfActive,
  writeJobFile as writeGeminiJobFile,
  listJobs as listGeminiJobs,
} from "../../plugins/gemini/scripts/lib/state.mjs";
import { buildJobRecord } from "../../plugins/claude/scripts/lib/job-record.mjs";

let INITIAL_CONFIG;
let INITIAL_GEMINI_CONFIG;
before(() => {
  INITIAL_CONFIG = { ...getStateConfig() };
  INITIAL_GEMINI_CONFIG = { ...getGeminiStateConfig() };
});
afterEach(() => {
  configureState(INITIAL_CONFIG);
  configureGeminiState(INITIAL_GEMINI_CONFIG);
});

const INVOCATION_FIELDS = {
  target: "claude",
  parent_job_id: null,
  resume_chain: [],
  mode_profile_name: "rescue",
  mode: "rescue",
  model: "claude-haiku-4-5-20251001",
  containment: "none",
  scope: "working-tree",
  dispose_effective: false,
  scope_base: null,
  scope_paths: null,
  prompt_head: "test",
  schema_spec: null,
  binary: "claude",
};

function freshDir(envVar = "COMMIT_TEST_DATA") {
  const dir = mkdtempSync(path.join(tmpdir(), "commit-test-"));
  process.env[envVar] = dir;
  configureState({
    pluginDataEnv: envVar,
    fallbackStateRootDir: path.join(dir, "fallback"),
  });
  return dir;
}

function cleanup(dir, envVar = "COMMIT_TEST_DATA") {
  delete process.env[envVar];
  rmSync(dir, { recursive: true, force: true });
}

function makeRecord(dir, id, overrides = {}) {
  return buildJobRecord({
    job_id: id,
    cwd: dir,
    workspace_root: dir,
    started_at: new Date().toISOString(),
    ...INVOCATION_FIELDS,
  }, {
    exitCode: 0,
    parsed: { ok: true, result: "DONE", structured: null, denials: [], costUsd: 0.001 },
    pidInfo: { pid: 1, starttime: "x", argv0: "claude" },
    claudeSessionId: null,
    ...overrides,
  }, []);
}

// ——— commitJobRecord ———

test("commitJobRecord: writes meta + state atomically on the happy path", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000111";
    const record = makeRecord(dir, id);
    const { metaError, stateError } = commitJobRecord(dir, id, record);
    assert.equal(metaError, null);
    assert.equal(stateError, null);
    assert.equal(readJobFileById(dir, id).status, "completed");
    const summary = listJobs(dir).find((j) => j.id === id);
    assert.ok(summary, "state.json must carry a summary");
    assert.equal(summary.status, "completed");
  } finally { cleanup(dir); }
});

test("commitJobRecord: meta failure leaves state untouched", () => {
  // Replace meta.json with a directory so writeJobFile rename fails.
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000222";
    // Pre-seed state with a queued summary so we can detect that commit
    // didn't update it.
    upsertJob(dir, { id, status: "queued" });
    // Now sabotage the meta path.
    const metaPath = resolveJobFile(dir, id);
    rmSync(metaPath, { recursive: true, force: true });
    require_then_mkdir(metaPath);
    const record = makeRecord(dir, id);
    const { metaError, stateError } = commitJobRecord(dir, id, record);
    assert.notEqual(metaError, null, "meta failure must be reported");
    assert.equal(stateError, null);
    // State summary should NOT have been updated to completed.
    const summary = listJobs(dir).find((j) => j.id === id);
    assert.equal(summary?.status, "queued",
      "meta failure must NOT leak a partial state.json update");
  } finally { cleanup(dir); }
});

// ——— commitJobRecordsIfActive (batch CAS) ———

test("commitJobRecordsIfActive: builder runs for active records in one batch", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000333";
    const running = makeRecord(dir, id, {
      status: "running", exitCode: null, parsed: null,
    });
    commitJobRecord(dir, id, running);
    let calledWith = null;
    const next = commitJobRecordsIfActive(dir, [id], (meta) => {
      calledWith = meta;
      return makeRecord(dir, id, {
        status: "stale", exitCode: null, parsed: null,
        errorMessage: "stale_active_job: test",
      });
    });
    assert.ok(calledWith, "builder must be called for an active record");
    assert.equal(calledWith.status, "running");
    assert.equal(next.length, 1, "builder result must be committed");
    assert.equal(readJobFileById(dir, id).status, "stale");
  } finally { cleanup(dir); }
});

test("commitJobRecordsIfActive: CAS aborts when meta is already terminal", () => {
  // BLOCKER 2 regression guard — simulate the worker having written its
  // terminal completed record before reconcile took the lock. Builder must
  // NOT run (no clobber), and meta must remain completed.
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000444";
    const completed = makeRecord(dir, id);   // status=completed by default
    commitJobRecord(dir, id, completed);
    let builderCalled = false;
    const next = commitJobRecordsIfActive(dir, [id], () => {
      builderCalled = true;
      return makeRecord(dir, id, {
        status: "stale", exitCode: null, parsed: null,
        errorMessage: "stale_active_job: shouldn't happen",
      });
    });
    assert.equal(builderCalled, false,
      "CAS must abort builder when on-disk meta is no longer active");
    assert.deepEqual(next, [], "no commit when CAS aborts");
    assert.equal(readJobFileById(dir, id).status, "completed",
      "terminal completed record must NOT be clobbered with stale");
  } finally { cleanup(dir); }
});

test("commitJobRecordsIfActive: returning null from builder is a no-op", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000555";
    const queued = buildJobRecord({
      job_id: id, cwd: dir, workspace_root: dir,
      started_at: new Date().toISOString(), ...INVOCATION_FIELDS,
    }, null, []);
    commitJobRecord(dir, id, queued);
    const result = commitJobRecordsIfActive(dir, [id], () => null);
    assert.deepEqual(result, []);
    assert.equal(readJobFileById(dir, id).status, "queued");
  } finally { cleanup(dir); }
});

test("commitJobRecordsIfActive: incomplete state-only summary can decline commit", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000666";
    upsertJob(dir, { id, status: "running" });   // summary only, no meta
    let calls = 0;
    const result = commitJobRecordsIfActive(dir, [id], (source) => {
      calls += 1;
      assert.equal(source.id, id);
      return null;
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, []);
  } finally { cleanup(dir); }
});

test("commitJobRecordsIfActive: full state-only record can be committed", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000667";
    const running = makeRecord(dir, id, {
      status: "running", exitCode: null, parsed: null,
    });
    commitJobRecord(dir, id, running);
    rmSync(resolveJobFile(dir, id), { force: true });
    let builderCalled = false;
    const result = commitJobRecordsIfActive(dir, [id], (source) => {
      builderCalled = true;
      assert.equal(source.id, id);
      return makeRecord(dir, id, {
        status: "stale", exitCode: null, parsed: null,
        errorMessage: "stale_active_job: state-only recovery",
      });
    });
    assert.equal(builderCalled, true);
    assert.equal(result.length, 1);
    assert.equal(readJobFileById(dir, id).status, "stale");
  } finally { cleanup(dir); }
});

test("commitJobRecordsIfActive: returns no committed records when state save fails", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000668";
    const running = makeRecord(dir, id, {
      status: "running", exitCode: null, parsed: null,
    });
    writeJobFile(dir, id, running);
    require_then_mkdir(resolveStateFile(dir));
    const result = commitJobRecordsIfActive(dir, [id], () => makeRecord(dir, id, {
      status: "stale", exitCode: null, parsed: null,
      errorMessage: "stale_active_job: save failed after meta write",
    }));
    assert.deepEqual(result, [],
      "caller must not receive committed records when state.json save failed");
    assert.equal(readJobFileById(dir, id).status, "stale",
      "meta write may still land; later reconcile can repair state from terminal meta");
  } finally { cleanup(dir); }
});

test("commitJobRecordsIfActive: terminal meta repairs active state without builder", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000669";
    const running = makeRecord(dir, id, {
      status: "running", exitCode: null, parsed: null,
    });
    commitJobRecord(dir, id, running);
    writeJobFile(dir, id, {
      ...running,
      status: "stale",
      error_message: "stale_active_job: meta already landed",
    });
    let builderCalled = false;
    const result = commitJobRecordsIfActive(dir, [id], () => {
      builderCalled = true;
      throw new Error("builder must not run for terminal meta repair");
    });
    assert.equal(builderCalled, false);
    assert.deepEqual(result, []);
    assert.equal(listJobs(dir).find((job) => job.id === id)?.status, "stale");
  } finally { cleanup(dir); }
});

// ——— Gemini parity ———

test("gemini commitJobRecord: same atomic-under-lock semantics", () => {
  const envVar = "COMMIT_GEMINI_TEST_DATA";
  const dir = mkdtempSync(path.join(tmpdir(), "commit-g-"));
  process.env[envVar] = dir;
  configureGeminiState({
    pluginDataEnv: envVar,
    fallbackStateRootDir: path.join(dir, "fallback"),
  });
  try {
    const id = "00000000-0000-4000-8000-000000000777";
    const record = buildJobRecord({
      job_id: id, target: "gemini",
      parent_job_id: null, resume_chain: [],
      mode_profile_name: "rescue", mode: "rescue",
      model: "gemini-3.1-pro-preview",
      cwd: dir, workspace_root: dir,
      containment: "none", scope: "working-tree",
      dispose_effective: false, scope_base: null, scope_paths: null,
      prompt_head: "test", schema_spec: null, binary: "gemini",
      started_at: new Date().toISOString(),
    }, {
      exitCode: 0,
      parsed: { ok: true, result: "DONE", structured: null, denials: [] },
      pidInfo: { pid: 1, starttime: "x", argv0: "gemini" },
      geminiSessionId: null,
    }, []);
    const { metaError, stateError } = commitGeminiJobRecord(dir, id, record);
    assert.equal(metaError, null);
    assert.equal(stateError, null);
    const result = commitGeminiRecordsIfActive(dir, [id], () => null);
    assert.deepEqual(result, [],
      "CAS aborts because the record is now terminal");
  } finally {
    delete process.env[envVar];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gemini commitJobRecordsIfActive: terminal meta repairs active state without builder", () => {
  const envVar = "COMMIT_GEMINI_TEST_DATA";
  const dir = mkdtempSync(path.join(tmpdir(), "commit-g-repair-"));
  process.env[envVar] = dir;
  configureGeminiState({
    pluginDataEnv: envVar,
    fallbackStateRootDir: path.join(dir, "fallback"),
  });
  try {
    const id = "00000000-0000-4000-8000-000000000778";
    const running = buildJobRecord({
      job_id: id, target: "gemini",
      parent_job_id: null, resume_chain: [],
      mode_profile_name: "rescue", mode: "rescue",
      model: "gemini-3.1-pro-preview",
      cwd: dir, workspace_root: dir,
      containment: "none", scope: "working-tree",
      dispose_effective: false, scope_base: null, scope_paths: null,
      prompt_head: "test", schema_spec: null, binary: "gemini",
      started_at: new Date().toISOString(),
    }, {
      status: "running",
      exitCode: null,
      parsed: null,
      pidInfo: { pid: 1, starttime: "x", argv0: "gemini" },
      geminiSessionId: null,
    }, []);
    commitGeminiJobRecord(dir, id, running);
    writeGeminiJobFile(dir, id, {
      ...running,
      status: "stale",
      error_message: "stale_active_job: meta already landed",
    });
    let builderCalled = false;
    const result = commitGeminiRecordsIfActive(dir, [id], () => {
      builderCalled = true;
      throw new Error("builder must not run for terminal meta repair");
    });
    assert.equal(builderCalled, false);
    assert.deepEqual(result, []);
    assert.equal(listGeminiJobs(dir).find((job) => job.id === id)?.status, "stale");
  } finally {
    delete process.env[envVar];
    rmSync(dir, { recursive: true, force: true });
  }
});

// ——— helpers ———

import { mkdirSync as require_then_mkdir } from "node:fs";
