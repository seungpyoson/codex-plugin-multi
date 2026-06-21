import { test } from "node:test";
import assert from "node:assert/strict";
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
