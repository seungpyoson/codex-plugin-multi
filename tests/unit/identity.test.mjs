// Unit tests for lib/identity.mjs — the four identity types (§21.1).
//
// Locks down: job_id vs claude_session_id vs resume_chain vs pid_info stay
// distinct. `capturePidInfo` / `verifyPidInfo` form an ownership proof, not
// merely a liveness check. PID-reuse-safe by construction.

import { test } from "node:test";
import assert from "node:assert/strict";
import cp, { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

import {
  newJobId,
  capturePidInfo,
  verifyPidInfo,
  attachPidCapture,
} from "../../plugins/claude/scripts/lib/identity.mjs";
import * as GeminiIdentity from "../../plugins/gemini/scripts/lib/identity.mjs";

const UUID_V4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SKIP_PS_UNDER_COVERAGE = {
  skip: process.env.CODEX_PLUGIN_COVERAGE === "1" || process.platform === "darwin"
    ? "macOS sandboxing can deny ps; shimmed Darwin tests cover parser and ownership comparison"
    : false,
};
let attachPidCaptureSkipReason = false;
if (!["linux", "darwin"].includes(process.platform)) {
  attachPidCaptureSkipReason = `unsupported platform: ${process.platform}`;
} else if (!fs.existsSync("/bin/sleep")) {
  attachPidCaptureSkipReason = "/bin/sleep not available";
} else if (process.env.CODEX_PLUGIN_COVERAGE === "1" && process.platform === "darwin") {
  attachPidCaptureSkipReason = "macOS sandboxing can deny ps under coverage; covered by Linux CI run";
}
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value) {
  Object.defineProperty(process, "platform", {
    value,
    enumerable: ORIGINAL_PLATFORM_DESCRIPTOR?.enumerable ?? true,
    configurable: true,
  });
}

function restorePlatform() {
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
}

function withPlatformAndFs(platform, methods, fn) {
  const originals = {};
  for (const name of Object.keys(methods)) {
    originals[name] = fs[name];
    fs[name] = methods[name];
  }
  syncBuiltinESMExports();
  setPlatform(platform);
  try {
    return fn();
  } finally {
    restorePlatform();
    for (const [name, value] of Object.entries(originals)) {
      fs[name] = value;
    }
    syncBuiltinESMExports();
  }
}

// Monkey-patch child_process methods (e.g. spawnSync) for the duration of fn.
// Required because Class 3b pins /bin/ps absolute, which makes PATH-shim
// based ps mocking ineffective. syncBuiltinESMExports propagates the
// mutation to identity.mjs's destructured `spawnSync` import.
function withPlatformAndChild(platform, methods, fn) {
  const originals = {};
  for (const name of Object.keys(methods)) {
    originals[name] = cp[name];
    cp[name] = methods[name];
  }
  syncBuiltinESMExports();
  setPlatform(platform);
  try {
    return fn();
  } finally {
    restorePlatform();
    for (const [name, value] of Object.entries(originals)) {
      cp[name] = value;
    }
    syncBuiltinESMExports();
  }
}

