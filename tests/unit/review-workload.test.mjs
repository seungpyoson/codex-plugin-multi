import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { capturePidInfo } from "../../scripts/lib/process-identity.mjs";
import {
  PROVIDER_WORKLOAD_BLOCKED_CODE,
  acquireProviderWorkloadLease,
  acquireProviderWorkloadGate,
  providerWorkloadBlockedExecution,
  concurrencyAdmissionBlockedExecution,
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

const SKIP_UNWRITABLE_PERMISSION_TEST_UNDER_ROOT = {
  skip: process.getuid?.() === 0
    ? "root can bypass chmod-based write denial"
    : false,
};

// Gate timeout for tests that assert a reclaim SUCCEEDS (ok:true). The production
// loop checks the deadline before it attempts reclaim (review-workload.mjs: the
// `Date.now() >= deadline` guard sits above the recreate/reclaim branches), so the
// budget must comfortably exceed the latency of reaching that first catch — a tight
// "1" lets the deadline fire before reclaim is ever tried, returning {ok:false}
// (~5% flake under parallel load). Do not lower this back to "1": that asserts the
// immediate-timeout path, not the reclaim path. The fast-timeout {ok:false} cases
// keep their own small budgets inline.
const RECLAIM_GATE_TIMEOUT_MS = "250";

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

test("provider workload lease admits current process when liveness capture is sandboxed", () => {
  const { root, env } = tempEnv();
  const captureDenied = () => { throw new Error("capture_error: injected process table denial"); };
  const lease = acquireProviderWorkloadLease({
    concurrencyKey: "sandboxed-current-process",
    limit: 1,
    lockRoot: root,
    jobId: "job-sandboxed-current",
    cwd: "/tmp/w",
    sourceBearing: true,
    env,
    capture: captureDenied,
  });
  try {
    assert.equal(lease.ok, true);
    assert.ok(lease.lease);
    const holder = JSON.parse(readFileSync(lease.lease.file, "utf8"));
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.starttime, null);
    assert.equal(holder.argv0, null);
  } finally {
    if (lease.lease) releaseProviderWorkloadLease(lease.lease);
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider workload lease treats a null-proof holder as occupied", () => {
  const { root, env } = tempEnv();
  const captureDenied = () => { throw new Error("capture_error: injected process table denial"); };
  const captureDifferentIdentity = () => ({
    pid: process.pid,
    starttime: "different-starttime",
    argv0: "different-argv0",
  });
  const first = acquireProviderWorkloadLease({
    concurrencyKey: "null-proof-current-process",
    limit: 1,
    lockRoot: root,
    jobId: "job-null-proof-current",
    cwd: "/tmp/w",
    sourceBearing: true,
    env,
    capture: captureDenied,
  });
  try {
    assert.equal(first.ok, true);
    const second = acquireProviderWorkloadLease({
      concurrencyKey: "null-proof-current-process",
      limit: 1,
      lockRoot: root,
      jobId: "job-null-proof-second",
      cwd: "/tmp/w",
      sourceBearing: true,
      env,
      capture: captureDifferentIdentity,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "active_same_provider_job");
    assert.deepEqual(second.capacity, { active_count: 1, limit: 1 });
  } finally {
    if (first.lease) releaseProviderWorkloadLease(first.lease);
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider workload lease fails closed when lock root cannot be created", SKIP_UNWRITABLE_PERMISSION_TEST_UNDER_ROOT, () => {
  const parent = mkdtempSync(join(tmpdir(), "provider-workload-unwritable-"));
  chmodSync(parent, 0o500);
  try {
    const result = acquireProviderWorkloadLease({
      concurrencyKey: "unwritable-lock-root",
      limit: 1,
      lockRoot: join(parent, "locks"),
      jobId: "job-unwritable-lock-root",
      cwd: "/tmp/w",
      sourceBearing: true,
      env: { RELAY_WORKLOAD_TEST_MODE: "1" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.equal(result.reason, "unwritable_provider_workload_lock_root");
    assert.deepEqual(result.capacity, { active_count: 0, limit: 1 });
  } finally {
    chmodSync(parent, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("provider workload lease fails closed when existing lock root is not writable", SKIP_UNWRITABLE_PERMISSION_TEST_UNDER_ROOT, () => {
  const root = mkdtempSync(join(tmpdir(), "provider-workload-unwritable-root-"));
  chmodSync(root, 0o500);
  try {
    const result = acquireProviderWorkloadLease({
      concurrencyKey: "existing-unwritable-lock-root",
      limit: 1,
      lockRoot: root,
      jobId: "job-existing-unwritable-lock-root",
      cwd: "/tmp/w",
      sourceBearing: true,
      env: { RELAY_WORKLOAD_TEST_MODE: "1" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.equal(result.reason, "unwritable_provider_workload_lock_root");
    assert.deepEqual(result.capacity, { active_count: 0, limit: 1 });
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider workload lease fails closed when lock root path is a file", () => {
  const parent = mkdtempSync(join(tmpdir(), "provider-workload-file-root-"));
  const root = join(parent, "locks");
  writeFileSync(root, "not a directory");
  const result = acquireProviderWorkloadLease({
    concurrencyKey: "file-lock-root",
    limit: 1,
    lockRoot: root,
    jobId: "job-file-lock-root",
    cwd: "/tmp/w",
    sourceBearing: true,
    env: { RELAY_WORKLOAD_TEST_MODE: "1" },
  });
  try {
    assert.equal(result.ok, false);
    assert.equal(result.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.equal(result.reason, "unwritable_provider_workload_lock_root");
    assert.deepEqual(result.capacity, { active_count: 0, limit: 1 });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("provider workload lease refuses a symlinked lock root", (t) => {
  if (process.platform === "win32") return t.skip("directory symlinks require elevated privileges on some Windows hosts");
  const parent = mkdtempSync(join(tmpdir(), "provider-workload-symlink-root-"));
  const target = join(parent, "target");
  const root = join(parent, "locks");
  mkdirSync(target);
  symlinkSync(target, root, "dir");
  let result;
  try {
    result = acquireProviderWorkloadLease({
      concurrencyKey: "symlink-lock-root",
      limit: 1,
      lockRoot: root,
      jobId: "job-symlink-lock-root",
      cwd: "/tmp/w",
      sourceBearing: true,
      env: { RELAY_WORKLOAD_TEST_MODE: "1" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.equal(result.reason, "unwritable_provider_workload_lock_root");
    assert.deepEqual(result.capacity, { active_count: 0, limit: 1 });
  } finally {
    if (result?.lease) releaseProviderWorkloadLease(result.lease);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("provider workload lease makes an existing lock root private before use", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-workload-public-root-"));
  chmodSync(root, 0o755);
  const result = acquireProviderWorkloadLease({
    concurrencyKey: "public-lock-root",
    limit: 1,
    lockRoot: root,
    jobId: "job-public-lock-root",
    cwd: "/tmp/w",
    sourceBearing: true,
    env: { RELAY_WORKLOAD_TEST_MODE: "1" },
  });
  try {
    assert.equal(result.ok, true);
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
  } finally {
    if (result.lease) releaseProviderWorkloadLease(result.lease);
    chmodSync(root, 0o700);
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
        RELAY_PROVIDER_WORKLOAD_GATE_TIMEOUT_MS: RECLAIM_GATE_TIMEOUT_MS,
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
    RELAY_PROVIDER_WORKLOAD_GATE_TIMEOUT_MS: RECLAIM_GATE_TIMEOUT_MS,
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
    message: "source-bearing review is already active",
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
  assert.match(source, /gate = acquireProviderWorkloadGate\([^,]+, env, capture, pidInfo\);/,
    "lease acquisition must hold the gate before inspecting or removing an inactive holder");
  assert.match(source, /removeInactiveHolder\([^,]+, holder\)/,
    "inactive-holder removal must be bound to the holder inspected while the gate is held");
  assert.doesNotMatch(source, /removeInactiveHolder\(file\)\) continue/,
    "stale reclaim must not unlink the lock path outside a serialized compare-and-retry section");
});

test("provider workload gate retries when owner write loses the gate directory race", async () => {
  const { root, env } = tempEnv();
  const moduleRoot = mkdtempSync(join(tmpdir(), "provider-workload-race-module-"));
  try {
    const source = readFileSync(new URL("../../scripts/lib/review-workload.mjs", import.meta.url), "utf8");
    const shimPath = join(moduleRoot, "fs-race-shim.mjs");
    const modulePath = join(moduleRoot, "review-workload-race.mjs");
    writeFileSync(shimPath, `
import * as fs from "node:fs";

export const chmodSync = fs.chmodSync;
export const existsSync = fs.existsSync;
export const linkSync = fs.linkSync;
export const lstatSync = fs.lstatSync;
export const readdirSync = fs.readdirSync;
export const readFileSync = fs.readFileSync;
export const renameSync = fs.renameSync;
export const rmSync = fs.rmSync;
export const unlinkSync = fs.unlinkSync;

let pendingGateDir = null;
let injected = false;

export function mkdirSync(path, options) {
  const result = fs.mkdirSync(path, options);
  if (!injected && String(path).endsWith(".json.gate")) pendingGateDir = String(path);
  return result;
}

export function writeFileSync(path, data, options) {
  if (!injected && pendingGateDir && String(path) === \`\${pendingGateDir}/owner.json\`) {
    injected = true;
    fs.rmSync(pendingGateDir, { recursive: true, force: true });
    const error = new Error("injected owner write ENOENT");
    error.code = "ENOENT";
    throw error;
  }
  return fs.writeFileSync(path, data, options);
}
`, "utf8");
    writeFileSync(
      modulePath,
      source
        .replace(
          'from "node:fs";',
          `from ${JSON.stringify(pathToFileURL(shimPath).href)};`,
        )
        .replace(
          'from "./process-identity.mjs";',
          `from ${JSON.stringify(new URL("../../scripts/lib/process-identity.mjs", import.meta.url).href)};`,
        ),
      "utf8",
    );

    const workload = await import(pathToFileURL(modulePath).href);
    const acquired = workload.acquireProviderWorkloadLease({
      concurrencyKey: "grok",
      limit: 1,
      lockRoot: root,
      jobId: "race-job",
      cwd: "/tmp/race",
      sourceBearing: true,
      env: { ...env, RELAY_WORKLOAD_TEST_MODE: "1" },
    });
    assert.equal(acquired.ok, true);
    assert.equal(JSON.parse(readFileSync(acquired.lease.file, "utf8")).job_id, "race-job");
    workload.releaseProviderWorkloadLease(acquired.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(moduleRoot, { recursive: true, force: true });
  }
});

test("provider workload gate recovers when the lock root vanishes mid-acquire instead of hot-looping", async () => {
  const { root, env } = tempEnv();
  const raceEnv = { ...env, RELAY_PROVIDER_WORKLOAD_GATE_TIMEOUT_MS: "750" };
  const moduleRoot = mkdtempSync(join(tmpdir(), "provider-workload-root-vanish-module-"));
  try {
    const source = readFileSync(new URL("../../scripts/lib/review-workload.mjs", import.meta.url), "utf8");
    const shimPath = join(moduleRoot, "fs-root-vanish-shim.mjs");
    const modulePath = join(moduleRoot, "review-workload-root-vanish.mjs");
    writeFileSync(shimPath, `
import * as fs from "node:fs";

export const chmodSync = fs.chmodSync;
export const existsSync = fs.existsSync;
export const linkSync = fs.linkSync;
export const lstatSync = fs.lstatSync;
export const readdirSync = fs.readdirSync;
export const readFileSync = fs.readFileSync;
export const renameSync = fs.renameSync;
export const rmSync = fs.rmSync;
export const unlinkSync = fs.unlinkSync;
export const writeFileSync = fs.writeFileSync;

let injected = false;

export function mkdirSync(path, options) {
  const p = String(path);
  if (!injected && p.endsWith(".json.gate")) {
    injected = true;
    // Concurrent teardown removes the whole lock root exactly as we try to create
    // the gate dir: the gate mkdir then fails ENOENT because its parent is gone.
    fs.rmSync(p.slice(0, p.lastIndexOf("/")), { recursive: true, force: true });
    const error = new Error("injected mkdir ENOENT (lock root vanished)");
    error.code = "ENOENT";
    error.syscall = "mkdir";
    throw error;
  }
  return fs.mkdirSync(path, options);
}
`, "utf8");
    writeFileSync(
      modulePath,
      source
        .replace('from "node:fs";', `from ${JSON.stringify(pathToFileURL(shimPath).href)};`)
        .replace('from "./process-identity.mjs";', `from ${JSON.stringify(new URL("../../scripts/lib/process-identity.mjs", import.meta.url).href)};`),
      "utf8",
    );

    const workload = await import(pathToFileURL(modulePath).href);
    const acquired = workload.acquireProviderWorkloadLease({
      concurrencyKey: "grok",
      limit: 1,
      lockRoot: root,
      jobId: "root-vanish-job",
      cwd: "/tmp/root-vanish",
      sourceBearing: true,
      env: { ...raceEnv, RELAY_WORKLOAD_TEST_MODE: "1" },
    });
    assert.equal(acquired.ok, true,
      "must re-establish the vanished lock root and acquire, not spin the catch loop to the deadline");
    assert.equal(JSON.parse(readFileSync(acquired.lease.file, "utf8")).job_id, "root-vanish-job");
    workload.releaseProviderWorkloadLease(acquired.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(moduleRoot, { recursive: true, force: true });
  }
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

test("legacy lock and slot-0 are distinct holders: both count toward the limit (no over-admit)", () => {
  const { root, env } = tempEnv();
  try {
    // The legacy single-flight lock (<slug>.json, mapped to index 0) and <slug>.slot-0.json are
    // DISTINCT holders during a mixed-version deploy (new code never writes the legacy path). They
    // must BOTH count, or limit>1 over-admits a source-bearing job. Deduping by index undercounts.
    writeFileSync(join(root, "k.json"), JSON.stringify(holder({ pid: 201 }))); // legacy holder A
    writeSlot(root, 0, { pid: 202 }); // slot-0 holder B (distinct pid/token)

    const blocked = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      limit: 2,
      env: { ...env, RELAY_WORKLOAD_TEST_MODE: "1", RELAY_BOOT_ID: "BOOT" },
      capture: matchingCapture,
    }));
    assert.equal(blocked.ok, false, "two distinct index-0 holders must count as two, not one");
    assert.deepEqual(blocked.capacity, { active_count: 2, limit: 2 });

    // At limit 3 the same two holders count as two, so a third is admitted at the next free index.
    const admitted = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      limit: 3,
      env: { ...env, RELAY_WORKLOAD_TEST_MODE: "1", RELAY_BOOT_ID: "BOOT" },
      capture: matchingCapture,
    }));
    assert.equal(admitted.ok, true);
    assert.match(admitted.lease.file, /k\.slot-1\.json$/);
    releaseProviderWorkloadLease(admitted.lease);
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

test("foreign-host gate owner is never reclaimed even when stale (fail-closed; wall-clock reclaim removed)", () => {
  const { root, env } = tempEnv();
  try {
    // F3 made the gate match slots: a foreign-host owner classifies "foreign" -> active, and the old
    // defensive wall-clock reclaim branch was removed (reclaiming a holder possibly live on another
    // host sharing the lock dir would over-admit source-bearing diffs). Backdate the gate dir so a
    // wall-clock policy WOULD reclaim it — proving the current code does NOT.
    writeGateOwner(root, currentProcessGateOwner({ hostname: "some-other-host", pid: 401 }));
    const gateDir = join(root, "k.json.gate");
    const longAgoSec = Date.now() / 1000 - 3600;
    utimesSync(gateDir, longAgoSec, longAgoSec);
    const captureError = () => { throw new Error("capture_error: foreign gate owner must not be inspected"); };

    const blocked = acquireProviderWorkloadLease(ctx({
      lockRoot: root,
      limit: 1,
      env: {
        ...env,
        RELAY_WORKLOAD_TEST_MODE: "1",
        RELAY_BOOT_ID: "CURRENT",
        RELAY_PROVIDER_WORKLOAD_GATE_TIMEOUT_MS: "60",
      },
      capture: captureError,
    }));

    assert.equal(blocked.ok, false, "stale foreign gate owner must NOT be wall-clock reclaimed");
    assert.equal(blocked.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
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

test("concurrencyAdmissionBlockedExecution classifies the failure without leaking the raw error (paths/identity)", () => {
  // resolveConcurrencyAdmission can throw a shared_state-identity failure whose
  // message embeds an absolute config-dir path (e.g. ENOENT ... stat '/abs/dir').
  // The shared helper must classify by reason and name only provider.route —
  // never forward that raw OS detail into the disclosed/persisted record (§8).
  const execution = concurrencyAdmissionBlockedExecution("claude", "subscription");
  assert.equal(execution.payload_sent, false);
  assert.equal(execution.parsed.reason, PROVIDER_WORKLOAD_BLOCKED_CODE);
  assert.deepEqual(execution.diagnostics.provider_workload, {
    reason: "concurrency_admission_failed",
    capacity: null,
  });
  assert.match(
    execution.errorMessage,
    /^provider_workload_blocked: concurrency admission failed for claude\.subscription$/,
  );
  // No filesystem path, ENOENT, or stat detail anywhere in the record. (A revert
  // to the old `(error, provider, route)` + `: ${detail}` signature would shift
  // the args and break the exact-message match above.)
  assert.doesNotMatch(
    JSON.stringify(execution),
    /ENOENT|stat |\/(?:Users|home|tmp|private|var)\//,
    "concurrency-admission disclosure must not forward filesystem paths or raw OS error detail",
  );
});

workloadTest("a corrupt/unreadable gate owner is timeout-gated, not reclaimed immediately (fail-closed)", () => {
  const { root, env } = tempEnv();
  try {
    const slug = "k";
    const gateDir = join(root, `${slug}.json.gate`);
    mkdirSync(gateDir, { recursive: true, mode: 0o700 });
    // A live holder whose owner.json is unparseable. With the fail-open bug this
    // is reclaimed on the FIRST inspection (no liveness proof, no timeout); fixed,
    // it must wait for the gate to age past the timeout — matching inspectSlot's
    // fail-closed treatment of an unparseable slot file.
    writeFileSync(join(gateDir, "owner.json"), "{ this is not valid json");
    // Age the gate so reclaim fires well before the acquire deadline (no boundary
    // race), but still only AFTER the timeout — proving it waited rather than
    // reclaiming immediately.
    const aged = new Date(Date.now() - 200);
    utimesSync(gateDir, aged, aged);
    const acquireEnv = { ...env, RELAY_PROVIDER_WORKLOAD_GATE_TIMEOUT_MS: "800" };
    const start = Date.now();
    const lease = acquireProviderWorkloadLease({
      concurrencyKey: slug, limit: 1, lockRoot: root, jobId: "after-corrupt",
      cwd: "/tmp/w", sourceBearing: true, env: acquireEnv,
    });
    const elapsed = Date.now() - start;
    try {
      assert.equal(lease.ok, true, "a corrupt gate owner must eventually reclaim after the timeout (no permanent deadlock)");
      // "At least" is robust to load (load only makes acquisition slower). With
      // the fail-open bug elapsed ≈ 0; fixed it waits ~600ms (800ms timeout minus
      // the 200ms pre-aging).
      assert.ok(elapsed >= 400, `corrupt gate owner must be timeout-gated, not immediately reclaimed; elapsed=${elapsed}ms`);
    } finally {
      if (lease.lease) releaseProviderWorkloadLease(lease.lease);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

workloadTest("the gate owner.json production WRITE persists real liveness identity (pid-reuse + boot-id)", () => {
  // Behavioral counterpart to the source-literal guard above. The gate owner is
  // written then released inside the acquire critical section, so it is observed
  // here by calling the exported gate primitive directly. If pidInfo fails to
  // thread through to writeGateOwner, starttime/argv0 land null on disk and a
  // crashed gate owner (reused pid reads "alive") becomes unreclaimable.
  const { root, env } = tempEnv();
  try {
    const gateBase = join(root, "k.json");
    const pidInfo = capturePidInfo(process.pid);
    const gate = acquireProviderWorkloadGate(gateBase, env, undefined, pidInfo);
    try {
      assert.equal(gate.ok, true, "gate must be acquirable on a clean root");
      const owner = JSON.parse(readFileSync(join(`${gateBase}.gate`, "owner.json"), "utf8"));
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.starttime, pidInfo.starttime, "gate owner must record the real starttime (PID-reuse detection)");
      assert.equal(owner.argv0, pidInfo.argv0, "gate owner must record the real argv0 (PID-reuse detection)");
      assert.ok(typeof owner.boot_id === "string" && owner.boot_id.length > 0, "gate owner must record boot_id (stale-boot reclaim)");
    } finally {
      gate.release?.();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
