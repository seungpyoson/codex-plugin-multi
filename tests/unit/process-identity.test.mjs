import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { capturePidInfo, classifyHolder, currentBootId, holderActive } from "../../scripts/lib/process-identity.mjs";

const SKIP_PS_UNDER_DARWIN_SANDBOX = {
  skip: process.platform === "darwin"
    ? "macOS sandboxing can deny ps; identity parser branches are covered in identity.test.mjs"
    : false,
};

test("currentBootId is stable within a process and non-empty", () => {
  const a = currentBootId();
  const b = currentBootId();
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test("currentBootId fallback is the constant unknown-<hostname> sentinel with an operator warning", () => {
  // When boot-id detection fails (no /proc, no sysctl), currentBootId returns `unknown-${hostname()}`.
  // The `unknown-` PREFIX is a contract: shouldReclaimUnverifiable (review-workload.mjs) treats any
  // `unknown-`-prefixed recorded boot id as operator-cleanup-only, so the fallback fails closed. Two
  // regressions this guards: (1) dropping the prefix would defeat that suppression; (2) adding
  // per-process entropy (a nonce) would make every restart look like a reboot and reclaim LIVE
  // holders. The exact-constant match below rejects both. The fallback path itself is cache- and
  // syscall-gated (untestable in-process without dep injection), so this is a source-level guard.
  const source = readFileSync(new URL("../../scripts/lib/process-identity.mjs", import.meta.url), "utf8");
  assert.match(source, /CACHED_BOOT_ID = `unknown-\$\{hostname\(\)\}`/, "fallback must be the constant unknown-<hostname> sentinel (no nonce)");
  assert.match(source, /warnBootIdFallback\(/, "fallback must emit a one-time operator warning");
});

test("currentBootId reads the clock-independent boot-session uuid on darwin", (t) => {
  // The boot id must prove a reboot, not a clock step. On darwin that means
  // kern.bootsessionuuid (clock-independent), NOT kern.boottime (= wall - uptime).
  if (process.platform !== "darwin") return t.skip("darwin-only");
  if (process.env.RELAY_BOOT_ID) return t.skip("RELAY_BOOT_ID override in effect");
  const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
  if (r.error || r.status !== 0 || !r.stdout.trim()) {
    return t.skip("sysctl kern.bootsessionuuid unavailable (sandbox/ancient macOS)");
  }
  // currentBootId must return the UUID, never the clock-derived boottime string
  // (which contains "sec ="). Proves the fix reads the reboot-proof source.
  const got = currentBootId();
  assert.equal(got, r.stdout.trim());
  assert.ok(!got.includes("sec ="), `boot id must not be clock-derived boottime: ${got}`);
});

test("capturePidInfo returns {pid,starttime,argv0} for the live self pid", SKIP_PS_UNDER_DARWIN_SANDBOX, () => {
  const info = capturePidInfo(process.pid);
  assert.equal(info.pid, process.pid);
  assert.ok(info.starttime && info.argv0);
});

test("capturePidInfo throws process_gone for an impossible pid", () => {
  assert.throws(() => capturePidInfo(2 ** 31 - 1), /process_gone|capture_error/);
});

test("holderActive treats a foreign hostname as occupied (fail-closed)", () => {
  assert.equal(holderActive({ hostname: "some-other-host", pid: 1 }, process.env), true);
});

test("holderActive treats a dead-but-recycled pid (starttime mismatch) as inactive", SKIP_PS_UNDER_DARWIN_SANDBOX, async () => {
  const self = capturePidInfo(process.pid);
  const stale = { hostname: (await import("node:os")).hostname(), pid: process.pid, starttime: "0", argv0: self.argv0 };
  assert.equal(holderActive(stale, process.env), false);
});

test("classifyHolder reports alive for the current process", SKIP_PS_UNDER_DARWIN_SANDBOX, () => {
  const self = capturePidInfo(process.pid);
  assert.equal(classifyHolder({ ...self }, process.env), "alive");
});

test("classifyHolder reports dead for pid reuse identity mismatch", SKIP_PS_UNDER_DARWIN_SANDBOX, () => {
  const self = capturePidInfo(process.pid);
  assert.equal(classifyHolder({ ...self, starttime: "0" }, process.env), "dead");
});

test("classifyHolder reports dead for a structurally invalid pid (cannot be a live process)", () => {
  // An invalid pid (non-integer / 0 / negative) can never be a running holder,
  // so the slot is safe to reclaim — matches the pre-#234 pidAlive behaviour.
  assert.equal(classifyHolder({ pid: "not-a-pid" }, process.env), "dead");
  assert.equal(classifyHolder({ pid: 0 }, process.env), "dead");
  assert.equal(classifyHolder({ pid: -5 }, process.env), "dead");
});

test("classifyHolder reports unverifiable when a real pid cannot be inspected (capture_error)", () => {
  // capture_error = a real pid we cannot inspect (sandbox/hidepid/EACCES). It
  // MUST fail closed (occupied) — reclaimable only on a stale boot id. Injected
  // capture makes this deterministic on every platform (not just darwin-sandbox).
  const captureError = () => { throw new Error("capture_error: ps denied by sandbox"); };
  assert.equal(classifyHolder({ pid: 4321 }, process.env, captureError), "unverifiable");
});

test("classifyHolder reports foreign for another hostname", () => {
  assert.equal(classifyHolder({ hostname: "some-other-host", pid: process.pid }, process.env), "foreign");
});
