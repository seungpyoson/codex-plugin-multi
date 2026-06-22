import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { capturePidInfo } from "../../scripts/lib/process-identity.mjs";
import {
  PROVIDER_WORKLOAD_BLOCKED_CODE,
  acquireProviderWorkloadLease,
  providerWorkloadBlockedExecution,
  releaseProviderWorkloadLease,
} from "../../scripts/lib/review-workload.mjs";

function tempEnv() {
  const root = mkdtempSync(join(tmpdir(), "provider-workload-test-"));
  return {
    root,
    env: {
      RELAY_PROVIDER_WORKLOAD_LOCK_DIR: root,
    },
  };
}

const SKIP_WORKLOAD_ACQUIRE_UNDER_DARWIN_SANDBOX = {
  skip: (() => {
    if (process.platform !== "darwin") return false;
    try {
      capturePidInfo(process.pid);
      return false;
    } catch {
      return "macOS sandboxing can deny ps; workload acquisition requires capturePidInfo(process.pid)";
    }
  })(),
};

function workloadTest(name, fn) {
  test(name, SKIP_WORKLOAD_ACQUIRE_UNDER_DARWIN_SANDBOX, fn);
}

test("provider workload lease test mode can acquire when current process proof is sandboxed", () => {
  const { root, env } = tempEnv();
  const lease = acquireProviderWorkloadLease({
    concurrencyKey: "test-mode-current-process",
    limit: 1,
    lockRoot: root,
    jobId: "job-test-mode",
    cwd: "/tmp/w",
    sourceBearing: true,
    env: { ...env, RELAY_WORKLOAD_TEST_MODE: "1" },
  });
  try {
    assert.equal(lease.ok, true);
    assert.ok(lease.lease);
  } finally {
    if (lease.lease) releaseProviderWorkloadLease(lease.lease);
    rmSync(root, { recursive: true, force: true });
  }
});

function ctx(over = {}) {
  return {
    concurrencyKey: "k",
    limit: 1,
    lockRoot: over.lockRoot,
    jobId: "j",
    cwd: "/tmp/w",
    sourceBearing: true,
    env: over.env,
    ...over,
  };
}

function holder(over = {}) {
  const pid = over.pid ?? 12345;
  return {
    schema_version: 1,
    provider: "test-provider",
    concurrency_key: "k",
    key_slug: "k",
    job_id: "held-job",
    pid,
    starttime: `start-${pid}`,
    argv0: `node-${pid}`,
    boot_id: "BOOT",
    hostname: hostname(),
    cwd: "/tmp/held",
    started_at: "2026-01-01T00:00:00.000Z",
    token: `token-${pid}`,
    ...over,
  };
}

function writeSlot(root, index, over = {}) {
  writeFileSync(join(root, `k.slot-${index}.json`), JSON.stringify(holder(over)));
}

function matchingCapture(pid) {
  return { pid, starttime: `start-${pid}`, argv0: `node-${pid}` };
}

function currentProcessGateOwner(over = {}) {
  let current = null;
  try {
    current = capturePidInfo(process.pid);
  } catch {
    current = { pid: process.pid, starttime: "sandboxed-current-start", argv0: "sandboxed-current-argv" };
  }
  return holder({
    pid: process.pid,
    starttime: current.starttime,
    argv0: current.argv0,
    boot_id: "CURRENT",
    token: "gate-owner-token",
    ...over,
  });
}

function writeGateOwner(root, owner) {
  const gateDir = join(root, "k.json.gate");
  mkdirSync(gateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(gateDir, "owner.json"), JSON.stringify(owner));
}

