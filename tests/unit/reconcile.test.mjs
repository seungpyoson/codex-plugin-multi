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
    const deadPid = findDeadPid();
    seedActive(dir, id, {
      pid_info: {
        pid: deadPid,
        starttime: "Thu Apr 24 12:00:00 2026",
        argv0: "claude",
      },
    });
    const reclaimed = reconcileActiveJobs(dir);
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
      pid_info: {
        pid: findDeadPid(),
        starttime: "Thu Apr 24 12:00:00 2026",
        argv0: "claude",
      },
    });
    reconcileActiveJobs(dir);
    const stale = readJobFileById(dir, id);
    assert.equal(stale.status, "stale");
    // Schema invariants: the canonical fields used by `continue --job`
    // must survive the reconciliation so an operator can resume.
    assert.equal(stale.mode, "rescue");
    assert.equal(stale.workspace_root, dir);
    assert.equal(stale.target, "claude");
    // Reconciliation never deletes the record from state.json either.
    const summary = listJobs(dir).find((j) => j.id === id);
    assert.ok(summary, "stale job must remain in state.json");
    assert.equal(summary.status, "stale");
  } finally {
    cleanup(dir);
  }
});

test("gemini reconcileActiveJobs: same semantics on the gemini state module", () => {
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
      pid_info: {
        pid: findDeadPid(),
        starttime: "Thu Apr 24 12:00:00 2026",
        argv0: "gemini",
      },
      claude_session_id: null,
      gemini_session_id: null,
      schema_version: 6,
    });
    GeminiState.upsertJob(dir, { id, status: "running" });

    const reclaimed = reconcileGemini(dir);
    assert.equal(reclaimed.length, 1);
    assert.equal(GeminiState.readJobFileById(dir, id).status, "stale");
  } finally {
    cleanup(dir, "RECONCILE_GEMINI_DATA");
  }
});
