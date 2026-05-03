// #16 follow-up 3: orphan active-job reconciliation.
//
// reconcileActiveJobs() must promote queued/running records to status=stale
// when the worker is provably gone (dead pid_info or never-spawned older
// than the orphan window). It must NEVER delete records and must produce a
// continuable terminal state operators can resume via `continue --job`.

import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  configureState,
  getStateConfig,
  upsertJob,
  writeJobFile,
  listJobs,
  readJobFileById,
  resolveJobFile,
} from "../../plugins/claude/scripts/lib/state.mjs";
import { reconcileActiveJobs } from "../../plugins/claude/scripts/lib/reconcile.mjs";
import * as GeminiState from "../../plugins/gemini/scripts/lib/state.mjs";
import { reconcileActiveJobs as reconcileGemini } from "../../plugins/gemini/scripts/lib/reconcile.mjs";

let INITIAL_CONFIG;
let INITIAL_GEMINI_CONFIG;
before(() => {
  INITIAL_CONFIG = { ...getStateConfig() };
  INITIAL_GEMINI_CONFIG = { ...GeminiState.getStateConfig() };
});
afterEach(() => {
  configureState(INITIAL_CONFIG);
  GeminiState.configureState(INITIAL_GEMINI_CONFIG);
});

const SEED_INVOCATION_FIELDS = {
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
  prompt_head: "rescue test",
  schema_spec: null,
  binary: "claude",
};

function freshDir(prefix = "reconcile-claude-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.env["RECONCILE_DATA"] = dir;
  configureState({
    pluginDataEnv: "RECONCILE_DATA",
    fallbackStateRootDir: path.join(dir, "fallback"),
  });
  return dir;
}

function freshGeminiDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "reconcile-gemini-"));
  process.env["RECONCILE_GEMINI_DATA"] = dir;
  GeminiState.configureState({
    pluginDataEnv: "RECONCILE_GEMINI_DATA",
    fallbackStateRootDir: path.join(dir, "fallback"),
  });
  return dir;
}

function cleanup(dir, key = "RECONCILE_DATA") {
  delete process.env[key];
  rmSync(dir, { recursive: true, force: true });
}

function findDeadPid() {
  for (let pid = 999999; pid < 1009999; pid += 1) {
    try { process.kill(pid, 0); }
    catch (e) { if (e?.code === "ESRCH") return pid; }
  }
  return 99999999;
}

const TEST_PID_INFO = Object.freeze({
  pid: 424242,
  starttime: "Fri May 01 12:00:00 2026",
  argv0: "node",
});

const verifier = (reasonOrMatch) => () => (
  reasonOrMatch === true
    ? { match: true }
    : { match: false, reason: reasonOrMatch }
);

function seedActive(dir, jobId, overrides = {}) {
  const record = {
    id: jobId, job_id: jobId,
    cwd: dir, workspace_root: dir,
    started_at: new Date(Date.now() - 10_000).toISOString(),
    status: "running",
    schema_version: 6,
    pid_info: null,
    claude_session_id: null,
    gemini_session_id: null,
    ...SEED_INVOCATION_FIELDS,
    ...overrides,
  };
  writeJobFile(dir, jobId, record);
  upsertJob(dir, record);
  return record;
}

