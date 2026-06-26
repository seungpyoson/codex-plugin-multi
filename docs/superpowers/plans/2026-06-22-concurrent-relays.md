# Concurrent Relays (#234) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global single-flight provider workload lock with a bounded, capability-driven, file-based counting semaphore so multiple source-bearing relays for the same provider run concurrently when (and only when) the execution model is safe.

**Architecture:** Generalize the existing gate (`mkdir` mutex + `owner.json` token) + lease (`linkSync` hardlink) in `scripts/lib/review-workload.mjs` into per-key **slot files** with all-slot accounting under the gate. A resolver in `scripts/lib/provider-route-policy.mjs` turns declarative per-route capability facts into a `{concurrencyKey, limit, lockRoot}` admission context. Liveness moves to a synced `scripts/lib/process-identity.mjs` using the existing `{pid, starttime, argv0}` model plus a host boot-id for reboot-proven reclaim. The engine stays provider-agnostic.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`, `node:fs` (sync APIs), `node:crypto` (`randomUUID`, `createHash`). No new runtime dependencies.

**Authoritative design:** `docs/superpowers/specs/2026-06-22-concurrent-relays-design.md` (the "spec"). Section refs below (§N) point there. Read it before starting.

## Global Constraints

- **Canonical-source + sync:** edit only `scripts/lib/*.mjs`; regenerate the 5 plugin copies with `npm run lint:sync` (write mode); `npm run lint:sync --check` (CI form) must exit 0; commit canonical libs + regenerated copies **together** (partial sync fails `tests/unit/plugin-copies-in-sync.test.mjs`).
- **Regenerate `relay/` build artifacts after ANY lib change** (discovered during Task 1): `relay/relay-*` is build output produced by `npm run build:relay` (and `npm run build:codex-relay`). A new/changed `scripts/lib/*.mjs` makes `relay/` stale and the `sync-relay-build --check` step in `lint:sync` fails. **Every lib-changing task must run `npm run build:relay` before `npm run lint`**, and commit the regenerated `relay/` files with the task.
- **Sync targets (verified):** `REVIEW_PROMPT_PLUGIN_TARGETS = [api-reviewers, claude, gemini, grok, kimi]` (`scripts/lib/plugin-targets.mjs`). DeepSeek/GLM are **configs inside `api-reviewers`**, not plugins.
- **Fail closed everywhere:** any unreadable/inconsistent/malformed admission state denies; never fail open into unbounded concurrency.
- **`limit` is a positive integer ≥ 1.** No `limit:0` / "unbounded" sentinel for source-bearing jobs. The only `{ok:true, lease:null}` is `sourceBearing !== true`.
- **`shared_state: true` ⇒ `limit === 1` is unrepresentable otherwise** (resolver throws).
- **No provider-specific hardcodes** outside the declarative capability table.
- **Capacity external response = counts only** (`active_count`, `limit`); job ids/holders are debug-log only.
- **Single-host, local-disk** lock root; no cross-host coordination.
- **`lib/` shared-state code requires unit tests before merge** (repo testing rule).
- Tests run via `npm test` (`node scripts/ci/run-tests.mjs`); full suite `npm run test:full`. Lint via `npm run lint`.

---

## File map

| File | Responsibility | Action |
|---|---|---|
| `scripts/lib/process-identity.mjs` | Canonical liveness: `capturePidInfo`, `currentBootId` (clock-independent boot-session id), `holderActive`; `classifyHolder` 4-state disposition added in Task 2 for the reclaim scan | Create (move from kimi `identity.mjs`) |
| `scripts/ci/sync-process-identity.mjs` | Copy `process-identity.mjs` → 5 plugins | Create |
| `plugins/kimi/scripts/lib/identity.mjs` | Re-export `capturePidInfo` from shared lib (no logic dup) | Modify |
| `scripts/lib/review-workload.mjs` | Counting semaphore: slot family, all-slot accounting, boot-id reclaim, resolver-supplied lockRoot, capacity, legacy migration | Modify (core) |
| `scripts/lib/provider-route-policy.mjs` | `resolveConcurrencyAdmission()` + concurrency facts table + fail-closed validation; resend-guard tests pin existing behavior | Modify |
| `plugins/api-reviewers/scripts/api-reviewer.mjs` | DeepSeek/GLM stateless facts; resolve+pass context; fail-loud assert | Modify (consumer) |
| `plugins/kimi/scripts/kimi-companion.mjs` | shared_state fact (`~/.kimi`); resolve+pass; fail-loud assert | Modify (consumer) |
| `plugins/gemini/scripts/gemini-companion.mjs` | shared_state fact (`~/.gemini`) | Modify (consumer) |
| `plugins/claude/scripts/claude-companion.mjs` | shared_state fact | Modify (consumer) |
| `plugins/grok/scripts/grok-web-reviewer.mjs` | grok-CLI + grok-web shared_state facts (dual-mode identity) | Modify (consumer) |
| `package.json` | add `sync-process-identity` to `lint:sync` chain | Modify |
| `docs/provider-parity-table.json` (+ schema) | "concurrency budget" audited row | Modify |
| `tests/unit/review-workload.test.mjs` | semaphore unit tests | Modify |
| `tests/unit/process-identity.test.mjs` | liveness/boot-id unit tests | Create |
| `tests/unit/review-workload-multiprocess.test.mjs` | fork-based stress test | Create |
| `tests/unit/provider-route-policy.test.mjs` | resolver + resend-guard tests | Modify |
| `tests/unit/plugin-copies-in-sync.test.mjs` | assert `process-identity.mjs` copied | Modify |

**Land order (§11):** Task 1 (process-identity) → Task 2 (semaphore core) → Task 3 (multi-process test) → Task 4 (resolver) → Task 5 (resend-guard tests) → Task 6 (all 5 consumers, atomic) → Task 7 (limit values) → Task 8 (sync regen + parity) → Task 9 (follow-up issue). Tasks 2's deliverable depends on Task 1; Task 6 depends on Task 4; consumer plumbing lands together in Task 6.

---

## Task 1: Promote liveness to `scripts/lib/process-identity.mjs` + boot-id

**Files:**
- Create: `scripts/lib/process-identity.mjs`
- Create: `scripts/ci/sync-process-identity.mjs`
- Create: `tests/unit/process-identity.test.mjs`
- Modify: `plugins/kimi/scripts/lib/identity.mjs` (re-export, drop the duplicated body)
- Modify: `package.json` (`lint:sync` chain), `tests/unit/plugin-copies-in-sync.test.mjs`

**Interfaces — Produces:**
- `capturePidInfo(pid) -> {pid, starttime, argv0}` — throws `Error` prefixed `process_gone:` / `capture_error:` / `invalid_pid:` (moved verbatim from `plugins/kimi/scripts/lib/identity.mjs:47`).
- `currentBootId(env = process.env) -> string` — stable per boot, cheap, darwin+linux.
- `holderActive(holder, env) -> boolean` — true iff same-host AND `capturePidInfo(holder.pid)` succeeds AND `{starttime, argv0}` match; on any thrown `capture_error`/`process_gone` it returns **true** (occupied/fail-closed) — death is proven only by the boot-id path, not here.

- [ ] **Step 1: Write the failing test for boot-id stability**

Create `tests/unit/process-identity.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { capturePidInfo, currentBootId, holderActive } from "../../scripts/lib/process-identity.mjs";

test("currentBootId is stable within a process and non-empty", () => {
  const a = currentBootId();
  const b = currentBootId();
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test("capturePidInfo returns {pid,starttime,argv0} for the live self pid", () => {
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

test("holderActive treats a dead-but-recycled pid (starttime mismatch) as inactive", () => {
  const self = capturePidInfo(process.pid);
  const stale = { hostname: (await import("node:os")).hostname(), pid: process.pid, starttime: "0", argv0: self.argv0 };
  assert.equal(holderActive(stale, process.env), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/process-identity.test.mjs`
Expected: FAIL — module `scripts/lib/process-identity.mjs` does not exist.

- [ ] **Step 3: Create `scripts/lib/process-identity.mjs`**

Move the `capturePidInfo` implementation (and its `captureLinux`/`captureDarwin` helpers and imports) **verbatim** from `plugins/kimi/scripts/lib/identity.mjs:47`+ into the new file and `export` it. Add:

```javascript
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";

// ... capturePidInfo + captureLinux + captureDarwin moved verbatim ...

let CACHED_BOOT_ID = null;
export function currentBootId(env = process.env) {
  if (env.RELAY_BOOT_ID) return String(env.RELAY_BOOT_ID); // test override
  if (CACHED_BOOT_ID) return CACHED_BOOT_ID;
  if (process.platform === "linux") {
    try { CACHED_BOOT_ID = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
    catch { /* fall through */ }
  }
  if (!CACHED_BOOT_ID && process.platform === "darwin") {
    // kern.bootsessionuuid is clock-independent (regenerated ONLY at boot).
    // kern.boottime (= wall - uptime) shifts on NTP/clock steps and would
    // falsely "prove" a reboot, reclaiming a live slot — so it is only the fallback.
    const uuid = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
    if (!uuid.error && uuid.status === 0 && uuid.stdout.trim()) CACHED_BOOT_ID = uuid.stdout.trim();
    else {
      const bt = spawnSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
      if (!bt.error && bt.status === 0 && bt.stdout.trim()) CACHED_BOOT_ID = bt.stdout.trim();
    }
  }
  if (!CACHED_BOOT_ID) CACHED_BOOT_ID = `unknown-${hostname()}`; // never empty
  return CACHED_BOOT_ID;
}

