#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, lstatSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, dirname, isAbsolute, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";

import { cleanGitEnv } from "./lib/git-env.mjs";
import { GIT_BINARY_ENV, gitEnv, isGitBinaryPolicyError, resolveGitBinary } from "./lib/git-binary.mjs";
import { isCodexSandbox } from "./lib/codex-env.mjs";
import { REVIEW_PROMPT_CONTRACT_VERSION, buildReviewAuditManifest, buildReviewPrompt, scopeResolutionReason } from "./lib/review-prompt.mjs";
import { USAGE_LIMIT_SAFE_MESSAGE, isUsageLimitDetail } from "./lib/usage-limit.mjs";
import { elapsedMs } from "./lib/time.mjs";
import { diffSourceFiles } from "./lib/diff-source.mjs";
import { buildExternalModelFailureDiagnostic } from "./lib/external-model-failure-core.mjs";
import { hasSubstantiveInvalidVerdictReason, reviewQualityFailureState } from "./lib/external-model-review-quality.mjs";
import { buildPrivacyRedactor } from "./lib/privacy-redaction.mjs";
import {
  buildPacketRecovery,
  CONCURRENCY_FACTS,
  latestSourcePacketPreviousAttempt,
  normalizeApprovalScope,
  resolveConcurrencyAdmission,
  selectProviderRoute,
  sourceSendApprovalTupleFingerprint,
  sourceSentPacketRecoveryReason,
} from "./lib/provider-route-policy.mjs";
import {
  EXTERNAL_REVIEW_KEYS,
  SOURCE_CONTENT_TRANSMISSION,
} from "./lib/external-review.mjs";
import {
  acquireProviderWorkloadLease,
  providerWorkloadBlockedExecution,
  releaseProviderWorkloadLease,
} from "./lib/review-workload.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const PROVIDERS_PATH = configuredPath("API_REVIEWERS_PROVIDERS_PATH", resolve(PLUGIN_ROOT, "config/providers.json"));
const SESSION_APPROVAL_POLICY_PATH = configuredPath(
  "API_REVIEWERS_SESSION_APPROVAL_POLICY_PATH",
  resolve(PLUGIN_ROOT, "config/session-approval.json"),
);
const VALID_MODES = new Set(["review", "adversarial-review", "custom-review"]);
const VALID_AUTH_MODES = new Set(["api_key"]);
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
const DEFAULT_PROVIDER_TIMEOUT_MS = 900000;
const SESSION_APPROVAL_GRANT_SCHEMA_VERSION = 1;
const DOCTOR_PROBE_PROMPT = "Return exactly: ok";
const CODEX_SOURCE_SEND_SANDBOX_GUIDANCE = "Use the default Codex sandbox for the matching source-bearing run. Do not request `sandbox_permissions: \"require_escalated\"` for a normal source send; if the default sandbox blocks provider auth, job state, temp files, or network, stop and report `sandbox_blocked` with `source_content_transmission: \"not_sent\"`.";
const HOST_NEUTRAL_SOURCE_SEND_SANDBOX_GUIDANCE = "Use the current execution environment for the matching source-bearing run. Do not broaden local execution access for a normal source send; if local execution blocks provider auth, job state, temp files, or network, stop and report `sandbox_blocked` with `source_content_transmission: \"not_sent\"`.";
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
  "credential_source",
  "endpoint",
  "http_status",
  "raw_model",
  "schema_version",
]);
const APPROVAL_GRANT_RECORD_KEYS = Object.freeze([
  "schema_version",
  "grant_id",
  "created_at",
  "expires_at",
  "grant_session_id",
  "provider_allowlist",
  "mode_allowlist",
  "workspace_root_hash",
  "path_constraints",
  "max_files",
  "max_bytes",
  "max_ttl_ms",
  "approval_fingerprint",
  "approval_tuple",
  "activation",
]);
const APPROVAL_GRANT_TUPLE_KEYS = Object.freeze([
  "provider",
  "mode",
  "selected_source",
  "rendered_prompt_hash",
  "request",
  "scope_resolution",
  "auth_path",
  "billing_path",
  "selected_route",
  "route_step",
  "route_steps",
  "fallback_reason",
  "approval_scope",
  "grant_bounds",
]);
const APPROVAL_GRANT_BOUNDS_KEYS = Object.freeze([
  "provider_allowlist",
  "mode_allowlist",
  "workspace_root_hash",
  "path_constraints",
  "max_files",
  "max_bytes",
  "expires_at",
  "max_ttl_ms",
  "schema_version",
]);
const APPROVAL_GRANT_ACTIVATION_KEYS = Object.freeze([
  "activated_at",
  "source_content_transmission",
  "approval_source",
]);
const ALLOWED_REQUEST_DEFAULT_KEYS = new Set(["thinking", "reasoning_effort", "max_tokens", "top_p", "stop"]);
const ACCOUNT_PAYMENT_DIAGNOSTIC_RE = /^(?:stripe-.+|cus_[A-Za-z0-9]{6,}|acct_(?:test_)?[A-Za-z0-9]{5,}|cs_(?:test|live)_[A-Za-z0-9]{6,}|(?:pi|sub|in|ii|ch|seti|setp|price|prod|iv)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,})$/i;
const CREDENTIAL_REDACTION_VALUE = Symbol("credential_redaction_value");
const REDACTION_SECRET_ENV_PREFIX = "API_REVIEWERS_REDACTION_SECRET";

function concurrencyAdmissionBlockedExecution(error, provider, route) {
  const detail = error?.message ?? String(error);
  return providerWorkloadBlockedExecution({
    ok: false,
    reason: "concurrency_admission_failed",
    message: `concurrency admission failed for ${provider}.${route}: ${detail}`,
    capacity: null,
  });
}

function resolveApiReviewerAdmissionContext(provider, env = process.env) {
  const route = "direct_api";
  const fact = CONCURRENCY_FACTS[provider]?.[route];
  if (!fact) {
    throw new Error(`missing concurrency fact for source-bearing route ${provider}.${route}`);
  }
  return resolveConcurrencyAdmission({
    category: fact.category,
    declaredLimit: fact.limit,
    limitEnv: fact.limit_env,
    provider,
    route,
    env,
  });
}

function assertSourceBearingWorkloadLease(workloadAdmission, sourceBearing) {
  if (workloadAdmission.ok && sourceBearing && workloadAdmission.lease == null) {
    process.stderr.write("api-reviewer: source-bearing admission returned no workload lease\n");
    process.exit(2);
  }
}

function configuredPath(envKey, fallbackPath) {
  const value = process.env[envKey];
  if (typeof value !== "string" || value.trim() === "") return fallbackPath;
  return resolve(value);
}

function writableOutput(output) {
  return output && typeof output.write === "function" ? output : process.stdout;
}

function printJson(obj, output = process.stdout) {
  writableOutput(output).write(`${JSON.stringify(obj, null, 2)}\n`);
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function lifecycleScope(externalReview) {
  const scope = externalReview?.scope ?? "";
  const base = externalReview?.scope_base ?? null;
  const paths = Array.isArray(externalReview?.scope_paths) ? externalReview.scope_paths.join(",") : null;
  return [scope, base, paths].filter(Boolean).join(" ") || "unknown";
}

function lifecycleJobId(obj, externalReview) {
  return externalReview?.job_id ?? obj?.job_id ?? obj?.id ?? null;
}

function lifecycleWorkspace(obj) {
  return obj?.workspace_root ?? obj?.cwd ?? "<workspace>";
}

function renderLifecycleMarkdown(obj) {
  const externalReview = obj?.external_review && typeof obj.external_review === "object"
    ? obj.external_review
    : externalReviewFromProgress(obj);
  if (!externalReview) return null;
  const jobId = lifecycleJobId(obj, externalReview);
  const workspace = lifecycleWorkspace(obj);
  const rows = [
    ["Provider", externalReview.provider ?? obj.provider ?? obj.target ?? "unknown"],
    ["Job", jobId ?? "unknown"],
    ["Session", externalReview.session_id ?? "pending"],
    ["Run", externalReview.run_kind ?? "unknown"],
    ["Mode", externalReview.mode ?? obj.mode ?? "unknown"],
    ["Scope", lifecycleScope(externalReview)],
    ["Source", externalReview.source_content_transmission ?? "unknown"],
    ["Status", obj.status ?? "unknown"],
  ];
  if (jobId) rows.push(["Retrieve", `result --job ${jobId} --cwd ${workspace}`]);
  rows.push(["Panel", `review-panel --workspace ${workspace}`]);
  if (obj.error_code) rows.push(["Error", obj.error_code]);
  if (obj.error_message) rows.push(["Message", obj.error_message]);
  if (obj.error_summary) rows.push(["Summary", obj.error_summary]);
  if (obj.http_status != null) rows.push(["HTTP", obj.http_status]);
  if (obj.suggested_action) rows.push(["Action", obj.suggested_action]);
  if (externalReview.disclosure) rows.push(["Disclosure", externalReview.disclosure]);
  return [
    "### EXTERNAL REVIEW",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([key, value]) => `| ${markdownCell(key)} | ${markdownCell(value)} |`),
    "",
  ].join("\n");
}

function externalReviewFromProgress(obj) {
  if (obj?.event !== "external_review_progress") return null;
  const provider = obj?.provider ?? obj?.target ?? "unknown";
  return {
    marker: "EXTERNAL REVIEW",
    provider,
    run_kind: obj?.run_kind ?? "foreground",
    job_id: obj?.job_id ?? null,
    session_id: null,
    parent_job_id: obj?.parent_job_id ?? null,
    mode: obj?.mode ?? null,
    scope: obj?.scope ?? null,
    scope_base: obj?.scope_base ?? null,
    scope_paths: obj?.scope_paths ?? null,
    source_content_transmission: obj?.source_content_transmission ?? "may_be_sent",
    disclosure: `Selected source content may be sent to ${provider} for external review.`,
  };
}

function printJsonLine(obj, output = process.stdout) {
  writableOutput(output).write(`${JSON.stringify(obj)}\n`);
}

const TERMINAL_EXTERNAL_REVIEW_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);

function isTerminalExternalReviewRecord(obj) {
  if (!obj?.external_review || typeof obj.external_review !== "object") return false;
  if (obj.event === "external_review_launched" || obj.event === "external_review_progress" || obj.event === "launched") {
    return false;
  }
  return TERMINAL_EXTERNAL_REVIEW_STATUSES.has(obj.status) || obj.result != null || obj.error_code != null;
}

function reviewMetadataProjection(obj) {
  const manifest = obj?.review_metadata?.audit_manifest;
  if (!manifest || typeof manifest !== "object") {
    return obj?.review_metadata && typeof obj.review_metadata === "object" ? { audit_manifest: null } : null;
  }
  const projection = {};
  for (const key of [
    "rendered_prompt_hash",
    "selected_source",
    "scope_resolution",
    "selected_route",
    "fallback_reason",
    "approval_scope",
    "packet_recovery",
  ]) {
    if (manifest[key] !== undefined) projection[key] = manifest[key];
  }
  return Object.keys(projection).length > 0 ? { audit_manifest: projection } : null;
}

function terminalLifecycleProjection(obj) {
  const projection = {
    event: "external_review_terminal",
    id: obj.id ?? obj.job_id ?? null,
    job_id: obj.job_id ?? obj.id ?? null,
    target: obj.target ?? null,
    provider: obj.provider ?? obj.external_review?.provider ?? null,
    mode: obj.mode ?? obj.external_review?.mode ?? null,
    cwd: obj.cwd ?? null,
    workspace_root: obj.workspace_root ?? obj.cwd ?? null,
    prompt_head: obj.prompt_head ?? null,
    status: obj.status ?? "unknown",
    started_at: obj.started_at ?? null,
    ended_at: obj.ended_at ?? null,
    exit_code: obj.exit_code ?? null,
    error_code: obj.error_code ?? null,
    error_message: obj.error_message ?? null,
    error_summary: obj.error_summary ?? null,
    suggested_action: obj.suggested_action ?? null,
    http_status: obj.http_status ?? null,
    external_review: obj.external_review,
  };
  if (obj.disclosure_note != null) projection.disclosure_note = obj.disclosure_note;
  const runtimeDiagnostics = {};
  if (obj.runtime_diagnostics?.sharding_plan != null) {
    runtimeDiagnostics.sharding_plan = obj.runtime_diagnostics.sharding_plan;
  }
  if (obj.runtime_diagnostics?.packet_recovery != null) {
    runtimeDiagnostics.packet_recovery = obj.runtime_diagnostics.packet_recovery;
  }
  if (Object.keys(runtimeDiagnostics).length > 0) {
    projection.runtime_diagnostics = runtimeDiagnostics;
  }
  if (obj.review_quality && typeof obj.review_quality === "object") {
    projection.review_quality = {
      failed_review_slot: obj.review_quality.failed_review_slot ?? null,
      reason: obj.review_quality.reason ?? null,
    };
  } else if (obj.review_metadata?.audit_manifest?.review_quality) {
    projection.review_quality = {
      failed_review_slot: obj.review_metadata.audit_manifest.review_quality.failed_review_slot ?? null,
      reason: null,
    };
  }
  const reviewMetadata = reviewMetadataProjection(obj);
  if (reviewMetadata) projection.review_metadata = reviewMetadata;
  return projection;
}

function lifecycleJsonlObject(obj) {
  return isTerminalExternalReviewRecord(obj) ? terminalLifecycleProjection(obj) : obj;
}

function printLifecycleJson(obj, lifecycleEvents, output = process.stdout) {
  if (lifecycleEvents === "jsonl") printJsonLine(lifecycleJsonlObject(obj), output);
  else if (lifecycleEvents === "markdown") {
    const markdown = renderLifecycleMarkdown(obj);
    if (markdown) writableOutput(output).write(markdown);
    else printJsonLine(obj, output);
  }
  else printJson(obj, output);
}

function externalReviewProgressEvent(invocation, { sequence, elapsedMs }) {
  return {
    event: "external_review_progress",
    job_id: invocation.job_id,
    target: invocation.target,
    status: "running",
    mode: invocation.mode ?? null,
    run_kind: invocation.run_kind ?? "foreground",
    heartbeat: sequence,
    elapsed_ms: Math.max(0, Math.trunc(elapsedMs ?? 0)),
  };
}

