#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { cleanGitEnv } from "./lib/git-env.mjs";
import { GIT_BINARY_ENV, gitEnv, isGitBinaryPolicyError, resolveGitBinary } from "./lib/git-binary.mjs";
import { isCodexSandbox } from "./lib/codex-env.mjs";
import { REVIEW_PROMPT_CONTRACT_VERSION, buildReviewAuditManifest, buildReviewPrompt, scopeResolutionReason } from "./lib/review-prompt.mjs";
import { USAGE_LIMIT_SAFE_MESSAGE, isUsageLimitDetail } from "./lib/usage-limit.mjs";
import {
  EXTERNAL_REVIEW_KEYS,
  SOURCE_CONTENT_TRANSMISSION,
} from "./lib/external-review.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const PROVIDERS_PATH = resolve(PLUGIN_ROOT, "config/providers.json");
const VALID_MODES = new Set(["review", "adversarial-review", "custom-review"]);
const VALID_AUTH_MODES = new Set(["api_key", "auto"]);
const SCHEMA_VERSION = 10;
const API_REVIEWER_STATE_VERSION = 1;
const MAX_RETAINED_API_REVIEWER_JOBS = 50;
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const API_REVIEWER_STATE_LOCK_DIR = ".state.lock";
const API_REVIEWER_STATE_LOCK_GATE_DIR = ".state.lock.gate";
const API_REVIEWER_STATE_LOCK_POLL_MS = 25;
const API_REVIEWER_STATE_LOCK_TIMEOUT_MS = 5000;
const API_REVIEWER_STATE_LOCK_STALE_MS = 30000;
const SCOPE_FILE_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const MAX_SCOPE_FILE_BYTES = 256 * 1024;
const MAX_SCOPE_TOTAL_BYTES = 1024 * 1024;
const DEFAULT_MAX_PROMPT_CHARS = 600000;
const GIT_SHOW_MAX_BUFFER_BYTES = MAX_SCOPE_FILE_BYTES + 1;
const API_REVIEWER_EXPECTED_KEYS = Object.freeze([
  "id",
  "job_id",
  "target",
  "provider",
  "parent_job_id",
  "claude_session_id",
  "gemini_session_id",
  "kimi_session_id",
  "resume_chain",
  "pid_info",
  "mode",
  "mode_profile_name",
  "model",
  "cwd",
  "workspace_root",
  "containment",
  "scope",
  "dispose_effective",
  "scope_base",
  "scope_paths",
  "prompt_head",
  "review_metadata",
  "schema_spec",
  "binary",
  "status",
  "started_at",
  "ended_at",
  "exit_code",
  "error_code",
  "error_message",
  "error_summary",
  "error_cause",
  "suggested_action",
  "external_review",
  "disclosure_note",
  "runtime_diagnostics",
  "result",
  "structured_output",
  "permission_denials",
  "mutations",
  "cost_usd",
  "usage",
  "auth_mode",
  "credential_ref",
  "endpoint",
  "http_status",
  "raw_model",
  "schema_version",
]);
const ALLOWED_REQUEST_DEFAULT_KEYS = new Set(["thinking", "reasoning_effort", "max_tokens", "top_p", "stop"]);
// Avoid corrupting structured fields when a broken local env has a tiny API-key placeholder.
const MIN_SECRET_REDACTION_LENGTH = 8;
const ACCOUNT_PAYMENT_TOKEN_RE = /\b(?:stripe-[^\s,;:)]+|cus_[A-Za-z0-9]{6,}|acct_(?:test_)?[A-Za-z0-9]{5,}|cs_(?:test|live)_[A-Za-z0-9]{6,}|(?:pi|sub|in|ii|ch|seti|setp|price|prod|iv)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,})/gi;
const ACCOUNT_PAYMENT_DIAGNOSTIC_RE = /^(?:stripe-.+|cus_[A-Za-z0-9]{6,}|acct_(?:test_)?[A-Za-z0-9]{5,}|cs_(?:test|live)_[A-Za-z0-9]{6,}|(?:pi|sub|in|ii|ch|seti|setp|price|prod|iv)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,})$/i;

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function printJsonLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function printLifecycleJson(obj, lifecycleEvents) {
  if (lifecycleEvents === "jsonl") printJsonLine(obj);
  else printJson(obj);
}

function parseLifecycleEventsMode(value) {
  if (value == null || value === false) return null;
  if (value === "jsonl") return "jsonl";
  throw runBadArgs("--lifecycle-events must be jsonl");
}

function isActiveJob(job) {
  return ACTIVE_JOB_STATUSES.has(job?.status);
}

const SAFE_JOB_ID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

function assertSafeJobId(jobId) {
  if (typeof jobId !== "string" || !SAFE_JOB_ID.test(jobId)) {
    throw new Error(`Unsafe jobId: ${JSON.stringify(jobId)}`);
  }
}

function apiReviewerDataRoot(env = process.env) {
  return resolve(env.API_REVIEWERS_PLUGIN_DATA ?? ".codex-plugin-data/api-reviewers");
}

function apiReviewerJobsDir(root) {
  return resolve(root, "jobs");
}

function apiReviewerStateFile(root) {
  return resolve(root, "state.json");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function pruneJobs(jobs) {
  const withIndex = jobs.map((job, originalIndex) => ({ job, originalIndex }));
  withIndex.sort((left, right) => {
    const lt = String(left.job.updatedAt ?? left.job.ended_at ?? left.job.endedAt ?? "");
    const rt = String(right.job.updatedAt ?? right.job.ended_at ?? right.job.endedAt ?? "");
    if (lt === rt) return left.originalIndex - right.originalIndex;
    return rt.localeCompare(lt);
  });
  let terminalCount = 0;
  return withIndex
    .filter(({ job }) => {
      if (isActiveJob(job)) return true;
      if (terminalCount >= MAX_RETAINED_API_REVIEWER_JOBS) return false;
      terminalCount += 1;
      return true;
    })
    .map(({ job }) => job);
}

async function loadApiReviewerState(root) {
  let stateJobs = [];
  try {
    const parsed = JSON.parse(await readFile(apiReviewerStateFile(root), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      stateJobs = [];
    } else {
      stateJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    }
  } catch {
    stateJobs = [];
  }
  return {
    version: API_REVIEWER_STATE_VERSION,
    jobs: mergeApiReviewerJobs(stateJobs, await discoverApiReviewerDiskJobs(root)),
  };
}

function summarizeApiReviewerJobRecord(record, fallbackJobId = null) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const jobId = record.job_id ?? record.id ?? fallbackJobId;
  try {
    assertSafeJobId(jobId);
  } catch {
    return null;
  }
  if (fallbackJobId !== null && jobId !== fallbackJobId) return null;
  return {
    id: jobId,
    job_id: jobId,
    target: record.target,
    provider: record.provider,
    status: record.status,
    mode: record.mode,
    scope: record.scope,
    scope_base: record.scope_base ?? null,
    scope_paths: record.scope_paths ?? null,
    updatedAt: record.updatedAt ?? record.ended_at ?? record.endedAt ?? record.started_at ?? record.startedAt ?? new Date(0).toISOString(),
  };
}

function mergeApiReviewerJobs(stateJobs, diskJobs) {
  const merged = [];
  const seen = new Set();
  for (const job of [...stateJobs, ...diskJobs]) {
    const summary = summarizeApiReviewerJobRecord(job);
    if (!summary) continue;
    const jobId = summary.id;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    merged.push(summary);
  }
  return merged;
}

async function discoverApiReviewerDiskJobs(root) {
  let entries;
  try {
    entries = await readdir(apiReviewerJobsDir(root), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobId = entry.name;
    try {
      assertSafeJobId(jobId);
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(resolve(apiReviewerJobsDir(root), jobId, "meta.json"), "utf8"));
      const summary = summarizeApiReviewerJobRecord(parsed, jobId);
      if (summary) jobs.push(summary);
    } catch {
      // Ignore malformed legacy artifacts; cleanup only acts on validated job records.
    }
  }
  return jobs;
}

async function writeApiReviewerState(root, state) {
  await mkdir(root, { recursive: true });
  const stateFile = apiReviewerStateFile(root);
  const tmpFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmpFile, stateFile);
  } catch (e) {
    try { await unlink(tmpFile); } catch { /* already gone */ }
    throw e;
  }
}

