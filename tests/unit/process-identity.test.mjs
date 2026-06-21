import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { capturePidInfo, currentBootId, holderActive } from "../../scripts/lib/process-identity.mjs";

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
