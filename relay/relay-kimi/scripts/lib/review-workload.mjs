import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { classifyHolder, capturePidInfo, currentBootId } from "./process-identity.mjs";

export const PROVIDER_WORKLOAD_BLOCKED_CODE = "provider_workload_blocked";
const GATE_TIMEOUT_ENV = "RELAY_PROVIDER_WORKLOAD_GATE_TIMEOUT_MS";
const SCHEMA_VERSION = 1;
const DEFAULT_GATE_TIMEOUT_MS = 5_000;
const GATE_POLL_MS = 25;
const GATE_OWNER_FILE = "owner.json";

function trimEdgeHyphens(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

function keySlug(key) {
  const dashed = String(key ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  const slug = trimEdgeHyphens(dashed);
  return slug || "unknown";
}

function legacyLockPath(root, slug) {
  return join(root, `${slug}.json`);
}

function slotPath(root, slug, index) {
  return join(root, `${slug}.slot-${index}.json`);
}

function gatePath(file) {
  return `${file}.gate`;
}

function positiveIntegerEnv(env, name, fallback) {
  const raw = env?.[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

function gateTimeoutMs(env) {
  return positiveIntegerEnv(env, GATE_TIMEOUT_ENV, DEFAULT_GATE_TIMEOUT_MS);
}

function sleepSync(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, Math.max(1, ms));
}

function readHolder(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readHolderState(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { present: true, holder: null, parseable: false };
    }
    return { present: true, holder: JSON.parse(readFileSync(file, "utf8")), parseable: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, holder: null, parseable: false };
    return { present: true, holder: null, parseable: false };
  }
}

function recordedBootId(holder) {
  return typeof holder?.boot_id === "string" && holder.boot_id.length > 0 ? holder.boot_id : null;
}

function shouldReclaimUnverifiable(holder, env) {
  const bootId = recordedBootId(holder);
  return bootId != null && bootId !== currentBootId(env);
}

function blockResult(key, capacity, reason = "active_same_provider_job") {
  const message = `${keySlug(key)} source-bearing review is already active`;
  return Object.freeze({
    ok: false,
    error_code: PROVIDER_WORKLOAD_BLOCKED_CODE,
    reason,
    message,
    capacity: Object.freeze({
      active_count: capacity?.active_count ?? 0,
      limit: capacity?.limit ?? null,
    }),
  });
}

function captureCurrentPidInfo(env = process.env) {
  try {
    return capturePidInfo(process.pid);
  } catch (error) {
    if (!env?.RELAY_WORKLOAD_TEST_MODE) throw error;
    return {
      pid: process.pid,
      starttime: `test-mode:${process.pid}`,
      argv0: process.argv?.[0] || "node",
    };
  }
}

function gateOwnerFile(gateDir) {
  return join(gateDir, GATE_OWNER_FILE);
}

function readGateOwnerRaw(gateDir) {
  try {
    return readFileSync(gateOwnerFile(gateDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return null;
  }
}

function parseGateOwner(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeGateOwner(gateDir, payload) {
  writeFileSync(gateOwnerFile(gateDir), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function gateAgeMs(gateDir) {
  try {
    return Date.now() - lstatSync(gateDir).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function gateOwnerActive(owner, gateDir, env) {
  if (!owner || typeof owner !== "object") return false;
  if (owner.hostname && owner.hostname !== hostname()) {
    return gateAgeMs(gateDir) <= gateTimeoutMs(env);
  }
  return classifyHolder(owner, env) !== "dead";
}

function tryReclaimProviderWorkloadGate(gateDir, env) {
  const ownerRaw = readGateOwnerRaw(gateDir);
  const owner = parseGateOwner(ownerRaw);
  if (gateOwnerActive(owner, gateDir, env)) return false;
  if (ownerRaw === undefined) {
    if (gateAgeMs(gateDir) <= gateTimeoutMs(env)) return false;
  }

  const orphanDir = `${gateDir}.orphaned-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    renameSync(gateDir, orphanDir);
    if (readGateOwnerRaw(orphanDir) !== ownerRaw) {
      try { renameSync(orphanDir, gateDir); } catch { /* leave orphan for manual cleanup */ }
      return false;
    }
    rmSync(orphanDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

function releaseProviderWorkloadGate(gateDir, token) {
  const owner = parseGateOwner(readGateOwnerRaw(gateDir));
  if (owner?.token !== token) return false;
  try {
    rmSync(gateDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function acquireProviderWorkloadGate(file, env) {
  const gateDir = gatePath(file);
  const deadline = Date.now() + gateTimeoutMs(env);
  for (;;) {
    const token = randomUUID();
    try {
      mkdirSync(gateDir, { mode: 0o700 });
      try {
        writeGateOwner(gateDir, {
          schema_version: SCHEMA_VERSION,
          pid: process.pid,
          hostname: hostname(),
          started_at: new Date().toISOString(),
          token,
        });
      } catch (error) {
        try { rmSync(gateDir, { recursive: true, force: true }); } catch { /* best effort */ }
        throw error;
      }
      return Object.freeze({
        ok: true,
        release: () => releaseProviderWorkloadGate(gateDir, token),
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (tryReclaimProviderWorkloadGate(gateDir, env)) continue;
      if (Date.now() >= deadline) {
        return Object.freeze({
          ok: false,
          holder: parseGateOwner(readGateOwnerRaw(gateDir)),
        });
      }
      sleepSync(GATE_POLL_MS);
    }
  }
}

function tryCreateLeaseFile(file, payload) {
  const candidate = `${file}.${process.pid}.${payload.token}.tmp`;
  try {
    writeFileSync(candidate, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    linkSync(candidate, file);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return false;
  } finally {
    try { unlinkSync(candidate); } catch { /* best effort */ }
  }
}

function removeInactiveHolder(file, expectedHolder) {
  const current = readHolder(file);
  if (!current) return true;
  if (current.token !== expectedHolder?.token) return false;
  try {
    unlinkSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function enumerateSlotFiles(root, slug) {
  const prefix = `${slug}.slot-`;
  const suffix = ".json";
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  const slots = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const rawIndex = name.slice(prefix.length, -suffix.length);
    if (!/^\d+$/.test(rawIndex)) continue;
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index)) continue;
    slots.push({ index, file: join(root, name), legacy: false });
  }
  slots.sort((a, b) => a.index - b.index);
  return slots;
}

// `capture` is an optional liveness-capture seam threaded through from
// acquireProviderWorkloadLease. In production it is undefined, so classifyHolder falls back
// to its default (capturePidInfo) — zero behavior change. Tests inject a capture that throws
// `capture_error` to drive a holder deterministically down the `unverifiable` branch on every
// platform (an invalid pid would classify as `dead`, never exercising the boot-id reclaim).
function inspectSlot(slot, env, capture) {
  const state = readHolderState(slot.file);
  if (!state.present) return { occupied: false, reclaimed: false };
  const holder = state.holder;
  if (!state.parseable || !holder || typeof holder !== "object" || !holder.token) {
    return { occupied: true, reclaimed: false };
  }

  const classification = classifyHolder(holder, env, capture);
  if (classification === "dead") {
    return { occupied: !removeInactiveHolder(slot.file, holder), reclaimed: true };
  }
  if (classification === "unverifiable" && shouldReclaimUnverifiable(holder, env)) {
    return { occupied: !removeInactiveHolder(slot.file, holder), reclaimed: true };
  }
  return { occupied: true, reclaimed: false };
}

function acquiredResult(file, payload) {
  const lease = { file, token: payload.token };
  const exitListener = () => releaseProviderWorkloadLease(lease);
  Object.defineProperty(lease, "exitListener", {
    value: exitListener,
    enumerable: false,
  });
  Object.freeze(lease);
  process.once("exit", exitListener);
  return Object.freeze({ ok: true, lease });
}

export function acquireProviderWorkloadLease({
  provider,
  concurrencyKey,
  limit,
  lockRoot,
  jobId,
  cwd = process.cwd(),
  sourceBearing = true,
  env = process.env,
  capture,
} = {}) {
  if (sourceBearing !== true) return Object.freeze({ ok: true, lease: null });

  if (concurrencyKey == null || String(concurrencyKey).trim() === "") {
    throw new Error("provider workload concurrencyKey is required for source-bearing jobs");
  }

  const key = String(concurrencyKey);
  const slug = keySlug(key);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return blockResult(key, { active_count: 0, limit: null }, "invalid_provider_workload_limit");
  }
  if (typeof lockRoot !== "string" || lockRoot.trim() === "") {
    return blockResult(key, { active_count: 0, limit }, "invalid_provider_workload_lock_root");
  }

  const root = lockRoot;
  const gateFile = legacyLockPath(root, slug);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  let pidInfo;
  try {
    pidInfo = captureCurrentPidInfo(env);
  } catch {
    return blockResult(key, { active_count: 0, limit }, "unverifiable_current_process");
  }

  const payload = Object.freeze({
    schema_version: SCHEMA_VERSION,
    provider: provider == null ? null : String(provider),
    concurrency_key: key,
    key_slug: slug,
    job_id: String(jobId ?? ""),
    pid: process.pid,
    starttime: pidInfo.starttime,
    argv0: pidInfo.argv0,
    boot_id: currentBootId(env),
    hostname: hostname(),
    cwd: String(cwd ?? ""),
    started_at: new Date().toISOString(),
    token: randomUUID(),
  });

  for (;;) {
    const gate = acquireProviderWorkloadGate(gateFile, env);
    if (!gate.ok) return blockResult(key, { active_count: limit, limit });
    try {
      const slots = enumerateSlotFiles(root, slug);
      if (!slots) return blockResult(key, { active_count: limit, limit }, "unreadable_provider_workload_lock_root");

      slots.unshift({ index: 0, file: gateFile, legacy: true });

      let activeCount = 0;
      const occupiedIndices = new Set();
      for (const slot of slots) {
        const result = inspectSlot(slot, env, capture);
        if (!result.occupied) continue;
        activeCount += 1;
        occupiedIndices.add(slot.index);
      }

      if (activeCount >= limit) {
        return blockResult(key, { active_count: activeCount, limit });
      }

      let index = 0;
      for (;;) {
        if (!occupiedIndices.has(index) && !existsSync(slotPath(root, slug, index))) break;
        index += 1;
      }
      const file = slotPath(root, slug, index);
      if (tryCreateLeaseFile(file, payload)) return acquiredResult(file, payload);
    } finally {
      gate.release?.();
    }
  }
}

export function releaseProviderWorkloadLease(lease) {
  if (!lease?.file || !lease?.token) return false;
  if (typeof lease.exitListener === "function") process.removeListener("exit", lease.exitListener);
  const holder = readHolder(lease.file);
  if (holder?.token !== lease.token) return false;
  try {
    unlinkSync(lease.file);
    return true;
  } catch {
    return false;
  }
}

export function providerWorkloadBlockedExecution(block) {
  const message = block?.message || "provider source-bearing review is already active";
  const capacity = block?.capacity
    ? {
        active_count: block.capacity.active_count,
        limit: block.capacity.limit,
      }
    : null;
  const diagnostics = {
    provider_workload: {
      reason: block?.reason ?? "active_same_provider_job",
      capacity,
    },
  };
  return {
    preflight: true,
    exitCode: null,
    parsed: {
      ok: false,
      reason: PROVIDER_WORKLOAD_BLOCKED_CODE,
      error: message,
    },
    pidInfo: null,
    payload_sent: false,
    stdout: "",
    stderr: "",
    errorMessage: `${PROVIDER_WORKLOAD_BLOCKED_CODE}: ${message}`,
    diagnostics,
    runtimeDiagnostics: diagnostics,
  };
}
