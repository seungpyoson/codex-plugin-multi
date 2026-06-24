// Identity types (spec §21.1).
//
// Every durable record names FOUR identities, separately:
//
//   job_id            — companion-minted UUID per `run`/`continue` invocation.
//   target_session_id — read from target stdout (`parsed.session_id`); the
//                       value the target actually ran under. Never minted here.
//   resume_chain[]    — newest-last list of prior target session IDs across
//                       a `continue` chain.
//   pid_info          — {pid, starttime, argv0} captured from /proc or ps at
//                       spawn time. Used for PID-reuse-safe cancel signaling.
//
// Forbidden by the spec: using `randomUUID()` for anything other than job_id;
// using `pid` alone as a signal target; aliasing job_id and session_id.

import { randomUUID } from "node:crypto";
import { capturePidInfo } from "./process-identity.mjs";

export { capturePidInfo } from "./process-identity.mjs";

/** Mint a new job_id. Only function in the code that `randomUUID`s for a
 *  durable record field — any other `randomUUID()` should be audited. */
export function newJobId() {
  return randomUUID();
}

/**
 * Attach pid_info capture to a freshly-spawned child. Defers reading
 * /proc/<pid>/cmdline (Linux) or `ps -o comm=` (Darwin) until just after the
 * child's 'spawn' event. The small delay matters for shebang targets such as
 * `#!/usr/bin/env node`: the PID can briefly report `env` before that wrapper
 * execs the real target, which would later mismatch as `argv0_mismatch`.
 *
 * Returns a `() => pidInfo | null` getter. The captured info becomes
 * available once the child has execve'd; if the child fails before
 * 'spawn' (e.g., ENOENT), the getter stays null and the caller's
 * existing 'error' handler remains authoritative.
 */
export function attachPidCapture(child, onSpawn) {
  let pidInfo = null;
  let callbackFired = false;
  let spawnSeen = false;
  let captureTimer = null;
  const captureNow = () => {
    if (pidInfo || !Number.isInteger(child.pid)) return pidInfo;
    try {
      pidInfo = capturePidInfo(child.pid);
    } catch (e) {
      pidInfo = { pid: child.pid, starttime: null, argv0: null, capture_error: e.message };
    }
    return pidInfo;
  };
  const fireCallback = () => {
    if (callbackFired || !Number.isInteger(child.pid)) return;
    callbackFired = true;
    captureNow();
    if (typeof onSpawn === "function") {
      try { onSpawn(pidInfo); } catch { /* status handoff is best-effort */ }
    }
  };
  child.once("spawn", () => {
    spawnSeen = true;
    captureTimer = setTimeout(fireCallback, 50);
  });
  child.once("close", () => {
    if (captureTimer) {
      clearTimeout(captureTimer);
      captureTimer = null;
    }
    if (spawnSeen) fireCallback();
  });
  return () => pidInfo;
}

/**
 * Re-capture pidInfo for saved.pid and compare.
 *
 * Returns `{match: true}` on exact match of both starttime and argv0.
 * Returns `{match: false, reason}` where `reason` is one of:
 *   - "process_gone"     — no live process at that pid.
 *   - "starttime_mismatch" — pid reused by a different process.
 *   - "argv0_mismatch"   — same starttime but different binary (edge case).
 *
 * Never throws. Callers treat `match=false` as "do not signal this pid".
 */
export function verifyPidInfo(saved) {
  if (!saved || typeof saved !== "object" || !Number.isInteger(saved.pid)) {
    return { match: false, reason: "invalid_saved" };
  }
  let current;
  try {
    current = capturePidInfo(saved.pid);
  } catch (e) {
    const msg = String(e.message ?? e);
    if (msg.includes("process_gone")) return { match: false, reason: "process_gone" };
    if (msg.includes("invalid_pid")) return { match: false, reason: "invalid_pid" };
    return { match: false, reason: "capture_error" };
  }
  if (current.starttime !== saved.starttime) {
    return { match: false, reason: "starttime_mismatch" };
  }
  if (current.argv0 !== saved.argv0) {
    return { match: false, reason: "argv0_mismatch" };
  }
  return { match: true };
}