export function holderActive(holder, env = process.env) {
  if (!holder || typeof holder !== "object") return false;
  if (holder.hostname && holder.hostname !== hostname()) return true; // foreign host => occupied, fail-closed
  let info;
  try { info = capturePidInfo(holder.pid); }
  catch (e) {
    // capture_error (sandbox/hidepid) => occupied/fail-closed; process_gone => dead.
    return !String(e?.message ?? "").startsWith("process_gone");
  }
  if (holder.starttime != null && String(info.starttime) !== String(holder.starttime)) return false;
  if (holder.argv0 != null && String(info.argv0) !== String(holder.argv0)) return false;
  return true;
}
```

- [ ] **Step 4: Make kimi re-export (no logic duplication)**

In `plugins/kimi/scripts/lib/identity.mjs`, replace the inline `capturePidInfo` body with `export { capturePidInfo } from "./process-identity.mjs";` (the synced copy sits beside it). Keep kimi's other exports intact.

- [ ] **Step 5: Create the sync script**

Create `scripts/ci/sync-process-identity.mjs` modeled exactly on `scripts/ci/sync-review-workload.mjs` (same `--check`/write contract, same `REVIEW_PROMPT_PLUGIN_TARGETS` import from `scripts/lib/plugin-targets.mjs`, same source/dest pattern, copying `scripts/lib/process-identity.mjs` → `plugins/<t>/scripts/lib/process-identity.mjs`).

- [ ] **Step 6: Wire into `lint:sync` + plugin-copies test**

In `package.json`, append `&& node scripts/ci/sync-process-identity.mjs --check` to the `lint:sync` value. In `tests/unit/plugin-copies-in-sync.test.mjs`, add `process-identity.mjs` to the synced-file assertions next to `review-workload.mjs`.

- [ ] **Step 7: Regenerate copies + run tests**

Run: `npm run lint:sync` (write) then `node --test tests/unit/process-identity.test.mjs tests/unit/plugin-copies-in-sync.test.mjs tests/unit/identity.test.mjs`
Expected: PASS. Then `npm run lint:sync` (the `--check` chain via `npm run lint`) exits 0.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/process-identity.mjs scripts/ci/sync-process-identity.mjs package.json \
  plugins/*/scripts/lib/process-identity.mjs plugins/kimi/scripts/lib/identity.mjs \
  tests/unit/process-identity.test.mjs tests/unit/plugin-copies-in-sync.test.mjs
git commit -m "feat(workload): promote process liveness + boot-id to synced scripts/lib/process-identity.mjs"
```