function assertLinuxIdentityBranches(identity) {
  const afterComm = ["S", ...Array.from({ length: 18 }, (_, i) => String(i + 1)), "98765", "tail"];
  const stat = `123 (node worker) ${afterComm.join(" ")}`;

  withPlatformAndFs("linux", {
    existsSync: (file) => file === "/proc" || file === "/proc/123/stat" || file === "/proc/123/cmdline",
    readFileSync: (file) => {
      if (file === "/proc/123/stat") return stat;
      if (file === "/proc/123/cmdline") return "/usr/bin/node\0--worker";
      throw new Error(`unexpected file ${file}`);
    },
  }, () => {
    assert.deepEqual(identity.capturePidInfo(123), {
      pid: 123,
      starttime: "98765",
      argv0: "/usr/bin/node",
    });
  });

  withPlatformAndFs("linux", {
    existsSync: (file) => file === "/proc" || file === "/proc/124/stat",
    readFileSync: (file) => {
      if (file === "/proc/124/stat") return stat.replace("123", "124");
      throw new Error(`unexpected file ${file}`);
    },
  }, () => {
    assert.deepEqual(identity.capturePidInfo(124), {
      pid: 124,
      starttime: "98765",
      argv0: "node worker",
    });
  });

  // /proc mounted but per-pid stat missing → process_gone (existing
  // semantics; the genuine "no such pid" signal on Linux).
  withPlatformAndFs("linux", {
    existsSync: (file) => file === "/proc",
    readFileSync: () => {
      throw new Error("should not read missing proc files");
    },
  }, () => {
    assert.throws(() => identity.capturePidInfo(125), /process_gone: no \/proc\/125\/stat/);
    assert.deepEqual(identity.verifyPidInfo({
      pid: 125,
      starttime: "x",
      argv0: "x",
    }), { match: false, reason: "process_gone" });
  });

  // Class 3 — /proc unmounted (containerized environment) → capture_error,
  // NOT process_gone. Without this precondition, every existsSync of a
  // per-pid stat returns false, falsely classifying LIVE pids as
  // process_gone, which cmdCancel would then turn into already_dead exit 0.
  withPlatformAndFs("linux", {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error("should not read when /proc is unmounted");
    },
  }, () => {
    assert.throws(
      () => identity.capturePidInfo(125),
      /capture_error: \/proc not available on linux/,
    );
    assert.deepEqual(
      identity.verifyPidInfo({ pid: 125, starttime: "x", argv0: "x" }),
      { match: false, reason: "capture_error" },
    );
  });

  // PR #21 review #3: malformed /proc output is a PARSE failure, not proof
  // of death. Distinguish via capture_error so reconcile/cmdCancel don't
  // act on it as if the pid were gone.
  withPlatformAndFs("linux", {
    existsSync: () => true,
    readFileSync: () => "malformed",
  }, () => {
    assert.throws(() => identity.capturePidInfo(126), /capture_error: malformed/);
  });

  withPlatformAndFs("linux", {
    existsSync: () => true,
    readFileSync: (file) => {
      if (file.endsWith("/stat")) return "127 (node) S 1 2";
      return "";
    },
  }, () => {
    assert.throws(() => identity.capturePidInfo(127), /capture_error: no starttime/);
  });

  withPlatformAndFs("linux", {
    existsSync: () => true,
    readFileSync: (file) => {
      if (file.endsWith("/stat")) return `) ${afterComm.join(" ")}`;
      return "";
    },
  }, () => {
    assert.throws(() => identity.capturePidInfo(127), /capture_error: no argv0\/comm/);
  });

  // PR #21 review #3: EACCES on /proc/<pid>/stat is the sandbox / hidepid
  // signal — the pid is likely alive; we just can't read its metadata.
  // capture_error keeps reconcile/cmdCancel from treating this as death.
  withPlatformAndFs("linux", {
    existsSync: () => true,
    readFileSync: () => {
      const e = new Error("permission denied");
      e.code = "EACCES";
      throw e;
    },
  }, () => {
    assert.throws(() => identity.capturePidInfo(128), /capture_error: permission denied/);
  });

  // The race case: existsSync returned true, then readFileSync threw ENOENT
  // (pid died between the two syscalls). This IS proof of death.
  withPlatformAndFs("linux", {
    existsSync: () => true,
    readFileSync: () => {
      const e = new Error("ENOENT: race");
      e.code = "ENOENT";
      throw e;
    },
  }, () => {
    assert.throws(() => identity.capturePidInfo(128), /process_gone: ENOENT/);
  });

  withPlatformAndFs("win32", {}, () => {
    assert.throws(() => identity.capturePidInfo(129), /platform win32 not supported/);
  });

  withPlatformAndFs("linux", {
    existsSync: () => {
      throw new Error("stat probe crashed");
    },
  }, () => {
    assert.deepEqual(identity.verifyPidInfo({
      pid: 130,
      starttime: "x",
      argv0: "x",
    }), { match: false, reason: "capture_error" });
  });

  assert.deepEqual(identity.verifyPidInfo(null), { match: false, reason: "invalid_saved" });
  assert.deepEqual(identity.verifyPidInfo({ pid: 0 }), { match: false, reason: "invalid_pid" });
}

test("newJobId: returns a UUID v4", () => {
  const id = newJobId();
  assert.match(id, UUID_V4);
});

test("newJobId: two calls return distinct values", () => {
  const a = newJobId();
  const b = newJobId();
  assert.notEqual(a, b);
});

test("capturePidInfo: current process returns {pid, starttime, argv0}", SKIP_PS_UNDER_COVERAGE, () => {
  const info = capturePidInfo(process.pid);
  assert.equal(info.pid, process.pid);
  assert.equal(typeof info.starttime, "string");
  assert.ok(info.starttime.length > 0, "starttime non-empty");
  assert.equal(typeof info.argv0, "string");
  assert.ok(info.argv0.length > 0, "argv0 non-empty");
});

test("capturePidInfo: invalid pid (0) throws invalid_pid", () => {
  assert.throws(() => capturePidInfo(0), /invalid_pid/);
});

test("capturePidInfo: invalid pid (-1) throws invalid_pid", () => {
  assert.throws(() => capturePidInfo(-1), /invalid_pid/);
});

