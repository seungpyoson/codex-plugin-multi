// Unit tests for lib/identity.mjs — the four identity types (§21.1).
//
// Locks down: job_id vs claude_session_id vs resume_chain vs pid_info stay
// distinct. `capturePidInfo` / `verifyPidInfo` form an ownership proof, not
// merely a liveness check. PID-reuse-safe by construction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  newJobId,
  capturePidInfo,
  verifyPidInfo,
  appendResumeLink,
} from "../../plugins/claude/scripts/lib/identity.mjs";
import * as GeminiIdentity from "../../plugins/gemini/scripts/lib/identity.mjs";

const UUID_V4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SKIP_PS_UNDER_COVERAGE = {
  skip: process.env.CODEX_PLUGIN_COVERAGE === "1" || process.platform === "darwin"
    ? "macOS sandboxing can deny ps; shimmed Darwin tests cover parser and ownership comparison"
    : false,
};
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

function assertLinuxIdentityBranches(identity) {
  const afterComm = ["S", ...Array.from({ length: 18 }, (_, i) => String(i + 1)), "98765", "tail"];
  const stat = `123 (node worker) ${afterComm.join(" ")}`;

  withPlatformAndFs("linux", {
    existsSync: (file) => file === "/proc/123/stat" || file === "/proc/123/cmdline",
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
    existsSync: (file) => file === "/proc/124/stat",
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

  withPlatformAndFs("linux", {
    existsSync: () => false,
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

  withPlatformAndFs("linux", {
    existsSync: () => true,
    readFileSync: () => "malformed",
  }, () => {
    assert.throws(() => identity.capturePidInfo(126), /process_gone: malformed/);
  });

  withPlatformAndFs("linux", {
    existsSync: () => true,
    readFileSync: (file) => {
      if (file.endsWith("/stat")) return "127 (node) S 1 2";
      return "";
    },
  }, () => {
    assert.throws(() => identity.capturePidInfo(127), /process_gone: no starttime/);
  });

  withPlatformAndFs("linux", {
    existsSync: () => true,
    readFileSync: (file) => {
      if (file.endsWith("/stat")) return `) ${afterComm.join(" ")}`;
      return "";
    },
  }, () => {
    assert.throws(() => identity.capturePidInfo(127), /process_gone: no argv0\/comm/);
  });

  withPlatformAndFs("linux", {
    existsSync: () => true,
    readFileSync: () => {
      throw new Error("permission denied");
    },
  }, () => {
    assert.throws(() => identity.capturePidInfo(128), /process_gone: permission denied/);
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

test("capturePidInfo: non-existent pid throws process_gone", () => {
  // PID 2^31 - 2 is effectively never a real pid.
  assert.throws(() => capturePidInfo(2147483646), /process_gone/);
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

test("verifyPidInfo: vanished process returns match:false process_gone (no throw)", () => {
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

test("appendResumeLink: non-mutating; appends to empty chain", () => {
  const rec = Object.freeze({ id: "j1", resume_chain: [] });
  const next = appendResumeLink(rec, "claude-session-A");
  assert.deepEqual(next.resume_chain, ["claude-session-A"]);
  // Original untouched.
  assert.deepEqual(rec.resume_chain, []);
});

test("appendResumeLink: appends newest-last to existing chain", () => {
  const rec = { id: "j2", resume_chain: ["a", "b"] };
  const next = appendResumeLink(rec, "c");
  assert.deepEqual(next.resume_chain, ["a", "b", "c"]);
});

test("appendResumeLink: records without resume_chain get one initialized", () => {
  const rec = { id: "j3" };
  const next = appendResumeLink(rec, "first");
  assert.deepEqual(next.resume_chain, ["first"]);
  // Original record untouched (no new key leaked onto it).
  assert.equal("resume_chain" in rec, false);
});

test("capturePidInfo: Darwin ps output can be parsed through a PATH shim", {
  skip: process.platform !== "darwin",
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "identity-ps-"));
  const originalPath = process.env.PATH;
  try {
    const ps = path.join(dir, "ps");
    writeFileSync(ps, "#!/bin/sh\necho 'Thu Apr 24 12:34:56 2026 /bin/fake-node'\n", "utf8");
    chmodSync(ps, 0o755);
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;

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
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capturePidInfo: Darwin ps malformed output is treated as process_gone", {
  skip: process.platform !== "darwin",
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "identity-ps-bad-"));
  const originalPath = process.env.PATH;
  try {
    const ps = path.join(dir, "ps");
    writeFileSync(ps, "#!/bin/sh\necho 'too short'\n", "utf8");
    chmodSync(ps, 0o755);
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;

    assert.throws(() => capturePidInfo(12345), /process_gone: ps output too short/);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gemini identity mirrors job ids and resume-chain semantics", () => {
  assert.match(GeminiIdentity.newJobId(), UUID_V4);
  const rec = { id: "g1", resume_chain: ["first"] };
  const next = GeminiIdentity.appendResumeLink(rec, "second");
  assert.deepEqual(next.resume_chain, ["first", "second"]);
  assert.deepEqual(rec.resume_chain, ["first"]);
});

test("gemini capturePidInfo parses Darwin ps output through the same shim", {
  skip: process.platform !== "darwin",
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gemini-identity-ps-"));
  const originalPath = process.env.PATH;
  try {
    const ps = path.join(dir, "ps");
    writeFileSync(ps, "#!/bin/sh\necho 'Fri Apr 25 01:02:03 2026 /bin/gemini-fake'\n", "utf8");
    chmodSync(ps, 0o755);
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;

    const info = GeminiIdentity.capturePidInfo(56789);
    assert.equal(info.starttime, "Fri Apr 25 01:02:03 2026");
    assert.equal(info.argv0, "/bin/gemini-fake");
    assert.deepEqual(GeminiIdentity.verifyPidInfo(info), { match: true });
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
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