---

## Task 2: Counting semaphore in `scripts/lib/review-workload.mjs`

**Files:**
- Modify: `scripts/lib/review-workload.mjs`
- Modify: `tests/unit/review-workload.test.mjs`

**Interfaces:**
- Consumes: `capturePidInfo`, `currentBootId` from `./process-identity.mjs` (Task 1).
- **Adds to `./process-identity.mjs` (then re-syncs it via `sync-process-identity.mjs` + `build:relay`):** `classifyHolder(holder, env = process.env, capture = capturePidInfo) -> 'alive' | 'dead' | 'unverifiable' | 'foreign'`. **Why this is required:** the existing `holderActive` boolean collapses `alive`/`unverifiable`/`foreign` → `true`, so it **cannot drive reclaim** — it can't distinguish an `unverifiable` (`capture_error`, reclaimable ONLY on a stale boot-id) slot from a genuinely `alive` one. Using `holderActive` for the reclaim scan would either deadlock (never reclaim unverifiable slots) or corrupt (reclaim a live holder). Keep `holderActive` as a thin wrapper = `classifyHolder(...) !== 'dead'` for any existing callers.
  - **Throw→state mapping (matches the pre-#234 `pidAlive`, do NOT regress it):** `process_gone` **and** `invalid_pid` (0 / negative / non-integer — a corrupt or legacy sentinel pid that can never be a live process) → **`dead`** (safe to reclaim: cannot over-admit a live holder). ONLY `capture_error` (a real pid we cannot inspect — sandbox/hidepid/EACCES) → **`unverifiable`** (fail closed; reclaimable only on a stale boot-id). The old single-flight reclaimed invalid/zero pids (`pidAlive` returned `false` for `pid <= 0`); mapping `invalid_pid → unverifiable` is a **regression** that deadlocks legacy/corrupt slots.
  - **`capture` injection seam:** the third param defaults to `capturePidInfo`; tests inject a function that throws `capture_error: …` to exercise the `unverifiable` branch deterministically on every platform (a real `capture_error` pid cannot be forced portably). Add `classifyHolder` unit tests to `tests/unit/process-identity.test.mjs`: alive→self pid; dead→starttime mismatch; **dead→invalid pid (`0`/`"not-a-pid"`)**; **unverifiable→injected `capture_error` throw**; foreign→other hostname.
- Produces: `acquireProviderWorkloadLease({ concurrencyKey, limit, lockRoot, jobId, cwd, sourceBearing, env }) -> {ok:true, lease}|{ok:true, lease:null}|{ok:false, error_code, reason, message, capacity}`. `lease = { file, token }` (plus non-enumerable exit listener). `releaseProviderWorkloadLease(lease) -> boolean`. `providerWorkloadBlockedExecution(block)` carries `capacity:{active_count, limit}` in diagnostics (counts only; holder ids debug-log only). Backward-compat: `provider` is still accepted and, when `concurrencyKey` is absent, the engine throws (no silent fallback) — see Task 6 for consumer wiring.

Behavior is defined by §4, §5.2 (engine obeys supplied `lockRoot`, no internal `RELAY_PROVIDER_WORKLOAD_LOCK_DIR` read when `lockRoot` is provided), §6, §8 of the spec. The tests below are the contract.

- [ ] **Step 1: Write failing tests — bounded admission + limit=1 golden + capacity**

Add to `tests/unit/review-workload.test.mjs` (reuse the existing `tempEnv()` helper but pass `lockRoot` explicitly):

```javascript
function ctx(over = {}) {
  return { concurrencyKey: "k", limit: 1, lockRoot: over.lockRoot, jobId: "j", cwd: "/tmp/w", sourceBearing: true, env: over.env, ...over };
}

test("limit=1 still single-flights (golden, byte-behaviour identical)", () => {
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("limit=N admits N and blocks N+1 with capacity", () => {
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("distinct concurrencyKeys never contend", () => {
  const { root } = tempEnv();
  try {
    const a = acquireProviderWorkloadLease(ctx({ lockRoot: root, concurrencyKey: "kimi", limit: 1 }));
    const b = acquireProviderWorkloadLease(ctx({ lockRoot: root, concurrencyKey: "deepseek.api", limit: 1 }));
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    releaseProviderWorkloadLease(a.lease); releaseProviderWorkloadLease(b.lease);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Write failing tests — fail-closed limit + lockRoot obedience + capacity hides ids**

```javascript
test("limit < 1 / non-integer denies for source-bearing (fail-closed)", () => {
  const { root } = tempEnv();
  try {
    for (const bad of [0, -1, 1.5, NaN, "2"]) {
      const r = acquireProviderWorkloadLease(ctx({ lockRoot: root, limit: bad }));
      assert.equal(r.ok, false, `limit ${bad} must deny`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine uses supplied lockRoot and ignores RELAY_PROVIDER_WORKLOAD_LOCK_DIR", () => {
  const { root } = tempEnv();
  const decoy = mkdtempSync(join(tmpdir(), "decoy-"));
  try {
    const a = acquireProviderWorkloadLease(ctx({ lockRoot: root, env: { RELAY_PROVIDER_WORKLOAD_LOCK_DIR: decoy } }));
    assert.equal(a.ok, true);
    // The lease file lives under the supplied lockRoot, not the env decoy.
    assert.ok(a.lease.file.startsWith(root));
    releaseProviderWorkloadLease(a.lease);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(decoy, { recursive: true, force: true }); }
});

test("capacity exposes counts only, never job ids/holders", () => {
  const { root } = tempEnv();
  try {
    const a = acquireProviderWorkloadLease(ctx({ lockRoot: root, limit: 1, jobId: "secret-job" }));
    const b = acquireProviderWorkloadLease(ctx({ lockRoot: root, limit: 1, jobId: "other" }));
    assert.equal(b.ok, false);
    assert.deepEqual(Object.keys(b.capacity).sort(), ["active_count", "limit"]);
    assert.ok(!JSON.stringify(b.capacity).includes("secret-job"));
    releaseProviderWorkloadLease(a.lease);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 3: Run to verify failures**

Run: `node --test tests/unit/review-workload.test.mjs`
Expected: FAIL — current signature/behaviour does not match (`capacity` undefined, lockRoot ignored, etc.).

- [ ] **Step 4: Implement the slot-family semaphore**

Modify `scripts/lib/review-workload.mjs` per §4/§6/§8. Key changes (keep the gate, `tryCreateLeaseFile` link-atomicity, exit-listener, and token-sealed `removeInactiveHolder` intact):
- `import { classifyHolder, capturePidInfo, currentBootId } from "./process-identity.mjs";` (add `classifyHolder` to the lib per the Interfaces block above, then re-sync + `build:relay`) and **delete** the local `pidAlive`/`holderActive`.
- `lockRoot` comes from the admission context; `lockPath`/scan operate under it. Throw if `sourceBearing === true` and `concurrencyKey` is missing/empty.
- Validate `limit`: `Number.isSafeInteger(limit) && limit >= 1` else return a block (fail-closed).
- `slotPath(lockRoot, key, i)` → `<lockRoot>/<keyslug>.slot-<i>.json`. Payload adds `{starttime, argv0}` (from `capturePidInfo(process.pid)`) and `boot_id` (`currentBootId(env)`).
- Acquire under the gate: enumerate **all** existing `<keyslug>.slot-*.json` (glob via `readdirSync(lockRoot)` filtered by prefix), classify each via `classifyHolder` → `alive`|`dead`|`unverifiable`|`foreign`. **Reclaim policy:** `dead` → `removeInactiveHolder` (always); `unverifiable` (`capture_error`) → reclaim **only** if its recorded `boot_id !== currentBootId(env)` (reboot proven), else treat as occupied; `foreign` → occupied, **never** reclaimed (single-host design); `alive` → occupied. `activeCount` = count of slots NOT reclaimed (alive + held-unverifiable + foreign) across **all** indices; if `activeCount >= limit` return `blockResult(... capacity:{active_count, limit})`; else claim lowest free index `0..` (first index with no occupant after reclaim), `tryCreateLeaseFile`.
- `providerWorkloadBlockedExecution` adds `capacity` (counts only) to `diagnostics.provider_workload`; any holder/job-id detail goes only to a debug log path, never the returned object.
- Legacy: a pre-existing `<keyslug>.json` (old single-lock filename) is read as slot-0-equivalent (counts toward `activeCount` at limit 1) for one-time deploy compatibility.

- [ ] **Step 5: Run tests to verify pass**

Run: `node --test tests/unit/review-workload.test.mjs`
Expected: PASS (all, including the prior single-flight cases, semantically).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/review-workload.mjs tests/unit/review-workload.test.mjs
git commit -m "feat(workload): bounded counting semaphore with all-slot accounting + boot-id reclaim"
```

---

## Task 3: Multi-process + crash + reboot reclaim tests

**Files:** Create `tests/unit/review-workload-multiprocess.test.mjs`

Invariant #3 is inherently cross-process; in-process tests cannot prove it. Use child `node -e` processes against a shared `lockRoot`.

- [ ] **Step 1: Write the fork-based stress test**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ACQUIRE_SNIPPET = (root, limit, jobId, holdMs) => `
  import { acquireProviderWorkloadLease } from ${JSON.stringify(new URL("../../scripts/lib/review-workload.mjs", import.meta.url).pathname)};
  const r = acquireProviderWorkloadLease({ concurrencyKey: "k", limit: ${limit}, lockRoot: ${JSON.stringify(root)}, jobId: ${JSON.stringify(jobId)}, cwd: "/tmp", sourceBearing: true });
  if (!r.ok) { console.log("BLOCKED"); process.exit(0); }
  console.log("ACQUIRED");
  await new Promise((res) => setTimeout(res, ${holdMs}));
`;

test("at most `limit` processes hold concurrently", () => {
  const root = mkdtempSync(join(tmpdir(), "wl-mp-"));
  try {
    const limit = 2;
    const procs = Array.from({ length: 5 }, (_, i) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", ACQUIRE_SNIPPET(root, limit, `j${i}`, 400)], { encoding: "utf8" }));
    const acquired = procs.filter((p) => p.stdout.includes("ACQUIRED")).length;
    // Overlap window: with 5 racing acquires holding 400ms, no more than `limit` can ever co-hold.
    // Count live slot files at no point exceeds limit; here assert total acquired that overlapped <= limit
    assert.ok(acquired <= limit, `acquired=${acquired} must be <= ${limit}`);
    assert.equal(readdirSync(root).filter((f) => f.endsWith(".json")).length <= limit, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

> Note for the implementer: the precise "peak concurrency" assertion is easiest by having each child append its index to a shared file under the gate and asserting no line-window exceeds `limit`; refine in implementation. The minimal contract: **never more than `limit` concurrent ACQUIRED holders, and a SIGKILLed holder frees exactly one slot.**

- [ ] **Step 2: Add SIGKILL-frees-exactly-one + reboot-id tests**

```javascript
test("a SIGKILLed holder frees exactly one slot on the next acquire", () => {
  // spawn a holder that acquires then sleeps; SIGKILL it; assert a fresh acquire reclaims exactly that slot.
  // Use spawn (async) + process.kill(child.pid, "SIGKILL"); then acquire in-process and assert ok + slot count == 1.
});

test("unverifiable slot with a STALE boot_id is reclaimed; with the CURRENT boot_id is NOT", () => {
  const root = mkdtempSync(join(tmpdir(), "wl-boot-"));
  try {
    // Write a slot file with hostname=localhost, boot_id="STALE", whose holder
    // classifies as UNVERIFIABLE (capture_error), NOT invalid/dead.
    // Acquire with RELAY_BOOT_ID="CURRENT": the STALE slot is reclaimed (reboot proven) -> ok.
    // Write another with boot_id="CURRENT" + unverifiable holder: acquire -> BLOCKED (occupied, not reclaimed).
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

> **CRITICAL for the reboot-id test (post-Task-2 correction):** an invalid/zero/garbage pid now classifies as **`dead`** (reclaimed regardless of boot id), so it CANNOT stand in for an `unverifiable` holder. To get a deterministic `unverifiable` slot through the acquire path you must force `classifyHolder` down the `capture_error` branch. An invalid pid will silently make this test a no-op (it tests `dead`, not the boot-id path). Options, pick one: (a) thread an optional `capture` seam into `acquireProviderWorkloadLease`/`inspectSlot` (mirroring `classifyHolder(holder, env, capture)`) and inject a `capture_error`-throwing function; or (b) export `inspectSlot`/`shouldReclaimUnverifiable` and unit-test the boot-id branch directly with an injected capture. Do NOT rely on darwin-sandbox to produce `capture_error` — that skips on linux CI and leaves the boot-id reclaim path unexercised where it actually runs.

- [ ] **Step 3: Implement test bodies, run, verify pass**

Run: `node --test tests/unit/review-workload-multiprocess.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/review-workload-multiprocess.test.mjs
git commit -m "test(workload): multi-process bound + SIGKILL one-slot + reboot-id reclaim"
```

---

## Task 4: `resolveConcurrencyAdmission()` + capability facts + fail-closed validation

**Files:**
- Modify: `scripts/lib/provider-route-policy.mjs`
- Modify: `tests/unit/provider-route-policy.test.mjs`

**Interfaces — Produces:**
- `resolveConcurrencyAdmission({ category, declaredLimit, limitEnv, sharedStateIdentity, provider, route, env }) -> { concurrencyKey, limit, lockRoot }`. Throws (caller converts to a pre-send deny) when: `category` unknown; `category==='shared_state'` with `declaredLimit > 1`; `limit` not a positive int; `shared_state` with no resolvable `sharedStateIdentity`. `limitEnv` may only lower `limit`.
- A `CONCURRENCY_FACTS` table (or per-route lookup) declaring `{category, limit, limit_env}` per provider/route. Stateless default `limit: 4`.

Behavior is defined by §5/§5.1/§5.2. Identity hashing uses `createHash("sha256")` over the resolved dir's `st_dev:st_ino` (via `statSync`) for `shared_state`; lock root is host-stable (`$XDG_STATE_HOME` or `~/.local/state/relay/locks/v2`) and **ignores** `RELAY_PROVIDER_WORKLOAD_LOCK_DIR` for `shared_state` unless `RELAY_WORKLOAD_TEST_MODE` is set.

- [ ] **Step 1: Write failing tests**

```javascript
import { resolveConcurrencyAdmission } from "../../scripts/lib/provider-route-policy.mjs";

test("shared_state forces limit 1; declaredLimit>1 throws", () => {
  assert.throws(() => resolveConcurrencyAdmission({ category: "shared_state", declaredLimit: 2, sharedStateIdentity: "/tmp", provider: "kimi" }), /shared_state/);
});

test("stateless default 4; env cap can only lower", () => {
  const r = resolveConcurrencyAdmission({ category: "stateless", declaredLimit: 4, limitEnv: "X", provider: "deepseek", route: "api", env: { X: "2" } });
  assert.equal(r.limit, 2);
  const r2 = resolveConcurrencyAdmission({ category: "stateless", declaredLimit: 4, limitEnv: "X", provider: "deepseek", route: "api", env: { X: "99" } });
  assert.equal(r2.limit, 4); // cap-only: cannot raise above declared
});

test("malformed / unknown category / unresolvable identity deny (throw)", () => {
  assert.throws(() => resolveConcurrencyAdmission({ category: "bogus", provider: "x" }));
  assert.throws(() => resolveConcurrencyAdmission({ category: "shared_state", declaredLimit: 1, sharedStateIdentity: null, provider: "kimi" }), /identity/);
});

test("shared_state lock root ignores RELAY_PROVIDER_WORKLOAD_LOCK_DIR in production", () => {
  const a = resolveConcurrencyAdmission({ category: "shared_state", declaredLimit: 1, sharedStateIdentity: "/tmp/home", provider: "kimi", env: { RELAY_PROVIDER_WORKLOAD_LOCK_DIR: "/decoy" } });
  assert.ok(!a.lockRoot.startsWith("/decoy"));
});

test("two shared_state routes resolving to the same dir produce the same key", () => {
  const a = resolveConcurrencyAdmission({ category: "shared_state", declaredLimit: 1, sharedStateIdentity: "/tmp/shared", provider: "alias-a" });
  const b = resolveConcurrencyAdmission({ category: "shared_state", declaredLimit: 1, sharedStateIdentity: "/tmp/shared", provider: "alias-b" });
  assert.equal(a.concurrencyKey, b.concurrencyKey); // no provider prefix for shared_state
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/unit/provider-route-policy.test.mjs`
Expected: FAIL — `resolveConcurrencyAdmission` not exported.

- [ ] **Step 3: Implement the resolver + table**

Add `resolveConcurrencyAdmission()` and a frozen `CONCURRENCY_FACTS` map to `scripts/lib/provider-route-policy.mjs` per §5. `sharedStateIdentity` is hashed via `statSync(dir)` → `${st_dev}:${st_ino}` → sha256 (the caller passes an already-`mkdir -p`+`realpath`'d dir — Task 6). Stateless key = `${provider}.${route}`. Lock root helper computes the host-stable path; honors the env override only for `stateless` (or under `RELAY_WORKLOAD_TEST_MODE`).

- [ ] **Step 4: Run, verify pass; Step 5: Commit**

```bash
git add scripts/lib/provider-route-policy.mjs tests/unit/provider-route-policy.test.mjs
git commit -m "feat(policy): resolveConcurrencyAdmission + fail-closed concurrency facts"
```

---

## Task 5: Resend-guard regression tests (pin HEAD behaviour)

**Files:** Modify `tests/unit/provider-route-policy.test.mjs`

§7: `provider_workload_blocked` already classifies `not_sent` and does not gate at HEAD (PR #226). **No production code change** unless hardening; if `previousFailureRequiresResendGate` is touched, the sent-fact must win first (§7) — but the default plan is tests only.

- [ ] **Step 1: Write the golden + regression tests**

```javascript
test("admission-blocked retry does NOT require resend (every PRE_TARGET_NOT_SENT code)", () => {
  // For each code in PRE_TARGET_NOT_SENT_ERROR_CODES: a previousAttempt {status:"failed", error_code, source_content_transmission:"not_sent"}
  // => evaluateSourcePacketPolicy(...) must NOT set resend_confirmation_required.
});

test("a genuinely-sent post-transmission failure STILL requires resend (no over-relaxation)", () => {
  // previousAttempt {status:"failed", source_content_transmission:"sent"} (or "may_be_sent") => resend_confirmation_required true.
});

test("record disagreement (source_sent:true + not_sent) does not silently resolve toward send", () => {
  // assert it gates / emits diagnostic, never falls through to a plain send.
});
```

Use the public `evaluateSourcePacketPolicy` entrypoint (or whichever function the existing tests already drive) rather than the private helpers, so the test exercises the composed path.

- [ ] **Step 2: Run — expect PASS at HEAD** (this pins existing behaviour). If any fails, that is a real HEAD bug; stop and report.

Run: `node --test tests/unit/provider-route-policy.test.mjs`

- [ ] **Step 3: Commit**

```bash
git add tests/unit/provider-route-policy.test.mjs
git commit -m "test(policy): pin resend-guard not_sent classification for admission blocks"
```

---

## Task 6: Convert all 5 consumers (atomic) + capability facts + fail-loud

**Files:** Modify `plugins/api-reviewers/scripts/api-reviewer.mjs`, `plugins/kimi/scripts/kimi-companion.mjs`, `plugins/gemini/scripts/gemini-companion.mjs`, `plugins/claude/scripts/claude-companion.mjs`, `plugins/grok/scripts/grok-web-reviewer.mjs`.

§5/§11: every source-bearing consumer resolves+passes the admission context **in this one change**; an unconverted/unresolvable route hard-fails pre-send (no provider-name fallback).

**Per consumer pattern (apply to each):**
1. Before the `acquireProviderWorkloadLease` call, resolve the route's `category`. For `shared_state` routes: resolve the state dir, `mkdirSync(dir, {recursive:true})`, `realpathSync(dir)`, pass as `sharedStateIdentity`. (Grok-web dual-mode: managed tunnel → `GROK2API_HOME`; already-reachable tunnel → normalized endpoint + session-pool identity; deny if neither resolves — §10.)
2. `const adm = resolveConcurrencyAdmission({...})` wrapped in try/catch → on throw, produce a pre-send deny via `providerWorkloadBlockedExecution`-style failure (source NOT sent).
3. `acquireProviderWorkloadLease({ ...adm, jobId, cwd, sourceBearing: true })`.
4. **Fail-loud assert:** if `admission.ok && lease == null` for a source-bearing job → throw/exit(2) internal-invariant-violation (replaces the silent `if (ok) workloadLease = lease` at e.g. `api-reviewer.mjs:4342`).

- [ ] **Step 1: Convert `api-reviewer.mjs`** (DeepSeek/GLM `stateless`, key `${provider}.${route}`) at `~4336`; add the fail-loud assert.
- [ ] **Step 2: Convert `kimi-companion.mjs`** (`shared_state`, `~/.kimi` family resolved+mkdir+realpath) at `~1283`.
- [ ] **Step 3: Convert `gemini-companion.mjs`** (`shared_state`, `~/.gemini`).
- [ ] **Step 4: Convert `claude-companion.mjs`** (`shared_state`).
- [ ] **Step 5: Convert `grok-web-reviewer.mjs`** (grok-CLI `shared_state` `~/.grok`; grok-web `shared_state` dual-mode identity) at `~4874`.
- [ ] **Step 6: Run the per-consumer test suites + smokes**

Run: `node --test tests/unit/kimi-dispatcher.test.mjs tests/unit/gemini-dispatcher.test.mjs tests/unit/claude-dispatcher.test.mjs tests/unit/grok-transport-adapters.test.mjs` then `npm run test:full`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/*/scripts/*.mjs
git commit -m "feat(consumers): resolve+pass admission context atomically across all 5 adapters; fail-loud on null lease"
```

---

## Task 7: Opt limit values (DeepSeek/GLM → 4)

**Files:** the `CONCURRENCY_FACTS` table in `scripts/lib/provider-route-policy.mjs`.

- [ ] **Step 1:** Set DeepSeek/GLM stateless routes to `limit: 4` with a `limit_env` cap (e.g. `RELAY_DEEPSEEK_MAX_CONCURRENT`, `RELAY_GLM_MAX_CONCURRENT`). All subscription/grok routes stay `limit: 1`.
- [ ] **Step 2:** Add/extend a resolver test asserting DeepSeek/GLM resolve to `limit 4` and that the env cap lowers it.
- [ ] **Step 3: Commit** `feat(policy): enable bounded concurrency (limit 4) for DeepSeek/GLM`.

---

## Task 8: Sync regen + parity table + full gate

**Files:** regenerated `plugins/*/scripts/lib/{review-workload,provider-route-policy,process-identity}.mjs`; `docs/provider-parity-table.json` (+ `docs/contracts/provider-parity-table.schema.json`).

- [ ] **Step 1:** Add a "concurrency budget" domain/row to the parity table (+ schema) recording each provider/route's `category` + `limit` so facts are audited declaratively. Update `tests/unit/*parity*`/`docs-contracts.test.mjs` as the schema requires.
- [ ] **Step 2:** `npm run lint:sync` (write) to regenerate all copies.
- [ ] **Step 3:** Run the full gate:

Run: `npm run lint` (includes `lint:sync --check`) and `npm run test:full`
Expected: both exit 0 / all pass. (Per memory, also confirm CI green after push — local-green ≠ CI-green.)

- [ ] **Step 4: Commit** `chore(sync): regenerate plugin copies + parity-table concurrency row`.

---

## Task 9: Deferred follow-up issue (consolidated)

- [ ] Create ONE GitHub issue (per the "one consolidated follow-up" rule) capturing §12: (1) global aggregate cap across providers (compose `acquire global→key`/`release key→global`); (2) external multi-host coordinator (only if a real requirement appears); (3) Grok-web concurrency proof before raising its limit above 1. Link `Related to #234`.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3 D1/D2/D3 → Tasks 4/6/7; §4 semaphore → Task 2; §5 facts/resolver → Task 4; §5.1 identity → Tasks 4+6; §5.2 lock root → Tasks 2+4; §6 liveness/boot-id → Tasks 1+2+3; §7 resend → Task 5; §8 capacity → Task 2; §9 tests → Tasks 2/3/4/5/6/8; §10 files → all tasks; §11 rollout order → task ordering; §12 follow-ups → Task 9. No gaps.
- **Placeholder scan:** test bodies in Task 3 Steps 2 are intentionally described (multi-process timing harness) with an explicit minimal contract; all other steps carry concrete code. Flagged for the implementer.
- **Type consistency:** admission context `{concurrencyKey, limit, lockRoot}` is uniform across Tasks 2/4/6; `resolveConcurrencyAdmission` return shape matches `acquireProviderWorkloadLease` input; `capturePidInfo`/`holderActive`/`currentBootId`/`classifyHolder` names consistent Tasks 1↔2↔3. **Post-Task-1 corrections (depth check):** (a) `currentBootId` darwin source is `kern.bootsessionuuid` (clock-independent), not `kern.boottime`; (b) the reclaim scan in Task 2 uses the 4-state `classifyHolder`, not the boolean `holderActive`, because the boolean cannot distinguish `unverifiable` from `alive` — see Task 2 Interfaces.

## Execution caveat (codex rescue)

Per project memory, `codex:rescue` is sandbox-walled from sibling git worktrees — it can investigate/produce/review but may be unable to write files in `.worktrees/feat-234-concurrent-relays`. Confirm reachability before delegating edits; otherwise apply edits in-session (subagent-driven-development) with codex used for review/diagnosis.