function externalReviewProgressMarkdownEvent(invocation, progress) {
  const base = invocation.external_review && typeof invocation.external_review === "object" ? invocation.external_review : {};
  const provider = base.provider ?? invocation.provider ?? invocation.target ?? progress.target ?? "unknown";
  return {
    ...progress,
    cwd: invocation.cwd ?? null,
    workspace_root: invocation.workspace_root ?? null,
    scope: base.scope ?? invocation.scope ?? null,
    scope_base: base.scope_base ?? invocation.scope_base ?? null,
    scope_paths: base.scope_paths ?? invocation.scope_paths ?? null,
    source_content_transmission: "may_be_sent",
    external_review: {
      marker: "EXTERNAL REVIEW",
      provider,
      run_kind: base.run_kind ?? invocation.run_kind ?? "foreground",
      job_id: base.job_id ?? invocation.job_id ?? progress.job_id ?? null,
      session_id: null,
      parent_job_id: base.parent_job_id ?? invocation.parent_job_id ?? null,
      mode: base.mode ?? invocation.mode ?? progress.mode ?? null,
      scope: base.scope ?? invocation.scope ?? null,
      scope_base: base.scope_base ?? invocation.scope_base ?? null,
      scope_paths: base.scope_paths ?? invocation.scope_paths ?? null,
      source_content_transmission: "may_be_sent",
      review_slot: base.review_slot ?? null,
      disclosure: base.disclosure ?? `Selected source content may be sent to ${provider} for external review.`,
    },
  };
}

function lifecycleHeartbeatIntervalMs(env = process.env) {
  const raw = env.CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS;
  if (raw === undefined || raw === null || raw === "") return 30000;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 30000;
}

function startLifecycleHeartbeat(
  invocation,
  lifecycleEvents,
  { intervalMs = lifecycleHeartbeatIntervalMs(), output = process.stdout, now = Date.now } = {},
) {
  if (lifecycleEvents !== "jsonl" && lifecycleEvents !== "markdown") return () => {};
  const interval = Number.isSafeInteger(intervalMs) && intervalMs > 0 ? intervalMs : lifecycleHeartbeatIntervalMs();
  const started = now();
  let sequence = 0;
  const timer = setInterval(() => {
    sequence += 1;
    const progress = externalReviewProgressEvent(invocation, {
      sequence,
      elapsedMs: now() - started,
    });
    printLifecycleJson(
      lifecycleEvents === "markdown" ? externalReviewProgressMarkdownEvent(invocation, progress) : progress,
      lifecycleEvents,
      output,
    );
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

function parseLifecycleEventsMode(value) {
  if (value == null || value === false) return null;
  if (value === "jsonl") return "jsonl";
  if (value === "markdown") return "markdown";
  throw runBadArgs("--lifecycle-events must be jsonl or markdown");
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

function isUnsafeJobIdError(error) {
  return error instanceof Error && error.message.startsWith("Unsafe jobId:");
}

function defaultDataRoot(pluginName, cwd = process.cwd()) {
  const workspace = resolve(cwd);
  const slug = basename(workspace).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return resolve(tmpdir(), "relay", pluginName, `${slug}-${hash}`);
}

function apiReviewerDataRoot(env = process.env, cwd = process.cwd()) {
  return resolve(env.API_REVIEWERS_PLUGIN_DATA ?? defaultDataRoot("api-reviewers", cwd));
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

async function verifyApiReviewerDataRootWritable(env = process.env, cwd = process.cwd()) {
  const root = apiReviewerDataRoot(env, cwd);
  const probeFile = resolve(root, `.write-preflight-${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(probeFile, "ok\n", { mode: 0o600 });
  } catch (e) {
    try { await unlink(probeFile); } catch { /* best-effort cleanup */ }
    return {
      ok: false,
      root,
      error: `API_REVIEWERS_PLUGIN_DATA is not writable at ${root}: ${e?.message ?? String(e)}`,
    };
  }
  try { await unlink(probeFile); } catch { /* best-effort cleanup */ }
  return { ok: true, root };
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

async function readApiReviewerMetaRecord(root, jobId) {
  assertSafeJobId(jobId);
  return JSON.parse(await readFile(resolve(apiReviewerJobsDir(root), jobId, "meta.json"), "utf8"));
}

function reviewSlotFromRecord(record) {
  const slot = record?.review_metadata?.audit_manifest?.review_slot
    ?? record?.external_review?.review_slot
    ?? null;
  return slot && typeof slot === "object" && !Array.isArray(slot) ? slot : null;
}

function priorSlotCountsTowardRetry(slot) {
  if (!slot?.retry_fingerprint) return false;
  if (slot.source_state === SOURCE_CONTENT_TRANSMISSION.NOT_SENT) return false;
  if (slot.verdict === "approved") return false;
  const reason = String(slot.not_counted_reason ?? "unknown");
  if (reason === "stale_head" || reason === "source_not_sent") return false;
  return true;
}

async function collectPriorReviewSlotAttempts(root, currentJobId = null) {
  let entries;
  try {
    entries = await readdir(apiReviewerJobsDir(root), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const attempts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobId = entry.name;
    if (currentJobId !== null && jobId === currentJobId) continue;
    try {
      assertSafeJobId(jobId);
      const parsed = JSON.parse(await readFile(resolve(apiReviewerJobsDir(root), jobId, "meta.json"), "utf8"));
      const manifest = parsed?.review_metadata?.audit_manifest ?? null;
      const slot = reviewSlotFromRecord(parsed);
      if (priorSlotCountsTowardRetry(slot)) {
        const sourceContentTransmission =
          parsed?.external_review?.source_content_transmission ??
          manifest?.source_content_transmission ??
          slot.source_state ??
          null;
        attempts.push({
          job_id: parsed?.job_id ?? jobId,
          started_at: parsed?.started_at ?? null,
          review_slot: slot,
          selected_source: manifest?.selected_source ?? null,
          source_packet: manifest?.selected_source ?? null,
          source_content_transmission: sourceContentTransmission,
          source_sent: sourceContentTransmission === SOURCE_CONTENT_TRANSMISSION.SENT,
          status: parsed?.status ?? null,
          error_code: parsed?.error_code ?? null,
          error_message: parsed?.error_message ?? null,
          review_quality: manifest?.review_quality ?? null,
        });
      }
    } catch {
      // Ignore malformed legacy artifacts; retry guards should be driven by
      // validated review-slot records, not by corrupt state.
    }
  }
  attempts.sort((left, right) => {
    const timeOrder = String(left.started_at ?? "").localeCompare(String(right.started_at ?? ""));
    if (timeOrder !== 0) return timeOrder;
    return String(left.job_id ?? "").localeCompare(String(right.job_id ?? ""));
  });
  return attempts;
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

async function optionsWithPromptFile(options) {
  const promptFile = options["prompt-file"];
  if (promptFile === undefined) return options;
  if (hasPromptText(options.prompt)) {
    throw runBadArgs("bad_args: pass prompt either with --prompt-file or --prompt, not both");
  }
  let promptText;
  try {
    promptText = (await readFile(promptFile, "utf8")).trim();
  } catch (e) {
    throw runBadArgs(`bad_args: could not read --prompt-file: ${e.message}`);
  }
  if (!hasPromptText(promptText)) {
    throw runBadArgs("bad_args: --prompt-file must contain a non-empty prompt");
  }
  return { ...options, prompt: promptText };
}

function assertSafeOptionKey(key, token) {
  if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new Error(`unsupported option ${token}`);
  }
}

async function loadProviders() {
  return JSON.parse(await readFile(PROVIDERS_PATH, "utf8"));
}

function validateSessionApprovalPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("session approval policy must be an object");
  }
  const expectedKeys = ["schema_version", "max_ttl_ms"];
  const keys = Object.keys(policy);
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(policy, key)) ||
    !keys.every((key) => expectedKeys.includes(key))
  ) {
    throw new Error("session approval policy has unexpected keys");
  }
  if (policy.schema_version !== SESSION_APPROVAL_GRANT_SCHEMA_VERSION) {
    throw new Error(`session approval policy schema_version must be ${SESSION_APPROVAL_GRANT_SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(policy.max_ttl_ms) || policy.max_ttl_ms <= 0) {
    throw new Error("session approval policy max_ttl_ms must be a positive integer");
  }
  return Object.freeze({
    schema_version: policy.schema_version,
    max_ttl_ms: policy.max_ttl_ms,
  });
}

async function loadSessionApprovalPolicy() {
  return validateSessionApprovalPolicy(JSON.parse(await readFile(SESSION_APPROVAL_POLICY_PATH, "utf8")));
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

function runProviderFailure(reason, message, diagnostics = null) {
  const error = new Error(message);
  error.apiReviewersReason = reason;
  if (diagnostics) error.apiReviewersDiagnostics = diagnostics;
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
    summary: "Direct API providers config is unreadable.",
    next_action: "Reinstall or repair the configured providers file and retry.",
    error_message: providersConfigErrorMessage(error),
  };
}

function selectedCredential(cfg, env = process.env) {
  const resolution = credentialEnvResolution(cfg, env);
  for (const keyName of cfg.env_keys ?? []) {
    if (typeof resolution.env[keyName] === "string" && resolution.env[keyName].length > 0) {
      return { keyName, value: resolution.env[keyName], source: resolution.sources[keyName] ?? null };
    }
  }
  return { keyName: null, value: null, source: null };
}

function credentialEnvKeys(cfg) {
  return (cfg.env_keys ?? []).filter((keyName) => typeof keyName === "string" && keyName.length > 0);
}

function presentCredentialEnvKeys(cfg, env = process.env) {
  const effectiveEnv = credentialEnvWithCache(cfg, env);
  return credentialEnvKeys(cfg).filter((keyName) => (
    typeof effectiveEnv[keyName] === "string" && effectiveEnv[keyName].length > 0
  ));
}

function missingCredentialAction(cfg) {
  const names = credentialEnvKeys(cfg).join(", ");
  return `This Codex process cannot see a non-empty credential env var or owner-only ~/.cache/op/env.sh credential cache entry. Restart or launch the session with one of these env vars exported: ${names}, or refresh the 1Password env cache. Then rerun the API reviewer doctor command. Do not run source-bearing review until doctor returns ready:true.`;
}

function envCacheDisabled(env = process.env) {
  return /^(?:1|true|yes)$/i.test(String(env.API_REVIEWERS_DISABLE_ENV_CACHE ?? ""));
}

function credentialEnvCachePath(env = process.env) {
  if (envCacheDisabled(env)) return null;
  if (typeof env.API_REVIEWERS_ENV_CACHE === "string" && env.API_REVIEWERS_ENV_CACHE.length > 0) {
    return resolve(env.API_REVIEWERS_ENV_CACHE);
  }
  if (typeof env.HOME !== "string" || env.HOME.length === 0) return null;
  return resolve(env.HOME, ".cache", "op", "env.sh");
}

function unquoteEnvCacheValue(raw) {
  const value = stripEnvCacheInlineComment(String(raw ?? "").trim());
  if (value.length === 0) return "";
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuotedEnvCacheValue(value.slice(1, -1));
  }
  return value;
}

function unescapeDoubleQuotedEnvCacheValue(value) {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && index + 1 < value.length && (value[index + 1] === '"' || value[index + 1] === "\\")) {
      out += value[index + 1];
      index += 1;
      continue;
    }
    out += value[index];
  }
  return out;
}

function isEnvWhitespace(char) {
  return char === " " || char === "\t";
}

function skipEnvWhitespace(value, index) {
  let cursor = index;
  while (cursor < value.length && isEnvWhitespace(value[cursor])) cursor += 1;
  return cursor;
}

function stripEnvCacheInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"') {
      if (char === "\\" && index + 1 < value.length) {
        index += 1;
        continue;
      }
      if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (index === 0) continue;
    if (char !== "#" || !isEnvWhitespace(value[index - 1])) continue;
    let end = index - 1;
    while (end > 0 && isEnvWhitespace(value[end - 1])) end -= 1;
    return value.slice(0, end).trim();
  }
  return value.trim();
}

function isEnvNameStart(char) {
  const code = char?.charCodeAt(0) ?? 0;
  return char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isEnvNameChar(char) {
  const code = char?.charCodeAt(0) ?? 0;
  return isEnvNameStart(char) || (code >= 48 && code <= 57);
}

function parseEnvCacheLine(raw) {
  const line = String(raw ?? "");
  let index = skipEnvWhitespace(line, 0);
  if (line.startsWith("export", index) && isEnvWhitespace(line[index + "export".length])) {
    index = skipEnvWhitespace(line, index + "export".length);
  }
  const nameStart = index;
  if (!isEnvNameStart(line[index])) return null;
  index += 1;
  while (index < line.length && isEnvNameChar(line[index])) index += 1;
  if (line[index] !== "=") return null;
  return [line.slice(nameStart, index), line.slice(index + 1)];
}

function splitEnvCacheLines(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
    lines.push(text.slice(start, end));
    start = index + 1;
  }
  if (start <= text.length) lines.push(text.slice(start));
  return lines;
}

function credentialEnvCacheEntries(env, names) {
  const wanted = new Set(names);
  if (wanted.size === 0) return {};
  const cachePath = credentialEnvCachePath(env);
  if (!cachePath) return {};
  try {
    const stat = lstatSync(cachePath);
    if (!stat.isFile()) return {};
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return {};
    const entries = {};
    const text = readFileSync(cachePath, "utf8");
    for (const line of splitEnvCacheLines(text)) {
      const parsed = parseEnvCacheLine(line);
      if (!parsed || !wanted.has(parsed[0])) continue;
      const value = unquoteEnvCacheValue(parsed[1]);
      if (value.length > 0) entries[parsed[0]] = value;
    }
    return entries;
  } catch {
    return {};
  }
}

function credentialEnvWithCache(cfgOrNames, env = process.env) {
  return credentialEnvResolution(cfgOrNames, env).env;
}

function credentialEnvResolution(cfgOrNames, env = process.env) {
  const names = Array.isArray(cfgOrNames) ? cfgOrNames : credentialEnvKeys(cfgOrNames);
  const entries = credentialEnvCacheEntries(env, names);
  const hasCacheEntries = Object.keys(entries).length > 0;
  const effectiveEnv = hasCacheEntries ? { ...env, ...entries } : env;
  const sources = {};
  for (const name of names) {
    if (typeof entries[name] === "string" && entries[name].length > 0) {
      sources[name] = "env_cache";
    } else if (typeof env[name] === "string" && env[name].length > 0) {
      sources[name] = "env";
    }
  }
  return { env: effectiveEnv, sources };
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
  return parsed.value === null ? { ok: true, value: DEFAULT_PROVIDER_TIMEOUT_MS } : parsed;
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
  if (cfg.auth_mode !== "api_key") {
    return {
      ok: false,
      reason: "bad_args",
      error: `${provider} auth_mode must be api_key`,
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
      reason: "prompt_too_large",
      error: `prompt_too_large:${prompt.length} chars exceeds ${cfg.display_name} max_prompt_chars=${maxPromptChars.value}`,
    };
  }
  return { ok: true, maxPromptChars };
}

function shardScopeInfoFor(scopeInfo, files) {
  return Object.freeze({
    ...scopeInfo,
    scope_paths: Object.freeze(files.map((file) => file.path)),
    files: Object.freeze([...files]),
  });
}

function shardApprovalTuple({
  cfg,
  mode,
  provider,
  scopeInfo,
  request,
  renderedPrompt,
  env = process.env,
  approvalScope = "session",
}) {
  const routeFields = approvalRouteFields(routeStateForApproval(cfg, env));
  const authPath = approvalAuthPathFor(cfg, env);
  const billingPath = approvalBillingPathFor(cfg);
  const auditManifest = buildApprovalAuditManifest({
    cfg,
    provider,
    mode,
    renderedPrompt,
    request,
    scopeInfo,
    routeFields,
    approvalScope,
  });
  const tuple = {
    provider,
    mode,
    rendered_prompt_hash: auditManifest.rendered_prompt_hash.value,
    source_packet: auditManifest.selected_source,
    scope_resolution: auditManifest.scope_resolution,
    scope_paths: Object.freeze([...(scopeInfo.scope_paths ?? [])]),
    request_settings: Object.freeze({
      timeout_ms: request.timeout_ms,
      max_tokens: request.max_tokens,
      max_steps_per_turn: request.max_steps_per_turn,
      temperature: request.temperature,
      stream: request.stream,
      request_defaults: Object.freeze(summarizeRequestDefaults(cfg.request_defaults)),
    }),
    auth_path: authPath,
    billing_path: billingPath,
    selected_route: routeFields.selected_route,
    route_step: routeFields.route_step,
    route_steps: routeFields.route_steps,
    fallback_reason: routeFields.fallback_reason,
    approval_scope: approvalScope,
  };
  return Object.freeze({
    ...tuple,
    approval_tuple_fingerprint: sourceSendApprovalTupleFingerprint({
      provider,
      mode,
      selectedSource: tuple.source_packet,
      renderedPromptHash: tuple.rendered_prompt_hash,
      scopeResolution: tuple.scope_resolution,
      requestSettings: tuple.request_settings,
      authPath: tuple.auth_path,
      billingPath: tuple.billing_path,
      selectedRoute: tuple.selected_route,
      routeStep: tuple.route_step,
      routeSteps: tuple.route_steps,
      fallbackReason: tuple.fallback_reason,
      approvalScope: tuple.approval_scope,
    }),
  });
}

function promptTooLargeNarrowing(cap, renderedPromptChars, reason, extra = {}) {
  return Object.freeze({
    reason: "prompt_too_large",
    source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    cap,
    rendered_prompt_chars: renderedPromptChars,
    shards: null,
    narrowing: Object.freeze({
      strategy: "operator_required",
      reason,
      ...extra,
    }),
  });
}

function buildShardingPlan({
  cfg,
  mode,
  provider,
  scopeInfo,
  userPrompt = "",
  env = process.env,
  renderedPromptChars,
  approvalScope = "session",
}) {
  const maxPromptChars = maxPromptCharsFor(cfg, env);
  if (!maxPromptChars.ok) return null;
  const cap = maxPromptChars.value;
  const files = Array.isArray(scopeInfo.files) ? scopeInfo.files : [];
  if (files.length === 0) {
    return promptTooLargeNarrowing(cap, renderedPromptChars, "no_scope_files_available");
  }
  let request;
  try {
    request = requestSettingsForApproval(cfg, env);
  } catch {
    return promptTooLargeNarrowing(cap, renderedPromptChars, "request_settings_unavailable");
  }

  const shards = [];
  let pending = [];
  let pendingPrompt = null;
  for (const file of files) {
    const candidate = [...pending, file];
    const candidateScope = shardScopeInfoFor(scopeInfo, candidate);
    let candidatePrompt;
    try {
      candidatePrompt = promptFor(mode, userPrompt, candidateScope, cfg.display_name);
    } catch {
      return promptTooLargeNarrowing(cap, renderedPromptChars, "shard_render_failed");
    }
    if (candidatePrompt.length <= cap) {
      pending = candidate;
      pendingPrompt = candidatePrompt;
      continue;
    }
    if (pending.length === 0) {
      return promptTooLargeNarrowing(cap, renderedPromptChars, "single_file_exceeds_cap", {
        file: String(file.path ?? "unknown"),
      });
    }
    shards.push({ files: pending, prompt: pendingPrompt });
    pending = [file];
    try {
      pendingPrompt = promptFor(mode, userPrompt, shardScopeInfoFor(scopeInfo, pending), cfg.display_name);
    } catch {
      return promptTooLargeNarrowing(cap, renderedPromptChars, "shard_render_failed");
    }
    if (pendingPrompt.length > cap) {
      return promptTooLargeNarrowing(cap, renderedPromptChars, "single_file_exceeds_cap", {
        file: String(file.path ?? "unknown"),
      });
    }
  }
  if (pending.length > 0 && pendingPrompt !== null) {
    shards.push({ files: pending, prompt: pendingPrompt });
  }

  const total = shards.length;
  const builtShards = shards.map((shard, idx) => {
    const shardScope = shardScopeInfoFor(scopeInfo, shard.files);
    const tuple = shardApprovalTuple({
      cfg,
      mode,
      provider,
      scopeInfo: shardScope,
      request,
      renderedPrompt: shard.prompt,
      env,
      approvalScope,
    });
    return Object.freeze({
      index: idx + 1,
      total,
      scope_paths: Object.freeze(shard.files.map((file) => file.path)),
      rendered_prompt_chars: shard.prompt.length,
      source_packet: tuple.source_packet,
      approval_tuple: tuple,
    });
  });
  return Object.freeze({
    reason: "prompt_too_large",
    source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    cap,
    rendered_prompt_chars: renderedPromptChars,
    shards: Object.freeze(builtShards),
    narrowing: null,
  });
}

function redactionContext(configuredSecretNames = [], env = process.env, extraSecretValues = []) {
  const names = Array.isArray(configuredSecretNames)
    ? configuredSecretNames.filter((name) => typeof name === "string" && name.length > 0)
    : [];
  const effectiveEnv = credentialEnvWithCache(names, env);
  const redactionEnv = { ...effectiveEnv };
  const redactionNames = [...names];
  let syntheticIndex = 0;
  const addSecret = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    const name = `${REDACTION_SECRET_ENV_PREFIX}_${syntheticIndex}`;
    syntheticIndex += 1;
    redactionEnv[name] = value;
    redactionNames.push(name);
  };
  for (const name of names) {
    if (typeof env[name] === "string" && env[name].length > 0 && env[name] !== effectiveEnv[name]) {
      addSecret(env[name]);
    }
  }
  for (const value of extraSecretValues) addSecret(value);
  return { env: redactionEnv, configuredSecretNames: redactionNames };
}

