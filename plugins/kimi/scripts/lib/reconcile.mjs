// Orphan active-job reconciliation (#16 follow-up 3).
//
// Background workers can die between writing the `running` record (in
// onSpawn) and the executeRun finalization. The persisted JobRecord stays
// at status=running forever, and pruneJobs() refuses to evict active
// records — so terminal history can be starved by unreconciled orphans.
//
// reconcileActiveJobs() walks active records (queued or running) and
// promotes them to status=stale when there is enough evidence that the
// worker is gone:
//
//   - pid_info present + valid: verifyPidInfo. process_gone /
//     starttime_mismatch / argv0_mismatch → stale (PID-reuse-safe;
//     the same identity check cmdCancel uses).
//   - pid_info missing or incomplete AND started_at older than the
//     configurable orphan window (default 1h): stale (the worker was
//     queued but never spawned, or pid_info was never captured).
//
// Reconciliation NEVER deletes records. It writes a stale terminal
// record via the canonical buildJobRecord path, so consumers see
// status=stale, error_code=stale_active_job, and a clear
// error_message naming the reason. Stale is continuable
// (CONTINUABLE_STATUSES set in the companions), so an operator who
// wants to retry the work can `continue --job <id>` without manual
// JSON mutation.
//
// Called from cmdStatus on every status request so the lifecycle
// self-heals without a separate reaper process.

import { listJobs, commitJobRecordsIfActive } from "./state.mjs";
import { verifyPidInfo } from "./identity.mjs";
import { buildJobRecord } from "./job-record.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running"]);

// 1 hour: long enough that any normal background worker has either
// completed, signaled, or was evidently killed with no chance of
// resuming. Tunable via reconcileActiveJobs(workspaceRoot, { orphanAgeMs }).
const DEFAULT_ORPHAN_AGE_MS = 60 * 60 * 1000;

function parseStartedAt(record) {
  if (!record?.started_at) return null;
  const t = Date.parse(record.started_at);
  return Number.isFinite(t) ? t : null;
}

function invocationFromMeta(meta) {
  // Project ONLY the invocation-phase fields buildJobRecord requires.
  // Lifecycle/result fields are re-derived from the synthetic execution
  // we feed in below, never carried over from the orphaned record.
  return {
    job_id: meta.job_id ?? meta.id,
    target: meta.target,
    parent_job_id: meta.parent_job_id ?? null,
    resume_chain: meta.resume_chain ?? [],
    mode_profile_name: meta.mode_profile_name,
    mode: meta.mode,
    model: meta.model,
    cwd: meta.cwd,
    workspace_root: meta.workspace_root,
    containment: meta.containment,
    scope: meta.scope,
    dispose_effective: meta.dispose_effective ?? false,
    scope_base: meta.scope_base ?? null,
    scope_paths: meta.scope_paths ?? null,
    prompt_head: meta.prompt_head ?? "",
    schema_spec: meta.schema_spec ?? null,
    binary: meta.binary,
    max_steps_per_turn: meta.max_steps_per_turn ?? null,
    started_at: meta.started_at,
  };
}

function classifyOrphan(meta, now, orphanAgeMs, verifyPidInfoFn) {
  const pidInfo = meta.pid_info ?? null;
  if (pidInfo && Number.isInteger(pidInfo.pid)
      && pidInfo.starttime && pidInfo.argv0
      && !pidInfo.capture_error) {
    const check = verifyPidInfoFn(pidInfo);
    if (check.match) return null;
    if (check.reason === "process_gone") {
      return `worker pid ${pidInfo.pid} no longer exists`;
    }
    if (check.reason === "starttime_mismatch" || check.reason === "argv0_mismatch") {
      return `worker pid ${pidInfo.pid} reused by a different process (${check.reason})`;
    }
    return null; // capture_error / invalid_saved — not enough evidence to reclaim
  }
  // No usable pid_info. Only reclaim when the record is older than the
  // orphan window (gives a real worker time to write its onSpawn record).
  const startedAtMs = parseStartedAt(meta);
  if (startedAtMs == null) return null;
  if (now - startedAtMs <= orphanAgeMs) return null;
  return `worker queued at ${meta.started_at} never produced pid_info ` +
    `(>${Math.round(orphanAgeMs / 1000)}s ago)`;
}

/**
 * Reconcile orphaned active jobs in `workspaceRoot`. Returns an array
 * of { job_id, reason } describing what was reclaimed (empty array
 * means nothing was reclaimed). Callers may surface that to the user
 * via stderr; cmdStatus calls this silently so a default `status`
 * just shows up-to-date records.
 *
 * BLOCKER 2 fix (PR #21 review): the read-classify-write loop runs
 * inside commitJobRecordsIfActive, which holds the state lock around
 * in-lock CAS reads of meta.json/state.json. A worker's commitJobRecord
 * that lands before reconcile takes the lock will be CAS-detected
 * (meta no longer active → builder NOT called); a worker that runs
 * after reconcile commits stale will simply overwrite the stale record
 * with its terminal record. Either way, terminal wins — no clobber.
 */
export function reconcileActiveJobs(workspaceRoot, {
  now = Date.now(),
  orphanAgeMs = DEFAULT_ORPHAN_AGE_MS,
  verifyPidInfoFn = verifyPidInfo,
} = {}) {
  const activeJobIds = listJobs(workspaceRoot)
    .filter((summary) => ACTIVE_STATUSES.has(summary.status))
    .map((summary) => summary.id);
  const reasons = new Map();
  const committed = commitJobRecordsIfActive(workspaceRoot, activeJobIds, (meta) => {
    // Inside the state lock. CAS already passed — meta.status is in
    // ACTIVE_JOB_STATUSES. Decide whether to promote.
    const reason = classifyOrphan(meta, now, orphanAgeMs, verifyPidInfoFn);
    if (!reason) return null;
    let invocation;
    try { invocation = invocationFromMeta(meta); }
    catch { return null; }
    if (!invocation.target || !invocation.mode_profile_name) return null;
    try {
      const next = buildJobRecord(invocation, {
        // status="stale" tells classifyExecution to short-circuit.
        status: "stale",
        exitCode: meta.exit_code ?? null,
        parsed: null,
        pidInfo: meta.pid_info ?? null,
        claudeSessionId: meta.claude_session_id ?? null,
        kimiSessionId: meta.kimi_session_id ?? null,
        errorMessage: `stale_active_job: ${reason}`,
      }, Array.isArray(meta.mutations) ? meta.mutations : []);
      reasons.set(next.id, reason);
      return next;
    } catch { return null; }
  });
  return committed.map((record) => ({ job_id: record.id, reason: reasons.get(record.id) }));
}