test("capturePidInfo: non-existent pid throws process_gone", SKIP_PS_UNDER_COVERAGE, () => {
  // Find an in-range pid that is genuinely not allocated. BSD ps's
  // PID_MAX rejects very large pids with stderr ("process id too large")
  // which classifies as capture_error (not death). Search the
  // 50000–99000 range for a process that doesn't exist — that exercises
  // the genuine "ps exit 1 with empty stderr" → process_gone path.
  let missingPid = null;
  for (let p = 50000; p < 99000; p += 1) {
    try { process.kill(p, 0); }
    catch (e) { if (e?.code === "ESRCH") { missingPid = p; break; } }
  }
  assert.ok(missingPid, "must find an in-range unallocated pid for the test");
  assert.throws(() => capturePidInfo(missingPid), /process_gone/);
});

test("verifyPidInfo: self-compare returns {match: true}", SKIP_PS_UNDER_COVERAGE, () => {
  const saved = capturePidInfo(process.pid);
  const check = verifyPidInfo(saved);
  assert.equal(check.match, true);
});

test("verifyPidInfo: starttime mismatch returns match:false starttime_mismatch", SKIP_PS_UNDER_COVERAGE, () => {
  const saved = capturePidInfo(process.pid);
  const tampered = { ...saved, starttime: "Fri Jan  1 00:00:00 1970" };
  const check = verifyPidInfo(tampered);
  assert.equal(check.match, false);
  assert.equal(check.reason, "starttime_mismatch");
});

test("verifyPidInfo: argv0 mismatch returns match:false argv0_mismatch", SKIP_PS_UNDER_COVERAGE, () => {
  const saved = capturePidInfo(process.pid);
  const tampered = { ...saved, argv0: "definitely-not-node" };
  const check = verifyPidInfo(tampered);
  assert.equal(check.match, false);
  assert.equal(check.reason, "argv0_mismatch");
});

test("verifyPidInfo: vanished process returns match:false process_gone (no throw)", SKIP_PS_UNDER_COVERAGE, () => {
  // Spawn a trivial child, let it exit, then verify.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    let saved;
    try {
      saved = capturePidInfo(child.pid);
    } catch (e) {
      // Child exited before we could capture — simulate instead.
      saved = { pid: 2147483646, starttime: "x", argv0: "x" };
    }
    child.on("close", () => {
      // Wait a tick so kernel reaps.
      setTimeout(() => {
        try {
          const check = verifyPidInfo(saved);
          assert.equal(check.match, false);
          // Either process_gone (normal case) or starttime_mismatch (PID reuse
          // very rare but theoretically possible in the brief window). Either
          // way, verifyPidInfo must NOT throw.
          assert.ok(
            check.reason === "process_gone" ||
              check.reason === "starttime_mismatch" ||
              check.reason === "argv0_mismatch",
            `unexpected reason: ${check.reason}`
          );
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 50);
    });
    child.on("error", reject);
  });
});

// Class 3b: capturePidInfo pins /bin/ps absolute, so PATH-shim mocks no
// longer work. Mock spawnSync directly via withPlatformAndChild and assert
// the parser handles its output. Also asserts the binary path used is
// /bin/ps — the regression test for the pinned-absolute fix.
test("capturePidInfo: Darwin ps output can be parsed through a spawnSync mock", () => {
  let observedBinary = null;
  let observedArgs = null;
  withPlatformAndChild("darwin", {
    spawnSync: (binary, args) => {
      observedBinary = binary;
      observedArgs = args;
      return {
        status: 0,
        stdout: "Thu Apr 24 12:34:56 2026 /bin/fake-node\n",
        stderr: "",
      };
    },
  }, () => {
    assert.deepEqual(capturePidInfo(12345), {
      pid: 12345,
      starttime: "Thu Apr 24 12:34:56 2026",
      argv0: "/bin/fake-node",
    });
    assert.deepEqual(verifyPidInfo({
      pid: 12345,
      starttime: "Thu Apr 24 12:34:56 2026",
      argv0: "/bin/fake-node",
    }), { match: true });
    assert.deepEqual(verifyPidInfo({
      pid: 12345,
      starttime: "Thu Apr 24 12:34:56 2026",
      argv0: "/bin/other",
    }), { match: false, reason: "argv0_mismatch" });
  });
  assert.equal(observedBinary, "/bin/ps",
    "Class 3b regression: capturePidInfo must invoke /bin/ps absolute (PATH-resolved 'ps' would let a stripped/shimmed PATH break ownership capture)");
  assert.deepEqual(observedArgs, ["-o", "lstart=,comm=", "-p", "12345"]);
});

