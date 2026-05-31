// cancel-marker.mjs — file-based sentinel that cmdCancel writes BEFORE
// signaling the target. The worker's executeRun reads-and-deletes it
// during finalization (consumeCancelMarker) and forces status=cancelled
// regardless of exit_code/signal — closes the SIGTERM-trap loophole
// where a target CLI that handles SIGTERM and exits 0 with valid output
// would otherwise be mis-classified as `completed`. (Issue #22 sub-task 2.)
//
// This module is in the byte-identical lib pair (VERBATIM_FILES). Only
// lifecycle-pure functions live here; target-specific concerns (warning
// prefix, branding) stay at the caller.

import { writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { resolveJobsDir, assertSafeJobId } from "./state.mjs";

// All public functions validate jobId BEFORE any path concat. The state
// module also enforces this for writeJobFile / resolveJobFile / state.json
// upserts, so under normal flow listJobs only returns UUIDs. The boundary
// validation here is defense in depth: if state.json is tampered (or a
// future code path bypasses state.mjs validation), callers like cmdCancel
// still cannot use a traversal-laden jobId to escape the jobs dir.

/** Returns the absolute path of the cancel-requested marker for a job. */
export function cancelMarkerPath(workspaceRoot, jobId) {
  assertSafeJobId(jobId);
  return `${resolveJobsDir(workspaceRoot)}/${jobId}/cancel-requested.flag`;
}

/**
 * Writes the cancel-requested marker (mode 0600). Creates the parent dir
 * if missing. Throws on failure so cmdCancel can decide how hard to fail.
 * For queued jobs the marker is the whole cancel mechanism, so failure
 * must surface as cancel_failed. For running jobs the signal can still
 * proceed, so callers may warn and continue.
 */
export function writeCancelMarker(workspaceRoot, jobId) {
  const p = cancelMarkerPath(workspaceRoot, jobId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, new Date().toISOString() + "\n", { mode: 0o600, encoding: "utf8" });
  try { chmodSync(p, 0o600); } catch { /* best-effort on non-POSIX */ }
  return p;
}

/**
 * Read-and-delete. Returns true if the marker was present (signal to
 * force status=cancelled). Any read/unlink error is swallowed — the
 * presence check has already happened, so an unlink loss is harmless
 * (the next run uses a different jobId). Caller contract: one worker
 * consumes a marker for a given job lifecycle; a second consumer seeing
 * false is a harmless no-op.
 */
export function consumeCancelMarker(workspaceRoot, jobId) {
  const p = cancelMarkerPath(workspaceRoot, jobId);
  if (!existsSync(p)) return false;
  try { unlinkSync(p); } catch { /* already gone */ }
  return true;
}
