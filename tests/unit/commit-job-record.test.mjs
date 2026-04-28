// PR #21 adversarial review BLOCKER 1 + 2:
//   1. Finalization fallback was unconditional — a state.json failure
//      would clobber a successful meta.json with status=failed.
//   2. Reconcile read meta=running, classified stale, then wrote stale
//      meta — clobbering a worker's terminal completed meta that landed
//      in the read-then-write window.
//
// Both are race classes: two writers for the same (cwd, jobId). The fix
// is commitJobRecord (atomic meta + state under one lock acquisition)
// and commitJobRecordIfActive (CAS read inside the lock, abort if no
// longer active).

import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  configureState,
  getStateConfig,
  commitJobRecord,
  commitJobRecordIfActive,
  upsertJob,
  writeJobFile,
  readJobFileById,
  resolveJobFile,
  listJobs,
} from "../../plugins/claude/scripts/lib/state.mjs";
import {
  configureState as configureGeminiState,
  getStateConfig as getGeminiStateConfig,
  commitJobRecord as commitGeminiJobRecord,
  commitJobRecordIfActive as commitGeminiIfActive,
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

// ——— commitJobRecordIfActive (CAS) ———

test("commitJobRecordIfActive: builder runs when meta is active", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000333";
    const running = makeRecord(dir, id, {
      status: "running", exitCode: null, parsed: null,
    });
    commitJobRecord(dir, id, running);
    let calledWith = null;
    const next = commitJobRecordIfActive(dir, id, (meta) => {
      calledWith = meta;
      return makeRecord(dir, id, {
        status: "stale", exitCode: null, parsed: null,
        errorMessage: "stale_active_job: test",
      });
    });
    assert.ok(calledWith, "builder must be called for an active record");
    assert.equal(calledWith.status, "running");
    assert.ok(next, "builder result must be committed");
    assert.equal(readJobFileById(dir, id).status, "stale");
  } finally { cleanup(dir); }
});

test("commitJobRecordIfActive: CAS aborts when meta is already terminal", () => {
  // BLOCKER 2 regression guard — simulate the worker having written its
  // terminal completed record before reconcile took the lock. Builder must
  // NOT run (no clobber), and meta must remain completed.
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000444";
    const completed = makeRecord(dir, id);   // status=completed by default
    commitJobRecord(dir, id, completed);
    let builderCalled = false;
    const next = commitJobRecordIfActive(dir, id, () => {
      builderCalled = true;
      return makeRecord(dir, id, {
        status: "stale", exitCode: null, parsed: null,
        errorMessage: "stale_active_job: shouldn't happen",
      });
    });
    assert.equal(builderCalled, false,
      "CAS must abort builder when on-disk meta is no longer active");
    assert.equal(next, null, "no commit when CAS aborts");
    assert.equal(readJobFileById(dir, id).status, "completed",
      "terminal completed record must NOT be clobbered with stale");
  } finally { cleanup(dir); }
});

test("commitJobRecordIfActive: returning null from builder is a no-op", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000555";
    const queued = buildJobRecord({
      job_id: id, cwd: dir, workspace_root: dir,
      started_at: new Date().toISOString(), ...INVOCATION_FIELDS,
    }, null, []);
    commitJobRecord(dir, id, queued);
    const result = commitJobRecordIfActive(dir, id, () => null);
    assert.equal(result, null);
    assert.equal(readJobFileById(dir, id).status, "queued");
  } finally { cleanup(dir); }
});

test("commitJobRecordIfActive: missing meta is a no-op (not a throw)", () => {
  const dir = freshDir();
  try {
    const id = "00000000-0000-4000-8000-000000000666";
    upsertJob(dir, { id, status: "running" });   // summary only, no meta
    let builderCalled = false;
    const result = commitJobRecordIfActive(dir, id, () => {
      builderCalled = true;
      return null;
    });
    assert.equal(builderCalled, false);
    assert.equal(result, null);
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
      model: "gemini-3-pro-preview",
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
    const result = commitGeminiIfActive(dir, id, () => null);
    assert.equal(result, null,
      "CAS aborts because the record is now terminal");
  } finally {
    delete process.env[envVar];
    rmSync(dir, { recursive: true, force: true });
  }
});

// ——— helpers ———

import { mkdirSync as require_then_mkdir } from "node:fs";