async function writeApiReviewerMetaRecord(root, record) {
  assertSafeJobId(record.job_id);
  const dir = resolve(root, "jobs", record.job_id);
  await mkdir(dir, { recursive: true });
  const metaFile = resolve(dir, "meta.json");
  const tmpFile = `${metaFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpFile, metaFile);
  } catch (e) {
    try { await unlink(tmpFile); } catch { /* already gone */ }
    throw e;
  }
}

async function readApiReviewerLockOwnerRaw(lockOwnerFile) {
  try {
    return await readFile(lockOwnerFile, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    return undefined;
  }
}

async function readApiReviewerLockOwner(lockOwnerFile) {
  try {
    const parsed = JSON.parse(await readFile(lockOwnerFile, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function apiReviewerLockAgeMs(lockStat, owner) {
  const startedAt = owner?.startedAt ? Date.parse(owner.startedAt) : NaN;
  if (Number.isFinite(startedAt)) return Date.now() - startedAt;
  return Date.now() - lockStat.mtimeMs;
}

function apiReviewerStateLockTimeoutMs(env = process.env) {
  const parsed = parsePositiveIntegerEnv(env, "API_REVIEWERS_STATE_LOCK_TIMEOUT_MS", "milliseconds");
  return parsed.ok && parsed.value !== null ? parsed.value : API_REVIEWER_STATE_LOCK_TIMEOUT_MS;
}

function apiReviewerStateLockStaleMs(env = process.env) {
  const parsed = parsePositiveIntegerEnv(env, "API_REVIEWERS_STATE_LOCK_STALE_MS", "milliseconds");
  return parsed.ok && parsed.value !== null ? parsed.value : API_REVIEWER_STATE_LOCK_STALE_MS;
}

async function tryReclaimStaleApiReviewerStateLock(lockDir) {
  const lockOwnerFile = resolve(lockDir, "owner.json");
  let lockStat;
  try {
    lockStat = await lstat(lockDir);
  } catch (e) {
    if (e.code === "ENOENT") return true;
    return false;
  }
  const ownerRaw = await readApiReviewerLockOwnerRaw(lockOwnerFile);
  if (ownerRaw === undefined) return false;
  const owner = await readApiReviewerLockOwner(lockOwnerFile);
  if (owner?.hostname && owner.hostname !== hostname()) return false;
  const sameHost = owner?.hostname === hostname();
  const ownerPidValid = Number.isInteger(owner?.pid) && owner.pid > 0;
  const sameHostAlive = sameHost && ownerPidValid && isProcessAlive(owner.pid);
  if (sameHostAlive) return false;

  const ownerDead = sameHost && ownerPidValid && !isProcessAlive(owner.pid);
  const ageMs = apiReviewerLockAgeMs(lockStat, owner);
  if (!ownerDead && ageMs <= apiReviewerStateLockStaleMs()) return false;

  const orphanDir = `${lockDir}.orphaned-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await rename(lockDir, orphanDir);
    const orphanOwnerRaw = await readApiReviewerLockOwnerRaw(resolve(orphanDir, "owner.json"));
    if (orphanOwnerRaw !== ownerRaw) {
      try { await rename(orphanDir, lockDir); } catch { /* leave orphan for manual cleanup */ }
      return false;
    }
    await rm(orphanDir, { recursive: true, force: true });
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return true;
    return false;
  }
}