workloadTest("provider workload lease blocks concurrent source-bearing launches for the same provider", () => {
  const { root, env } = tempEnv();
  try {
    const first = acquireProviderWorkloadLease({
      concurrencyKey: "claude",
      limit: 1,
      lockRoot: root,
      jobId: "job-first",
      cwd: "/tmp/work-a",
      sourceBearing: true,
      env,
    });
    assert.equal(first.ok, true);

    const second = acquireProviderWorkloadLease({
      concurrencyKey: "claude",
      limit: 1,
      lockRoot: root,
      jobId: "job-second",
      cwd: "/tmp/work-b",
      sourceBearing: true,
      env,
    });
    assert.equal(second.ok, false);
    assert.equal(second.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.equal(second.reason, "active_same_provider_job");
    assert.deepEqual(second.capacity, { active_count: 1, limit: 1 });

    const blocked = providerWorkloadBlockedExecution(second);
    assert.equal(blocked.preflight, true);
    assert.equal(blocked.parsed.reason, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.match(blocked.errorMessage, /^provider_workload_blocked:/);
    assert.deepEqual(blocked.diagnostics.provider_workload.capacity, { active_count: 1, limit: 1 });
    assert.equal(blocked.diagnostics.provider_workload.holder, undefined);

    assert.equal(releaseProviderWorkloadLease(first.lease), true);
    const third = acquireProviderWorkloadLease({
      concurrencyKey: "claude",
      limit: 1,
      lockRoot: root,
      jobId: "job-third",
      cwd: "/tmp/work-c",
      sourceBearing: true,
      env,
    });
    assert.equal(third.ok, true);
    releaseProviderWorkloadLease(third.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider workload gate reclaims a pid-reused owner using the injected identity capture", () => {
  const { root, env } = tempEnv();
  try {
    writeGateOwner(root, currentProcessGateOwner());
    const reusedPidCapture = (pid) => {
      assert.equal(pid, process.pid);
      return { pid, starttime: "reused-starttime", argv0: "reused-argv0" };
    };

    const acquired = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      env: {
        ...env,
        RELAY_WORKLOAD_TEST_MODE: "1",
        RELAY_BOOT_ID: "CURRENT",
        RELAY_PROVIDER_WORKLOAD_GATE_TIMEOUT_MS: "1",
      },
      capture: reusedPidCapture,
    }));

    assert.equal(acquired.ok, true, "pid-reused gate owner must be reclaimable");
    releaseProviderWorkloadLease(acquired.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider workload gate reclaims unverifiable stale-boot owners but fails closed on the current boot", () => {
  const { root, env } = tempEnv();
  const captureError = () => { throw new Error("capture_error: injected process table denial"); };
  const testEnv = {
    ...env,
    RELAY_WORKLOAD_TEST_MODE: "1",
    RELAY_BOOT_ID: "CURRENT",
    RELAY_PROVIDER_WORKLOAD_GATE_TIMEOUT_MS: "1",
  };
  try {
    writeGateOwner(root, currentProcessGateOwner({ boot_id: "STALE" }));
    const staleBoot = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      env: testEnv,
      capture: captureError,
    }));
    assert.equal(staleBoot.ok, true, "stale-boot unverifiable gate owner must be reclaimed");
    releaseProviderWorkloadLease(staleBoot.lease);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });

    writeGateOwner(root, currentProcessGateOwner({ boot_id: "CURRENT" }));
    const currentBoot = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      env: testEnv,
      capture: captureError,
    }));
    assert.equal(currentBoot.ok, false, "current-boot unverifiable gate owner must stay occupied");
    assert.equal(currentBoot.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider workload slugging avoids Sonar-flagged boundary alternation regex", () => {
  const source = readFileSync(new URL("../../scripts/lib/review-workload.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /replace\(\s*\/\^-\+\|-\+\$\/g/);
});

test("provider workload lease publishes a complete payload atomically", () => {
  const source = readFileSync(new URL("../../scripts/lib/review-workload.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /openSync\(\s*file\s*,\s*"wx"/,
    "lease publication must not create the final lock path before payload bytes exist",
  );
  assert.match(source, /linkSync\(/, "lease publication should atomically link a complete candidate file");
});

test("provider workload gate owner records full liveness identity for reclaim (pid-reuse + boot-id)", () => {
  // The gate owner must persist the SAME identity a slot does. The reclaim tests above pre-seed an
  // owner with starttime/argv0/boot_id, so they exercise the READ/classify path but not the
  // production WRITE. If acquireProviderWorkloadGate stops writing these, a crashed gate owner
  // becomes unreclaimable: classifyHolder skips the null starttime/argv0 checks (a reused pid reads
  // "alive") and a missing boot_id defeats stale-boot reclaim. This guards that write side.
  const source = readFileSync(new URL("../../scripts/lib/review-workload.mjs", import.meta.url), "utf8");
  const gateWrite = source.match(/writeGateOwner\(gateDir,\s*\{[\s\S]*?\}\)/);
  assert.ok(gateWrite, "writeGateOwner payload literal not found");
  assert.match(gateWrite[0], /\bstarttime:/, "gate owner must record starttime (PID-reuse detection)");
  assert.match(gateWrite[0], /\bargv0:/, "gate owner must record argv0 (PID-reuse detection)");
  assert.match(gateWrite[0], /\bboot_id:/, "gate owner must record boot_id (stale-boot reclaim)");
});

test("source-bearing acquisition requires an explicit concurrencyKey", () => {
  assert.throws(
    () => acquireProviderWorkloadLease({
      provider: "legacy-provider",
      limit: 1,
      lockRoot: "/tmp/unused",
      sourceBearing: true,
    }),
    /concurrencyKey is required/,
  );
});

test("provider workload blocked execution diagnostics expose capacity only", () => {
  const execution = providerWorkloadBlockedExecution({
    ok: false,
    error_code: PROVIDER_WORKLOAD_BLOCKED_CODE,
    reason: "active_same_provider_job",
    message: "k source-bearing review is already active",
    capacity: { active_count: 2, limit: 2 },
    holder: { job_id: "secret-job" },
  });
  assert.deepEqual(execution.diagnostics.provider_workload, {
    reason: "active_same_provider_job",
    capacity: { active_count: 2, limit: 2 },
  });
  assert.ok(!JSON.stringify(execution).includes("secret-job"));
});

test("provider workload lease serializes stale reclaim before removing inactive holders", () => {
  const source = readFileSync(new URL("../../scripts/lib/review-workload.mjs", import.meta.url), "utf8");
  assert.match(source, /function acquireProviderWorkloadGate\(/,
    "stale reclaim must be protected by a provider-local gate");
  assert.match(source, /const gate = acquireProviderWorkloadGate\([^,]+, env, capture, pidInfo\);/,
    "lease acquisition must hold the gate before inspecting or removing an inactive holder");
  assert.match(source, /removeInactiveHolder\([^,]+, holder\)/,
    "inactive-holder removal must be bound to the holder inspected while the gate is held");
  assert.doesNotMatch(source, /removeInactiveHolder\(file\)\) continue/,
    "stale reclaim must not unlink the lock path outside a serialized compare-and-retry section");
});

workloadTest("provider workload lease release unregisters exit cleanup listener", () => {
  const { root, env } = tempEnv();
  const before = process.listenerCount("exit");
  try {
    const acquired = acquireProviderWorkloadLease({
      concurrencyKey: "claude-listener",
      limit: 1,
      lockRoot: root,
      jobId: "job-listener",
      cwd: "/tmp/work-listener",
      sourceBearing: true,
      env,
    });
    assert.equal(acquired.ok, true);
    assert.equal(process.listenerCount("exit"), before + 1);
    assert.equal(releaseProviderWorkloadLease(acquired.lease), true);
    assert.equal(process.listenerCount("exit"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

workloadTest("provider workload lease is provider-neutral and ignores source-free probes", () => {
  const { root, env } = tempEnv();
  try {
    const claude = acquireProviderWorkloadLease({
      concurrencyKey: "claude",
      limit: 1,
      lockRoot: root,
      jobId: "job-claude",
      cwd: "/tmp/work-a",
      sourceBearing: true,
      env,
    });
    assert.equal(claude.ok, true);

    const gemini = acquireProviderWorkloadLease({
      concurrencyKey: "gemini",
      limit: 1,
      lockRoot: root,
      jobId: "job-gemini",
      cwd: "/tmp/work-b",
      sourceBearing: true,
      env,
    });
    assert.equal(gemini.ok, true);

    const sourceFree = acquireProviderWorkloadLease({
      concurrencyKey: "claude",
      limit: 1,
      lockRoot: root,
      jobId: "job-ping",
      cwd: "/tmp/work-c",
      sourceBearing: false,
      env,
    });
    assert.equal(sourceFree.ok, true);
    assert.equal(sourceFree.lease, null);

    releaseProviderWorkloadLease(claude.lease);
    releaseProviderWorkloadLease(gemini.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider workload counts occupied slots above a lowered limit before admitting new work", () => {
  const { root, env } = tempEnv();
  try {
    writeSlot(root, 7, { pid: 101 });
    writeSlot(root, 9, { pid: 102 });

    const blocked = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      limit: 2,
      env: { ...env, RELAY_WORKLOAD_TEST_MODE: "1", RELAY_BOOT_ID: "BOOT" },
      capture: matchingCapture,
    }));

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.deepEqual(blocked.capacity, { active_count: 2, limit: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy workload lock and slot zero coexist as one occupied index at limit greater than one", () => {
  const { root, env } = tempEnv();
  try {
    const legacyAndSlotZero = holder({ pid: 201, token: "same-index-token" });
    writeFileSync(join(root, "k.json"), JSON.stringify(legacyAndSlotZero));
    writeSlot(root, 0, legacyAndSlotZero);

    const acquired = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      limit: 2,
      env: { ...env, RELAY_WORKLOAD_TEST_MODE: "1", RELAY_BOOT_ID: "BOOT" },
      capture: matchingCapture,
    }));

    assert.equal(acquired.ok, true);
    assert.match(acquired.lease.file, /k\.slot-1\.json$/);
    releaseProviderWorkloadLease(acquired.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreign-host workload holders count as occupied and are never boot-id reclaimed", () => {
  const { root, env } = tempEnv();
  try {
    writeSlot(root, 0, {
      hostname: "some-other-host",
      boot_id: "STALE",
      pid: 301,
    });
    const captureError = () => { throw new Error("capture_error: should not inspect foreign holder"); };

    const blocked = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      limit: 1,
      env: { ...env, RELAY_WORKLOAD_TEST_MODE: "1", RELAY_BOOT_ID: "CURRENT" },
      capture: captureError,
    }));

    assert.equal(blocked.ok, false);
    assert.deepEqual(blocked.capacity, { active_count: 1, limit: 1 });
    assert.equal(JSON.parse(readFileSync(join(root, "k.slot-0.json"), "utf8")).hostname, "some-other-host");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown boot-id unverifiable workload holders fail closed across simulated reboots", () => {
  const { root, env } = tempEnv();
  try {
    writeSlot(root, 0, {
      pid: 401,
      boot_id: "unknown-myhost",
      hostname: hostname(),
    });
    const captureError = () => { throw new Error("capture_error: process table unavailable"); };

    const blocked = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      limit: 1,
      env: { ...env, RELAY_WORKLOAD_TEST_MODE: "1", RELAY_BOOT_ID: "REAL-BOOT-AFTER-REBOOT" },
      capture: captureError,
    }));

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.deepEqual(blocked.capacity, { active_count: 1, limit: 1 });
    assert.equal(JSON.parse(readFileSync(join(root, "k.slot-0.json"), "utf8")).boot_id, "unknown-myhost");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

workloadTest("provider workload lease reclaims stale lock files whose pid is not alive", () => {
  const { root, env } = tempEnv();
  try {
    writeFileSync(join(root, "kimi.json"), JSON.stringify({
      provider: "kimi",
      job_id: "stale-job",
      pid: 0,
      token: "stale-token",
      cwd: "/tmp/stale",
      started_at: "2000-01-01T00:00:00.000Z",
    }));

    const acquired = acquireProviderWorkloadLease({
      concurrencyKey: "kimi",
      limit: 1,
      lockRoot: root,
      jobId: "fresh-job",
      cwd: "/tmp/fresh",
      sourceBearing: true,
      env,
    });
    assert.equal(acquired.ok, true);
    assert.equal(JSON.parse(readFileSync(join(root, "kimi.slot-0.json"), "utf8")).job_id, "fresh-job");
    releaseProviderWorkloadLease(acquired.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

workloadTest("limit=1 still single-flights (golden, byte-behaviour identical)", () => {
  const { root } = tempEnv();
  try {
    const a = acquireProviderWorkloadLease(ctx({ lockRoot: root, jobId: "a" }));
    assert.equal(a.ok, true);
    const b = acquireProviderWorkloadLease(ctx({ lockRoot: root, jobId: "b" }));
    assert.equal(b.ok, false);
    assert.equal(b.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.equal(b.capacity.active_count, 1);
    assert.equal(b.capacity.limit, 1);
    releaseProviderWorkloadLease(a.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

workloadTest("limit=N admits N and blocks N+1 with capacity", () => {
  const { root } = tempEnv();
  try {
    const leases = [];
    for (let i = 0; i < 3; i++) {
      const r = acquireProviderWorkloadLease(ctx({ lockRoot: root, limit: 3, jobId: `j${i}` }));
      assert.equal(r.ok, true, `acquire ${i}`);
      leases.push(r.lease);
    }
    const blocked = acquireProviderWorkloadLease(ctx({ lockRoot: root, limit: 3, jobId: "j3" }));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.capacity.active_count, 3);
    assert.equal(blocked.capacity.limit, 3);
    leases.forEach(releaseProviderWorkloadLease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

workloadTest("distinct concurrencyKeys never contend", () => {
  const { root } = tempEnv();
  try {
    const a = acquireProviderWorkloadLease(ctx({ lockRoot: root, concurrencyKey: "kimi", limit: 1 }));
    const b = acquireProviderWorkloadLease(ctx({ lockRoot: root, concurrencyKey: "deepseek.api", limit: 1 }));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    releaseProviderWorkloadLease(a.lease);
    releaseProviderWorkloadLease(b.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("limit < 1 / non-integer denies for source-bearing with invalid limit reason (fail-closed)", () => {
  const { root } = tempEnv();
  try {
    for (const bad of [0, -1, 1.5, NaN, "2"]) {
      const r = acquireProviderWorkloadLease(ctx({ lockRoot: root, limit: bad }));
      assert.equal(r.ok, false, `limit ${bad} must deny`);
      assert.equal(r.reason, "invalid_provider_workload_limit", `limit ${bad} must use invalid limit reason`);
      assert.deepEqual(r.capacity, { active_count: 0, limit: null });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

workloadTest("engine uses supplied lockRoot and ignores RELAY_PROVIDER_WORKLOAD_LOCK_DIR", () => {
  const { root } = tempEnv();
  const decoy = mkdtempSync(join(tmpdir(), "decoy-"));
  try {
    const a = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      env: { RELAY_PROVIDER_WORKLOAD_LOCK_DIR: decoy },
    }));
    assert.equal(a.ok, true);
    assert.ok(a.lease.file.startsWith(root));
    assert.deepEqual(readdirSync(decoy), []);
    releaseProviderWorkloadLease(a.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

workloadTest("capacity exposes counts only, never job ids/holders", () => {
  const { root } = tempEnv();
  try {
    const a = acquireProviderWorkloadLease(ctx({ lockRoot: root, limit: 1, jobId: "secret-job" }));
    const b = acquireProviderWorkloadLease(ctx({ lockRoot: root, limit: 1, jobId: "other" }));
    assert.equal(b.ok, false);
    assert.deepEqual(Object.keys(b.capacity).sort(), ["active_count", "limit"]);
    assert.ok(!JSON.stringify(b.capacity).includes("secret-job"));
    assert.ok(!JSON.stringify(b).includes("secret-job"));
    releaseProviderWorkloadLease(a.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
