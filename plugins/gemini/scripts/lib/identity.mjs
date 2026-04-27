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
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

/** Mint a new job_id. Only function in the code that `randomUUID`s for a
 *  durable record field — any other `randomUUID()` should be audited. */
export function newJobId() {
  return randomUUID();
}

/**
 * Capture {pid, starttime, argv0} for the given pid.
 *
 * - Validates pid is a positive integer. Throws `invalid_pid` otherwise.
 * - Darwin: `ps -o lstart=,comm= -p <pid>`. lstart is stable across `ps`
 *   invocations for a given process; it changes only if the pid is a
 *   different process (PID reuse).
 * - Linux: reads `/proc/<pid>/stat` field 22 (starttime in jiffies) and
 *   `/proc/<pid>/cmdline` (NUL-separated argv; argv0 is the first segment).
 * - Throws `process_gone` if the pid has no live process.
 *
 * Design note on BSD/Linux parity: starttime + argv0 together close the
 * PID-reuse window. starttime alone can theoretically collide for two
 * processes scheduled in the same jiffy, but argv0 diverges. Both must match.
 */
export function capturePidInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid_pid: ${JSON.stringify(pid)}`);
  }
  if (process.platform === "linux") {
    return captureLinux(pid);
  }
  if (process.platform === "darwin") {
    return captureDarwin(pid);
  }
  // Other platforms (win32, freebsd, ...) unsupported at this milestone.
  // Target companions are used on macOS/Linux in practice; error explicitly so
  // a silent-pass policy never disguises a platform regression.
  throw new Error(
    `process_gone: platform ${process.platform} not supported by capturePidInfo`
  );
}

function captureLinux(pid) {
  const statPath = `/proc/${pid}/stat`;
  const cmdlinePath = `/proc/${pid}/cmdline`;
  if (!existsSync(statPath)) {
    throw new Error(`process_gone: no /proc/${pid}/stat`);
  }
  let statRaw;
  let cmdlineRaw;
  try {
    statRaw = readFileSync(statPath, "utf8");
    cmdlineRaw = existsSync(cmdlinePath) ? readFileSync(cmdlinePath, "utf8") : "";
  } catch (e) {
    throw new Error(`process_gone: ${e.message}`);
  }
  // /proc/<pid>/stat format: `pid (comm) state ppid ... starttime(field 22)...`
  // `comm` may contain spaces and parens — use the LAST `)` to split.
  const close = statRaw.lastIndexOf(")");
  if (close < 0) throw new Error(`process_gone: malformed /proc/${pid}/stat`);
  const fieldsAfterComm = statRaw.slice(close + 2).trim().split(/\s+/);
  // After (comm), field 3 is state → index 0 in fieldsAfterComm; starttime
  // is stat field 22, which is index 22-3 = 19 in fieldsAfterComm.
  const starttime = fieldsAfterComm[19] ?? null;
  if (!starttime) {
    throw new Error(`process_gone: no starttime in /proc/${pid}/stat`);
  }
  // cmdline is NUL-delimited argv. argv0 is up to the first NUL.
  const argv0 = (cmdlineRaw.split("\0")[0] || "").trim();
  if (!argv0) {
    // Some kernel threads / zombies have empty cmdline — fall back to comm
    // (field 2 of stat, between the first `(` and last `)`).
    const commStart = statRaw.indexOf("(");
    const comm = commStart >= 0 ? statRaw.slice(commStart + 1, close) : "";
    if (!comm) throw new Error(`process_gone: no argv0/comm for pid ${pid}`);
    return { pid, starttime: String(starttime), argv0: comm };
  }
  return { pid, starttime: String(starttime), argv0 };
}

function captureDarwin(pid) {
  let out;
  try {
    out = execFileSync("ps", ["-o", "lstart=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // ps exits non-zero when pid doesn't exist.
    throw new Error(`process_gone: ${e.message}`);
  }
  const line = out.trim();
  if (!line) {
    throw new Error(`process_gone: ps returned no output for pid ${pid}`);
  }
  // lstart is a 5-token date (`Thu Apr 24 12:34:56 2026`); comm is the rest.
  const tokens = line.split(/\s+/);
  if (tokens.length < 6) {
    throw new Error(`process_gone: ps output too short: ${line}`);
  }
  const starttime = tokens.slice(0, 5).join(" ");
  const argv0 = tokens.slice(5).join(" ");
  if (!starttime || !argv0) {
    throw new Error(`process_gone: ps missing fields: ${line}`);
  }
  return { pid, starttime, argv0 };
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

/**
 * Append a prior target session ID to `record.resume_chain`, newest-last.
 * Non-mutating: returns a new record; the input is untouched.
 */
export function appendResumeLink(record, priorClaudeSessionId) {
  const prior = Array.isArray(record?.resume_chain) ? record.resume_chain : [];
  return { ...record, resume_chain: [...prior, priorClaudeSessionId] };
}