function credentialRedactionValues(execution = null) {
  const value = execution?.[CREDENTIAL_REDACTION_VALUE];
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function redactor(env = process.env, configuredSecretNames = []) {
  const context = redactionContext(configuredSecretNames, env);
  return buildPrivacyRedactor(context).text;
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

function redactRecord(record, env = process.env, configuredSecretNames = [], sourceFiles = [], extraSecretValues = []) {
  const context = redactionContext(configuredSecretNames, env, extraSecretValues);
  return buildPrivacyRedactor({ ...context, sourceFiles }).value(record);
}

function configuredSecretNamesFromProviders(providers) {
  return Object.values(providers ?? {}).flatMap((cfg) => (
    Array.isArray(cfg?.env_keys) ? cfg.env_keys.filter((name) => typeof name === "string" && name.length > 0) : []
  ));
}

async function configuredSecretNamesForResult() {
  try {
    return configuredSecretNamesFromProviders(await loadProviders());
  } catch (cause) {
    const error = new Error("provider_config_unavailable");
    error.apiReviewersReason = "config_error";
    error.cause = cause;
    throw error;
  }
}

function baseUrlFor(cfg) {
  if (cfg.base_url === undefined || cfg.base_url === null || cfg.base_url === "") return null;
  let url = String(cfg.base_url);
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function sourceFreeProviderProbeFields(execution, cfg) {
  const status = execution.exitCode === 0 && execution.parsed?.ok === true
    ? "ok"
    : (execution.parsed?.reason ?? "provider_error");
  return {
    status,
    http_status: execution.http_status ?? null,
    endpoint: execution.endpoint ?? baseUrlFor(cfg),
    model: cfg.model,
    raw_model: execution.parsed?.raw_model ?? null,
    source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    prompt_chars: DOCTOR_PROBE_PROMPT.length,
  };
}

function sourceFreePreSendFailureExecution(execution, cfg, env = process.env) {
  const effectiveEnv = credentialEnvWithCache(cfg, env);
  const providerProbe = sourceFreeProviderProbeFields(execution, cfg);
  const errorMessage = redactor(effectiveEnv, cfg.env_keys)(
    execution.parsed?.error ?? providerProbe.status,
  );
  const credential = selectedCredential(cfg, effectiveEnv);
  return {
    ...providerFailureWithDiagnostics(
      providerProbe.status,
      errorMessage,
      execution.http_status ?? null,
      execution.parsed?.raw ?? null,
      false,
      {
        ...(execution.diagnostics ?? {}),
        source_free_preflight: {
          ...providerProbe,
          error_message: errorMessage,
        },
      },
    ),
    credential_ref: execution.credential_ref ?? credential.keyName ?? null,
    credential_source: execution.credential_source ?? credential.source ?? null,
    endpoint: execution.endpoint ?? baseUrlFor(cfg),
  };
}

function sourceFreePreSendProbeEnv(env = process.env) {
  const next = { ...env };
  delete next.API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES;
  delete next.API_REVIEWERS_MOCK_ASSERT_PROMPT_EXCLUDES;
  delete next.API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY;
  return next;
}

async function sourceFreePreSendFailure(provider, cfg, env = process.env) {
  const execution = await callProvider(provider, cfg, DOCTOR_PROBE_PROMPT, sourceFreePreSendProbeEnv(env));
  if (execution.exitCode === 0 && execution.parsed?.ok === true) return null;
  return sourceFreePreSendFailureExecution(execution, cfg, env);
}

async function doctorFields(provider, cfg, env = process.env) {
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
      next_action: `Set ${provider} auth_mode to api_key.`,
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
      next_action: missingCredentialAction(cfg),
      auth_mode: cfg.auth_mode,
      credential_candidates: credentialEnvKeys(cfg),
      present_credential_env_keys: presentCredentialEnvKeys(cfg, env),
      endpoint,
      cost_quota_readiness: costQuotaReadiness,
    };
  }
  const execution = await callProvider(provider, cfg, DOCTOR_PROBE_PROMPT, env);
  const providerProbe = sourceFreeProviderProbeFields(execution, cfg);
  if (providerProbe.status !== "ok") {
    const errorMessage = redactor(env, cfg.env_keys)(execution.parsed?.error ?? providerProbe.status);
    return {
      provider,
      status: providerProbe.status,
      ready: false,
      summary: `${cfg.display_name} direct API reviewer source-free readiness probe failed: ${providerProbe.status}.`,
      next_action: suggestedAction(providerProbe.status, provider, cfg, errorMessage, execution.http_status ?? null, env),
      auth_mode: cfg.auth_mode,
      credential_ref: credential.keyName,
      credential_source: credential.source,
      endpoint,
      model: cfg.model,
      provider_probe: {
        ...providerProbe,
        error_message: errorMessage,
      },
      cost_quota_readiness: execution.diagnostics?.cost_quota ?? costQuotaReadiness,
    };
  }
  return {
    provider,
    status: "ok",
    ready: true,
    summary: `${cfg.display_name} direct API reviewer is ready using ${credential.keyName}; source-free live probe succeeded.`,
    next_action: "Run a direct API review.",
    auth_mode: cfg.auth_mode,
    credential_ref: credential.keyName,
    credential_source: credential.source,
    endpoint,
    model: cfg.model,
    provider_probe: providerProbe,
    cost_quota_readiness: execution.diagnostics?.cost_quota ?? costQuotaReadiness,
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

async function readGitDiffScopeFiles(gitCwd, workspaceRoot, scopeBase, relPaths) {
  for (const relPath of relPaths) validateScopePath(workspaceRoot, relPath);
  const files = [];
  const totalBytes = { value: 0 };
  const diffFiles = diffSourceFiles(gitCwd, scopeBase, { scopePaths: relPaths, workspaceRoot });
  for (const file of diffFiles) {
    const text = Buffer.isBuffer(file.content)
      ? file.content.toString("utf8")
      : String(file.content ?? "");
    addScopeFile(files, file.path, text, totalBytes);
  }
  if (files.length === 0) throw new Error("scope_empty: selected diff files are missing or empty");
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
    ? await readGitDiffScopeFiles(cwd, workspaceRoot, scopeBase, relPaths)
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
  if (!remote) return basename(workspaceRoot);
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
    credential_source: credential.source,
    [CREDENTIAL_REDACTION_VALUE]: credential.value,
    endpoint: baseUrlFor(cfg),
    diagnostics: diagnostics(),
  };
}

function providerCredentialExecutionFields(cfg, credential) {
  return {
    credential_ref: credential.keyName ?? null,
    credential_source: credential.source ?? null,
    [CREDENTIAL_REDACTION_VALUE]: credential.value ?? null,
    endpoint: baseUrlFor(cfg),
  };
}

async function callProvider(provider, cfg, prompt, env = process.env) {
  const effectiveEnv = credentialEnvWithCache(cfg, env);
  const preflight = validateDirectApiRunPreflight(cfg, provider, effectiveEnv);
  if (!preflight.ok) return providerFailure(preflight.reason, preflight.error, null, null, false);
  const { credential, maxTokensOverride, timeoutMs } = preflight;
  const credentialFields = providerCredentialExecutionFields(cfg, credential);
  const endpoint = `${baseUrlFor(cfg)}/chat/completions`;
  const requestBody = {
    model: cfg.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  };
  const defaultsResult = applyRequestDefaults(requestBody, cfg.request_defaults);
  if (!defaultsResult.ok) {
    return {
      ...providerFailureWithDiagnostics("bad_args", defaultsResult.error, null, null, false, {
        configured_timeout_ms: timeoutMs.value,
        prompt_chars: prompt.length,
        request_defaults: summarizeRequestDefaults(cfg.request_defaults),
        max_tokens: requestBody.max_tokens ?? null,
        temperature: requestBody.temperature ?? null,
      }),
      ...credentialFields,
    };
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
  if (effectiveEnv.API_REVIEWERS_MOCK_RESPONSE) {
    return mockProviderExecution(cfg, prompt, credential, effectiveEnv, requestBody);
  }
  const redact = redactor(effectiveEnv, cfg.env_keys);
  const started = Date.now();
  try {
    const response = await postProviderJson(endpoint, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential.value}`,
      },
      body: JSON.stringify(requestBody),
      timeoutMs: timeoutMs.value,
    });
    const text = response.text;
    const parsed = parseJson(text);
    if (!response.ok) {
      const errorCode = classifyHttpFailure(response.status, parsed, text);
      return {
        ...providerFailureWithDiagnostics(
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
        ),
        ...credentialFields,
      };
    }
    if (!parsed.ok) {
      return {
        ...providerFailureWithDiagnostics("malformed_response", parsed.error, response.status, null, true, diagnostics()),
        ...credentialFields,
      };
    }
    const content = parsed.value?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return {
        ...providerFailureWithDiagnostics(
          "malformed_response",
          "response did not include choices[0].message.content",
          response.status,
          parsed.value,
          true,
          diagnostics(),
        ),
        ...credentialFields,
      };
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
      ...credentialFields,
      diagnostics: diagnostics(),
    };
  } catch (e) {
    const reason = isProviderTimeoutException(e) ? "timeout" : "provider_unavailable";
    return {
      ...providerFailureWithDiagnostics(
        reason,
        redact(e?.message ?? String(e)),
        null,
        null,
        payloadSentForProviderException(e),
        {
          ...diagnostics(),
          elapsed_ms: Date.now() - started,
          fetch_error: fetchExceptionDiagnostics(e, redact),
        },
      ),
      ...credentialFields,
    };
  }
}

function postProviderJson(endpoint, { headers, body, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch (e) {
      rejectPromise(e);
      return;
    }
    const transport = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
    if (!transport) {
      rejectPromise(new Error(`unsupported provider endpoint protocol: ${url.protocol}`));
      return;
    }

    let settled = false;
    let timeout = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn(value);
    };

    const request = transport(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        finish(resolvePromise, {
          ok: status >= 200 && status < 300,
          status,
          text,
        });
      });
      response.on("error", (error) => finish(rejectPromise, error));
    });

    timeout = setTimeout(() => {
      const error = new Error(`request timed out after ${timeoutMs}ms`);
      error.name = "AbortError";
      error.code = "API_REVIEWERS_REQUEST_TIMEOUT";
      request.destroy(error);
      finish(rejectPromise, error);
    }, timeoutMs);
    request.on("error", (error) => finish(rejectPromise, error));
    request.end(body);
  });
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

function providerExceptionCode(error) {
  return error?.code ?? error?.cause?.code ?? null;
}

function isProviderTimeoutException(error) {
  if (error?.name === "AbortError") return true;
  const code = providerExceptionCode(error);
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return true;
  }
  const causeName = String(error?.cause?.name ?? "");
  const causeMessage = String(error?.cause?.message ?? "");
  return /TimeoutError$/u.test(causeName) || /timeout error/i.test(causeMessage);
}

function payloadSentForProviderException(error) {
  if (error?.name === "AbortError") return true;
  const code = providerExceptionCode(error);
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return true;
  if (code === "UND_ERR_CONNECT_TIMEOUT") return false;
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

function boundedDiagnosticString(value, redact) {
  if (value == null) return null;
  const text = redact(String(value));
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function errorDiagnosticFields(error, redact) {
  if (!error || typeof error !== "object") return null;
  const fields = {
    name: boundedDiagnosticString(error.name, redact),
    code: boundedDiagnosticString(error.code, redact),
    message: boundedDiagnosticString(error.message, redact),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null && value !== ""));
}

function fetchExceptionDiagnostics(error, redact) {
  const diagnostics = errorDiagnosticFields(error, redact) ?? {
    message: boundedDiagnosticString(error, redact),
  };
  const causeFields = errorDiagnosticFields(error?.cause, redact);
  if (causeFields && Object.keys(causeFields).length > 0) {
    diagnostics.cause = causeFields;
  }
  if (Array.isArray(error?.cause?.errors)) {
    const errors = error.cause.errors
      .slice(0, 3)
      .map((entry) => errorDiagnosticFields(entry, redact))
      .filter((entry) => entry && Object.keys(entry).length > 0);
    if (errors.length > 0) diagnostics.cause_errors = errors;
    if (error.cause.errors.length > errors.length) diagnostics.cause_errors_truncated = true;
  }
  return diagnostics;
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

function sourceSendSandboxGuidance(env = process.env) {
  return isCodexSandbox(env)
    ? CODEX_SOURCE_SEND_SANDBOX_GUIDANCE
    : HOST_NEUTRAL_SOURCE_SEND_SANDBOX_GUIDANCE;
}

function scopeFailedSuggestedAction(errorMessage = "") {
  if (/scope_empty:\s*branch-diff selected no files/i.test(errorMessage)) {
    return "Branch-diff selected no files before provider launch. Branch-diff reviews committed HEAD-vs-base changes only; it does not include dirty working-tree edits. Choose a different --scope-base <ref> if this branch should have committed changes, use --scope-base HEAD~1 to review the last commit, or use custom-review with explicit --scope-paths for uncommitted, already-merged, or no-diff branches.";
  }
  if (/scope_base_invalid:/i.test(errorMessage)) {
    return "Use a concrete branch, tag, remote ref, or commit SHA for --scope-base; option-shaped values beginning with '-' are rejected before git branch-diff runs.";
  }
  return "Adjust --scope, --scope-base, or --scope-paths and retry.";
}

function promptTooLargeSuggestedAction() {
  return "Rendered prompt exceeds the direct API provider prompt budget before launch. Use a narrower scope, split the review into explicit custom-review shards, or raise API_REVIEWERS_MAX_PROMPT_CHARS only after confirming the selected provider accepts larger prompts.";
}

function reviewQualityReasons(errorMessage) {
  const prefix = "review_quality_failed:";
  const text = String(errorMessage ?? "");
  if (!text.startsWith(prefix)) return [];
  return text.slice(prefix.length).split(",").map((reason) => reason.trim()).filter(Boolean);
}

function suggestedAction(errorCode, provider, cfg, errorMessage = "", httpStatus = null, env = process.env) {
  const sharedDiagnostic = buildExternalModelFailureDiagnostic(errorCode, cfg.display_name ?? provider);
  if (errorCode === "bad_args") return "Correct the api-reviewer command arguments and retry.";
  if (errorCode === "approval_required") return "Run approval-request, render the approval summary to the user, and pass the returned approval_token.value with --approval-token only after explicit approval.";
  if (errorCode === "prompt_too_large") return promptTooLargeSuggestedAction();
  if (errorCode === "config_error") return "Reinstall or repair the configured providers file and retry.";
  if (errorCode === "missing_key") return missingCredentialAction(cfg);
  if (errorCode === "auth_rejected") return `Check the ${cfg.display_name} API key and billing/plan for ${cfg.model}.`;
  if (errorCode === "usage_limited") {
    return `Treat this ${cfg.display_name} slot as failed. Do not automatically resend selected source. ` +
      `${cfg.display_name} reported a quota, usage-tier, billing, or credit limit. This plugin does not purchase credits or upgrade tiers automatically; inspect the provider account and perform any billing transaction only after explicit user approval. ` +
      "Require a fresh matching approval token whenever provider, mode, source packet, prompt hash, scope resolution, request settings, auth path, billing path, selected route, or fallback reason changes.";
  }
  // Kept for backward compatibility with older persisted records and future non-HTTP callers.
  if (errorCode === "rate_limited") return `Wait and retry, or lower concurrency for ${provider}.`;
  if (errorCode === "timeout") {
    return `${sharedDiagnostic?.suggested_action ?? "Treat this reviewer slot as failed. Do not automatically resend selected source."} ` +
      "The provider did not respond within the timeout window; retry later, increase API_REVIEWERS_TIMEOUT_MS, " +
      "or narrow the source packet.";
  }
  if (errorCode === "provider_unavailable") return providerUnavailableSuggestedAction(errorMessage, httpStatus, env);
  if (errorCode === "review_not_completed") {
    const displayName = cfg.display_name ?? provider;
    const reasons = reviewQualityReasons(errorMessage);
    if (hasSubstantiveInvalidVerdictReason(reasons)) {
      return `Treat this ${displayName} slot as failed. Do not automatically resend selected source. ` +
        "Retry by narrowing the scope, sharding the source packet, or relaying the prompt to another ready reviewer. " +
        "Require a fresh matching approval token whenever provider, mode, source packet, prompt hash, scope resolution, " +
        "request settings, auth path, or billing path changes.";
    }
    return "Treat this reviewer slot as failed, inspect the raw result and review_quality reasons, then retry with a source packet the reviewer can inspect.";
  }
  if (errorCode === "scope_failed") return scopeFailedSuggestedAction(errorMessage);
  if (errorCode === "sandbox_blocked") return "Set API_REVIEWERS_PLUGIN_DATA to a writable path inside the Codex workspace or another approved writable root, start a fresh Codex session if sandbox roots changed, then retry.";
  if (errorCode === "git_binary_rejected") return sharedDiagnostic?.suggested_action ?? `Set ${GIT_BINARY_ENV} to a trusted Git executable outside the workspace, or unset it to use the default Git binary.`;
  return sharedDiagnostic?.suggested_action ?? "Inspect error_message and retry after correcting the provider or request configuration.";
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
    review_slot: null,
    disclosure: `Selected source content may be sent to ${provider} for external review.`,
  });
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return count === 1 ? singular : pluralValue;
}

function requestSettingsForApproval(cfg, env = process.env) {
  const maxTokensOverride = parseMaxTokensOverride(env);
  if (!maxTokensOverride.ok) throw runBadArgs(maxTokensOverride.error);
  const timeoutMs = parseProviderTimeoutMs(env);
  if (!timeoutMs.ok) throw runBadArgs(timeoutMs.error);
  const requestBody = {
    model: cfg.model,
    messages: [],
    temperature: 0,
  };
  const defaultsResult = applyRequestDefaults(requestBody, cfg.request_defaults);
  if (!defaultsResult.ok) throw runBadArgs(defaultsResult.error);
  if (maxTokensOverride.value !== null) {
    requestBody.max_tokens = maxTokensOverride.value;
  } else if (!Object.hasOwn(requestBody, "max_tokens")) {
    requestBody.max_tokens = 4096;
  }
  return {
    timeout_ms: timeoutMs.value,
    max_tokens: requestBody.max_tokens ?? null,
    max_steps_per_turn: null,
    temperature: requestBody.temperature ?? null,
    stream: false,
  };
}

function approvalRequestSettingsProjection(cfg, request) {
  return Object.freeze({
    provider: cfg.display_name,
    model: cfg.model,
    timeout_ms: request.timeout_ms,
    max_tokens: request.max_tokens,
    max_steps_per_turn: request.max_steps_per_turn,
    temperature: request.temperature,
    stream: request.stream,
  });
}

function approvalAuthPathFor(cfg, env = process.env) {
  const credential = selectedCredential(cfg, env);
  return Object.freeze({
    auth_mode: cfg.auth_mode ?? null,
    credential_ref: credential.keyName ?? null,
    credential_source: credential.source ?? null,
  });
}

function approvalBillingPathFor(cfg) {
  return Object.freeze({
    endpoint: cfg.base_url ? baseUrlFor(cfg) : null,
    model: cfg.model ?? null,
  });
}

function providerCapabilitiesForConfig(cfg) {
  const credentialNames = Array.isArray(cfg.env_keys) ? cfg.env_keys : [];
  return Object.freeze({
    api: Object.freeze({
      kind: "direct_api",
      auth_path: "api_key_env",
      credential_env_names: credentialNames,
      billing_path: approvalBillingPathFor(cfg),
      source_packet: Object.freeze({
        resume_without_resend_supported: false,
      }),
    }),
  });
}

function routeStateForApproval(cfg, env = process.env, { sourceSendApproved = false } = {}) {
  const credentialNames = Array.isArray(cfg.env_keys) ? cfg.env_keys : [];
  const effectiveEnv = credentialEnvWithCache(credentialNames, env);
  try {
    return selectProviderRoute({
      requestedRoute: "subscription",
      fallbackReason: env.API_REVIEWERS_ROUTE_FALLBACK_REASON || null,
      providerCapabilities: providerCapabilitiesForConfig(cfg),
      env: effectiveEnv,
      sourceBearing: true,
      sourceSendApproved,
    });
  } catch (e) {
    if (/unsupported (?:API|route) fallback reason/.test(e?.message ?? "")) {
      throw runBadArgs(`bad_args: ${e.message}`);
    }
    throw e;
  }
}

function approvalRouteFields(routeState) {
  return Object.freeze({
    selected_route: routeState?.selected_route ?? null,
    route_step: routeState?.route_step ?? null,
    route_steps: routeState?.route_steps ?? null,
    fallback_reason: routeState?.fallback_reason ?? null,
    auth_path: routeState?.auth_path ?? null,
    billing_path: routeState?.billing_path ?? null,
    source_send_approval_required: routeState?.source_send_approval_required ?? null,
    source_send_approval_state: routeState?.source_send_approval_state ?? null,
  });
}

const LARGE_SOURCE_PACKET_FLAG = "--allow-large-source-packet";

function sourcePacketOverrideRouteFields(options = {}) {
  const approved = options["allow-large-source-packet"] === true;
  return {
    resendConfirmationApproved: options["resend-confirmation-approved"] === true,
    sourcePacketOverrideApproved: approved,
    sourcePacketOverrideSource: approved ? LARGE_SOURCE_PACKET_FLAG : null,
  };
}

function reviewSlotRouteFields(options = {}, base = {}) {
  const reviewSlot = { ...base };
  if (typeof options["review-slot-disposition"] === "string") {
    reviewSlot.disposition = options["review-slot-disposition"];
  }
  if (typeof options["review-slot-waiver-artifact"] === "string") {
    reviewSlot.waiverArtifact = options["review-slot-waiver-artifact"];
  }
  if (typeof options["review-slot-override-artifact"] === "string") {
    reviewSlot.overrideArtifact = options["review-slot-override-artifact"];
  }
  return reviewSlot;
}

function approvalScopeForOptions(options = {}) {
  return normalizeApprovalScope(options["approval-scope"] ?? "session");
}

function approvalTokenFor({ provider, mode, auditManifest, authPath = null, billingPath = null, routeFields = null, approvalScope = "session" }) {
  const tupleFingerprint = sourceSendApprovalTupleFingerprint({
    provider,
    mode,
    selectedSource: auditManifest.selected_source,
    renderedPromptHash: auditManifest.rendered_prompt_hash,
    requestSettings: auditManifest.request,
    scopeResolution: auditManifest.scope_resolution,
    authPath,
    billingPath,
    selectedRoute: routeFields?.selected_route ?? null,
    routeStep: routeFields?.route_step ?? null,
    routeSteps: routeFields?.route_steps ?? null,
    fallbackReason: routeFields?.fallback_reason ?? null,
    approvalScope,
  });
  return Object.freeze({
    algorithm: "sha256",
    value: createHash("sha256")
      .update(`source-send-approval-token-v1:${tupleFingerprint.value}`)
      .digest("hex"),
  });
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
    return JSON.stringify(value);
  }
  if (type === "object") {
    const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
    const fields = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new Error(`canonical_json_unsupported_type:${type}`);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedStringArrayOrNull(value) {
  if (value == null) return null;
  return Object.freeze([...value].map(String).sort((left, right) => left.localeCompare(right)));
}

function sortedSelectedSource(selectedSource) {
  const files = [...(selectedSource?.files ?? [])]
    .map((file) => Object.freeze({
      path: file.path,
      bytes: file.bytes,
      lines: file.lines,
      content_hash: file.content_hash,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    files: Object.freeze(files),
    totals: Object.freeze({
      files: selectedSource?.totals?.files ?? files.length,
      bytes: selectedSource?.totals?.bytes ?? 0,
      lines: selectedSource?.totals?.lines ?? 0,
    }),
  });
}

function sortedScopeResolution(scopeResolution) {
  return Object.freeze({
    scope: scopeResolution.scope,
    scope_base: scopeResolution.scope_base ?? null,
    scope_paths: sortedStringArrayOrNull(scopeResolution.scope_paths),
    reason: scopeResolution.reason,
  });
}

function parseGrantTtlMs(grantPolicy, options = {}) {
  const raw = options["grant-ttl-ms"];
  if (raw === undefined || raw === null || raw === "") {
    throw runBadArgs("bad_args: --grant-ttl-ms is required");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw runBadArgs(`bad_args: --grant-ttl-ms must be a positive integer number of milliseconds; got ${JSON.stringify(raw)}`);
  }
  if (parsed > grantPolicy.max_ttl_ms) {
    throw runBadArgs(`bad_args: --grant-ttl-ms ${parsed} exceeds configured maximum ${grantPolicy.max_ttl_ms}`);
  }
  return parsed;
}

function parseGrantExpiresAt(grantPolicy, options = {}) {
  const raw = options["grant-expires-at"];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw runBadArgs("bad_args: --grant-expires-at is required");
  }
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw runBadArgs("bad_args: --grant-expires-at must be an ISO-8601 UTC timestamp with milliseconds");
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw runBadArgs("bad_args: --grant-expires-at must be a valid UTC timestamp");
  }
  if (millis <= Date.now()) {
    throw runProviderFailure("approval_required", "approval_required: grant expiry is not in the future");
  }
  if (millis - Date.now() > grantPolicy.max_ttl_ms) {
    throw runBadArgs(`bad_args: --grant-expires-at exceeds configured maximum ${grantPolicy.max_ttl_ms}ms grant window`);
  }
  return value;
}

function grantBoundsFor({ provider, mode, scopeInfo, selectedSource, expiresAt, grantPolicy }) {
  return Object.freeze({
    provider_allowlist: Object.freeze([provider]),
    mode_allowlist: Object.freeze([mode]),
    workspace_root_hash: sha256Hex(resolve(scopeInfo.workspaceRoot ?? scopeInfo.cwd ?? process.cwd())),
    path_constraints: Object.freeze({
      scope: scopeInfo.scope,
      scope_paths: sortedStringArrayOrNull(scopeInfo.scope_paths),
    }),
    max_files: selectedSource.totals.files,
    max_bytes: selectedSource.totals.bytes,
    expires_at: expiresAt,
    max_ttl_ms: grantPolicy.max_ttl_ms,
    schema_version: SESSION_APPROVAL_GRANT_SCHEMA_VERSION,
  });
}

function grantApprovalTupleFor({ provider, mode, auditManifest, authPath = null, billingPath = null, routeFields = null, grantBounds }) {
  return Object.freeze({
    provider,
    mode,
    selected_source: sortedSelectedSource(auditManifest.selected_source),
    rendered_prompt_hash: auditManifest.rendered_prompt_hash,
    request: auditManifest.request,
    scope_resolution: sortedScopeResolution(auditManifest.scope_resolution),
    auth_path: authPath,
    billing_path: billingPath,
    selected_route: routeFields?.selected_route ?? null,
    route_step: routeFields?.route_step ?? null,
    route_steps: routeFields?.route_steps ?? null,
    fallback_reason: routeFields?.fallback_reason ?? null,
    approval_scope: "grant",
    grant_bounds: grantBounds,
  });
}

function approvalFingerprintFor(approvalTuple) {
  return sha256Hex(canonicalJson(approvalTuple));
}

function grantApprovalTokenFor(approvalTuple) {
  const approvalFingerprint = approvalFingerprintFor(approvalTuple);
  return Object.freeze({
    algorithm: "sha256",
    value: sha256Hex(canonicalJson({
      token_type: "grant_approval_token",
      approval_fingerprint: approvalFingerprint,
    })),
  });
}

function buildApprovalAuditManifest({ cfg, provider = null, mode = null, renderedPrompt, request, scopeInfo, routeFields = null, approvalScope = "session", options = {} }) {
  return buildReviewAuditManifest({
    prompt: renderedPrompt,
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
      timeoutMs: request.timeout_ms,
      maxTokens: request.max_tokens,
      maxStepsPerTurn: request.max_steps_per_turn,
      temperature: request.temperature,
      stream: request.stream,
    },
    truncation: {
      prompt: false,
      source: false,
      output: false,
    },
    scope: {
      name: scopeInfo.scope,
      base: scopeInfo.scope_base ?? null,
      paths: scopeInfo.scope_paths ?? null,
      reason: scopeResolutionReason(scopeInfo),
    },
    route: {
      mode,
      providerId: provider,
      selectedRoute: routeFields?.selected_route ?? null,
      routeStep: routeFields?.route_step ?? null,
      routeSteps: routeFields?.route_steps ?? null,
      fallbackReason: routeFields?.fallback_reason ?? null,
      approvalScope,
      authPath: approvalAuthPathFor(cfg, process.env),
      billingPath: routeFields?.billing_path ?? null,
      sourceSendApprovalRequired: routeFields?.source_send_approval_required ?? null,
      sourceSendApprovalState: routeFields?.source_send_approval_state ?? null,
      providerCapabilities: providerCapabilitiesForConfig(cfg),
      previousAttempt: latestSourcePacketPreviousAttempt(options.reviewSlotPriorAttempts),
      reviewSlot: reviewSlotRouteFields(options, {
        priorAttempts: options.reviewSlotPriorAttempts ?? [],
      }),
      ...sourcePacketOverrideRouteFields(options),
    },
    status: "approval_request",
    errorCode: null,
  });
}

function sourcePacketPolicyFailureFromManifest(auditManifest) {
  const policy = auditManifest?.source_packet_policy ?? null;
  if (!policy || policy.source_send_allowed !== false) return null;
  const errorCode = policy.source_packet_policy_error_code ?? "source_packet_policy_blocked";
  return providerFailureWithDiagnostics(
    errorCode,
    `${errorCode}: ${policy.suggested_action ?? "source packet policy blocked selected source send"}`,
    null,
    null,
    false,
    {
      source_packet_policy: policy,
      packet_recovery: auditManifest?.packet_recovery ?? null,
      review_slot_retry_policy: auditManifest?.review_slot_retry_policy ?? null,
      review_slot: auditManifest?.review_slot ?? null,
    },
  );
}

function packetRecoveryFromShardingPlan({
  cfg,
  provider,
  mode,
  scopeInfo,
  renderedPrompt,
  shardingPlan,
  approvalScope = "session",
  options = {},
  env = process.env,
} = {}) {
  if (!shardingPlan || shardingPlan.reason !== "prompt_too_large") return null;
  const request = requestSettingsForApproval(cfg, env);
  const routeFields = approvalRouteFields(routeStateForApproval(cfg, env));
  const auditManifest = buildApprovalAuditManifest({
    cfg,
    provider,
    mode,
    renderedPrompt,
    request,
    scopeInfo,
    routeFields,
    approvalScope,
    options,
  });
  return buildPacketRecovery({
    reason: "prompt_too_large",
    sourcePacketPolicy: auditManifest.source_packet_policy,
    providerCapabilities: providerCapabilitiesForConfig(cfg),
    provider,
    mode,
    routeStep: routeFields.route_step,
    selectedSource: auditManifest.selected_source,
    sourceContentTransmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    renderedPromptBudgetChars: shardingPlan.cap,
    requiresSourceSendApproval: routeFields.source_send_approval_required === true,
    shardPlans: Array.isArray(shardingPlan.shards) ? shardingPlan.shards : null,
  });
}

function approvalDiagnostics(cfg, request, renderedPrompt, authPath = null, billingPath = null, routeFields = null, approvalScope = "session") {
  return {
    configured_timeout_ms: request.timeout_ms,
    prompt_chars: renderedPrompt.length,
    request_defaults: summarizeRequestDefaults(cfg.request_defaults),
    max_tokens: request.max_tokens ?? null,
    temperature: request.temperature ?? null,
    selected_route: routeFields?.selected_route ?? null,
    fallback_reason: routeFields?.fallback_reason ?? null,
    approval_scope: approvalScope,
    auth_path: authPath,
    billing_path: billingPath,
  };
}

function shouldRequireApprovalToken(env = process.env) {
  return !env.API_REVIEWERS_MOCK_RESPONSE || env.API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS === "1";
}

function validateApprovalToken(options, expectedToken) {
  const provided = typeof options["approval-token"] === "string" ? options["approval-token"].trim() : "";
  return provided.length > 0 && provided === expectedToken.value;
}

function oneTimeApprovalUseFile(root, token) {
  const digest = createHash("sha256").update(String(token ?? "")).digest("hex");
  return resolve(root, "approval-tokens", "once", `${digest}.json`);
}

function approvalGrantsDir(root) {
  return resolve(root, "approval-grants");
}

function approvalGrantFile(root, grantId) {
  return resolve(approvalGrantsDir(root), `${grantId}.json`);
}

async function oneTimeApprovalAlreadyUsed(root, token) {
  try {
    await lstat(oneTimeApprovalUseFile(root, token));
    return true;
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

function buildApprovalGrantRecord({ approvalTuple, approvalFingerprint, activatedAt }) {
  const bounds = approvalTuple.grant_bounds;
  return Object.freeze({
    schema_version: SESSION_APPROVAL_GRANT_SCHEMA_VERSION,
    grant_id: `grant_${approvalFingerprint}`,
    created_at: activatedAt,
    expires_at: bounds.expires_at,
    grant_session_id: `session_${approvalFingerprint.slice(0, 32)}`,
    provider_allowlist: bounds.provider_allowlist,
    mode_allowlist: bounds.mode_allowlist,
    workspace_root_hash: bounds.workspace_root_hash,
    path_constraints: bounds.path_constraints,
    max_files: bounds.max_files,
    max_bytes: bounds.max_bytes,
    max_ttl_ms: bounds.max_ttl_ms,
    approval_fingerprint: approvalFingerprint,
    approval_tuple: approvalTuple,
    activation: Object.freeze({
      activated_at: activatedAt,
      source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
      approval_source: "grant_approval_token",
    }),
  });
}

function approvalGrantRecordMatches(record, approvalTuple, approvalFingerprint) {
  return record?.schema_version === SESSION_APPROVAL_GRANT_SCHEMA_VERSION
    && record?.approval_fingerprint === approvalFingerprint
    && requestFieldMatches(record?.approval_tuple, approvalTuple);
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => expectedKeys.includes(key));
}

function isIsoUtcMillis(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function approvalGrantProjectionMatches(record) {
  const bounds = record?.approval_tuple?.grant_bounds;
  return hasExactKeys(record, APPROVAL_GRANT_RECORD_KEYS)
    && hasExactKeys(record.approval_tuple, APPROVAL_GRANT_TUPLE_KEYS)
    && hasExactKeys(bounds, APPROVAL_GRANT_BOUNDS_KEYS)
    && hasExactKeys(record.activation, APPROVAL_GRANT_ACTIVATION_KEYS)
    && /^grant_[a-f0-9]{64}$/.test(record.grant_id)
    && /^[A-Za-z0-9_-]+$/.test(record.grant_session_id)
    && isIsoUtcMillis(record.created_at)
    && isIsoUtcMillis(record.expires_at)
    && isIsoUtcMillis(record.activation.activated_at)
    && record.activation.source_content_transmission === SOURCE_CONTENT_TRANSMISSION.NOT_SENT
    && record.activation.approval_source === "grant_approval_token"
    && record.provider_allowlist && requestFieldMatches(record.provider_allowlist, bounds.provider_allowlist)
    && record.mode_allowlist && requestFieldMatches(record.mode_allowlist, bounds.mode_allowlist)
    && record.workspace_root_hash === bounds.workspace_root_hash
    && requestFieldMatches(record.path_constraints, bounds.path_constraints)
    && record.max_files === bounds.max_files
    && record.max_bytes === bounds.max_bytes
    && record.max_ttl_ms === bounds.max_ttl_ms
    && record.expires_at === bounds.expires_at
    && record.approval_fingerprint === approvalFingerprintFor(record.approval_tuple);
}

function approvalGrantMatchesRun(record, { provider, mode, scopeInfo, auditManifest, authPath, billingPath, routeFields, grantPolicy, now = Date.now() }) {
  if (!approvalGrantProjectionMatches(record)) return false;
  if (!Array.isArray(record.provider_allowlist) || !record.provider_allowlist.includes(provider)) return false;
  if (!Array.isArray(record.mode_allowlist) || !record.mode_allowlist.includes(mode)) return false;
  if (record.max_ttl_ms !== grantPolicy.max_ttl_ms) return false;
  if (Date.parse(record.expires_at) <= now) return false;
  const selectedSource = sortedSelectedSource(auditManifest.selected_source);
  if (selectedSource.totals.files > record.max_files) return false;
  if (selectedSource.totals.bytes > record.max_bytes) return false;
  const workspaceHash = sha256Hex(resolve(scopeInfo.workspaceRoot ?? scopeInfo.cwd ?? process.cwd()));
  if (workspaceHash !== record.workspace_root_hash) return false;
  const currentPathConstraints = {
    scope: scopeInfo.scope,
    scope_paths: sortedStringArrayOrNull(scopeInfo.scope_paths),
  };
  if (!requestFieldMatches(record.path_constraints, currentPathConstraints)) return false;
  const currentTuple = grantApprovalTupleFor({
    provider,
    mode,
    auditManifest,
    authPath,
    billingPath,
    routeFields,
    grantBounds: record.approval_tuple.grant_bounds,
  });
  return requestFieldMatches(currentTuple, record.approval_tuple);
}

function isClearlyExpiredApprovalGrant(record, now = Date.now()) {
  const millis = Date.parse(record?.expires_at);
  return Number.isFinite(millis) && millis <= now;
}

async function cleanupExpiredApprovalGrantFile(file, record, now = Date.now()) {
  if (!isClearlyExpiredApprovalGrant(record, now)) return false;
  try {
    await unlink(file);
  } catch {
    // Opportunistic cleanup must not turn a source-send approval check into an I/O failure.
  }
  return true;
}

function approvalGrantAuditFields(record) {
  return Object.freeze({
    grant_id: record.grant_id,
    grant_session_id: record.grant_session_id,
    created_at: record.created_at,
    expires_at: record.expires_at,
    matched_at: new Date().toISOString(),
    max_files: record.max_files,
    max_bytes: record.max_bytes,
  });
}

async function findMatchingApprovalGrant(root, context) {
  let names;
  try {
    names = await readdir(approvalGrantsDir(root));
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw runProviderFailure("approval_required", "approval_required: approval grant store is unreadable");
  }
  const matches = [];
  const now = context.now ?? Date.now();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = resolve(approvalGrantsDir(root), name);
    let record;
    try {
      record = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (await cleanupExpiredApprovalGrantFile(file, record, now)) continue;
    if (approvalGrantMatchesRun(record, context)) matches.push(record);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw runProviderFailure("approval_required", "approval_required: multiple matching approval grants found; run approval-request for this source send");
  }
  return matches[0];
}

async function persistApprovalGrant(root, approvalTuple, approvalFingerprint) {
  const activatedAt = new Date().toISOString();
  const record = buildApprovalGrantRecord({ approvalTuple, approvalFingerprint, activatedAt });
  await mkdir(approvalGrantsDir(root), { recursive: true });
  const file = approvalGrantFile(root, record.grant_id);
  let handle = null;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    const existing = JSON.parse(await readFile(file, "utf8"));
    if (!approvalGrantRecordMatches(existing, approvalTuple, approvalFingerprint)) {
      throw runProviderFailure("approval_required", "approval_required: existing approval grant file does not match requested grant proof");
    }
    return Object.freeze(existing);
  } finally {
    if (handle) await handle.close();
  }
}

function approvalGrantActivationResponse({ provider, cfg, mode, scopeInfo, grantRecord }) {
  return Object.freeze({
    event: "external_review_session_approval_grant",
    provider,
    display_name: cfg.display_name,
    mode,
    scope: scopeInfo.scope,
    scope_base: scopeInfo.scope_base ?? null,
    scope_paths: sortedStringArrayOrNull(scopeInfo.scope_paths),
    source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    approval_source: "grant_approval_token",
    grant_id: grantRecord.grant_id,
    grant_session_id: grantRecord.grant_session_id,
    created_at: grantRecord.created_at,
    expires_at: grantRecord.expires_at,
    provider_allowlist: grantRecord.provider_allowlist,
    mode_allowlist: grantRecord.mode_allowlist,
    max_files: grantRecord.max_files,
    max_bytes: grantRecord.max_bytes,
    max_ttl_ms: grantRecord.max_ttl_ms,
    approval_fingerprint: grantRecord.approval_fingerprint,
  });
}

async function consumeOneTimeApproval(root, token, payload) {
  const file = oneTimeApprovalUseFile(root, token);
  await mkdir(dirname(file), { recursive: true });
  let handle = null;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    throw e;
  } finally {
    if (handle) await handle.close();
  }
}

function buildApprovalRequest({ provider, cfg, mode, options, scopeInfo }) {
  const renderedPrompt = promptFor(mode, options.prompt ?? "", scopeInfo, cfg.display_name);
  const promptBudget = validateRenderedPromptBudget(renderedPrompt, cfg);
  if (!promptBudget.ok) {
    const approvalScope = approvalScopeForOptions(options);
    let diagnostics = null;
    if (promptBudget.reason === "prompt_too_large") {
      const shardingPlan = buildShardingPlan({
        cfg,
        mode,
        provider,
        scopeInfo,
        userPrompt: options.prompt ?? "",
        renderedPromptChars: renderedPrompt.length,
        approvalScope,
      });
      diagnostics = {
        sharding_plan: shardingPlan,
        packet_recovery: packetRecoveryFromShardingPlan({
          cfg,
          provider,
          mode,
          scopeInfo,
          renderedPrompt,
          shardingPlan,
          approvalScope,
          options,
        }),
      };
    }
    throw runProviderFailure(promptBudget.reason, promptBudget.error, diagnostics);
  }
  const request = requestSettingsForApproval(cfg);
  const authPath = approvalAuthPathFor(cfg, process.env);
  const billingPath = approvalBillingPathFor(cfg);
  const routeFields = approvalRouteFields(routeStateForApproval(cfg, process.env));
  const approvalScope = approvalScopeForOptions(options);
  const auditManifest = buildApprovalAuditManifest({ cfg, provider, mode, renderedPrompt, request, scopeInfo, routeFields, approvalScope, options });
  const sourcePacketFailure = sourcePacketPolicyFailureFromManifest(auditManifest);
  if (sourcePacketFailure) {
    throw runProviderFailure(
      sourcePacketFailure.parsed.reason,
      sourcePacketFailure.parsed.error,
      sourcePacketFailure.diagnostics,
    );
  }
  const approvalToken = approvalTokenFor({ provider, mode, auditManifest, authPath, billingPath, routeFields, approvalScope });
  const totals = auditManifest.selected_source.totals;
  const approvalQuestion = `Allow sending ${totals.files} selected ${plural(totals.files, "file")} (${totals.bytes} ${plural(totals.bytes, "byte")}, ${totals.lines} ${plural(totals.lines, "line")}) to ${cfg.display_name} for external review?`;
  const disclosure = `Selected source content has not been sent to ${cfg.display_name}. Running the review will send the selected source content to ${cfg.display_name} through direct API auth.`;
  return Object.freeze({
    event: "external_review_approval_request",
    provider,
    display_name: cfg.display_name,
    mode,
    scope: scopeInfo.scope,
    scope_base: scopeInfo.scope_base ?? null,
    scope_paths: scopeInfo.scope_paths ?? null,
    source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    disclosure,
    approval_question: approvalQuestion,
    recommended_tool_justification: `${disclosure} ${approvalQuestion} If approved, pass approval_token.value with --approval-token before running the external API command. ${sourceSendSandboxGuidance()}`,
    approval_token: approvalToken,
    selected_source: auditManifest.selected_source,
    rendered_prompt_hash: auditManifest.rendered_prompt_hash,
    source_packet_policy: auditManifest.source_packet_policy,
    review_slot_retry_policy: auditManifest.review_slot_retry_policy,
    review_slot: auditManifest.review_slot,
    request: approvalRequestSettingsProjection(cfg, request),
    selected_route: routeFields.selected_route,
    route_step: routeFields.route_step,
    route_steps: routeFields.route_steps,
    fallback_reason: routeFields.fallback_reason,
    approval_scope: approvalScope,
    auth_path: authPath,
    billing_path: billingPath,
    scope_resolution: auditManifest.scope_resolution,
    denial_action: Object.freeze({
      action: "generate_relay_prompt",
      source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    }),
    denial_fallback: "If approval is denied, stop the direct API retry and generate a relay prompt instead of treating the reviewer as approved or failed by the provider.",
  });
}

function buildApprovalGrantRequest({ provider, cfg, mode, options, scopeInfo, grantPolicy, grantExpiresAt = null }) {
  const grantTtlMs = grantExpiresAt ? null : parseGrantTtlMs(grantPolicy, options);
  const renderedPrompt = promptFor(mode, options.prompt ?? "", scopeInfo, cfg.display_name);
  const promptBudget = validateRenderedPromptBudget(renderedPrompt, cfg);
  if (!promptBudget.ok) {
    const diagnostics = promptBudget.reason === "prompt_too_large"
      ? {
          sharding_plan: buildShardingPlan({
            cfg,
            mode,
            provider,
            scopeInfo,
            userPrompt: options.prompt ?? "",
            renderedPromptChars: renderedPrompt.length,
            approvalScope: "grant",
          }),
        }
      : null;
    throw runProviderFailure(promptBudget.reason, promptBudget.error, diagnostics);
  }
  const request = requestSettingsForApproval(cfg);
  const authPath = approvalAuthPathFor(cfg, process.env);
  const billingPath = approvalBillingPathFor(cfg);
  const routeFields = approvalRouteFields(routeStateForApproval(cfg, process.env));
  const auditManifest = buildApprovalAuditManifest({
    cfg,
    provider,
    mode,
    renderedPrompt,
    request,
    scopeInfo,
    routeFields,
    approvalScope: "grant",
    options,
  });
  const sourcePacketFailure = sourcePacketPolicyFailureFromManifest(auditManifest);
  if (sourcePacketFailure) {
    throw runProviderFailure(
      sourcePacketFailure.parsed.reason,
      sourcePacketFailure.parsed.error,
      sourcePacketFailure.diagnostics,
    );
  }
  const selectedSource = sortedSelectedSource(auditManifest.selected_source);
  const expiresAt = grantExpiresAt ?? new Date(Date.now() + grantTtlMs).toISOString();
  const grantBounds = grantBoundsFor({ provider, mode, scopeInfo, selectedSource, expiresAt, grantPolicy });
  const approvalTuple = grantApprovalTupleFor({
    provider,
    mode,
    auditManifest,
    authPath,
    billingPath,
    routeFields,
    grantBounds,
  });
  const grantApprovalToken = grantApprovalTokenFor(approvalTuple);
  const totals = selectedSource.totals;
  const approvalQuestion = `Allow a bounded session grant for sending ${totals.files} selected ${plural(totals.files, "file")} (${totals.bytes} ${plural(totals.bytes, "byte")}, ${totals.lines} ${plural(totals.lines, "line")}) to ${cfg.display_name} until ${expiresAt}?`;
  const disclosure = `Selected source content has not been sent to ${cfg.display_name}. Activating this grant will not send selected source; later matching runs may send selected source to ${cfg.display_name} through direct API auth.`;
  const approvalRequest = Object.freeze({
    event: "external_review_session_approval_request",
    provider,
    display_name: cfg.display_name,
    mode,
    scope: scopeInfo.scope,
    scope_base: scopeInfo.scope_base ?? null,
    scope_paths: sortedStringArrayOrNull(scopeInfo.scope_paths),
    source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    disclosure,
    approval_question: approvalQuestion,
    recommended_tool_justification: `${disclosure} ${approvalQuestion} If approved, pass grant_approval_token.value to approval-grant activate with grant_bounds.expires_at before any grant-approved source send. ${sourceSendSandboxGuidance()}`,
    grant_approval_token: grantApprovalToken,
    grant_bounds: grantBounds,
    selected_source: selectedSource,
    rendered_prompt_hash: auditManifest.rendered_prompt_hash,
    source_packet_policy: auditManifest.source_packet_policy,
    review_slot_retry_policy: auditManifest.review_slot_retry_policy,
    review_slot: auditManifest.review_slot,
    request: approvalRequestSettingsProjection(cfg, request),
    selected_route: routeFields.selected_route,
    route_step: routeFields.route_step,
    route_steps: routeFields.route_steps,
    fallback_reason: routeFields.fallback_reason,
    approval_scope: "grant",
    auth_path: authPath,
    billing_path: billingPath,
    scope_resolution: sortedScopeResolution(auditManifest.scope_resolution),
    denial_action: Object.freeze({
      action: "skip_session_grant",
      source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    }),
    denial_fallback: "If approval is denied, do not activate a session grant. Use the existing approval-request flow for any later source send.",
  });
  return Object.freeze({ approvalRequest, approvalTuple });
}

function errorCauseFor(errorCode) {
  if (errorCode === "bad_args") return "caller";
  if (errorCode === "approval_required") return "approval_gate";
  if (errorCode === "config_error") return "provider_config";
  if (errorCode === "scope_failed") return "scope_resolution";
  if (errorCode === "source_packet_too_large" || errorCode === "resend_confirmation_required") {
    return buildExternalModelFailureDiagnostic(errorCode, "external model")?.error_cause ?? "source_packet_policy";
  }
  if (errorCode === "provider_workload_blocked") {
    return buildExternalModelFailureDiagnostic(errorCode, "external model")?.error_cause ?? "workload_admission";
  }
  if (errorCode === "git_binary_rejected") return "git_binary_policy";
  if (errorCode === "sandbox_blocked") return "sandbox_access";
  if (errorCode === "usage_limited") return "cost_quota_usage_limit";
  if (errorCode === "review_not_completed") return "review_quality";
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

function diagnosticErrorSummary(errorCode, errorMessage, scopeInfo, execution, semanticReasons = null) {
  if (errorCode === "review_not_completed") {
    const reasons = semanticReasons
      ?? execution.review_metadata?.audit_manifest?.review_quality?.semantic_failure_reasons;
    const suffix = Array.isArray(reasons) && reasons.length > 0 ? ` (${reasons.join(",")})` : "";
    return `review did not complete as a usable external review${suffix}`;
  }
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

function buildReviewMetadata(provider, cfg, mode, scopeInfo, execution = null, startedAt = null, endedAt = null, options = {}) {
  let routeFields;
  try {
    routeFields = approvalRouteFields(routeStateForApproval(cfg, process.env, { sourceSendApproved: !!execution?.approval_scope }));
  } catch (e) {
    if (e?.apiReviewersReason !== "bad_args") throw e;
    routeFields = approvalRouteFields(null);
  }
  const processCompleted = execution?.exitCode === 0 && execution?.parsed?.ok === true;
  const sourceContentTransmission = directApiTransmission(
    processCompleted,
    execution?.payload_sent ?? (processCompleted ? true : null),
  );
  let auditManifest = execution?.prompt ? buildReviewAuditManifest({
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
    route: {
      mode,
      providerId: provider,
      selectedRoute: routeFields.selected_route,
      routeStep: routeFields.route_step,
      routeSteps: routeFields.route_steps,
      fallbackReason: routeFields.fallback_reason,
      approvalScope: execution?.approval_scope ?? null,
      authPath: approvalAuthPathFor(cfg, process.env),
      billingPath: routeFields.billing_path,
      sourceContentTransmission,
      sourceSendApprovalRequired: routeFields.source_send_approval_required,
      sourceSendApprovalState: routeFields.source_send_approval_state,
      providerCapabilities: providerCapabilitiesForConfig(cfg),
      packetRecovery: execution.diagnostics?.packet_recovery ?? null,
      previousAttempt: latestSourcePacketPreviousAttempt(options.reviewSlotPriorAttempts),
      reviewSlot: reviewSlotRouteFields(options, {
        priorAttempts: options.reviewSlotPriorAttempts ?? [],
      }),
      ...sourcePacketOverrideRouteFields(options),
    },
    result: execution.parsed?.result ?? "",
    status: execution.exitCode === 0 && execution.parsed?.ok === true ? "completed" : "failed",
    errorCode: execution.parsed?.reason ?? null,
  }) : null;
  if (auditManifest && execution?.approval_source === "session_grant") {
    auditManifest = Object.freeze({
      ...auditManifest,
      approval_source: "session_grant",
      approval_grant: execution.approval_grant ?? null,
    });
  }
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
      elapsed_ms: elapsedMs(startedAt, endedAt),
    } : null,
    audit_manifest: auditManifest,
  };
}

function buildRuntimeDiagnostics(diagnostics) {
  if (!diagnostics) return null;
  const hasProviderRequest = (
    Object.hasOwn(diagnostics, "configured_timeout_ms") ||
    Object.hasOwn(diagnostics, "elapsed_ms") ||
    Object.hasOwn(diagnostics, "prompt_chars") ||
    Object.hasOwn(diagnostics, "request_defaults") ||
    Object.hasOwn(diagnostics, "max_tokens") ||
    Object.hasOwn(diagnostics, "temperature") ||
    Object.hasOwn(diagnostics, "fetch_error")
  );
  const out = {};
  if (hasProviderRequest) {
    out.provider_request = {
      configured_timeout_ms: diagnostics.configured_timeout_ms ?? null,
      elapsed_ms: diagnostics.elapsed_ms ?? null,
      prompt_chars: diagnostics.prompt_chars ?? null,
      request_defaults: diagnostics.request_defaults ?? null,
      max_tokens: diagnostics.max_tokens ?? null,
      temperature: diagnostics.temperature ?? null,
      fetch_error: diagnostics.fetch_error ?? null,
    };
    out.cost_quota = diagnostics.cost_quota ?? null;
  } else if (Object.hasOwn(diagnostics, "cost_quota")) {
    out.cost_quota = diagnostics.cost_quota ?? null;
  }
  if (diagnostics.sharding_plan) {
    out.sharding_plan = diagnostics.sharding_plan;
  }
  if (diagnostics.source_packet_policy) {
    out.source_packet_policy = diagnostics.source_packet_policy;
  }
  if (diagnostics.packet_recovery) {
    out.packet_recovery = diagnostics.packet_recovery;
  }
  if (diagnostics.review_slot_retry_policy) {
    out.review_slot_retry_policy = diagnostics.review_slot_retry_policy;
  }
  if (diagnostics.review_slot) {
    out.review_slot = diagnostics.review_slot;
  }
  if (diagnostics.provider_workload) {
    out.provider_workload = diagnostics.provider_workload;
  }
  return Object.keys(out).length === 0 ? null : out;
}

function sourceBearingFailurePacketRecovery({ provider, cfg, mode, reviewMetadata, errorCode, transmission }) {
  const recoveryReason = sourceSentPacketRecoveryReason({
    status: "failed",
    errorCode,
    sourceContentTransmission: transmission,
  });
  if (!recoveryReason) return null;
  if (
    transmission !== SOURCE_CONTENT_TRANSMISSION.SENT &&
    transmission !== SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT &&
    transmission !== SOURCE_CONTENT_TRANSMISSION.UNKNOWN
  ) return null;
  const auditManifest = reviewMetadata?.audit_manifest;
  if (!auditManifest || auditManifest.packet_recovery) return null;
  const sourcePacketPolicy = Object.freeze({
    ...(auditManifest.source_packet_policy ?? {}),
    provider,
    mode,
    route_step: auditManifest.source_packet_policy?.route_step ?? auditManifest.route_step ?? null,
    source_send_allowed: false,
    source_content_transmission: transmission,
    source_packet_action: "resend_confirmation_required",
    source_packet_policy_error_code: "resend_confirmation_required",
    suggested_action: "Do not automatically resend selected source after a failed source-sent review slot.",
  });
  return buildPacketRecovery({
    reason: recoveryReason,
    sourcePacketPolicy,
    providerCapabilities: providerCapabilitiesForConfig(cfg),
    provider,
    mode,
    routeStep: sourcePacketPolicy.route_step ?? null,
    selectedSource: auditManifest.selected_source ?? null,
    sourceContentTransmission: transmission,
    requiresSourceSendApproval: true,
  });
}

function buildRecord({ provider, cfg, mode, options, scopeInfo, execution, startedAt, endedAt }) {
  let reviewMetadata = buildReviewMetadata(provider, cfg, mode, scopeInfo, execution, startedAt, endedAt, options);
  const processCompleted = execution.exitCode === 0 && execution.parsed?.ok === true;
  const reviewQualityState = processCompleted
    ? reviewQualityFailureState(reviewMetadata?.audit_manifest?.review_quality, {
      missingReasonsMessage: "review_quality_failed",
      emptyReasonsMessage: "review_quality_failed",
    })
    : null;
  const completed = processCompleted && !reviewQualityState;
  const redaction = redactionContext(cfg.env_keys, process.env, credentialRedactionValues(execution));
  const redactSensitiveText = buildPrivacyRedactor({
    ...redaction,
    sourceFiles: scopeInfo.files,
  }).text;
  const result = processCompleted ? redactSensitiveText(execution.parsed.result) : null;
  const semanticReasons = reviewMetadata?.audit_manifest?.review_quality?.semantic_failure_reasons ?? null;
  const errorMessage = completed ? null : redactSensitiveText(reviewQualityState ? reviewQualityState.error_message : (execution.parsed?.error ?? ""));
  const errorCode = completed ? null : (reviewQualityState ? reviewQualityState.error_code : (execution.parsed?.reason ?? "provider_error"));
  const target = provider;
  const payloadSent = execution.payload_sent ?? (processCompleted ? true : null);
  const sourceContentTransmission = directApiTransmission(completed, payloadSent);
  const disclosure = directApiDisclosure(cfg.display_name, completed, payloadSent);
  const packetRecovery = execution.diagnostics?.packet_recovery
    ?? reviewMetadata?.audit_manifest?.packet_recovery
    ?? sourceBearingFailurePacketRecovery({
      provider,
      cfg,
      mode,
      reviewMetadata,
      errorCode,
      transmission: sourceContentTransmission,
    });
  if (packetRecovery && reviewMetadata?.audit_manifest && !reviewMetadata.audit_manifest.packet_recovery) {
    reviewMetadata = Object.freeze({
      ...reviewMetadata,
      audit_manifest: Object.freeze({
        ...reviewMetadata.audit_manifest,
        packet_recovery: packetRecovery,
      }),
    });
  }
  const reviewSlot = reviewMetadata?.audit_manifest?.review_slot
    ? Object.freeze({
      ...reviewMetadata.audit_manifest.review_slot,
      source_state: sourceContentTransmission,
    })
    : null;
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
    review_slot: reviewSlot,
    disclosure,
  });
  const runtimeDiagnostics = buildRuntimeDiagnostics(packetRecovery
    ? { ...(execution.diagnostics ?? {}), packet_recovery: packetRecovery }
    : execution.diagnostics);
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
    prompt_head: hasPromptText(options.prompt)
      ? promptHead(redactSensitiveText(options.prompt))
      : "",
    review_metadata: reviewMetadata,
    schema_spec: null,
    binary: null,
    status: completed ? "completed" : "failed",
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: execution.exitCode,
    error_code: errorCode,
    error_message: errorMessage,
    error_summary: completed ? null : diagnosticErrorSummary(errorCode, errorMessage, scopeInfo, execution, semanticReasons),
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
    credential_source: execution.credential_source ?? null,
    endpoint: execution.endpoint ?? (cfg.base_url ? baseUrlFor(cfg) : null),
    http_status: execution.http_status ?? null,
    raw_model: execution.parsed?.raw_model ?? null,
    schema_version: SCHEMA_VERSION,
  });
}

async function persistRecord(record, env = process.env, cwd = record.workspace_root ?? record.cwd ?? process.cwd()) {
  const root = apiReviewerDataRoot(env, cwd);
  await writeApiReviewerMetaRecord(root, record);
  await withApiReviewerStateLock(root, async () => {
    await writeApiReviewerMetaRecord(root, record);
    await updateApiReviewerStateForRecord(root, record);
  });
}

async function persistRecordBestEffort(record, env = process.env, configuredSecretNames = [], cwd = record.workspace_root ?? record.cwd ?? process.cwd()) {
  try {
    await persistRecord(record, env, cwd);
    return record;
  } catch (e) {
    const detail = redactor(env, configuredSecretNames)(`JobRecord persistence failed: ${e?.message ?? String(e)}`);
    return {
      ...record,
      disclosure_note: record.disclosure_note ? `${record.disclosure_note} ${detail}` : detail,
    };
  }
}

async function cmdResult(options) {
  const jobId = options.job ?? options["job-id"];
  if (!jobId) {
    printJson({ ok: false, error_code: "bad_args", error: "--job <id> is required" });
    process.exit(1);
  }
  const lookupCwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const root = apiReviewerDataRoot(process.env, bestEffortWorkspaceRoot(lookupCwd));
  const suggestedAction =
    `Run result with --job ${jobId} --cwd <workspace used when the job was launched>, ` +
    "and reuse the same API_REVIEWERS_PLUGIN_DATA value if one was set.";
  try {
    const record = await readApiReviewerMetaRecord(root, jobId);
    const configuredSecretNames = await configuredSecretNamesForResult();
    printJson(redactRecord(record, process.env, configuredSecretNames));
  } catch (e) {
    if (isUnsafeJobIdError(e)) {
      printJson({ ok: false, error_code: "bad_args", error: "unsafe_job_id" });
      process.exit(1);
    }
    if (e?.code === "ENOENT") {
      printJson({ ok: false, error_code: "not_found", job_id: jobId, data_root: root, suggested_action: suggestedAction });
      process.exit(1);
    }
    if (e instanceof SyntaxError) {
      printJson({ ok: false, error_code: "malformed_record", job_id: jobId });
      process.exit(1);
    }
    if (e?.apiReviewersReason === "config_error") {
      printJson({ ok: false, error_code: "config_error", job_id: jobId, error: "provider_config_unavailable" });
      process.exit(1);
    }
    printJson({ ok: false, error_code: "read_failed", job_id: jobId, error: "read_failed" });
    process.exit(1);
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
  const fields = await doctorFields(provider, cfg);
  printJson(fields);
  if (fields.ready !== true) process.exit(1);
}

function validateApprovalCommandArgs(provider, mode) {
  if (!provider) throw runBadArgs("bad_args: --provider is required");
  if (!VALID_MODES.has(mode)) throw runBadArgs(`bad_args: unsupported --mode ${mode}`);
}

async function loadApprovalProviderConfig(provider) {
  let providers;
  try {
    providers = await loadProviders();
  } catch (e) {
    throw runConfigError(`config_error: ${providersConfigErrorMessage(e)}`);
  }
  try {
    const cfg = providerConfig(providers, provider);
    return Object.freeze({ cfg, configuredSecretNames: cfg.env_keys ?? [] });
  } catch (e) {
    throw runBadArgs(e.message);
  }
}

async function loadSessionApprovalGrantPolicy() {
  try {
    return await loadSessionApprovalPolicy();
  } catch (e) {
    throw runConfigError(`config_error: session approval policy unreadable: ${e.message}`);
  }
}

async function collectApprovalScopeAndPriorAttempts(options, mode) {
  const scopeInfo = await collectScope({ ...options, mode });
  options.reviewSlotPriorAttempts = await collectPriorReviewSlotAttempts(
    apiReviewerDataRoot(process.env, scopeInfo.workspaceRoot ?? scopeInfo.cwd),
  );
  return scopeInfo;
}

function printApprovalCommandFailure(e, { provider, configuredSecretNames, scopeInfo }) {
  const reason = isGitBinaryPolicyError(e) ? "git_binary_rejected" : (e.apiReviewersReason ?? "scope_failed");
  const redact = redactor(process.env, configuredSecretNames);
  const response = {
    ok: false,
    provider,
    status: reason,
    error_code: reason,
    error_message: redact(e?.message ?? String(e)),
  };
  const runtimeDiagnostics = buildRuntimeDiagnostics(e?.apiReviewersDiagnostics);
  if (runtimeDiagnostics) response.runtime_diagnostics = runtimeDiagnostics;
  printJson(redactRecord(response, process.env, configuredSecretNames, scopeInfo?.files ?? []));
  process.exit(1);
}

async function cmdApprovalRequest(options) {
  const provider = options.provider ?? null;
  const mode = options.mode ?? "review";
  let configuredSecretNames = [];
  let scopeInfo = null;
  try {
    validateApprovalCommandArgs(provider, mode);
    const providerConfigResult = await loadApprovalProviderConfig(provider);
    const cfg = providerConfigResult.cfg;
    configuredSecretNames = providerConfigResult.configuredSecretNames;
    options = await optionsWithPromptFile(options);
    if (!hasPromptText(options.prompt)) throw runBadArgs("bad_args: prompt is required (pass --prompt <focus>)");
    scopeInfo = await collectApprovalScopeAndPriorAttempts(options, mode);
    let approvalRequest;
    try {
      approvalRequest = buildApprovalRequest({ provider, cfg, mode, options, scopeInfo });
    } catch (e) {
      if (e?.apiReviewersReason) throw e;
      throw runProviderFailure("approval_request_failed", e?.message ?? String(e));
    }
    printJson(approvalRequest);
  } catch (e) {
    printApprovalCommandFailure(e, { provider, configuredSecretNames, scopeInfo });
  }
}

async function cmdApprovalGrantRequest(options) {
  const provider = options.provider ?? null;
  const mode = options.mode ?? "review";
  let configuredSecretNames = [];
  let scopeInfo = null;
  try {
    validateApprovalCommandArgs(provider, mode);
    const providerConfigResult = await loadApprovalProviderConfig(provider);
    const cfg = providerConfigResult.cfg;
    configuredSecretNames = providerConfigResult.configuredSecretNames;
    options = await optionsWithPromptFile(options);
    if (!hasPromptText(options.prompt)) throw runBadArgs("bad_args: prompt is required (pass --prompt <focus>)");
    const grantPolicy = await loadSessionApprovalGrantPolicy();
    scopeInfo = await collectApprovalScopeAndPriorAttempts(options, mode);
    let approvalRequest;
    try {
      ({ approvalRequest } = buildApprovalGrantRequest({ provider, cfg, mode, options, scopeInfo, grantPolicy }));
    } catch (e) {
      if (e?.apiReviewersReason) throw e;
      throw runProviderFailure("approval_grant_request_failed", e?.message ?? String(e));
    }
    printJson(approvalRequest);
  } catch (e) {
    printApprovalCommandFailure(e, { provider, configuredSecretNames, scopeInfo });
  }
}

async function cmdApprovalGrantActivate(options) {
  const provider = options.provider ?? null;
  const mode = options.mode ?? "review";
  let configuredSecretNames = [];
  let scopeInfo = null;
  try {
    validateApprovalCommandArgs(provider, mode);
    const grantPolicy = await loadSessionApprovalGrantPolicy();
    const grantExpiresAt = parseGrantExpiresAt(grantPolicy, options);
    const providerConfigResult = await loadApprovalProviderConfig(provider);
    const cfg = providerConfigResult.cfg;
    configuredSecretNames = providerConfigResult.configuredSecretNames;
    options = await optionsWithPromptFile(options);
    if (!hasPromptText(options.prompt)) throw runBadArgs("bad_args: prompt is required (pass --prompt <focus>)");
    scopeInfo = await collectApprovalScopeAndPriorAttempts(options, mode);
    let approvalRequest;
    let approvalTuple;
    try {
      ({ approvalRequest, approvalTuple } = buildApprovalGrantRequest({
        provider,
        cfg,
        mode,
        options,
        scopeInfo,
        grantPolicy,
        grantExpiresAt,
      }));
    } catch (e) {
      if (e?.apiReviewersReason) throw e;
      throw runProviderFailure("approval_grant_activation_failed", e?.message ?? String(e));
    }
    if (!validateApprovalToken(options, approvalRequest.grant_approval_token)) {
      throw runProviderFailure(
        "approval_required",
        "approval_required: run approval-grant request, show the source-free grant summary to the user, and pass the matching grant_approval_token.value with --approval-token and grant_bounds.expires_at",
      );
    }
    const approvalFingerprint = approvalFingerprintFor(approvalTuple);
    const grantRecord = await persistApprovalGrant(
      apiReviewerDataRoot(process.env, scopeInfo.workspaceRoot ?? scopeInfo.cwd),
      approvalTuple,
      approvalFingerprint,
    );
    printJson(approvalGrantActivationResponse({ provider, cfg, mode, scopeInfo, grantRecord }));
  } catch (e) {
    printApprovalCommandFailure(e, { provider, configuredSecretNames, scopeInfo });
  }
}

async function cmdApprovalGrant(argv) {
  const [subcommand = "help", ...rest] = argv;
  const options = parseArgs(rest);
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printJson({
      ok: true,
      command: "approval-grant",
      subcommands: ["request", "activate"],
      source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    });
    return;
  }
  if (subcommand === "request") return cmdApprovalGrantRequest(options);
  if (subcommand === "activate") return cmdApprovalGrantActivate(options);
  throw new Error(`unknown_approval_grant_command:${subcommand}`);
}

async function cmdRun(options) {
  const provider = options.provider ?? null;
  const mode = options.mode ?? "review";
  let approvalScope = "session";
  let lifecycleEvents = null;
  const startedAt = new Date().toISOString();
  const jobId = `job_${randomUUID()}`;
  const runOptions = { ...options, jobId };
  let providers;
  let cfg;
  let scopeInfo;
  let execution;
  let workloadLease = null;
  try {
    lifecycleEvents = parseLifecycleEventsMode(options["lifecycle-events"]);
    if (!provider) throw runBadArgs("bad_args: --provider is required");
    if (!VALID_MODES.has(mode)) throw runBadArgs(`bad_args: unsupported --mode ${mode}`);
    approvalScope = approvalScopeForOptions(options);
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
    options = await optionsWithPromptFile(options);
    Object.assign(runOptions, options);
    const preflight = validateDirectApiRunPreflight(cfg, provider, process.env);
    if (!preflight.ok && preflight.reason === "bad_args") throw runBadArgs(preflight.error);
    if (!preflight.ok) throw runProviderFailure(preflight.reason, preflight.error);
    if (!hasPromptText(options.prompt)) throw runBadArgs("bad_args: prompt is required (pass --prompt <focus>)");
    const statePreflight = await verifyApiReviewerDataRootWritable(
      process.env,
      options.cwd ? resolve(options.cwd) : process.cwd(),
    );
    if (!statePreflight.ok) throw runProviderFailure("sandbox_blocked", statePreflight.error);
    scopeInfo = await collectScope({ ...runOptions, mode });
    runOptions.reviewSlotPriorAttempts = await collectPriorReviewSlotAttempts(
      apiReviewerDataRoot(process.env, scopeInfo.workspaceRoot ?? scopeInfo.cwd),
      jobId,
    );
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
    let renderedPrompt = null;
    try {
      renderedPrompt = promptFor(mode, options.prompt ?? "", scopeInfo, cfg.display_name);
      const promptBudget = validateRenderedPromptBudget(renderedPrompt, cfg, process.env);
      if (!promptBudget.ok) {
        let diagnostics = null;
        if (promptBudget.reason === "prompt_too_large") {
          const shardingPlan = buildShardingPlan({
            cfg,
            mode,
            provider,
            scopeInfo,
            userPrompt: options.prompt ?? "",
            env: process.env,
            renderedPromptChars: renderedPrompt.length,
            approvalScope,
          });
          diagnostics = {
            sharding_plan: shardingPlan,
            packet_recovery: packetRecoveryFromShardingPlan({
              cfg,
              provider,
              mode,
              scopeInfo,
              renderedPrompt,
              shardingPlan,
              approvalScope,
              options: runOptions,
              env: process.env,
            }),
          };
        }
        execution = providerFailureWithDiagnostics(
          promptBudget.reason,
          redactor(process.env)(promptBudget.error),
          null,
          null,
          false,
          diagnostics,
        );
        execution.prompt = renderedPrompt;
      }
      let request = null;
      let authPath = null;
      let billingPath = null;
      let routeFields = null;
      let auditManifest = null;
      if (!execution) {
        request = requestSettingsForApproval(cfg);
        authPath = approvalAuthPathFor(cfg, process.env);
        billingPath = approvalBillingPathFor(cfg);
        routeFields = approvalRouteFields(routeStateForApproval(cfg, process.env));
        auditManifest = buildApprovalAuditManifest({ cfg, provider, mode, renderedPrompt, request, scopeInfo, routeFields, approvalScope, options: runOptions });
        execution = sourcePacketPolicyFailureFromManifest(auditManifest);
        if (execution) execution.prompt = renderedPrompt;
      }
      if (!execution && shouldRequireApprovalToken(process.env)) {
        const expectedToken = approvalTokenFor({ provider, mode, auditManifest, authPath, billingPath, routeFields, approvalScope });
        const providedApprovalToken = typeof options["approval-token"] === "string" && options["approval-token"].trim().length > 0;
        let matchedGrant = null;
        if (!providedApprovalToken) {
          let grantPolicy;
          try {
            grantPolicy = await loadSessionApprovalPolicy();
          } catch (e) {
            throw runConfigError(`config_error: session approval policy unreadable: ${e.message}`);
          }
          matchedGrant = await findMatchingApprovalGrant(
            apiReviewerDataRoot(process.env, scopeInfo.workspaceRoot ?? scopeInfo.cwd),
            { provider, mode, scopeInfo, auditManifest, authPath, billingPath, routeFields, grantPolicy },
          );
          if (matchedGrant) {
            approvalScope = "grant";
            runOptions.approval_source = "session_grant";
            runOptions.approval_grant = approvalGrantAuditFields(matchedGrant);
          }
        }
        if (!matchedGrant && !validateApprovalToken(options, expectedToken)) {
          execution = providerFailureWithDiagnostics(
            "approval_required",
            "approval_required: run approval-request, show the approval summary to the user, and pass the returned approval_token.value with --approval-token after explicit approval",
            null,
            null,
            false,
            approvalDiagnostics(cfg, request, renderedPrompt, authPath, billingPath, routeFields, approvalScope),
          );
          execution.prompt = renderedPrompt;
        } else if (
          approvalScope === "once" &&
          await oneTimeApprovalAlreadyUsed(
            apiReviewerDataRoot(process.env, scopeInfo.workspaceRoot ?? scopeInfo.cwd),
            options["approval-token"],
          )
        ) {
          execution = providerFailureWithDiagnostics(
            "approval_required",
            "approval_required: one-time approval token has already been used; run approval-request again before source is sent",
            null,
            null,
            false,
            approvalDiagnostics(cfg, request, renderedPrompt, authPath, billingPath, routeFields, approvalScope),
          );
          execution.prompt = renderedPrompt;
        }
      }
    } catch (e) {
      const reason = e?.apiReviewersReason ?? "scope_failed";
      execution = providerFailure(reason, redactor(process.env)(e?.message ?? String(e)), null, null, false);
    }
    if (execution) {
      // handled below by the terminal JobRecord path without a launch event
    } else {
      let admissionContext;
      try {
        admissionContext = resolveApiReviewerAdmissionContext(provider, process.env);
      } catch (error) {
        execution = concurrencyAdmissionBlockedExecution(error, provider, "direct_api");
        execution.prompt = renderedPrompt;
      }
      const workloadAdmission = execution ? null : acquireProviderWorkloadLease({
        ...admissionContext,
        provider,
        jobId,
        cwd: scopeInfo.cwd,
        sourceBearing: true,
        env: process.env,
      });
      if (workloadAdmission?.ok) {
        assertSourceBearingWorkloadLease(workloadAdmission, true);
        workloadLease = workloadAdmission.lease;
      } else if (workloadAdmission) {
        execution = providerWorkloadBlockedExecution(workloadAdmission);
        execution.prompt = renderedPrompt;
      }
    }
    if (execution) {
      // handled below by the terminal JobRecord path without a launch event
    } else {
      execution = await sourceFreePreSendFailure(provider, cfg, process.env);
    }
    if (execution) {
      execution.prompt = renderedPrompt;
      // handled below by the terminal JobRecord path without a launch event
    } else {
      if (approvalScope === "once" && shouldRequireApprovalToken(process.env)) {
        const consumed = await consumeOneTimeApproval(
          apiReviewerDataRoot(process.env, scopeInfo.workspaceRoot ?? scopeInfo.cwd),
          options["approval-token"],
          {
            provider,
            mode,
            job_id: jobId,
            consumed_at: new Date().toISOString(),
          },
        );
        if (!consumed) {
          execution = providerFailureWithDiagnostics(
            "approval_required",
            "approval_required: one-time approval token has already been used; run approval-request again before source is sent",
            null,
            null,
            false,
            { approval_scope: approvalScope },
          );
          execution.prompt = renderedPrompt;
        }
      }
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
      const stopHeartbeat = startLifecycleHeartbeat({
        job_id: jobId,
        target: provider,
        mode,
        cwd: scopeInfo.cwd,
        workspace_root: scopeInfo.workspaceRoot,
        external_review: buildLaunchExternalReview({ cfg, mode, options: runOptions, scopeInfo }),
      }, lifecycleEvents);
      try {
        execution = await callProvider(provider, cfg, renderedPrompt);
        execution.prompt = renderedPrompt;
      } catch (e) {
        execution = providerFailure("provider_unavailable", redactor(process.env)(e?.message ?? String(e)), null, null, null);
        execution.prompt = renderedPrompt;
      } finally {
        stopHeartbeat();
        releaseProviderWorkloadLease(workloadLease);
        workloadLease = null;
      }
    }
  }
  releaseProviderWorkloadLease(workloadLease);
  workloadLease = null;
  if (execution) {
    execution.approval_scope = approvalScope;
    if (runOptions.approval_source === "session_grant") {
      execution.approval_source = "session_grant";
      execution.approval_grant = runOptions.approval_grant;
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
  }), process.env, cfg.env_keys, scopeInfo.files, credentialRedactionValues(execution));
  const printableRecord = record.error_code === "sandbox_blocked"
    ? record
    : await persistRecordBestEffort(record, process.env, cfg.env_keys, record.workspace_root ?? record.cwd);
  printLifecycleJson(printableRecord, lifecycleEvents);
  process.exit(record.status === "completed" ? 0 : 1);
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  if (cmd === "approval-grant") return cmdApprovalGrant(rest);
  const options = parseArgs(rest);
  if (cmd === "doctor" || cmd === "ping") return cmdDoctor(options);
  if (cmd === "approval-request") return cmdApprovalRequest(options);
  if (cmd === "run") return cmdRun(options);
  if (cmd === "result") return cmdResult(options);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    let providers;
    try {
      providers = await loadProviders();
    } catch (e) {
      printJson({
        ok: false,
        commands: ["doctor", "ping", "approval-request", "approval-grant", "run", "result"],
        providers: [],
        ...providersConfigErrorFields(e),
      });
      process.exit(1);
    }
    printJson({ ok: true, commands: ["doctor", "ping", "approval-request", "approval-grant", "run", "result"], providers: Object.keys(providers) });
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
