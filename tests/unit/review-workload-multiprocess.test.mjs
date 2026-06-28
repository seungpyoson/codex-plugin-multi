// Task 3 (#234): cross-process invariants for the bounded counting semaphore. Invariant #3
// (at most `limit` concurrent holders) and crash/reboot reclaim are inherently multi-process;
// in-process tests cannot prove them. These use real child `node` processes against a shared
// `lockRoot`, plus an injected capture seam for the reboot-id branch (which is otherwise
// undecidable in-process: only a `capture_error` throw yields an `unverifiable` holder, and
// an invalid pid would classify as `dead` — silently no-op'ing the boot-id reclaim path).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { acquireProviderWorkloadLease, releaseProviderWorkloadLease } from "../../scripts/lib/review-workload.mjs";
import { capturePidInfo } from "../../scripts/lib/process-identity.mjs";

const WORKLOAD_LIB = fileURLToPath(new URL("../../scripts/lib/review-workload.mjs", import.meta.url));

// These two tests spawn real child processes that take the REAL liveness-capture
// acquire path (no RELAY_WORKLOAD_TEST_MODE). On a macOS sandbox that denies
// /bin/ps, child liveness capture cannot prove real process identities, so the
// assertions hard-fail rather than proving anything. Skip
// when the current process cannot capture its own identity (same guard used by
// review-workload.test.mjs). Linux CI has /proc, so it still runs there; the
// boot-id reclaim test below uses an injected capture and is unaffected.
const SKIP_WORKLOAD_ACQUIRE_UNDER_DARWIN_SANDBOX = {
  skip: (() => {
    if (process.platform !== "darwin") return false;
    try {
      capturePidInfo(process.pid);
      return false;
    } catch {
      return "macOS sandboxing can deny ps; multi-process workload acquisition requires capturePidInfo(process.pid)";
    }
  })(),
};

function countSlotFiles(root) {
  return readdirSync(root).filter((f) => /\.slot-\d+\.json$/.test(f) || /^[^.]+\.json$/.test(f)).length;
}

// A child that races for a lease against a shared lockRoot and records its outcome (with
// timestamps) to a shared append-only log. Uses the REAL liveness capture (no
// RELAY_WORKLOAD_TEST_MODE): a synthetic starttime would make a live holder's record fail the
// starttime check and classify as `dead`, over-admitting and defeating the bound.
function raceChildSnippet({ root, limit, jobId, holdMs, logFile }) {
  return `
import { appendFileSync } from "node:fs";
import { acquireProviderWorkloadLease, releaseProviderWorkloadLease } from ${JSON.stringify(WORKLOAD_LIB)};
const r = acquireProviderWorkloadLease({
  concurrencyKey: "k",
  limit: ${JSON.stringify(limit)},
  lockRoot: ${JSON.stringify(root)},
  jobId: ${JSON.stringify(jobId)},
  cwd: "/tmp",
  sourceBearing: true,
});
if (!r.ok) {
  appendFileSync(${JSON.stringify(logFile)}, "BLOCKED " + ${JSON.stringify(jobId)} + " " + Date.now() + "\\n");
  process.exit(0);
}
appendFileSync(${JSON.stringify(logFile)}, "ACQUIRE " + ${JSON.stringify(jobId)} + " " + Date.now() + "\\n");
await new Promise((res) => setTimeout(res, ${JSON.stringify(holdMs)}));
appendFileSync(${JSON.stringify(logFile)}, "RELEASE " + ${JSON.stringify(jobId)} + " " + Date.now() + "\\n");
releaseProviderWorkloadLease(r.lease);
process.exit(0);
`;
}

// A child that acquires, touches `acquiredMarker` (so the parent knows it holds the slot —
// a file marker avoids stdout-buffering races), then holds far longer than the test needs so
// it can be SIGKILLed mid-hold. SIGKILL is uncatchable, so its process.once("exit") release
// listener never runs — the slot is orphaned, exactly the crash this test reclaims.
function holdChildSnippet({ root, limit, jobId, acquiredMarker }) {
  return `
import { writeFileSync } from "node:fs";
import { acquireProviderWorkloadLease } from ${JSON.stringify(WORKLOAD_LIB)};
const r = acquireProviderWorkloadLease({
  concurrencyKey: "k",
  limit: ${JSON.stringify(limit)},
  lockRoot: ${JSON.stringify(root)},
  jobId: ${JSON.stringify(jobId)},
  cwd: "/tmp",
  sourceBearing: true,
});
if (!r.ok) { process.exit(3); }
writeFileSync(${JSON.stringify(acquiredMarker)}, "1");
await new Promise((res) => setTimeout(res, 60000));
`;
}

