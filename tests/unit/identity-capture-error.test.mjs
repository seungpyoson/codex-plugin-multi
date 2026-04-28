// PR #21 review #3 — captureDarwin / captureLinux must distinguish
// "process is genuinely gone" from "I couldn't determine".
//
// The original implementation wrapped EVERY ps/proc failure as
// `process_gone`, including:
//   - PATH stripped (ENOENT spawning ps)
//   - sandboxed ps (EACCES on exec)
//   - hostile ps stub returning exit 1 with "operation not permitted"
//   - hostile ps stub returning exit 0 with empty stdout
//   - /proc EACCES (hidepid, sandbox)
//
// All four of those produce the same message as a real "no such pid", so
// reconcileActiveJobs would falsely promote a LIVE worker to stale, and
// cmdCancel would return already_dead instead of signaling.
//
// The fix: only ps-exit-1-with-empty-stderr (and /proc ENOENT for the stat
// path) are genuine `process_gone`. Everything else is `capture_error`.
// verifyPidInfo already maps capture_error to a distinct reason; reconcile
// already treats capture_error as "no evidence to reclaim".

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { capturePidInfo, verifyPidInfo } from "../../plugins/claude/scripts/lib/identity.mjs";

// We need a long-lived child whose pid we can probe under various hostile
// environments. Spawn `sleep 60` and tear it down at end-of-suite.
let LIVE_PID;
let LIVE_CHILD;
test("setup — spawn a live child to probe", async () => {
  LIVE_CHILD = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  await new Promise((res) => LIVE_CHILD.once("spawn", res));
  LIVE_PID = LIVE_CHILD.pid;
  assert.ok(Number.isInteger(LIVE_PID), "live child must have a pid");
});

// On Darwin, capturePidInfo invokes ps internally with the parent process's
// PATH/env. To exercise the "ps unavailable" branches, we need to invoke
// capturePidInfo from a CHILD process whose env is hostile, then read back
// the result. This test runs inside the same process — it's a sanity check
// that the live-pid happy path returns a record (regression guard for the
// "every error is process_gone" wrapper).
test("capturePidInfo: live pid in normal env returns {pid, starttime, argv0}", () => {
  const info = capturePidInfo(LIVE_PID);
  assert.equal(info.pid, LIVE_PID);
  assert.ok(info.starttime, "starttime present");
  assert.ok(info.argv0, "argv0 present");
});