test("reconcileActiveJobs: leaves a fresh queued/running job alone", () => {
  const dir = freshDir();
  try {
    const id = "fresh-running-job";
    seedActive(dir, id, { started_at: new Date(Date.now() - 5_000).toISOString() });
    const reclaimed = reconcileActiveJobs(dir);
    assert.deepEqual(reclaimed, [], "young job with no pid_info must not be reclaimed");
    assert.equal(readJobFileById(dir, id).status, "running",
      "record must remain running");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: queued/running with a dead pid is promoted to stale", () => {
  const dir = freshDir();
  try {
    const id = "dead-pid-job";
    seedActive(dir, id, {
      pid_info: TEST_PID_INFO,
    });
    const reclaimed = reconcileActiveJobs(dir, {
      verifyPidInfoFn: verifier("process_gone"),
    });
    assert.equal(reclaimed.length, 1, `expected 1 reclaim; got ${JSON.stringify(reclaimed)}`);
    assert.equal(reclaimed[0].job_id, id);
    assert.match(reclaimed[0].reason, /no longer exists|reused/);
    const after = readJobFileById(dir, id);
    assert.equal(after.status, "stale",
      "dead-pid orphan must be promoted to stale");
    assert.equal(after.error_code, "stale_active_job");
    assert.match(after.error_message, /stale_active_job: /);
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: live pid_info leaves running job active", () => {
  const dir = freshDir();
  try {
    const id = "live-pid-job";
    seedActive(dir, id, { pid_info: TEST_PID_INFO });
    assert.deepEqual(reconcileActiveJobs(dir, { verifyPidInfoFn: verifier(true) }), [],
      "matching live pid_info must not be reclaimed as stale");
    assert.equal(readJobFileById(dir, id).status, "running");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: live pid with mismatched identity is promoted as reused", () => {
  const dir = freshDir();
  try {
    const id = "reused-pid-job";
    seedActive(dir, id, {
      pid_info: TEST_PID_INFO,
    });
    const reclaimed = reconcileActiveJobs(dir, {
      verifyPidInfoFn: verifier("argv0_mismatch"),
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].job_id, id);
    assert.match(reclaimed[0].reason, /reused by a different process/);
    assert.equal(readJobFileById(dir, id).status, "stale");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: missing pid_info reclaimed only after orphan window", () => {
  const dir = freshDir();
  try {
    const idYoung = "queued-young";
    const idOld = "queued-old";
    seedActive(dir, idYoung, {
      status: "queued",
      pid_info: null,
      started_at: new Date(Date.now() - 60_000).toISOString(),
    });
    seedActive(dir, idOld, {
      status: "queued",
      pid_info: null,
      started_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    });
    // Default orphan window is 1h; idYoung must stay, idOld must be reclaimed.
    const reclaimed = reconcileActiveJobs(dir);
    assert.equal(reclaimed.length, 1, `expected exactly 1 reclaim; got ${JSON.stringify(reclaimed)}`);
    assert.equal(reclaimed[0].job_id, idOld);
    assert.equal(readJobFileById(dir, idYoung).status, "queued");
    assert.equal(readJobFileById(dir, idOld).status, "stale");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: stale jobs are continuable history, not deleted", () => {
  const dir = freshDir();
  try {
    const id = "permanent-stale-job";
    seedActive(dir, id, {
      pid_info: TEST_PID_INFO,
      external_review: {
        marker: "EXTERNAL REVIEW",
        provider: "Claude Code",
        run_kind: "background",
      },
    });
    reconcileActiveJobs(dir, {
      verifyPidInfoFn: verifier("process_gone"),
    });
    const stale = readJobFileById(dir, id);
    assert.equal(stale.status, "stale");
    // Schema invariants: the canonical fields used by `continue --job`
    // must survive the reconciliation so an operator can resume.
    assert.equal(stale.mode, "rescue");
    assert.equal(stale.workspace_root, dir);
    assert.equal(stale.target, "claude");
    assert.equal(stale.external_review.run_kind, "background");
    assert.equal(stale.external_review.source_content_transmission, "sent");
    assert.equal(
      stale.external_review.disclosure,
      "Selected source content was sent to Claude Code for external review; the run became stale before completion.",
    );
    // Reconciliation never deletes the record from state.json either.
    const summary = listJobs(dir).find((j) => j.id === id);
    assert.ok(summary, "stale job must remain in state.json");
    assert.equal(summary.status, "stale");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: legacy active records without external_review keep run kind unknown", () => {
  const dir = freshDir();
  try {
    const id = "legacy-running-without-external-review";
    seedActive(dir, id, {
      pid_info: TEST_PID_INFO,
      external_review: undefined,
    });
    const reclaimed = reconcileActiveJobs(dir, {
      verifyPidInfoFn: verifier("process_gone"),
    });
    assert.equal(reclaimed.length, 1);
    const stale = readJobFileById(dir, id);
    assert.equal(stale.status, "stale");
    assert.equal(stale.external_review.run_kind, "unknown");
    assert.equal(stale.external_review.source_content_transmission, "sent");
    assert.match(stale.external_review.disclosure, /run became stale/);
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: legacy queued records without pid_info keep transmission unknown", () => {
  const dir = freshDir();
  try {
    const id = "legacy-queued-without-pid";
    seedActive(dir, id, {
      status: "queued",
      pid_info: null,
      external_review: undefined,
      started_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const reclaimed = reconcileActiveJobs(dir, {
      orphanAgeMs: 60 * 60 * 1000,
    });
    assert.equal(reclaimed.length, 1);
    const stale = readJobFileById(dir, id);
    assert.equal(stale.status, "stale");
    assert.equal(stale.external_review.run_kind, "unknown");
    assert.equal(stale.external_review.source_content_transmission, "unknown");
    assert.match(stale.external_review.disclosure, /may have been sent/);
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: invalid started_at string is left alone", () => {
  // parseStartedAt returns null when the ISO string is unparseable.
  // Reconciliation must not crash and must not reclaim such records.
  const dir = freshDir();
  try {
    const id = "bad-started-at";
    seedActive(dir, id, {
      pid_info: null,
      started_at: "not-a-date",
    });
    assert.deepEqual(reconcileActiveJobs(dir), [],
      "record with unparseable started_at must be left active");
    assert.equal(readJobFileById(dir, id).status, "running");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: TOCTOU regression — terminal meta written mid-flight is NOT clobbered", () => {
  // PR #21 review BLOCKER 2 regression guard. The race used to be:
  //   t1: reconcile reads meta = running
  //   t2: worker writes meta = completed
  //   t3: reconcile writes meta = stale (CLOBBERS completed result)
  //
  // The fix moves the read-classify-write into commitJobRecordsIfActive,
  // which holds the state lock around an in-lock CAS read. Because we
  // hold the lock while reading + writing, the only way for a worker's
  // commit to land in between is if the worker's commitJobRecord runs
  // BEFORE we acquired the lock — in which case the in-lock read sees
  // the terminal status and the builder is NOT called.
  //
  // Direct simulation of "worker beat us to the lock": pre-write the
  // terminal record before invoking reconcile. Reconcile must see the
  // terminal status via its in-lock CAS read and abort.
  const dir = freshDir();
  try {
    const id = "toctou-completed";
    seedActive(dir, id, {
      pid_info: { pid: findDeadPid(), starttime: "Thu Apr 24 12:00:00 2026", argv0: "claude" },
    });
    // Worker's terminal commit lands BEFORE reconcile's lock acquisition.
    // Use writeJobFile + upsertJob (the legacy non-atomic pattern is fine
    // for the test fixture; the contract is "if meta is terminal on disk
    // when reconcile reads under lock, no clobber").
    writeJobFile(dir, id, {
      ...readJobFileById(dir, id),
      status: "completed",
      result: "REAL_WORKER_RESULT",
      ended_at: new Date().toISOString(),
      exit_code: 0, error_code: null, error_message: null,
    });
    upsertJob(dir, { id, status: "completed" });

    const reclaimed = reconcileActiveJobs(dir);
    assert.deepEqual(reclaimed, [],
      "reconcile must NOT promote a terminal record (CAS abort)");
    const after = readJobFileById(dir, id);
    assert.equal(after.status, "completed",
      "terminal completed record must NOT be clobbered with stale");
    assert.equal(after.result, "REAL_WORKER_RESULT",
      "worker's result must survive reconcile pass");
  } finally { cleanup(dir); }
});

test("reconcileActiveJobs: state-summary active + meta terminal repairs state", () => {
  // Defense in depth: if state.json says running but meta.json says
  // completed (e.g., a writer crashed mid-update), reconciliation must
  // trust the meta and repair state — not promote to stale.
  const dir = freshDir();
  try {
    const id = "summary-vs-meta";
    seedActive(dir, id, { status: "completed" });
    // Override summary to say running while meta still says completed.
    upsertJob(dir, { id, status: "running" });
    assert.deepEqual(reconcileActiveJobs(dir), []);
    assert.equal(readJobFileById(dir, id).status, "completed",
      "meta wins; reconciliation must not flip a completed record to stale");
    assert.equal(listJobs(dir).find((job) => job.id === id)?.status, "completed",
      "state summary must be repaired from terminal meta without reporting a reclaim");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: invalid pid (zero/negative) is treated as no pid_info", () => {
  // pid_info { pid: 0, ... } is invalid; reconcile must fall back to
  // age-based logic instead of trying to verify pid 0.
  const dir = freshDir();
  try {
    const id = "invalid-pid";
    seedActive(dir, id, {
      pid_info: { pid: 0, starttime: "x", argv0: "claude" },
      started_at: new Date(Date.now() - 5_000).toISOString(),
    });
    assert.deepEqual(reconcileActiveJobs(dir), [],
      "young record with invalid pid must remain active");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: pid_info missing argv0 falls through to age check", () => {
  const dir = freshDir();
  try {
    const id = "no-argv0";
    seedActive(dir, id, {
      pid_info: { pid: 1, starttime: "x", argv0: null },
      started_at: new Date(Date.now() - 5_000).toISOString(),
    });
    assert.deepEqual(reconcileActiveJobs(dir), [],
      "young record with incomplete pid_info must remain active");
    // Tighten orphan window so the same record reclaims via age fallback.
    const reclaimed = reconcileActiveJobs(dir, { orphanAgeMs: 1_000 });
    assert.equal(reclaimed.length, 1);
    assert.equal(readJobFileById(dir, id).status, "stale");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: pid_info with capture_error is treated as missing pid_info", () => {
  // capture_error means we couldn't read /proc or run `ps` — we have a
  // pid number but no ownership proof. Reconcile must NOT signal that
  // pid (cmdCancel already refuses); it should fall through to the
  // age-based branch.
  const dir = freshDir();
  try {
    const id = "capture-error-young";
    seedActive(dir, id, {
      pid_info: { pid: 1, starttime: null, argv0: null, capture_error: "EPERM" },
      started_at: new Date(Date.now() - 30_000).toISOString(),
    });
    assert.deepEqual(reconcileActiveJobs(dir), [],
      "young record with capture_error must remain active until orphan window");
    assert.equal(readJobFileById(dir, id).status, "running");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: configurable orphan window controls when missing pid_info reclaims", () => {
  const dir = freshDir();
  try {
    const id = "tunable-orphan";
    seedActive(dir, id, {
      status: "queued",
      pid_info: null,
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min
    });
    // Default 1h window — leaves it.
    assert.deepEqual(reconcileActiveJobs(dir), [],
      "10-min queued must stay active under default 1h window");
    // Tighten to 5 min — reclaims it.
    const reclaimed = reconcileActiveJobs(dir, { orphanAgeMs: 5 * 60 * 1000 });
    assert.equal(reclaimed.length, 1);
    assert.equal(readJobFileById(dir, id).status, "stale");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: terminal records (completed/failed/cancelled) are ignored", () => {
  // Reconciliation only touches active records; terminal records must
  // pass through unchanged so a re-run of cmdStatus is idempotent.
  const dir = freshDir();
  try {
    for (const status of ["completed", "failed", "cancelled", "stale"]) {
      seedActive(dir, `${status}-job`, {
        status,
        pid_info: { pid: findDeadPid(), starttime: "x", argv0: "claude" },
      });
    }
    assert.deepEqual(reconcileActiveJobs(dir), [],
      "terminal records must be ignored, even with dead pid_info");
    for (const status of ["completed", "failed", "cancelled", "stale"]) {
      assert.equal(readJobFileById(dir, `${status}-job`).status, status,
        `${status} record must not be promoted to stale`);
    }
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: missing meta.json on disk is skipped without throwing", () => {
  // listJobs returns a state.json summary; meta.json may be missing if a
  // prior writer failed. Incomplete summaries must be skipped instead of
  // crashing the next status call.
  const dir = freshDir();
  try {
    upsertJob(dir, { id: "summary-only", status: "running",
      started_at: new Date(Date.now() - 10_000).toISOString() });
    // No writeJobFile — meta.json absent. Should be a no-op.
    assert.deepEqual(reconcileActiveJobs(dir), [],
      "summary without meta.json must be skipped, not throw");
  } finally {
    cleanup(dir);
  }
});

test("reconcileActiveJobs: full state-only active record is reclaimed when meta is missing", () => {
  // If state.json retained a full active JobRecord but meta.json disappeared,
  // reconcile can still produce a terminal stale meta record instead of
  // leaving status --all polluted forever.
  const dir = freshDir();
  try {
    const id = "state-only-full-record";
    seedActive(dir, id, {
      started_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    rmSync(resolveJobFile(dir, id), { force: true });

    const reclaimed = reconcileActiveJobs(dir);
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].job_id, id);
    const after = readJobFileById(dir, id);
    assert.equal(after.status, "stale");
    assert.match(after.error_message, /stale_active_job/);
  } finally {
    cleanup(dir);
  }
});

test("gemini reconcileActiveJobs: dead pid promotes to stale", () => {
  const dir = freshGeminiDir();
  try {
    const id = "gemini-dead-pid-job";
    GeminiState.writeJobFile(dir, id, {
      id, job_id: id,
      target: "gemini",
      parent_job_id: null,
      resume_chain: [],
      mode_profile_name: "rescue",
      mode: "rescue",
      model: "gemini-3-flash-preview",
      cwd: dir, workspace_root: dir,
      containment: "none", scope: "working-tree",
      dispose_effective: false,
      scope_base: null, scope_paths: null,
      prompt_head: "rescue test", schema_spec: null,
      binary: "gemini",
      status: "running",
      started_at: new Date(Date.now() - 10_000).toISOString(),
      pid_info: TEST_PID_INFO,
      external_review: {
        marker: "EXTERNAL REVIEW",
        provider: "Gemini CLI",
        run_kind: "background",
      },
      claude_session_id: null,
      gemini_session_id: null,
      schema_version: 6,
    });
    GeminiState.upsertJob(dir, { id, status: "running" });

    const reclaimed = reconcileGemini(dir, {
      verifyPidInfoFn: verifier("process_gone"),
    });
    assert.equal(reclaimed.length, 1);
    const after = GeminiState.readJobFileById(dir, id);
    assert.equal(after.status, "stale");
    assert.equal(after.external_review.run_kind, "background");
  } finally {
    cleanup(dir, "RECONCILE_GEMINI_DATA");
  }
});

test("gemini reconcileActiveJobs: missing pid_info reclaimed only after orphan window", () => {
  const dir = freshGeminiDir();
  try {
    const baseRecord = (id, startedAt) => ({
      id, job_id: id,
      target: "gemini",
      parent_job_id: null,
      resume_chain: [],
      mode_profile_name: "rescue",
      mode: "rescue",
      model: "gemini-3-flash-preview",
      cwd: dir, workspace_root: dir,
      containment: "none", scope: "working-tree",
      dispose_effective: false,
      scope_base: null, scope_paths: null,
      prompt_head: "rescue test", schema_spec: null,
      binary: "gemini",
      status: "queued",
      started_at: startedAt,
      pid_info: null,
      claude_session_id: null,
      gemini_session_id: null,
      schema_version: 6,
    });
    const young = baseRecord("g-young", new Date(Date.now() - 60_000).toISOString());
    const old = baseRecord("g-old", new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());
    GeminiState.writeJobFile(dir, young.id, young);
    GeminiState.writeJobFile(dir, old.id, old);
    GeminiState.upsertJob(dir, { id: young.id, status: "queued" });
    GeminiState.upsertJob(dir, { id: old.id, status: "queued" });

    const reclaimed = reconcileGemini(dir);
    assert.equal(reclaimed.length, 1, `expected 1 reclaim; got ${JSON.stringify(reclaimed)}`);
    assert.equal(reclaimed[0].job_id, "g-old");
    assert.equal(GeminiState.readJobFileById(dir, "g-young").status, "queued");
    assert.equal(GeminiState.readJobFileById(dir, "g-old").status, "stale");
  } finally {
    cleanup(dir, "RECONCILE_GEMINI_DATA");
  }
});