function spawnModule(snippet) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", snippet], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = { child, pid: child.pid, stdout: "", stderr: "", exited: false, code: null };
  child.stdout.on("data", (d) => { result.stdout += d.toString(); });
  child.stderr.on("data", (d) => { result.stderr += d.toString(); });
  result.done = new Promise((resolve) => {
    child.on("exit", (code) => { result.exited = true; result.code = code; resolve(result); });
  });
  return result;
}

function waitForFile(filePath, proc, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (existsSync(filePath)) return resolve();
      if (proc.exited) return reject(new Error(`child exited before acquiring: code=${proc.code} stderr=${proc.stderr}`));
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${filePath}; stderr=${proc.stderr}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test("at most `limit` processes ever hold a slot concurrently; the overflow is blocked", SKIP_WORKLOAD_ACQUIRE_UNDER_DARWIN_SANDBOX, async () => {
  const root = mkdtempSync(join(tmpdir(), "wl-mp-"));
  const logFile = join(root, "outcomes.log");
  writeFileSync(logFile, "");
  try {
    const limit = 2;
    const total = 5;
    const holdMs = 1500; // generous: all children race within ~150ms of spawn, well inside the hold
    const procs = Array.from({ length: total }, (_, i) =>
      spawnModule(raceChildSnippet({ root, limit, jobId: `j${i}`, holdMs, logFile })));
    const results = await Promise.all(procs.map((p) => p.done));

    for (const r of results) {
      assert.equal(r.code, 0, `child exited non-zero: code=${r.code} stderr=${r.stderr}`);
    }

    const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    const acquires = lines.filter((l) => l.startsWith("ACQUIRE "));
    const blocks = lines.filter((l) => l.startsWith("BLOCKED "));
    assert.equal(acquires.length + blocks.length, total, `every child must record exactly one outcome: ${lines.join("|")}`);

    // Peak concurrency from the timestamped event stream: +1 on ACQUIRE, -1 on RELEASE. On a
    // timestamp tie, count the ACQUIRE first (conservative over-estimate), so a true breach can
    // never hide. This is the core bound — never more than `limit` holders at any instant.
    const events = [];
    for (const l of lines) {
      const [kind, , ts] = l.split(" ");
      if (kind === "ACQUIRE") events.push({ t: Number(ts), d: +1, order: 0 });
      else if (kind === "RELEASE") events.push({ t: Number(ts), d: -1, order: 1 });
    }
    events.sort((a, b) => (a.t - b.t) || (a.order - b.order));
    let cur = 0;
    let peak = 0;
    for (const e of events) { cur += e.d; if (cur > peak) peak = cur; }
    assert.ok(peak <= limit, `peak concurrency ${peak} must never exceed limit ${limit}`);

    // Non-vacuous: acquisition happened, and the overflow was actually rejected. A single
    // block already proves the semaphore reached capacity (a child blocks only when
    // activeCount === limit), which combined with peak <= limit forces peak === limit — so
    // peak === limit is proven without a timing-sensitive `blocked >= total - limit` floor
    // (expected here: 3 blocked, but that exact count depends on spawn timing under load).
    assert.ok(peak >= 1, "at least one process must have acquired");
    assert.ok(blocks.length >= 1, `the overflow must be rejected (≥1 blocked); got ${blocks.length}`);

    // All holders released, so no slot files linger (outcomes.log is not a slot file).
    assert.equal(countSlotFiles(root), 0, "all slots must be released after every holder exits");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SIGKILLed holder frees exactly one slot — the dead slot is reclaimed, a live sibling is preserved", SKIP_WORKLOAD_ACQUIRE_UNDER_DARWIN_SANDBOX, async () => {
  const root = mkdtempSync(join(tmpdir(), "wl-kill-"));
  try {
    const limit = 2;
    const victimMarker = join(root, "victim.acquired");
    const survivorMarker = join(root, "survivor.acquired");
    // Two live holders fill both slots.
    const victim = spawnModule(holdChildSnippet({ root, limit, jobId: "victim", acquiredMarker: victimMarker }));
    const survivor = spawnModule(holdChildSnippet({ root, limit, jobId: "survivor", acquiredMarker: survivorMarker }));
    await waitForFile(victimMarker, victim);
    await waitForFile(survivorMarker, survivor);
    assert.equal(countSlotFiles(root), 2, "both holders should occupy a slot before the kill");

    // SIGKILL one holder: uncatchable, so no release runs — its slot is orphaned (a real crash).
    victim.child.kill("SIGKILL");
    await victim.done;

    // In-process acquire (real liveness): the dead victim's slot classifies `dead` and is
    // reclaimed; the survivor stays `alive` and is NOT reclaimed. Net: exactly one slot freed.
    const reclaimer = acquireProviderWorkloadLease({
      concurrencyKey: "k", limit, lockRoot: root, jobId: "reclaimer", cwd: "/tmp", sourceBearing: true,
    });
    try {
      assert.equal(reclaimer.ok, true, "the SIGKILLed holder's slot must be reclaimable");
      // Exactly 2 slots: survivor + reclaimer. If the dead slot had not been freed we would
      // block (over capacity); if the live survivor had been wrongly reclaimed we would see it
      // gone. Exactly-one-freed means the count holds at the limit, not above it.
      assert.equal(countSlotFiles(root), 2, "must reclaim exactly the dead slot, preserving the live sibling");
      // The survivor is still running and holding its slot.
      assert.equal(survivor.exited, false, "the live sibling must not have been disturbed");
    } finally {
      releaseProviderWorkloadLease(reclaimer.lease);
    }

    survivor.child.kill("SIGKILL");
    await survivor.done;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unverifiable slot with a STALE boot id is reclaimed (reboot proven); with the CURRENT boot id it is NOT", () => {
  const root = mkdtempSync(join(tmpdir(), "wl-boot-"));
  try {
    // Inject a capture that fails with `capture_error` for any pid → the holder classifies as
    // `unverifiable` deterministically on every platform (the only path that exercises boot-id
    // reclaim; an invalid pid would be `dead` and reclaimed regardless of boot id).
    const captureError = () => { throw new Error("capture_error: injected — process table unreadable"); };
    const env = { ...process.env, RELAY_BOOT_ID: "CURRENT", RELAY_WORKLOAD_TEST_MODE: "1" };

    const writeUnverifiableSlot = (bootId) => {
      const holder = {
        schema_version: 1, provider: "grok-web", concurrency_key: "k", key_slug: "k",
        job_id: "ghost", pid: 999999, starttime: "100", argv0: "node",
        boot_id: bootId,
        hostname: hostname(), // must match current host, else classifyHolder returns "foreign"
        cwd: "/tmp", started_at: "2026-01-01T00:00:00.000Z", token: "ghost-token",
      };
      writeFileSync(join(root, "k.slot-0.json"), JSON.stringify(holder));
    };

    // STALE boot id ⇒ a reboot is proven ⇒ the unverifiable slot is reclaimed ⇒ acquire succeeds.
    writeUnverifiableSlot("STALE");
    const afterReboot = acquireProviderWorkloadLease({
      concurrencyKey: "k", limit: 1, lockRoot: root, jobId: "after-reboot",
      cwd: "/tmp", sourceBearing: true, env, capture: captureError,
    });
    assert.equal(afterReboot.ok, true, "a stale-boot unverifiable slot must be reclaimed after a proven reboot");
    releaseProviderWorkloadLease(afterReboot.lease);

    // Fresh root for the negative case.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    // CURRENT boot id ⇒ no reboot proven ⇒ the unverifiable slot is NOT reclaimed ⇒ blocked.
    writeUnverifiableSlot("CURRENT");
    const sameBoot = acquireProviderWorkloadLease({
      concurrencyKey: "k", limit: 1, lockRoot: root, jobId: "same-boot",
      cwd: "/tmp", sourceBearing: true, env, capture: captureError,
    });
    assert.equal(sameBoot.ok, false, "a current-boot unverifiable slot must fail closed (occupied, not reclaimed)");
    assert.equal(sameBoot.error_code, "provider_workload_blocked");
    assert.ok(existsSync(join(root, "k.slot-0.json")), "the unreclaimed slot must remain on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