// Run capturePidInfo inside a child whose PATH excludes ps. The child reports
// the throw message back via stdout — we assert it does NOT start with
// process_gone (the live pid is alive; the failure is "ps not findable").
function runCaptureInHostileEnv(envOverrides) {
  const probe = `
    import { capturePidInfo } from "${process.cwd()}/plugins/claude/scripts/lib/identity.mjs";
    try {
      const info = capturePidInfo(${LIVE_PID});
      process.stdout.write("OK:" + JSON.stringify(info));
    } catch (e) {
      process.stdout.write("THREW:" + e.message);
    }
  `;
  const probeDir = mkdtempSync(path.join(tmpdir(), "probe-"));
  const probePath = path.join(probeDir, "probe.mjs");
  writeFileSync(probePath, probe, "utf8");
  try {
    const res = spawnSync(process.execPath, [probePath], {
      encoding: "utf8",
      env: { ...envOverrides },     // ABSOLUTELY no inherited env
    });
    return { stdout: res.stdout, stderr: res.stderr, status: res.status };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

test("captureDarwin: PATH points at empty dir → THROW capture_error (NOT process_gone) for live pid", { skip: process.platform !== "darwin" }, () => {
  // macOS spawn falls back to a system PATH when env has no PATH at all.
  // Force the failure by pointing PATH at a real but empty directory so
  // `ps` is genuinely not findable.
  const emptyDir = mkdtempSync(path.join(tmpdir(), "empty-path-"));
  try {
    const r = runCaptureInHostileEnv({ PATH: emptyDir });
    assert.match(r.stdout, /^THREW:/, `expected throw, got: ${r.stdout}`);
    assert.match(r.stdout, /capture_error/, `must be capture_error, not process_gone — got: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /^THREW:process_gone/,
      "must NOT report process_gone — the pid is alive, ps just couldn't run");
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("captureDarwin: hostile ps stub (exit 1 + 'permission denied') → capture_error", { skip: process.platform !== "darwin" }, () => {
  const stubDir = mkdtempSync(path.join(tmpdir(), "ps-stub-"));
  const stub = path.join(stubDir, "ps");
  writeFileSync(stub, "#!/bin/sh\necho 'ps: operation not permitted' >&2\nexit 1\n", "utf8");
  chmodSync(stub, 0o755);
  try {
    const r = runCaptureInHostileEnv({ PATH: stubDir });
    assert.match(r.stdout, /^THREW:/, `expected throw, got: ${r.stdout}`);
    assert.match(r.stdout, /capture_error/,
      `non-empty stderr from ps must be capture_error, not process_gone — got: ${r.stdout}`);
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test("captureDarwin: hostile ps stub (exit 0 + empty stdout) → capture_error", { skip: process.platform !== "darwin" }, () => {
  const stubDir = mkdtempSync(path.join(tmpdir(), "ps-stub-"));
  const stub = path.join(stubDir, "ps");
  writeFileSync(stub, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(stub, 0o755);
  try {
    const r = runCaptureInHostileEnv({ PATH: stubDir });
    assert.match(r.stdout, /^THREW:/, `expected throw, got: ${r.stdout}`);
    assert.match(r.stdout, /capture_error/,
      `empty-stdout from ps must be capture_error, not process_gone — got: ${r.stdout}`);
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test("captureDarwin: ps stub mimicking real 'no such pid' (exit 1 + empty stderr) → process_gone", { skip: process.platform !== "darwin" }, () => {
  const stubDir = mkdtempSync(path.join(tmpdir(), "ps-stub-"));
  const stub = path.join(stubDir, "ps");
  // BSD ps's actual no-such-process behavior: exit 1 with empty stdout AND empty stderr.
  writeFileSync(stub, "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(stub, 0o755);
  try {
    const r = runCaptureInHostileEnv({ PATH: stubDir });
    assert.match(r.stdout, /^THREW:/, `expected throw, got: ${r.stdout}`);
    assert.match(r.stdout, /process_gone/,
      `silent exit-1 IS the genuine 'no such pid' signal — got: ${r.stdout}`);
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test("verifyPidInfo: capture_error reason maps through correctly", { skip: process.platform !== "darwin" }, () => {
  // Run verifyPidInfo from a child with PATH pointing at an empty dir so
  // capturePidInfo can't find ps. Result must be {match:false,
  // reason:"capture_error"} — NOT process_gone (the pid is alive; we just
  // couldn't ask ps).
  const probe = `
    import { verifyPidInfo } from "${process.cwd()}/plugins/claude/scripts/lib/identity.mjs";
    const r = verifyPidInfo({ pid: ${LIVE_PID}, starttime: "x", argv0: "sleep" });
    process.stdout.write(JSON.stringify(r));
  `;
  const probeDir = mkdtempSync(path.join(tmpdir(), "vprobe-"));
  const emptyDir = mkdtempSync(path.join(tmpdir(), "empty-path-v-"));
  const probePath = path.join(probeDir, "vprobe.mjs");
  writeFileSync(probePath, probe, "utf8");
  try {
    const res = spawnSync(process.execPath, [probePath], {
      encoding: "utf8",
      env: { PATH: emptyDir },
    });
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.match, false);
    assert.equal(parsed.reason, "capture_error",
      `must propagate as capture_error, not process_gone — got: ${res.stdout}`);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("teardown — kill live child", () => {
  try { process.kill(LIVE_PID, "SIGTERM"); } catch {}
});
