import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

export const PROVIDER_WORKLOAD_BLOCKED_CODE = "provider_workload_blocked";
const LOCK_ENV = "CODEX_PLUGIN_MULTI_PROVIDER_WORKLOAD_LOCK_DIR";
const SCHEMA_VERSION = 1;

function lockRoot(env = process.env) {
  return env[LOCK_ENV] || join(tmpdir(), "codex-plugin-multi", "provider-workload");
}

function providerSlug(provider) {
  const slug = String(provider ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

function lockPath(provider, env) {
  return join(lockRoot(env), `${providerSlug(provider)}.json`);
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
  const message =
    `${providerSlug(provider)} source-bearing review is already active` +
    `${visible.job_id ? ` in job ${visible.job_id}` : ""}`;
  return Object.freeze({
    ok: false,
    error_code: PROVIDER_WORKLOAD_BLOCKED_CODE,
    reason: "active_same_provider_job",
    message,
    holder: visible,
  });
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
    let handle = null;
    try {
      handle = openSync(file, "wx", 0o600);
      writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      closeSync(handle);
      const lease = Object.freeze({ file, token: payload.token });
      process.once("exit", () => releaseProviderWorkloadLease(lease));
      return Object.freeze({ ok: true, lease });
    } catch (error) {
      if (handle !== null) {
        try { closeSync(handle); } catch { /* best effort */ }
      }
      if (error?.code !== "EEXIST") throw error;
      const holder = readHolder(file);
      if (!holderActive(holder)) {
        try {
          unlinkSync(file);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code === "ENOENT") continue;
          throw unlinkError;
        }
      }
      return blockResult(provider, file, holder);
    }
  }
}

export function releaseProviderWorkloadLease(lease) {
  if (!lease?.file || !lease?.token) return false;
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
