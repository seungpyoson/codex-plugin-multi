import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import {
  binaryAvailable,
  formatCommandFailure,
  runCommand,
  runCommandChecked,
  terminateProcessTree,
} from "../../plugins/claude/scripts/lib/process.mjs";

test("runCommand: captures stdout, stderr, status, and command metadata", () => {
  const result = runCommand(process.execPath, [
    "-e",
    "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
  ]);

  assert.equal(result.command, process.execPath);
  assert.deepEqual(result.args.slice(0, 1), ["-e"]);
  assert.equal(result.status, 3);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.error, null);
});

test("runCommand: supports bounded spawnSync timeouts", () => {
  const result = runCommand(process.execPath, [
    "-e",
    "setTimeout(() => {}, 1000)",
  ], { timeout: 50 });

  assert.equal(result.status, null);
  assert.equal(result.error?.code, "ETIMEDOUT");
});

test("runCommandChecked: returns successful result and throws formatted failures", () => {
  const ok = runCommandChecked(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(ok.stdout, "ok");

  assert.throws(
    () => runCommandChecked(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(7)"]),
    /exit=7: bad/,
  );
  assert.throws(
    () => runCommandChecked("/definitely/missing/codex-plugin-test-binary"),
    /ENOENT/,
  );
});

test("binaryAvailable: reports available, missing, and non-zero binaries", () => {
  assert.deepEqual(binaryAvailable(process.execPath, ["--version"]).available, true);
  assert.deepEqual(binaryAvailable("/definitely/missing/codex-plugin-test-binary").detail, "not found");

  const unavailable = binaryAvailable(process.execPath, [
    "-e",
    "process.stderr.write('nope'); process.exit(9)",
  ]);
  assert.deepEqual(unavailable, { available: false, detail: "nope" });

  const stdoutDetail = binaryAvailable(process.execPath, [
    "-e",
    "process.stdout.write('stdout detail'); process.exit(8)",
  ]);
  assert.deepEqual(stdoutDetail, { available: false, detail: "stdout detail" });

  const exitDetail = binaryAvailable(process.execPath, [
    "-e",
    "process.exit(6)",
  ]);
  assert.deepEqual(exitDetail, { available: false, detail: "exit 6" });

  const stderrOk = binaryAvailable(process.execPath, [
    "-e",
    "process.stderr.write('version on stderr')",
  ]);
  assert.deepEqual(stderrOk, { available: true, detail: "version on stderr" });
});

test("terminateProcessTree: rejects non-finite pids without signaling", () => {
  assert.deepEqual(terminateProcessTree(NaN), {
    attempted: false,
    delivered: false,
    method: null,
  });
});

test("terminateProcessTree: POSIX process-group success and fallbacks", () => {
  const calls = [];
  const groupResult = terminateProcessTree(42, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
    },
  });
  assert.deepEqual(groupResult, { attempted: true, delivered: true, method: "process-group" });
  assert.deepEqual(calls, [[-42, "SIGTERM"]]);

  const fallbackCalls = [];
  const fallbackResult = terminateProcessTree(43, {
    platform: "darwin",
    killImpl(pid, signal) {
      fallbackCalls.push([pid, signal]);
      if (pid === -43) {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      }
    },
  });
  assert.deepEqual(fallbackResult, { attempted: true, delivered: true, method: "process" });
  assert.deepEqual(fallbackCalls, [[-43, "SIGTERM"], [43, "SIGTERM"]]);

  const goneResult = terminateProcessTree(44, {
    platform: "linux",
    killImpl() {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    },
  });
  assert.deepEqual(goneResult, { attempted: true, delivered: false, method: "process-group" });
});

test("terminateProcessTree: Windows taskkill success, missing process, and ENOENT fallback", () => {
  const success = terminateProcessTree(50, {
    platform: "win32",
    runCommandImpl(command, args) {
      return { command, args, status: 0, stdout: "", stderr: "", error: null };
    },
  });
  assert.equal(success.method, "taskkill");
  assert.equal(success.delivered, true);

  const missing = terminateProcessTree(51, {
    platform: "win32",
    runCommandImpl(command, args) {
      return { command, args, status: 128, stdout: "no running instance", stderr: "", error: null };
    },
  });
  assert.equal(missing.method, "taskkill");
  assert.equal(missing.delivered, false);

  const fallback = terminateProcessTree(52, {
    platform: "win32",
    runCommandImpl(command, args) {
      const error = new Error("missing taskkill");
      error.code = "ENOENT";
      return { command, args, status: 1, stdout: "", stderr: "", error };
    },
    killImpl(pid) {
      assert.equal(pid, 52);
    },
  });
  assert.deepEqual(fallback, { attempted: true, delivered: true, method: "kill" });
});

test("terminateProcessTree: Windows and POSIX error branches stay explicit", () => {
  assert.throws(
    () => terminateProcessTree(60, {
      platform: "win32",
      runCommandImpl(command, args) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        return { command, args, status: 1, stdout: "", stderr: "", error };
      },
    }),
    /permission denied/,
  );

  assert.throws(
    () => terminateProcessTree(61, {
      platform: "win32",
      runCommandImpl(command, args) {
        return { command, args, status: 5, stdout: "", stderr: "hard failure", error: null };
      },
    }),
    /taskkill .*exit=5: hard failure/,
  );

  const fallbackGone = terminateProcessTree(62, {
    platform: "darwin",
    killImpl(pid) {
      const error = new Error(pid < 0 ? "group denied" : "gone");
      error.code = pid < 0 ? "EPERM" : "ESRCH";
      throw error;
    },
  });
  assert.deepEqual(fallbackGone, { attempted: true, delivered: false, method: "process" });

  const windowsFallbackGone = terminateProcessTree(63, {
    platform: "win32",
    runCommandImpl(command, args) {
      const error = new Error("missing taskkill");
      error.code = "ENOENT";
      return { command, args, status: 1, stdout: "", stderr: "", error };
    },
    killImpl() {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    },
  });
  assert.deepEqual(windowsFallbackGone, { attempted: true, delivered: false, method: "kill" });

  assert.throws(
    () => terminateProcessTree(64, {
      platform: "win32",
      runCommandImpl(command, args) {
        const error = new Error("missing taskkill");
        error.code = "ENOENT";
        return { command, args, status: 1, stdout: "", stderr: "", error };
      },
      killImpl() {
        const error = new Error("kill denied");
        error.code = "EPERM";
        throw error;
      },
    }),
    /kill denied/,
  );

  assert.throws(
    () => terminateProcessTree(65, {
      platform: "linux",
      killImpl(pid) {
        const error = new Error(pid < 0 ? "group denied" : "process denied");
        error.code = "EPERM";
        throw error;
      },
    }),
    /process denied/,
  );
});

test("formatCommandFailure: includes signal, stderr, or stdout detail", () => {
  assert.equal(
    formatCommandFailure({ command: "cmd", args: ["a"], signal: "SIGTERM", status: null, stderr: "", stdout: "" }),
    "cmd a: signal=SIGTERM",
  );
  assert.equal(
    formatCommandFailure({ command: "cmd", args: [], signal: null, status: 2, stderr: "", stdout: "details" }),
    "cmd: exit=2: details",
  );
});