test("capturePidInfo: Darwin ps malformed output is treated as capture_error", () => {
  // PR #21 review #3: a hostile / buggy ps that returns truncated output is
  // a parse failure, NOT proof the pid is dead. capture_error keeps reconcile
  // and cmdCancel from acting on it.
  withPlatformAndChild("darwin", {
    spawnSync: () => ({ status: 0, stdout: "too short\n", stderr: "" }),
  }, () => {
    assert.throws(() => capturePidInfo(12345), /capture_error: ps output too short/);
  });
});

test("capturePidInfo: Darwin spawnSync error → capture_error (e.g. /bin/ps missing)", () => {
  // If /bin/ps itself can't be exec'd (chroot, hardened sandbox), spawnSync
  // sets result.error. The pid may well be alive — we just couldn't ask.
  // capture_error → cmdCancel emits unverifiable + exit 2.
  withPlatformAndChild("darwin", {
    spawnSync: () => ({
      error: Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
      status: null, stdout: "", stderr: "",
    }),
  }, () => {
    assert.throws(() => capturePidInfo(12345), /capture_error: ENOENT/);
  });
});

test("gemini identity mirrors job id semantics", () => {
  assert.match(GeminiIdentity.newJobId(), UUID_V4);
});

test("gemini capturePidInfo parses Darwin ps output through spawnSync mock", () => {
  withPlatformAndChild("darwin", {
    spawnSync: (binary) => {
      assert.equal(binary, "/bin/ps",
        "gemini side must also pin /bin/ps absolute");
      return {
        status: 0,
        stdout: "Fri Apr 25 01:02:03 2026 /bin/gemini-fake\n",
        stderr: "",
      };
    },
  }, () => {
    const info = GeminiIdentity.capturePidInfo(56789);
    assert.equal(info.starttime, "Fri Apr 25 01:02:03 2026");
    assert.equal(info.argv0, "/bin/gemini-fake");
    assert.deepEqual(GeminiIdentity.verifyPidInfo(info), { match: true });
  });
});

test("capturePidInfo: Linux, unsupported platform, and verify error branches", () => {
  assertLinuxIdentityBranches({
    capturePidInfo,
    verifyPidInfo,
  });
});

test("gemini capturePidInfo: Linux, unsupported platform, and verify error branches", () => {
  assertLinuxIdentityBranches(GeminiIdentity);
});

// Class 5a / Finding H: the existing #25 dispatcher tests only assert that
// onSpawn fires asynchronously (after spawn() returns). A regressed
// implementation that captures pid_info SYNCHRONOUSLY but defers the
// callback would still pass those tests — yet the captured argv0 would
// be the PARENT's (the test runner = "node"), not the child binary.
//
// This test catches that class of regression by spawning a child with a
// DIFFERENT binary from the parent (sleep, not node) and asserting the
// captured argv0 reflects the child binary post-execve, not the parent's.
test(
  "attachPidCapture: captured argv0 reflects child binary post-execve, not parent's argv (Class 5a)",
  { skip: attachPidCaptureSkipReason },
  () => new Promise((resolve, reject) => {
    const child = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
    let cleanupDone = false;
    const cleanup = () => {
      if (cleanupDone) return;
      cleanupDone = true;
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    };

    const getPidInfo = attachPidCapture(child, () => {
      try {
        const info = getPidInfo();
        assert.ok(info, "pidInfo must be populated after 'spawn' fires");
        // capture_error here means /proc denied or ps failed — skip the
        // argv0 assertion in that case (Class 3 paths cover capture_error
        // semantics directly).
        if (info.capture_error) {
          cleanup();
          resolve();
          return;
        }
        const argv0 = String(info.argv0 ?? "");
        // Regression assertion: parent is `node` (the test runner). If
        // capture happened pre-execve, argv0 would contain "node". After
        // execve completes, argv0 reflects /bin/sleep on Linux
        // (/proc/<pid>/cmdline = "/bin/sleep") or "sleep" on Darwin
        // (ps -o comm=).
        assert.ok(
          /sleep/.test(argv0),
          `Class 5a regression: argv0 ${JSON.stringify(argv0)} must contain "sleep" (the child binary). A pre-execve capture would record the parent's argv (e.g. "node ${path.basename(process.argv[1] ?? "")}").`,
        );
        assert.ok(
          !/^node\b/.test(argv0),
          `argv0 ${JSON.stringify(argv0)} must NOT start with "node" — that would mean attachPidCapture read the parent's cmdline before the child execve completed.`,
        );
        cleanup();
        resolve();
      } catch (e) {
        cleanup();
        reject(e);
      }
    });

    child.once("error", (err) => {
      cleanup();
      reject(err);
    });
    // Hard timeout in case 'spawn' never fires.
    setTimeout(() => {
      cleanup();
      reject(new Error("attachPidCapture: 'spawn' callback never fired within 5s"));
    }, 5000).unref();
  }),
);