async function releaseApiReviewerStateLock(lockDir, token) {
  const owner = await readApiReviewerLockOwner(resolve(lockDir, "owner.json"));
  if (owner?.token === token && owner?.pid === process.pid && owner?.hostname === hostname()) {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function acquireApiReviewerStateLockGate(root, deadline) {
  const gateDir = resolve(root, API_REVIEWER_STATE_LOCK_GATE_DIR);
  const gateOwnerFile = resolve(gateDir, "owner.json");
  while (true) {
    try {
      await mkdir(gateDir);
      const token = randomUUID();
      try {
        await writeFile(gateOwnerFile, `${JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
          token,
        })}\n`, "utf8");
      } catch (e) {
        await rm(gateDir, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      return () => releaseApiReviewerStateLock(gateDir, token);
    } catch (e) {
      if (e.code !== "EEXIST") {
        throw new Error(`api_reviewer_state_lock_error: could not acquire ${gateDir}: ${e.message}`);
      }
      if (await tryReclaimStaleApiReviewerStateLock(gateDir)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`api_reviewer_state_lock_timeout: could not acquire ${gateDir}`);
      }
      await sleep(API_REVIEWER_STATE_LOCK_POLL_MS);
    }
  }
}

async function withApiReviewerStateLock(root, fn) {
  await mkdir(root, { recursive: true });
  const lockDir = resolve(root, API_REVIEWER_STATE_LOCK_DIR);
  const lockOwnerFile = resolve(lockDir, "owner.json");
  const deadline = Date.now() + apiReviewerStateLockTimeoutMs();
  while (true) {
    let releaseGate = null;
    let token = null;
    let lockDirCreated = false;
    try {
      releaseGate = await acquireApiReviewerStateLockGate(root, deadline);
      try {
        await mkdir(lockDir);
        lockDirCreated = true;
      } catch (e) {
        if (e.code !== "EEXIST") {
          throw new Error(`api_reviewer_state_lock_error: could not acquire ${lockDir}: ${e.message}`);
        }
        const reclaimed = await tryReclaimStaleApiReviewerStateLock(lockDir);
        if (!reclaimed) {
          await releaseGate();
          releaseGate = null;
          if (Date.now() >= deadline) {
            throw new Error(`api_reviewer_state_lock_timeout: could not acquire ${lockDir}`);
          }
          await sleep(API_REVIEWER_STATE_LOCK_POLL_MS);
          continue;
        }
        // Reclaim succeeded; recreate lockDir while still holding the gate so
        // no third writer can acquire during the orphan put-back window.
        await mkdir(lockDir);
        lockDirCreated = true;
      }
      token = randomUUID();
      await writeFile(lockOwnerFile, `${JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        token,
      })}\n`, "utf8");
      await releaseGate();
      releaseGate = null;
    } catch (e) {
      if (String(e.message ?? "").startsWith("api_reviewer_state_lock_")) throw e;
      if (lockDirCreated) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      }
      throw new Error(`api_reviewer_state_lock_error: could not acquire ${lockDir}: ${e.message}`);
    } finally {
      if (releaseGate) await releaseGate();
    }
    try {
      return await fn();
    } finally {
      await releaseApiReviewerStateLock(lockDir, token);
    }
  }
}

async function removeApiReviewerJobDir(root, jobId) {
  assertSafeJobId(jobId);
  const jobsDir = apiReviewerJobsDir(root);
  const jobDir = resolve(jobsDir, jobId);
  const rel = relative(jobsDir, jobDir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
  try {
    const stat = await lstat(jobDir);
    if (stat.isDirectory()) {
      await rm(jobDir, { recursive: true, force: true });
      return;
    }
    await unlink(jobDir);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
}

async function removeApiReviewerJobTmpFiles(root, jobId) {
  assertSafeJobId(jobId);
  const jobDir = resolve(apiReviewerJobsDir(root), jobId);
  try {
    const stat = await lstat(jobDir);
    if (!stat.isDirectory()) return;
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  let names;
  try {
    names = await readdir(jobDir);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  const prefix = "meta.json.";
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    try { await unlink(resolve(jobDir, name)); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

async function updateApiReviewerStateForRecord(root, record) {
  const previousJobs = (await loadApiReviewerState(root)).jobs;
  const summary = summarizeApiReviewerJobRecord(record);
  if (!summary) return;
  const merged = [summary, ...previousJobs.filter((job) => (job.id ?? job.job_id) !== record.id)];
  const nextJobs = pruneJobs(merged);
  const retainedIds = new Set(nextJobs.map((job) => job.id ?? job.job_id));
  for (const job of previousJobs) {
    const jobId = job.id ?? job.job_id;
    if (retainedIds.has(jobId) || isActiveJob(job)) continue;
    try { await removeApiReviewerJobTmpFiles(root, jobId); }
    catch { /* best-effort cleanup must not hide the current review result */ }
    try { await removeApiReviewerJobDir(root, jobId); }
    catch { /* best-effort cleanup must not hide the current review result */ }
  }
  await writeApiReviewerState(root, {
    version: API_REVIEWER_STATE_VERSION,
    jobs: nextJobs,
  });
}

function parseArgs(argv) {
  const out = Object.create(null);
  out._ = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      const key = token.slice(2, eq);
      assertSafeOptionKey(key, token);
      out[key] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    assertSafeOptionKey(key, token);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function assertSafeOptionKey(key, token) {
  if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new Error(`unsupported option ${token}`);
  }
}

async function loadProviders() {
  return JSON.parse(await readFile(PROVIDERS_PATH, "utf8"));
}

function providerConfig(providers, name) {
  const cfg = providers[name];
  if (!cfg) throw new Error(`unknown_provider:${name}`);
  if (!VALID_AUTH_MODES.has(cfg.auth_mode)) {
    throw new Error(`unsupported_auth_mode:${cfg.auth_mode}`);
  }
  return cfg;
}

function fallbackProviderConfig(provider) {
  const displayName = provider ? String(provider) : "API Reviewers";
  return {
    display_name: displayName,
    auth_mode: "api_key",
    env_keys: [],
    base_url: null,
    model: null,
  };
}

function runBadArgs(message) {
  const error = new Error(message);
  error.apiReviewersReason = "bad_args";
  return error;
}

function runConfigError(message) {
  const error = new Error(message);
  error.apiReviewersReason = "config_error";
  return error;
}

function runProviderFailure(reason, message) {
  const error = new Error(message);
  error.apiReviewersReason = reason;
  return error;
}

function providersConfigErrorMessage(error) {
  return `providers config unreadable: ${error.message}`;
}

function providersConfigErrorFields(error, provider = null) {
  return {
    provider,
    status: "config_error",
    ready: false,
    summary: "API Reviewers providers config is unreadable.",
    next_action: "Reinstall or repair plugins/api-reviewers/config/providers.json and retry.",
    error_message: providersConfigErrorMessage(error),
  };
}

function selectedCredential(cfg, env = process.env) {
  for (const keyName of cfg.env_keys ?? []) {
    if (typeof env[keyName] === "string" && env[keyName].length > 0) {
      return { keyName, value: env[keyName] };
    }
  }
  return { keyName: null, value: null };
}

function parsePositiveIntegerEnv(env, name, label) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      error: `${name} must be a positive integer number of ${label}; got ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true, value: parsed };
}

function parseMaxTokensOverride(env = process.env) {
  return parsePositiveIntegerEnv(env, "API_REVIEWERS_MAX_TOKENS", "tokens");
}

function parseMaxPromptCharsOverride(env = process.env) {
  return parsePositiveIntegerEnv(env, "API_REVIEWERS_MAX_PROMPT_CHARS", "characters");
}

function parseProviderTimeoutMs(env = process.env) {
  const parsed = parsePositiveIntegerEnv(env, "API_REVIEWERS_TIMEOUT_MS", "milliseconds");
  return parsed.value === null ? { ok: true, value: 600000 } : parsed;
}

function applyRequestDefaults(requestBody, requestDefaults = {}) {
  const entries = Object.entries(requestDefaults);
  for (const [key] of entries) {
    if (!ALLOWED_REQUEST_DEFAULT_KEYS.has(key)) {
      return { ok: false, error: `disallowed_request_default:${key}` };
    }
  }
  for (const [key, value] of entries) {
    requestBody[key] = value;
  }
  return { ok: true };
}

function validateDirectApiRunPreflight(cfg, provider, env = process.env) {
  if (cfg.auth_mode !== "api_key" && cfg.auth_mode !== "auto") {
    return {
      ok: false,
      reason: "bad_args",
      error: `${provider} auth_mode must be api_key or auto`,
    };
  }
  const maxTokensOverride = parseMaxTokensOverride(env);
  if (!maxTokensOverride.ok) {
    return { ok: false, reason: "bad_args", error: maxTokensOverride.error };
  }
  const maxPromptCharsOverride = parseMaxPromptCharsOverride(env);
  if (!maxPromptCharsOverride.ok) {
    return { ok: false, reason: "bad_args", error: maxPromptCharsOverride.error };
  }
  const timeoutMs = parseProviderTimeoutMs(env);
  if (!timeoutMs.ok) {
    return { ok: false, reason: "bad_args", error: timeoutMs.error };
  }
  const credential = selectedCredential(cfg, env);
  if (!credential.value) {
    return {
      ok: false,
      reason: "missing_key",
      error: `${cfg.display_name} API key is not available`,
    };
  }
  const requestDefaultsProbe = applyRequestDefaults({
    model: cfg.model,
    messages: [],
    temperature: 0,
  }, cfg.request_defaults);
  if (!requestDefaultsProbe.ok) {
    return { ok: false, reason: "bad_args", error: requestDefaultsProbe.error };
  }
  return { ok: true, maxTokensOverride, maxPromptCharsOverride, timeoutMs, credential };
}

function maxPromptCharsFor(cfg, env = process.env) {
  const override = parseMaxPromptCharsOverride(env);
  if (!override.ok) return override;
  if (override.value !== null) return override;
  const configured = cfg.max_prompt_chars;
  if (configured === undefined || configured === null || configured === "") {
    return { ok: true, value: DEFAULT_MAX_PROMPT_CHARS };
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      error: `${cfg.display_name} max_prompt_chars must be a positive integer number of characters; got ${JSON.stringify(configured)}`,
    };
  }
  return { ok: true, value: parsed };
}

function validateRenderedPromptBudget(prompt, cfg, env = process.env) {
  const maxPromptChars = maxPromptCharsFor(cfg, env);
  if (!maxPromptChars.ok) {
    return { ok: false, reason: "bad_args", error: maxPromptChars.error };
  }
  if (prompt.length > maxPromptChars.value) {
    return {
      ok: false,
      reason: "scope_failed",
      error: `prompt_too_large:${prompt.length} chars exceeds ${cfg.display_name} max_prompt_chars=${maxPromptChars.value}`,
    };
  }
  return { ok: true, maxPromptChars };
}

function redactor(env = process.env, configuredSecretNames = []) {
  const configured = new Set(configuredSecretNames);
  const secrets = Object.entries(env)
    .filter(([name, value]) => (
      typeof value === "string" &&
      (
        (configured.has(name) && value.length >= 4) ||
        (/(?:^|_)(?:API_KEY|TOKEN|ACCESS_KEY|SECRET|ADMIN_KEY)$/.test(name) && value.length >= MIN_SECRET_REDACTION_LENGTH)
      )
    ))
    .map(([, value]) => value);
  return (text) => {
    let out = String(text ?? "");
    for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
    out = out.replace(/Authorization:\s*\S.*$/gim, "Authorization: [REDACTED]");
    out = out.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    out = redactEmailTokens(out);
    out = out.replaceAll(/\bplan[_-]?id=[^\s,;:)]+/gi, "[REDACTED]");
    out = out.replaceAll(ACCOUNT_PAYMENT_TOKEN_RE, "[REDACTED]");
    return out;
  };
}

function redactEmailTokens(text) {
  let out = "";
  let token = "";
  const flush = () => {
    out += redactEmailToken(token);
    token = "";
  };
  for (const ch of String(text ?? "")) {
    if (isEmailTokenChar(ch)) {
      token += ch;
    } else {
      flush();
      out += ch;
    }
  }
  flush();
  return out;
}

function isEmailTokenChar(ch) {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ch === "." || ch === "_" || ch === "%" || ch === "+" || ch === "-" || ch === "@"
  );
}

function redactEmailToken(token) {
  if (!token) return "";
  let end = token.length;
  while (end > 0 && token[end - 1] === ".") end -= 1;
  const core = token.slice(0, end);
  const suffix = token.slice(end);
  return isEmailLikeToken(core) ? `[REDACTED]${suffix}` : token;
}

function isEmailLikeToken(token) {
  const at = token.indexOf("@");
  if (at <= 0 || at !== token.lastIndexOf("@") || at === token.length - 1) return false;
  const domain = token.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  if (dot <= 0 || dot >= domain.length - 2) return false;
  for (let i = dot + 1; i < domain.length; i += 1) {
    const code = domain.charCodeAt(i);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) return false;
  }
  return true;
}

function redactValue(value, redact) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, redactValue(entryValue, redact)])
    );
  }
  return value;
}

function redactRecord(record, env = process.env, configuredSecretNames = []) {
  return redactValue(record, redactor(env, configuredSecretNames));
}

function baseUrlFor(cfg) {
  let url = String(cfg.base_url);
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function doctorFields(provider, cfg, env = process.env) {
  const credential = selectedCredential(cfg, env);
  const endpoint = baseUrlFor(cfg);
  const costQuotaReadiness = {
    status: "unknown_not_probed",
    source: "doctor_does_not_call_billing_or_usage_endpoints",
    billing_mutation: "not_supported",
  };
  if (!VALID_AUTH_MODES.has(cfg.auth_mode)) {
    return {
      provider,
      status: "config_error",
      ready: false,
      summary: `${cfg.display_name} direct API auth mode is unsupported.`,
      next_action: `Set ${provider} auth_mode to api_key or auto.`,
      auth_mode: cfg.auth_mode,
      endpoint,
      cost_quota_readiness: costQuotaReadiness,
    };
  }
  if (!credential.value) {
    return {
      provider,
      status: "missing_key",
      ready: false,
      summary: `${cfg.display_name} direct API key is not available.`,
      next_action: `Expose one of these key names to Codex: ${(cfg.env_keys ?? []).join(", ")}.`,
      auth_mode: cfg.auth_mode,
      credential_candidates: cfg.env_keys ?? [],
      endpoint,
      cost_quota_readiness: costQuotaReadiness,
    };
  }
  return {
    provider,
    status: "ok",
    ready: true,
    summary: `${cfg.display_name} direct API reviewer is ready using ${credential.keyName}.`,
    next_action: "Run a direct API review.",
    auth_mode: cfg.auth_mode,
    credential_ref: credential.keyName,
    endpoint,
    model: cfg.model,
    cost_quota_readiness: costQuotaReadiness,
  };
}

function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: false,
    windowsHide: true,
  });

  return {
    command,
    args,
    status: result.status ?? (result.error || result.signal ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

function git(args, cwd, options = {}) {
  const res = runCommand(resolveGitBinary({ cwd, workspaceRoot: options.workspaceRoot }), args, { cwd, env: gitEnv(cleanGitEnv()) });
  if (res.error) throw new Error(`git_failed:${res.error.message}`);
  if (res.signal) throw new Error(`git_failed:signal:${res.signal}`);
  if (res.status !== 0) {
    if (options.allowFailure) return null;
    const detail = String(res.stderr || res.stdout || `git exited with status ${res.status}`).trim();
    throw new Error(`git_failed:${detail}`);
  }
  return res.stdout.trim();
}

function gitRaw(args, cwd, options = {}) {
  const res = runCommand(resolveGitBinary({ cwd, workspaceRoot: options.workspaceRoot }), args, {
    cwd,
    env: gitEnv(cleanGitEnv()),
    maxBuffer: options.maxBuffer,
  });
  if (res.error) throw new Error(`git_failed:${res.error.message}`);
  if (res.signal) throw new Error(`git_failed:signal:${res.signal}`);
  if (res.status !== 0) {
    if (options.allowFailure) return null;
    const detail = String(res.stderr || res.stdout || `git exited with status ${res.status}`).trim();
    throw new Error(`git_failed:${detail}`);
  }
  return res.stdout;
}

function bestEffortWorkspaceRoot(cwd) {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd, { allowFailure: true }) || cwd;
  } catch (error) {
    if (isGitBinaryPolicyError(error)) throw error;
    return cwd;
  }
}

function splitScopePaths(value) {
  if (!value) return [];
  return String(value).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function splitGitPathList(output) {
  return output ? output.split("\0").filter(Boolean) : [];
}

function matchGlob(rel, pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          re += "(?:.*/)?";
          i += 1;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (".^$+(){}|\\[]".includes(c)) re += `\\${c}`;
    else re += c;
  }
  re += "$";
  return new RegExp(re).test(rel);
}

async function readUtf8ScopeFileWithinLimit(filePath, normalizedRel, beforeOpen = null) {
  beforeOpen ??= await lstat(filePath);
  let handle;
  try {
    handle = await open(filePath, SCOPE_FILE_OPEN_FLAGS);
  } catch (e) {
    if (e?.code === "ELOOP") throw new Error(`unsafe_scope_path:${normalizedRel}`);
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (!sameFileIdentity(beforeOpen, info)) {
      throw new Error(`unsafe_scope_path:${normalizedRel}: file changed before secure open`);
    }
    if (info.size > MAX_SCOPE_FILE_BYTES) {
      throw new Error(`scope_file_too_large:${normalizedRel}: ${info.size} bytes exceeds ${MAX_SCOPE_FILE_BYTES} byte limit`);
    }

    const chunks = [];
    let total = 0;
    for (;;) {
      const remaining = MAX_SCOPE_FILE_BYTES + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(remaining, 64 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SCOPE_FILE_BYTES) {
        throw new Error(`scope_file_too_large:${normalizedRel}: ${total} bytes exceeds ${MAX_SCOPE_FILE_BYTES} byte limit`);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total === 0) return "";
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle?.close();
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function addScopeFile(files, normalizedRel, text, totalBytes) {
  if (text.length === 0) return;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SCOPE_FILE_BYTES) {
    throw new Error(`scope_file_too_large:${normalizedRel}: ${bytes} bytes exceeds ${MAX_SCOPE_FILE_BYTES} byte limit`);
  }
  totalBytes.value += bytes;
  if (totalBytes.value > MAX_SCOPE_TOTAL_BYTES) {
    throw new Error(`scope_total_too_large:${totalBytes.value} bytes exceeds ${MAX_SCOPE_TOTAL_BYTES} byte limit`);
  }
  files.push({ path: normalizedRel, text });
}

function scopeName(options) {
  return options.scope ?? (options.mode === "custom-review" ? "custom" : "branch-diff");
}

function safeScopeBase(base) {
  const value = base ?? "main";
  if (typeof value !== "string" || value.trim() === "" || value.startsWith("-")) {
    throw new Error(`scope_base_invalid: base ref ${JSON.stringify(value)} is not safe for git branch-diff`);
  }
  return value;
}

function selectedScopePaths(scope, options, cwd, workspaceRoot = null) {
  if (scope === "custom") {
    const relPaths = splitScopePaths(options["scope-paths"]);
    if (relPaths.length === 0) throw new Error("scope_paths_required: custom-review requires --scope-paths");
    return relPaths;
  }
  if (scope === "branch-diff") {
    const base = safeScopeBase(options["scope-base"]);
    const changed = gitRaw(["diff", "-z", "--name-only", `${base}...HEAD`, "--"], cwd, { workspaceRoot });
    const requested = splitScopePaths(options["scope-paths"]);
    const changedPaths = splitGitPathList(changed);
    const relPaths = requested.length > 0
      ? changedPaths.filter((relPath) => requested.some((pattern) => matchGlob(relPath, pattern)))
      : changedPaths;
    if (relPaths.length === 0) throw new Error("scope_empty: branch-diff selected no files");
    return relPaths;
  }
  throw new Error(`unsupported_scope:${scope}`);
}

function validateScopePath(workspaceRoot, relPath) {
  if (relPath.includes("..") || isAbsolute(relPath) || relPath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(relPath)) {
    throw new Error(`unsafe_scope_path:${relPath}`);
  }
  const abs = resolve(workspaceRoot, relPath);
  const normalizedRel = relative(workspaceRoot, abs);
  if (normalizedRel.startsWith("..") || normalizedRel === "") {
    throw new Error(`unsafe_scope_path:${relPath}`);
  }
  return { abs, normalizedRel };
}

async function readGitScopeFiles(gitCwd, workspaceRoot, relPaths) {
  const files = [];
  const totalBytes = { value: 0 };
  for (const relPath of relPaths) {
    const { normalizedRel } = validateScopePath(workspaceRoot, relPath);
    const blobSpec = `HEAD:${normalizedRel}`;
    const sizeText = gitRaw(["cat-file", "-s", blobSpec], gitCwd, { allowFailure: true, workspaceRoot });
    if (sizeText === null) continue;
    const blobBytes = Number.parseInt(sizeText.trim(), 10);
    if (!Number.isSafeInteger(blobBytes) || blobBytes < 0) {
      throw new Error(`scope_invalid_git_blob_size:${normalizedRel}`);
    }
    if (blobBytes > MAX_SCOPE_FILE_BYTES) {
      throw new Error(`scope_file_too_large:${normalizedRel}: ${blobBytes} bytes exceeds ${MAX_SCOPE_FILE_BYTES} byte limit`);
    }
    const text = gitRaw(["show", blobSpec], gitCwd, {
      allowFailure: true,
      maxBuffer: GIT_SHOW_MAX_BUFFER_BYTES,
      workspaceRoot,
    });
    if (text === null || text.length === 0) continue;
    addScopeFile(files, normalizedRel, text, totalBytes);
  }
  if (files.length === 0) throw new Error("scope_empty: selected files are missing or empty");
  return files;
}

async function readFilesystemScopeFiles(workspaceRoot, relPaths) {
  const files = [];
  const totalBytes = { value: 0 };
  const realWorkspaceRoot = await realpath(workspaceRoot);
  for (const relPath of relPaths) {
    const { abs, normalizedRel } = validateScopePath(workspaceRoot, relPath);
    let beforeOpen;
    try {
      beforeOpen = await lstat(abs);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (beforeOpen.isSymbolicLink()) {
      throw new Error(`unsafe_scope_path:${normalizedRel}`);
    }
    const realAbs = await realpath(abs);
    const realRel = relative(realWorkspaceRoot, realAbs);
    if (realRel.startsWith("..") || realRel === "") {
      throw new Error(`unsafe_scope_path:${relPath}`);
    }
    const text = await readUtf8ScopeFileWithinLimit(realAbs, normalizedRel, beforeOpen);
    if (text === null) continue;
    addScopeFile(files, normalizedRel, text, totalBytes);
  }
  if (files.length === 0) throw new Error("scope_empty: selected files are missing or empty");
  return files;
}

async function collectScope(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const workspaceRoot = git(["rev-parse", "--show-toplevel"], cwd, { allowFailure: true }) || cwd;
  const scope = scopeName(options);
  const scopeBase = scope === "branch-diff" ? options["scope-base"] ?? "main" : null;
  const relPaths = selectedScopePaths(scope, options, cwd, workspaceRoot);
  const files = scope === "branch-diff"
    ? await readGitScopeFiles(cwd, workspaceRoot, relPaths)
    : await readFilesystemScopeFiles(workspaceRoot, relPaths);
  return {
    cwd,
    workspaceRoot,
    scope,
    scope_base: scopeBase,
    scope_paths: relPaths,
    repository: repositoryIdentity(cwd, workspaceRoot),
    base_commit: scopeBase ? gitCommitForPrompt(cwd, scopeBase, workspaceRoot) : null,
    head_ref: git(["branch", "--show-current"], cwd, { allowFailure: true, workspaceRoot }) || "HEAD",
    head_commit: gitCommitForPrompt(cwd, "HEAD", workspaceRoot),
    files,
  };
}

function gitCommitForPrompt(cwd, ref, workspaceRoot = null) {
  if (!ref) return null;
  try {
    return git(["rev-parse", "--verify", `${ref}^{commit}`], cwd, { allowFailure: true, workspaceRoot }) || null;
  } catch (error) {
    if (isGitBinaryPolicyError(error)) throw error;
    return null;
  }
}

function repositoryIdentity(cwd, workspaceRoot) {
  const remote = git(["remote", "get-url", "origin"], cwd, { allowFailure: true, workspaceRoot });
  if (!remote) return workspaceRoot;
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return match ? match[1] : remote;
}

function fileContentDelimiter(file, index) {
  let delimiter = `API REVIEWER FILE ${index}: ${file.path}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!file.text.includes(`BEGIN ${delimiter}`) && !file.text.includes(`END ${delimiter}`)) {
      return delimiter;
    }
    delimiter = `${delimiter} #`;
  }
  throw new Error(`scope_delimiter_collision:${file.path}`);
}

function promptFileBlock(file, index) {
  const delimiter = fileContentDelimiter(file, index);
  return [
    `BEGIN ${delimiter}`,
    file.text,
    `END ${delimiter}`,
  ].join("\n");
}

function promptFor(mode, userPrompt, scopeInfo, providerName = "Direct API reviewer") {
  const modeLine = mode === "adversarial-review"
    ? "You are performing an adversarial code review. Prioritize correctness bugs, security risks, regressions, and missing tests."
    : "You are performing a code review. Prioritize bugs, behavioral regressions, and missing tests.";
  const liveContext = [
    "Live verification context:",
    "- This repository has verified the configured DeepSeek and GLM direct API endpoints/models from Codex-managed runs.",
    "- Do not reject model IDs or endpoint hosts solely because they differ from general public documentation; require current run failure evidence or repo-local contradictory evidence.",
    "- The JobRecord will include the actual endpoint, HTTP status, raw model, credential key name, and usage metadata when the provider returns them.",
  ].join("\n");
  const files = scopeInfo.files.map((file, index) => promptFileBlock(file, index + 1)).join("\n\n");
  return buildReviewPrompt({
    provider: providerName,
    mode,
    repository: scopeInfo.repository,
    baseRef: scopeInfo.scope_base ?? null,
    baseCommit: scopeInfo.base_commit ?? null,
    headRef: scopeInfo.head_ref ?? "HEAD",
    headCommit: scopeInfo.head_commit ?? null,
    scope: scopeInfo.scope,
    scopePaths: scopeInfo.scope_paths,
    userPrompt,
    extraInstructions: [
      modeLine,
      liveContext,
      "Selected files:",
      files,
    ],
  });
}

function hasPromptText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function promptHead(value) {
  return hasPromptText(value) ? value.slice(0, 200) : "";
}

function requestFieldMatches(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    return actual.every((item, index) => requestFieldMatches(item, expected[index]));
  }
  if (
    actual && expected &&
    typeof actual === "object" &&
    typeof expected === "object"
  ) {
    const actualKeys = Object.keys(actual).sort((a, b) => a.localeCompare(b));
    const expectedKeys = Object.keys(expected).sort((a, b) => a.localeCompare(b));
    if (!requestFieldMatches(actualKeys, expectedKeys)) return false;
    return actualKeys.every((key) => requestFieldMatches(actual[key], expected[key]));
  }
  return false;
}

function mockProviderExecution(cfg, prompt, credential, env, requestBody) {
  const diagnostics = () => ({
    configured_timeout_ms: parseProviderTimeoutMs(env).value,
    prompt_chars: prompt.length,
    request_defaults: summarizeRequestDefaults(cfg.request_defaults),
    max_tokens: requestBody.max_tokens ?? null,
    temperature: requestBody.temperature ?? null,
  });
  const expectedPromptText = env.API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES;
  if (expectedPromptText && !prompt.includes(expectedPromptText)) {
    return providerFailureWithDiagnostics("mock_assertion_failed", `prompt missing expected text: ${expectedPromptText}`, 200, null, false, diagnostics());
  }
  const excludedPromptText = env.API_REVIEWERS_MOCK_ASSERT_PROMPT_EXCLUDES;
  if (excludedPromptText && prompt.includes(excludedPromptText)) {
    return providerFailureWithDiagnostics("mock_assertion_failed", `prompt included excluded text: ${excludedPromptText}`, 200, null, false, diagnostics());
  }
  if (env.API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY) {
    const parsedExpected = parseJson(env.API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY);
    if (!parsedExpected.ok || !parsedExpected.value || typeof parsedExpected.value !== "object" || Array.isArray(parsedExpected.value)) {
      return providerFailureWithDiagnostics("mock_assertion_failed", "API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY must be a JSON object", 200, null, false, diagnostics());
    }
    for (const [key, expected] of Object.entries(parsedExpected.value)) {
      if (!requestFieldMatches(requestBody[key], expected)) {
        return providerFailureWithDiagnostics(
          "mock_assertion_failed",
          `request body field ${key} expected ${JSON.stringify(expected)} but got ${JSON.stringify(requestBody[key])}`,
          200,
          null,
          false,
          diagnostics()
        );
      }
    }
  }
  const parsed = parseJson(env.API_REVIEWERS_MOCK_RESPONSE);
  if (!parsed.ok) return providerFailureWithDiagnostics("malformed_response", parsed.error, 200, null, false, diagnostics());
  const content = parsed.value?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return providerFailureWithDiagnostics("malformed_response", "response did not include choices[0].message.content", 200, parsed.value, false, diagnostics());
  }
  return {
    exitCode: 0,
    parsed: {
      ok: true,
      result: content,
      usage: parsed.value.usage ?? null,
      raw_model: parsed.value.model ?? null,
    },
    session_id: safeProviderSessionId(parsed.value?.id),
    http_status: 200,
    credential_ref: credential.keyName,
    endpoint: baseUrlFor(cfg),
    diagnostics: diagnostics(),
  };
}

async function callProvider(provider, cfg, prompt, env = process.env) {
  const preflight = validateDirectApiRunPreflight(cfg, provider, env);
  if (!preflight.ok) return providerFailure(preflight.reason, preflight.error, null, null, false);
  const { credential, maxTokensOverride, timeoutMs } = preflight;
  const endpoint = `${baseUrlFor(cfg)}/chat/completions`;
  const requestBody = {
    model: cfg.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  };
  const defaultsResult = applyRequestDefaults(requestBody, cfg.request_defaults);
  if (!defaultsResult.ok) {
    return providerFailureWithDiagnostics("bad_args", defaultsResult.error, null, null, false, {
      configured_timeout_ms: timeoutMs.value,
      prompt_chars: prompt.length,
      request_defaults: summarizeRequestDefaults(cfg.request_defaults),
      max_tokens: requestBody.max_tokens ?? null,
      temperature: requestBody.temperature ?? null,
    });
  }
  if (maxTokensOverride.value !== null) {
    requestBody.max_tokens = maxTokensOverride.value;
  } else if (!Object.hasOwn(requestBody, "max_tokens")) {
    requestBody.max_tokens = 4096;
  }
  const diagnostics = () => ({
    configured_timeout_ms: timeoutMs.value,
    prompt_chars: prompt.length,
    request_defaults: summarizeRequestDefaults(cfg.request_defaults),
    max_tokens: requestBody.max_tokens ?? null,
    temperature: requestBody.temperature ?? null,
  });
  if (env.API_REVIEWERS_MOCK_RESPONSE) {
    return mockProviderExecution(cfg, prompt, credential, env, requestBody);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs.value);
  const redact = redactor(env, cfg.env_keys);
  const started = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential.value}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      const errorCode = classifyHttpFailure(response.status, parsed, text);
      return providerFailureWithDiagnostics(
        errorCode,
        providerErrorMessage(parsed, text, redact, { safeUsageLimit: errorCode === "usage_limited" }),
        response.status,
        parsed,
        true,
        {
          ...diagnostics(),
          elapsed_ms: Date.now() - started,
          cost_quota: costQuotaDiagnostics(errorCode, response.status, parsed),
        },
      );
    }
    if (!parsed.ok) {
      return providerFailureWithDiagnostics("malformed_response", parsed.error, response.status, null, true, diagnostics());
    }
    const content = parsed.value?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return providerFailureWithDiagnostics(
        "malformed_response",
        "response did not include choices[0].message.content",
        response.status,
        parsed.value,
        true,
        diagnostics(),
      );
    }
    return {
      exitCode: 0,
      parsed: {
        ok: true,
        result: content,
        usage: parsed.value.usage ?? null,
        raw_model: parsed.value.model ?? null,
      },
      session_id: safeProviderSessionId(parsed.value?.id),
      http_status: response.status,
      credential_ref: credential.keyName,
      endpoint: baseUrlFor(cfg),
      diagnostics: diagnostics(),
    };
  } catch (e) {
    const reason = e?.name === "AbortError" ? "timeout" : "provider_unavailable";
    return providerFailureWithDiagnostics(
      reason,
      redact(e?.message ?? String(e)),
      null,
      null,
      payloadSentForProviderException(e),
      {
        ...diagnostics(),
        elapsed_ms: Date.now() - started,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function summarizeRequestDefaults(defaults = {}) {
  const summary = {};
  for (const key of ["thinking", "reasoning_effort", "max_tokens", "top_p"]) {
    if (Object.hasOwn(defaults, key)) summary[key] = defaults[key];
  }
  return summary;
}

function safeProviderSessionId(value) {
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9._:/=+@-]{1,200}$/.test(value) ? value : null;
}

function payloadSentForProviderException(error) {
  if (error?.name === "AbortError") return true;
  const code = error?.code ?? error?.cause?.code ?? null;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" ||
      code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return false;
  }
  return null;
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function providerErrorMessage(parsed, text, redact, { safeUsageLimit = false } = {}) {
  if (safeUsageLimit) return USAGE_LIMIT_SAFE_MESSAGE;
  if (parsed.ok) {
    const message = parsed.value?.error?.message ?? parsed.value?.message ?? JSON.stringify(parsed.value).slice(0, 800);
    return redact(message);
  }
  return redact(text).slice(0, 800);
}

function providerFailureDetail(parsed) {
  if (!parsed.ok) return {};
  const value = parsed.value;
  if (value && typeof value === "object" && "error" in value && value.error != null) return value.error;
  return value ?? {};
}

function providerFailureDetailText(parsed) {
  return JSON.stringify(providerFailureDetail(parsed) ?? {});
}

function providerFailureDetailObject(parsed) {
  const detail = providerFailureDetail(parsed);
  return detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {};
}

function classifyHttpFailure(status, parsed, text = "") {
  const detail = parsed.ok ? providerFailureDetailText(parsed) : String(text ?? "");
  const usageLimitDetail = isUsageLimitDetail(detail);
  if (status === 401 || (status === 403 && !usageLimitDetail)) return "auth_rejected";
  if (status === 402 || (status === 403 && usageLimitDetail) || (status === 429 && usageLimitDetail)) return "usage_limited";
  if (status === 429) return "rate_limited";
  if (status === 501) return "provider_error";
  if (status === 408 || status === 409 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504) {
    return "provider_unavailable";
  }
  if (status >= 500 && status <= 599) return "provider_error";
  if (/capacity|resource|overload|unavailable/i.test(detail)) {
    return "provider_unavailable";
  }
  if (isUsageLimitDetail(detail)) return "usage_limited";
  return "provider_error";
}

function safeDiagnosticString(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (ACCOUNT_PAYMENT_DIAGNOSTIC_RE.test(text)) return null;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(text) ? text : null;
}

function costQuotaDiagnostics(errorCode, httpStatus, parsed) {
  const error = providerFailureDetailObject(parsed);
  return {
    classification: errorCode === "usage_limited" ? "usage_limited" : "not_reported",
    http_status: httpStatus ?? null,
    provider_error_code: safeDiagnosticString(error.code) ?? null,
    provider_error_type: safeDiagnosticString(error.type) ?? null,
    billing_mutation: "not_attempted",
  };
}

function providerFailure(reason, message, httpStatus, raw = null, payloadSent = null) {
  return {
    exitCode: 1,
    parsed: {
      ok: false,
      reason,
      error: message,
      raw,
    },
    http_status: httpStatus,
    payload_sent: payloadSent,
  };
}

function providerFailureWithDiagnostics(reason, message, httpStatus, raw = null, payloadSent = null, diagnostics = null) {
  return {
    ...providerFailure(reason, message, httpStatus, raw, payloadSent),
    diagnostics,
  };
}

function providerUnavailableSuggestedAction(errorMessage = "", httpStatus = null, env = process.env) {
  const looksLikeNetworkFailure = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i.test(errorMessage);
  if (httpStatus == null && isCodexSandbox(env) && looksLikeNetworkFailure) {
    return `If running inside Codex, set [sandbox_workspace_write].network_access = true in ~/.codex/config.toml, start a fresh Codex session, then retry; or run this direct API reviewer outside sandbox. If network is already enabled, retry later or switch reviewer provider.`;
  }
  if (httpStatus == null && looksLikeNetworkFailure) {
    return `Check network access, retry later, or switch reviewer provider.`;
  }
  return `Retry later or switch reviewer provider.`;
}

function scopeFailedSuggestedAction(errorMessage = "") {
  if (/scope_empty:\s*branch-diff selected no files/i.test(errorMessage)) {
    return "Branch-diff selected no files before provider launch. Branch-diff reviews committed HEAD-vs-base changes only; it does not include dirty working-tree edits. Choose a different --scope-base <ref> if this branch should have committed changes, use --scope-base HEAD~1 to review the last commit, or use custom-review with explicit --scope-paths for uncommitted, already-merged, or no-diff branches.";
  }
  if (/scope_base_invalid:/i.test(errorMessage)) {
    return "Use a concrete branch, tag, remote ref, or commit SHA for --scope-base; option-shaped values beginning with '-' are rejected before git branch-diff runs.";
  }
  if (/prompt_too_large:/i.test(errorMessage)) {
    return "Rendered prompt exceeds the direct API provider prompt budget before launch. Use a narrower scope, split the review into explicit custom-review shards, or raise API_REVIEWERS_MAX_PROMPT_CHARS only after confirming the selected provider accepts larger prompts.";
  }
  return "Adjust --scope, --scope-base, or --scope-paths and retry.";
}

function suggestedAction(errorCode, provider, cfg, errorMessage = "", httpStatus = null, env = process.env) {
  if (errorCode === "bad_args") return "Correct the api-reviewer command arguments and retry.";
  if (errorCode === "config_error") return "Reinstall or repair plugins/api-reviewers/config/providers.json and retry.";
  if (errorCode === "missing_key") return `Expose one of these key names to Codex: ${(cfg.env_keys ?? []).join(", ")}.`;
  if (errorCode === "auth_rejected") return `Check the ${cfg.display_name} API key and billing/plan for ${cfg.model}.`;
  if (errorCode === "usage_limited") return `${cfg.display_name} reported a quota, usage-tier, billing, or credit limit. This plugin does not purchase credits or upgrade tiers automatically; inspect the provider account and perform any billing transaction only after explicit user approval.`;
  // Kept for backward compatibility with older persisted records and future non-HTTP callers.
  if (errorCode === "rate_limited") return `Wait and retry, or lower concurrency for ${provider}.`;
  if (errorCode === "timeout") return `The provider did not respond within the timeout window. Retry later, increase API_REVIEWERS_TIMEOUT_MS, or switch reviewer provider.`;
  if (errorCode === "provider_unavailable") return providerUnavailableSuggestedAction(errorMessage, httpStatus, env);
  if (errorCode === "scope_failed") return scopeFailedSuggestedAction(errorMessage);
  if (errorCode === "git_binary_rejected") return `Set ${GIT_BINARY_ENV} to a trusted Git executable outside the workspace, or unset it to use the default Git binary.`;
  return "Inspect error_message and retry after correcting the provider or request configuration.";
}

function directApiDisclosure(displayName, completed, payloadSent) {
  const transmission = directApiTransmission(completed, payloadSent);
  if (transmission === SOURCE_CONTENT_TRANSMISSION.SENT && completed) {
    return `Selected source content was sent to ${displayName} through direct API auth.`;
  }
  if (transmission === SOURCE_CONTENT_TRANSMISSION.NOT_SENT) {
    return `Selected source content was not sent to ${displayName} through direct API auth.`;
  }
  if (transmission === SOURCE_CONTENT_TRANSMISSION.SENT) {
    return `Selected source content was sent to ${displayName} through direct API auth, but the provider did not return a clean result.`;
  }
  return `Selected source content may have been sent to ${displayName} through direct API auth.`;
}

function directApiTransmission(completed, payloadSent) {
  if (completed || payloadSent === true) return SOURCE_CONTENT_TRANSMISSION.SENT;
  if (payloadSent === false) return SOURCE_CONTENT_TRANSMISSION.NOT_SENT;
  return SOURCE_CONTENT_TRANSMISSION.UNKNOWN;
}

function freezeExternalReview(review) {
  const keys = Object.keys(review);
  if (keys.length !== EXTERNAL_REVIEW_KEYS.length
      || keys.some((key, index) => key !== EXTERNAL_REVIEW_KEYS[index])) {
    throw new Error(`external_review keys drifted: ${keys.join(",")}`);
  }
  return Object.freeze(review);
}

function freezeRecord(record) {
  const keys = Object.keys(record);
  if (keys.length !== API_REVIEWER_EXPECTED_KEYS.length
      || keys.some((key, index) => key !== API_REVIEWER_EXPECTED_KEYS[index])) {
    throw new Error(`api reviewer JobRecord keys drifted: ${keys.join(",")}`);
  }
  return Object.freeze(record);
}

function buildLaunchExternalReview({ cfg, mode, options, scopeInfo }) {
  const provider = cfg.display_name;
  return freezeExternalReview({
    marker: "EXTERNAL REVIEW",
    provider,
    run_kind: "foreground",
    job_id: options.jobId,
    session_id: null,
    parent_job_id: null,
    mode,
    scope: scopeInfo?.scope ?? null,
    scope_base: scopeInfo?.scope_base ?? null,
    scope_paths: scopeInfo?.scope_paths ?? null,
    source_content_transmission: SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT,
    disclosure: `Selected source content may be sent to ${provider} for external review.`,
  });
}

function errorCauseFor(errorCode) {
  if (errorCode === "bad_args") return "caller";
  if (errorCode === "config_error") return "provider_config";
  if (errorCode === "scope_failed") return "scope_resolution";
  if (errorCode === "git_binary_rejected") return "git_binary_policy";
  if (errorCode === "usage_limited") return "cost_quota_usage_limit";
  return "direct_api_provider";
}

function scopeDiagnostics(scopeInfo) {
  const files = Array.isArray(scopeInfo.files) ? scopeInfo.files : [];
  const selectedChars = files.reduce((sum, file) => sum + String(file.text ?? "").length, 0);
  const selectedBytes = files.reduce((sum, file) => sum + Buffer.byteLength(String(file.text ?? ""), "utf8"), 0);
  return {
    selected_files: files.length,
    selected_bytes: selectedBytes,
    selected_chars: selectedChars,
  };
}

function diagnosticErrorSummary(errorCode, errorMessage, scopeInfo, execution) {
  if (errorCode !== "timeout") return errorMessage || errorCode;
  const scope = scopeDiagnostics(scopeInfo);
  const diagnostics = execution.diagnostics ?? {};
  const promptChars = diagnostics.prompt_chars ?? 0;
  const estimatedTokens = Math.ceil(promptChars / 4);
  return [
    `timeout after ${diagnostics.elapsed_ms ?? "unknown"}ms`,
    `configured_timeout_ms=${diagnostics.configured_timeout_ms ?? "unknown"}`,
    `selected_files=${scope.selected_files}`,
    `selected_bytes=${scope.selected_bytes}`,
    `selected_chars=${scope.selected_chars}`,
    `prompt_chars=${promptChars}`,
    `estimated_tokens=${estimatedTokens}`,
    `max_tokens=${diagnostics.max_tokens ?? "unknown"}`,
  ].join(" ");
}

function buildReviewMetadata(cfg, scopeInfo, execution = null) {
  const auditManifest = execution?.prompt ? buildReviewAuditManifest({
    prompt: execution.prompt,
    sourceFiles: scopeInfo.files,
    git: {
      remote: scopeInfo.repository ?? null,
      branch: scopeInfo.head_ref ?? null,
      baseRef: scopeInfo.scope_base ?? null,
      baseCommit: scopeInfo.base_commit ?? null,
      headRef: scopeInfo.head_ref ?? null,
      headCommit: scopeInfo.head_commit ?? null,
    },
    promptBuilder: {
      contractVersion: REVIEW_PROMPT_CONTRACT_VERSION,
      pluginVersion: "0.1.0",
      pluginCommit: gitCommitForPrompt(PLUGIN_ROOT, "HEAD"),
    },
    request: {
      provider: cfg.display_name,
      model: cfg.model,
      timeoutMs: execution.diagnostics?.configured_timeout_ms ?? null,
      maxTokens: execution.diagnostics?.max_tokens ?? null,
      temperature: execution.diagnostics?.temperature ?? null,
      stream: false,
    },
    truncation: {
      prompt: false,
      source: false,
      output: false,
    },
    providerIds: {
      sessionId: execution.session_id ?? null,
    },
    scope: {
      name: scopeInfo.scope,
      base: scopeInfo.scope_base ?? null,
      paths: scopeInfo.scope_paths ?? null,
      reason: scopeResolutionReason(scopeInfo),
    },
    result: execution.parsed?.result ?? "",
    status: execution.exitCode === 0 && execution.parsed?.ok === true ? "completed" : "failed",
    errorCode: execution.parsed?.reason ?? null,
  }) : null;
  return {
    prompt_contract_version: REVIEW_PROMPT_CONTRACT_VERSION,
    prompt_provider: cfg.display_name,
    scope: scopeInfo.scope,
    scope_base: scopeInfo.scope_base ?? null,
    scope_paths: scopeInfo.scope_paths ?? null,
    raw_output: execution ? {
      http_status: execution.http_status ?? null,
      raw_model: execution.parsed?.raw_model ?? null,
      parsed_ok: execution.parsed?.ok ?? null,
      result_chars: typeof execution.parsed?.result === "string" ? execution.parsed.result.length : null,
    } : null,
    audit_manifest: auditManifest,
  };
}

function buildRecord({ provider, cfg, mode, options, scopeInfo, execution, startedAt, endedAt }) {
  const completed = execution.exitCode === 0 && execution.parsed?.ok === true;
  const redact = redactor(process.env, cfg.env_keys);
  const result = completed ? redact(execution.parsed.result) : null;
  const errorMessage = completed ? null : redact(execution.parsed?.error ?? "");
  const errorCode = completed ? null : (execution.parsed?.reason ?? "provider_error");
  const target = provider;
  const sourceContentTransmission = directApiTransmission(completed, execution.payload_sent ?? null);
  const disclosure = directApiDisclosure(cfg.display_name, completed, execution.payload_sent ?? null);
  const externalReview = freezeExternalReview({
    marker: "EXTERNAL REVIEW",
    provider: cfg.display_name,
    run_kind: "foreground",
    job_id: options.jobId,
    session_id: execution.session_id ?? null,
    parent_job_id: null,
    mode,
    scope: scopeInfo.scope,
    scope_base: scopeInfo.scope_base ?? null,
    scope_paths: scopeInfo.scope_paths ?? null,
    source_content_transmission: sourceContentTransmission,
    disclosure,
  });
  const runtimeDiagnostics = execution.diagnostics ? {
    provider_request: {
      configured_timeout_ms: execution.diagnostics.configured_timeout_ms ?? null,
      elapsed_ms: execution.diagnostics.elapsed_ms ?? null,
      prompt_chars: execution.diagnostics.prompt_chars ?? null,
      request_defaults: execution.diagnostics.request_defaults ?? null,
      max_tokens: execution.diagnostics.max_tokens ?? null,
      temperature: execution.diagnostics.temperature ?? null,
    },
    cost_quota: execution.diagnostics.cost_quota ?? null,
  } : null;
  return freezeRecord({
    id: options.jobId,
    job_id: options.jobId,
    target,
    provider,
    parent_job_id: null,
    claude_session_id: null,
    gemini_session_id: null,
    kimi_session_id: null,
    resume_chain: [],
    pid_info: null,
    mode,
    mode_profile_name: mode,
    model: cfg.model,
    cwd: scopeInfo.cwd,
    workspace_root: scopeInfo.workspaceRoot,
    containment: "none",
    scope: scopeInfo.scope,
    dispose_effective: false,
    scope_base: scopeInfo.scope_base ?? null,
    scope_paths: scopeInfo.scope_paths ?? null,
    prompt_head: promptHead(options.prompt),
    review_metadata: buildReviewMetadata(cfg, scopeInfo, execution),
    schema_spec: null,
    binary: null,
    status: completed ? "completed" : "failed",
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: execution.exitCode,
    error_code: errorCode,
    error_message: errorMessage,
    error_summary: completed ? null : diagnosticErrorSummary(errorCode, errorMessage, scopeInfo, execution),
    error_cause: completed ? null : errorCauseFor(errorCode),
    suggested_action: completed ? null : suggestedAction(errorCode, provider, cfg, errorMessage, execution.http_status ?? null),
    external_review: externalReview,
    disclosure_note: disclosure,
    runtime_diagnostics: runtimeDiagnostics,
    result,
    structured_output: null,
    permission_denials: [],
    mutations: [],
    cost_usd: null,
    usage: execution.parsed?.usage ?? null,
    auth_mode: cfg.auth_mode,
    credential_ref: execution.credential_ref ?? null,
    endpoint: execution.endpoint ?? (cfg.base_url ? baseUrlFor(cfg) : null),
    http_status: execution.http_status ?? null,
    raw_model: execution.parsed?.raw_model ?? null,
    schema_version: SCHEMA_VERSION,
  });
}

async function persistRecord(record, env = process.env) {
  const root = apiReviewerDataRoot(env);
  await writeApiReviewerMetaRecord(root, record);
  await withApiReviewerStateLock(root, async () => {
    await writeApiReviewerMetaRecord(root, record);
    await updateApiReviewerStateForRecord(root, record);
  });
}

async function persistRecordBestEffort(record, env = process.env, configuredSecretNames = []) {
  try {
    await persistRecord(record, env);
    return record;
  } catch (e) {
    const detail = redactor(env, configuredSecretNames)(`JobRecord persistence failed: ${e?.message ?? String(e)}`);
    return {
      ...record,
      disclosure_note: record.disclosure_note ? `${record.disclosure_note} ${detail}` : detail,
    };
  }
}

async function cmdDoctor(options) {
  const provider = options.provider;
  let providers;
  try {
    providers = await loadProviders();
  } catch (e) {
    printJson(providersConfigErrorFields(e, provider ?? null));
    process.exit(1);
  }
  if (!provider) throw new Error("bad_args: --provider is required");
  const cfg = providerConfig(providers, provider);
  printJson(doctorFields(provider, cfg));
}

async function cmdRun(options) {
  const provider = options.provider ?? null;
  const mode = options.mode ?? "review";
  let lifecycleEvents = null;
  const startedAt = new Date().toISOString();
  const jobId = `job_${randomUUID()}`;
  const runOptions = { ...options, jobId };
  let providers;
  let cfg;
  let scopeInfo;
  let execution;
  try {
    lifecycleEvents = parseLifecycleEventsMode(options["lifecycle-events"]);
    if (!provider) throw runBadArgs("bad_args: --provider is required");
    if (!VALID_MODES.has(mode)) throw runBadArgs(`bad_args: unsupported --mode ${mode}`);
    try {
      providers = await loadProviders();
    } catch (e) {
      throw runConfigError(`config_error: ${providersConfigErrorMessage(e)}`);
    }
    try {
      cfg = providerConfig(providers, provider);
    } catch (e) {
      throw runBadArgs(e.message);
    }
    const preflight = validateDirectApiRunPreflight(cfg, provider, process.env);
    if (!preflight.ok && preflight.reason === "bad_args") throw runBadArgs(preflight.error);
    if (!preflight.ok) throw runProviderFailure(preflight.reason, preflight.error);
    scopeInfo = await collectScope({ ...runOptions, mode });
  } catch (e) {
    const redact = redactor();
    const policyError = isGitBinaryPolicyError(e);
    const reason = policyError ? "git_binary_rejected" : (e.apiReviewersReason ?? "scope_failed");
    cfg ??= fallbackProviderConfig(provider);
    const cwd = resolve(process.cwd());
    scopeInfo = {
      cwd,
      workspaceRoot: policyError ? cwd : bestEffortWorkspaceRoot(cwd),
      scope: options.scope ?? null,
      scope_base: options["scope-base"] ?? null,
      scope_paths: splitScopePaths(options["scope-paths"]),
    };
    execution = {
      exitCode: 1,
      parsed: { ok: false, reason, error: redact(e.message) },
      payload_sent: false,
    };
  }
  if (!execution) {
    if (!hasPromptText(options.prompt)) {
      execution = providerFailure("bad_args", "prompt is required (pass --prompt <focus>)", null, null, false);
    }
  }
  if (!execution) {
    let renderedPrompt = null;
    try {
      renderedPrompt = promptFor(mode, options.prompt ?? "", scopeInfo, cfg.display_name);
      const promptBudget = validateRenderedPromptBudget(renderedPrompt, cfg, process.env);
      if (!promptBudget.ok) {
        execution = providerFailure(promptBudget.reason, redactor(process.env)(promptBudget.error), null, null, false);
        execution.prompt = renderedPrompt;
      }
    } catch (e) {
      execution = providerFailure("scope_failed", redactor(process.env)(e?.message ?? String(e)), null, null, false);
    }
    if (execution) {
      // handled below by the terminal JobRecord path without a launch event
    } else {
    if (lifecycleEvents) {
      printLifecycleJson({
        event: "external_review_launched",
        job_id: jobId,
        target: provider,
        status: "launched",
        external_review: buildLaunchExternalReview({ cfg, mode, options: runOptions, scopeInfo }),
      }, lifecycleEvents);
    }
    try {
      execution = await callProvider(provider, cfg, renderedPrompt);
      execution.prompt = renderedPrompt;
    } catch (e) {
      execution = providerFailure("provider_unavailable", redactor(process.env)(e?.message ?? String(e)), null, null, null);
      execution.prompt = renderedPrompt;
    }
    }
  }
  const record = redactRecord(buildRecord({
    provider: provider ?? "api-reviewers",
    cfg,
    mode,
    options: runOptions,
    scopeInfo,
    execution,
    startedAt,
    endedAt: new Date().toISOString(),
  }), process.env, cfg.env_keys);
  const printableRecord = await persistRecordBestEffort(record, process.env, cfg.env_keys);
  printLifecycleJson(printableRecord, lifecycleEvents);
  process.exit(record.status === "completed" ? 0 : 1);
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (cmd === "doctor" || cmd === "ping") return cmdDoctor(options);
  if (cmd === "run") return cmdRun(options);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    let providers;
    try {
      providers = await loadProviders();
    } catch (e) {
      printJson({
        ok: false,
        commands: ["doctor", "ping", "run"],
        providers: [],
        ...providersConfigErrorFields(e),
      });
      process.exit(1);
    }
    printJson({ ok: true, commands: ["doctor", "ping", "run"], providers: Object.keys(providers) });
    return;
  }
  throw new Error(`unknown_command:${cmd}`);
}

try {
  await main();
} catch (e) {
  printJson({ ok: false, error: e.message });
  process.exit(1);
}
