// P8-wl1: Cross-host workload-lease liveness reproduction.
// CLAIM (Root 5): holderActive() returns true UNCONDITIONALLY for a foreign-host
// holder (no pid/mtime/timeout), so a stale lease from another host blocks all
// source-bearing reviews forever. CONTROL: identical lease with local hostname is
// reclaimed (stale-local path uses pidAlive()).
//
// Strategy: drive the REAL acquireProviderWorkloadLease() against a real on-disk
// lease file at the real lease path. Point the lock dir at an isolated tmp dir via
// the documented RELAY_PROVIDER_WORKLOAD_LOCK_DIR env so we never touch the shared
// default. Plant a lease with hostname=other-host / dead pid / ancient mtime, then
// observe whether acquire is blocked and whether the lease is reclaimed on retry.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireProviderWorkloadLease,
  PROVIDER_WORKLOAD_BLOCKED_CODE,
} from "../../lib/review-workload.mjs";

const PROVIDER = "agy";
const SLUG = "agy";
const DEAD_PID = 999999; // not a live process on this host
const ANCIENT_EPOCH_S = 1; // ~1970, far past any timeout

function plantLease(lockDir, host) {
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const file = join(lockDir, `${SLUG}.json`);
  const payload = {
    schema_version: 1,
    provider: PROVIDER,
    provider_slug: SLUG,
    job_id: "stale-job-from-elsewhere",
    pid: DEAD_PID,
    hostname: host,
    cwd: "/somewhere/else",
    started_at: "1970-01-01T00:00:01.000Z",
    token: "planted-stale-token",
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // backdate mtime so any age-based check would treat it as ancient
  utimesSync(file, ANCIENT_EPOCH_S, ANCIENT_EPOCH_S);
  return file;
}

function runArm(label, host) {
  const lockDir = mkdtempSync(join(tmpdir(), `p8wl1-${label}-`));
  const env = { ...process.env, RELAY_PROVIDER_WORKLOAD_LOCK_DIR: lockDir };
  const leaseFile = plantLease(lockDir, host);

  const acquired = [];
  let res1, res2;
  try {
    res1 = acquireProviderWorkloadLease({ provider: PROVIDER, jobId: "live-job-1", env });
    if (res1?.ok) acquired.push(res1.lease);
    // retry to test "still blocked / no liveness fallback"
    res2 = acquireProviderWorkloadLease({ provider: PROVIDER, jobId: "live-job-2", env });
    if (res2?.ok) acquired.push(res2.lease);
  } finally {
    // do not call releaseProviderWorkloadLease — we want to inspect raw disk state first
  }

  const fileExists = existsSync(leaseFile);
  let onDisk = null;
  try { onDisk = JSON.parse(readFileSync(leaseFile, "utf8")); } catch { onDisk = null; }

  console.log(`\n=== ARM: ${label} (planted hostname=${JSON.stringify(host)}) ===`);
  console.log(`  current host          : ${hostname()}`);
  console.log(`  attempt#1 ok          : ${res1?.ok === true}`);
  console.log(`  attempt#1 error_code  : ${res1?.error_code ?? "(none)"}`);
  console.log(`  attempt#1 reason      : ${res1?.reason ?? "(none)"}`);
  console.log(`  attempt#1 holder.host : ${res1?.holder?.hostname ?? "(n/a)"}`);
  console.log(`  attempt#2 (retry) ok  : ${res2?.ok === true}`);
  console.log(`  attempt#2 error_code  : ${res2?.error_code ?? "(none)"}`);
  console.log(`  lease file still exists: ${fileExists}`);
  console.log(`  on-disk token         : ${onDisk?.token ?? "(gone)"}`);
  const reclaimed = onDisk?.token !== "planted-stale-token";
  console.log(`  PLANTED LEASE RECLAIMED: ${reclaimed}`);

  // cleanup
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }

  return {
    label,
    blocked: res1?.ok !== true && res1?.error_code === PROVIDER_WORKLOAD_BLOCKED_CODE,
    retryBlocked: res2?.ok !== true,
    reclaimed,
  };
}

console.log(`BLOCK CODE constant: ${PROVIDER_WORKLOAD_BLOCKED_CODE}`);

const foreign = runArm("foreign-host", "other-host-totally-different");
const local = runArm("control-local", hostname());

console.log(`\n=== VERDICT ===`);
console.log(`foreign-host: blocked=${foreign.blocked} retryBlocked=${foreign.retryBlocked} reclaimed=${foreign.reclaimed}`);
console.log(`control-local: blocked=${local.blocked} retryBlocked=${local.retryBlocked} reclaimed=${local.reclaimed}`);

const pinned =
  foreign.blocked && foreign.retryBlocked && !foreign.reclaimed && // foreign blocks forever
  !local.blocked && local.reclaimed; // local stale is reclaimed

console.log(`\nPINNED (foreign blocks + no reclaim, local control reclaims): ${pinned}`);
if (foreign.reclaimed) console.log("REFUTED: foreign-host lease was reclaimed.");
