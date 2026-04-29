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
import { spawnSync } from "node:child_process";
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
 * - Throws `process_gone` ONLY when the platform proof says the pid is
 *   genuinely gone (BSD ps exit 1 with empty stderr; /proc/<pid>/stat
 *   missing). Throws `capture_error` for every other failure mode —
 *   `ps` not findable, `ps` denied by sandbox, `/proc` EACCES, hostile
 *   stub. Issue #22 sub-task 3: the previous "every error is process_gone"
 *   wrapper would falsely promote a LIVE worker to stale whenever the
 *   companion ran inside a sandbox or with a stripped PATH.
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
  // Class 3 — /proc precondition (Finding B from reviewer round 2).
  // In a hardened container or sandbox where /proc is unmounted, EVERY
  // existsSync('/proc/<pid>/stat') returns false. Treating that as
  // process_gone would falsely reclassify LIVE pids as already_dead. The
  // honest signal is "we can't see the process table" — capture_error,
  // which cmdCancel maps to unverifiable + exit 2 (refused for safety).
  if (!existsSync("/proc")) {
    throw new Error(`capture_error: /proc not available on linux (sandbox or unmounted)`);
  }
  const statPath = `/proc/${pid}/stat`;
  const cmdlinePath = `/proc/${pid}/cmdline`;
  // Genuine "no such pid" signal on Linux: /proc/<pid>/stat doesn't exist.
  if (!existsSync(statPath)) {
    throw new Error(`process_gone: no /proc/${pid}/stat`);
  }
  let statRaw;
  let cmdlineRaw;
  try {
    statRaw = readFileSync(statPath, "utf8");
    cmdlineRaw = existsSync(cmdlinePath) ? readFileSync(cmdlinePath, "utf8") : "";
  } catch (e) {
    // Issue #22 sub-task 3: distinguish "pid died between existsSync and
    // readFileSync" (ENOENT — race, treat as process_gone) from "I am not
    // permitted to read this" (EACCES from hidepid/sandbox — capture_error).
    if (e?.code === "ENOENT") throw new Error(`process_gone: ${e.message}`);
    throw new Error(`capture_error: ${e.message}`);
  }
  // /proc/<pid>/stat format: `pid (comm) state ppid ... starttime(field 22)...`
  // `comm` may contain spaces and parens — use the LAST `)` to split.
  const close = statRaw.lastIndexOf(")");
  if (close < 0) throw new Error(`capture_error: malformed /proc/${pid}/stat`);
  const fieldsAfterComm = statRaw.slice(close + 2).trim().split(/\s+/);
  // After (comm), field 3 is state → index 0 in fieldsAfterComm; starttime
  // is stat field 22, which is index 22-3 = 19 in fieldsAfterComm.
  const starttime = fieldsAfterComm[19] ?? null;
  if (!starttime) {
    throw new Error(`capture_error: no starttime in /proc/${pid}/stat`);
  }
  // cmdline is NUL-delimited argv. argv0 is up to the first NUL.
  const argv0 = (cmdlineRaw.split("\0")[0] || "").trim();
  if (!argv0) {
    // Some kernel threads / zombies have empty cmdline — fall back to comm
    // (field 2 of stat, between the first `(` and last `)`).
    const commStart = statRaw.indexOf("(");
    const comm = commStart >= 0 ? statRaw.slice(commStart + 1, close) : "";
    if (!comm) throw new Error(`capture_error: no argv0/comm for pid ${pid}`);
    return { pid, starttime: String(starttime), argv0: comm };
  }
  return { pid, starttime: String(starttime), argv0 };
}

function captureDarwin(pid) {
  // Class 3 — pin /bin/ps absolute. PATH-resolved "ps" let a stripped or
  // shimmed PATH break ownership capture (silent stub on PATH could exit
  // 1 with empty everything, mimicking real "no such pid" and
  // mis-classifying LIVE pids as process_gone). /bin/ps is part of the
  // macOS base install and stable; if it's missing or denied, spawnSync
  // sets result.error → capture_error, which is the safe answer.
  // spawnSync (not execFileSync) so we can distinguish failure modes by
  // result.status / result.error / result.stderr.
  const result = spawnSync("/bin/ps", ["-o", "lstart=,comm=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    // spawn itself failed — `ps` not findable, EACCES on exec, sandbox
    // denied execve. The pid may well be alive; we just couldn't ask.
    throw new Error(`capture_error: ${result.error.message}`);
  }
  const stdout = result.stdout ?? "";
  const stderr = (result.stderr ?? "").trim();
  if (result.status !== 0) {
    // BSD `ps -p <missing_pid>` exits 1 with BOTH stdout and stderr empty.
    // Anything else (sandbox-denied stderr, hostile stub) is capture_error.
    if (stderr === "" && stdout.trim() === "") {
      throw new Error(`process_gone: ps exit ${result.status} for pid ${pid}`);
    }
    throw new Error(`capture_error: ps exit ${result.status}: ${stderr || stdout.trim().slice(0, 120)}`);
  }
  const line = stdout.trim();
  if (!line) {
    // ps exited 0 but printed nothing — hostile stub. NOT proof of death.
    throw new Error(`capture_error: ps returned no output for pid ${pid}`);
  }
  // lstart is a 5-token date (`Thu Apr 24 12:34:56 2026`); comm is the rest.
  const tokens = line.split(/\s+/);
  if (tokens.length < 6) {
    throw new Error(`capture_error: ps output too short: ${line}`);
  }
  const starttime = tokens.slice(0, 5).join(" ");
  const argv0 = tokens.slice(5).join(" ");
  if (!starttime || !argv0) {
    throw new Error(`capture_error: ps missing fields: ${line}`);
  }
  return { pid, starttime, argv0 };
}

/**
 * Attach pid_info capture to a freshly-spawned child. Defers reading
 * /proc/<pid>/cmdline (Linux) or `ps -o comm=` (Darwin) until the child's
 * 'spawn' event — Node's canonical post-execve signal. Reading earlier
 * returns the parent's argv, which then mismatches verifyPidInfo at
 * cancel time as `argv0_mismatch` (issue #25).
 *
 * Returns a `() => pidInfo | null` getter. The captured info becomes
 * available once the child has execve'd; if the child fails before
 * 'spawn' (e.g., ENOENT), the getter stays null and the caller's
 * existing 'error' handler remains authoritative.
 */
export function attachPidCapture(child, onSpawn) {
  let pidInfo = null;
  child.once("spawn", () => {
    try {
      pidInfo = capturePidInfo(child.pid);
    } catch (e) {
      pidInfo = { pid: child.pid, starttime: null, argv0: null, capture_error: e.message };
    }
    if (typeof onSpawn === "function" && Number.isInteger(child.pid)) {
      try { onSpawn(pidInfo); } catch { /* status handoff is best-effort */ }
    }
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
