import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

export const PROVIDER_WORKLOAD_BLOCKED_CODE = "provider_workload_blocked";
const LOCK_ENV = "RELAY_PROVIDER_WORKLOAD_LOCK_DIR";
const GATE_TIMEOUT_ENV = "RELAY_PROVIDER_WORKLOAD_GATE_TIMEOUT_MS";
const SCHEMA_VERSION = 1;
const DEFAULT_GATE_TIMEOUT_MS = 5_000;
const GATE_POLL_MS = 25;
const GATE_OWNER_FILE = "owner.json";

function lockRoot(env = process.env) {
  return env[LOCK_ENV] || join(tmpdir(), "relay", "provider-workload");
}

function trimEdgeHyphens(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

function providerSlug(provider) {
  const dashed = String(provider ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  const slug = trimEdgeHyphens(dashed);
  return slug || "unknown";
}

function lockPath(provider, env) {
  return join(lockRoot(env), `${providerSlug(provider)}.json`);
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

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function holderActive(holder) {
  if (!holder || typeof holder !== "object") return false;
  if (holder.hostname && holder.hostname !== hostname()) return true;
  return pidAlive(holder.pid);
}

function safeHolder(holder, file) {
  return Object.freeze({
    provider: holder?.provider ?? null,
    job_id: holder?.job_id ?? null,
    pid: Number.isSafeInteger(holder?.pid) ? holder.pid : null,
    hostname: holder?.hostname ?? null,
    cwd: holder?.cwd ?? null,
    started_at: holder?.started_at ?? null,
    lock_file: file,
  });
}

function blockResult(provider, file, holder) {
  const visible = safeHolder(holder, file);
  const jobSuffix = visible.job_id ? ` in job ${visible.job_id}` : "";
  const message = `${providerSlug(provider)} source-bearing review is already active${jobSuffix}`;
  return Object.freeze({
    ok: false,
    error_code: PROVIDER_WORKLOAD_BLOCKED_CODE,
    reason: "active_same_provider_job",
    message,
    holder: visible,
  });
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
  return pidAlive(owner.pid);
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
      if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) {
        return Object.freeze({
          ok: false,
          holder: parseGateOwner(readGateOwnerRaw(gateDir)),
        });
      }
      if (tryReclaimProviderWorkloadGate(gateDir, env)) continue;
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
  jobId,
  cwd = process.cwd(),
  sourceBearing = true,
  env = process.env,
} = {}) {
  if (sourceBearing !== true) return Object.freeze({ ok: true, lease: null });

  const root = lockRoot(env);
  const file = lockPath(provider, env);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  const payload = Object.freeze({
    schema_version: SCHEMA_VERSION,
    provider: String(provider ?? "unknown"),
    provider_slug: providerSlug(provider),
    job_id: String(jobId ?? ""),
    pid: process.pid,
    hostname: hostname(),
    cwd: String(cwd ?? ""),
    started_at: new Date().toISOString(),
    token: randomUUID(),
  });

  for (;;) {
    const gate = acquireProviderWorkloadGate(file, env);
    if (!gate.ok) return blockResult(provider, file, gate.holder);
    try {
      if (tryCreateLeaseFile(file, payload)) return acquiredResult(file, payload);

      const holder = readHolder(file);
      if (holderActive(holder)) return blockResult(provider, file, holder);
      if (removeInactiveHolder(file, holder) && tryCreateLeaseFile(file, payload)) {
        return acquiredResult(file, payload);
      }
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
  const diagnostics = {
    provider_workload: {
      reason: block?.reason ?? "active_same_provider_job",
      holder: block?.holder ?? null,
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
