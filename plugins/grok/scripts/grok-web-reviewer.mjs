#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanGitEnv as cleanCanonicalGitEnv } from "./lib/git-env.mjs";
import { GIT_BINARY_ENV, gitEnv, isGitBinaryPolicyError, resolveGitBinary } from "./lib/git-binary.mjs";
import { REVIEW_PROMPT_CONTRACT_VERSION, buildReviewAuditManifest, buildReviewPrompt, scopeResolutionReason } from "./lib/review-prompt.mjs";
import { USAGE_LIMIT_SAFE_MESSAGE, isUsageLimitDetail } from "./lib/usage-limit.mjs";
import { elapsedMs } from "./lib/time.mjs";
import { providerApiCapability, sanitizeTargetEnv } from "./lib/provider-env.mjs";
import { selectProviderRoute } from "./lib/provider-route-policy.mjs";
import { diffSourceFiles } from "./lib/diff-source.mjs";
import { buildExternalModelFailureDiagnostic } from "./lib/external-model-failure-core.mjs";
import { hasSubstantiveInvalidVerdictReason, reviewQualityFailureState } from "./lib/external-model-review-quality.mjs";
import { buildPrivacyRedactor } from "./lib/privacy-redaction.mjs";
import {
  EXTERNAL_REVIEW_KEYS,
  SOURCE_CONTENT_TRANSMISSION,
  sourceContentTransmissionForExecution,
} from "./lib/external-review.mjs";
import { isJwtShapedToken } from "./lib/jwt.mjs";

const VALID_MODES = new Set(["review", "adversarial-review", "custom-review"]);
const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const DEFAULT_GROK2API_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_GROK2API_ADMIN_KEY = "grok2api";
const DEFAULT_MODEL = "grok-4.20-fast";
const DEFAULT_TIMEOUT_MS = 900000;
const DEFAULT_DOCTOR_TIMEOUT_MS = 2000;
const DEFAULT_CHAT_DOCTOR_TIMEOUT_MS = 10000;
const DEFAULT_TUNNEL_START_TIMEOUT_MS = 8000;
const DEFAULT_TUNNEL_CLEANUP_TIMEOUT_MS = 2000;
const DEFAULT_GROK2API_REPO_URL = "https://github.com/chenyme/grok2api.git";
const DEFAULT_CLI_MODEL = "grok-build";
const DEFAULT_CLI_MAX_TURNS = 8;
const GROK_CLI_TIMEOUT_KILL_GRACE_MS = 250;
const TUNNEL_START_POLL_MS = 250;
const GROK2API_UV_BINARY_ENV = "GROK2API_UV_BINARY";
const GROK2API_FIXED_EXEC_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const GROK2API_UV_BINARY_CANDIDATES = Object.freeze([
  "/opt/homebrew/bin/uv",
  "/usr/local/bin/uv",
  "/usr/bin/uv",
  "uv",
]);
const DEFAULT_MAX_PROMPT_CHARS = 400000;
const VALID_TRANSPORTS = new Set(["cli", "web", "auto"]);
const REVIEW_READINESS_PREFLIGHT_HEADER = "x-codex-grok-readiness-preflight";
const REVIEW_READINESS_PREFLIGHT_PROMPT = "Return exactly: ok";
const MAX_SCOPE_FILE_BYTES = 256 * 1024;
const MAX_SCOPE_TOTAL_BYTES = 1024 * 1024;
const GIT_SHOW_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_STATE_JOBS = 50;
const STATE_LOCK_STALE_MS = 60 * 1000;
const SCHEMA_VERSION = 10;
const ACCOUNT_PAYMENT_DIAGNOSTIC_RE = /^(?:stripe-.+|cus_[A-Za-z0-9]{6,}|acct_(?:test_)?[A-Za-z0-9]{5,}|cs_(?:test|live)_[A-Za-z0-9]{6,}|(?:pi|sub|in|ii|ch|seti|setp|price|prod|iv)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,})$/i;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const GROK_SESSION_SYNC_SCRIPT = resolve(SCRIPT_DIR, "grok-sync-browser-session.mjs");
const SCOPE_FILE_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const GROK_EXPECTED_KEYS = Object.freeze([
  "id",
  "job_id",
  "target",
  "provider",
  "fallback_from",
  "transport",
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
  if (obj.status !== "completed" && obj.runtime_diagnostics !== undefined) {
    projection.runtime_diagnostics = obj.runtime_diagnostics;
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
  throw new Error("bad_args: --lifecycle-events must be jsonl or markdown");
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

function normalizeBaseUrl(value) {
  let url = String(value || DEFAULT_BASE_URL);
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function normalizeGrok2ApiBaseUrl(value, tunnelBaseUrl = DEFAULT_BASE_URL) {
  const fallback = normalizeBaseUrl(tunnelBaseUrl).replace(/\/(?:(?:api\/)?v1|api)$/, "");
  let url = String(value || fallback || DEFAULT_GROK2API_BASE_URL);
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function transportMode(options = {}, env = process.env) {
  const raw = String(options.transport ?? env.GROK_TRANSPORT ?? "cli").trim().toLowerCase();
  const normalized = raw === "legacy" || raw === "tunnel" || raw === "grok-web" ? "web" : raw;
  if (!VALID_TRANSPORTS.has(normalized)) {
    throw new Error(`bad_args: unsupported Grok transport ${JSON.stringify(raw)}; use cli, web, or auto`);
  }
  return normalized;
}

function cliConfig(env = process.env, options = {}) {
  const timeoutMs = parsePositiveIntegerEnv(env, "GROK_CLI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const maxPromptChars = parsePositiveIntegerEnv(env, "GROK_CLI_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS, "character count");
  const maxTurns = parsePositiveIntegerEnv(env, "GROK_CLI_MAX_TURNS", DEFAULT_CLI_MAX_TURNS, "turn count");
  return {
    provider: "grok",
    display_name: "Grok CLI",
    auth_mode: "subscription_cli",
    transport: "cli",
    requested_transport: options.requestedTransport ?? "cli",
    fallback_from: options.fallbackFrom ?? null,
    fallback_reason: options.fallbackReason ?? null,
    binary: env.GROK_CLI_BINARY || "grok",
    base_url: null,
    model: env.GROK_CLI_MODEL || DEFAULT_CLI_MODEL,
    timeout_ms: timeoutMs,
    max_prompt_chars: maxPromptChars,
    max_turns: maxTurns,
    credential_ref: null,
    credential_value: null,
    api_capability: providerApiCapability("grok"),
  };
}

function pathExistsExecutable(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(binary, env = process.env) {
  const pathValue = String(env.PATH ?? "");
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(dir, binary);
    if (pathExistsExecutable(candidate)) return candidate;
  }
  return null;
}

function pathIsInsideOrEqual(candidate, parent) {
  if (!candidate || !parent) return false;
  const rel = relative(parent, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function pathHasNodeModulesBin(candidate) {
  const parts = String(candidate ?? "").split(/[\\/]+/u);
  return parts.some((part, index) => part === "node_modules" && parts[index + 1] === ".bin");
}

function trustedGrokCliBinaryPath(binary, { cwd = process.cwd(), workspaceRoot = bestEffortWorkspaceRoot(cwd), env = process.env } = {}) {
  const raw = String(binary ?? "").trim();
  if (!raw) {
    const error = new Error("Grok CLI binary is empty.");
    error.code = "grok_cli_untrusted_binary";
    throw error;
  }
  const hasPathSeparator = /[\\/]/u.test(raw);
  const candidate = isAbsolute(raw)
    ? raw
    : (hasPathSeparator ? resolve(cwd, raw) : findExecutableOnPath(raw, env));
  if (!candidate) return raw;
  let realCandidate = candidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return candidate;
  }
  const realWorkspaceRoot = (() => {
    try {
      return realpathSync(workspaceRoot);
    } catch {
      return resolve(workspaceRoot);
    }
  })();
  if (pathIsInsideOrEqual(realCandidate, realWorkspaceRoot) || pathHasNodeModulesBin(realCandidate)) {
    const error = new Error(`Grok CLI binary is not trusted: ${realCandidate}`);
    error.code = "grok_cli_untrusted_binary";
    throw error;
  }
  return realCandidate;
}

function resolveTrustedGrokCliConfig(cfg, { cwd = process.cwd(), workspaceRoot = bestEffortWorkspaceRoot(cwd), env = process.env } = {}) {
  if (cfg.transport !== "cli") return cfg;
  return {
    ...cfg,
    binary: trustedGrokCliBinaryPath(cfg.binary, { cwd, workspaceRoot, env }),
    trusted_workspace_root: workspaceRoot,
  };
}

function webConfig(env = process.env, options = {}) {
  const timeoutMs = parsePositiveIntegerEnv(env, "GROK_WEB_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const doctorTimeoutMs = parsePositiveIntegerEnv(env, "GROK_WEB_DOCTOR_TIMEOUT_MS", DEFAULT_DOCTOR_TIMEOUT_MS);
  const chatDoctorTimeoutMs = parsePositiveIntegerEnv(env, "GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS", DEFAULT_CHAT_DOCTOR_TIMEOUT_MS);
  const tunnelStartTimeoutMs = parsePositiveIntegerEnv(env, "GROK_WEB_TUNNEL_START_TIMEOUT_MS", DEFAULT_TUNNEL_START_TIMEOUT_MS);
  const tunnelCleanupTimeoutMs = parsePositiveIntegerEnv(env, "GROK_WEB_TUNNEL_CLEANUP_TIMEOUT_MS", DEFAULT_TUNNEL_CLEANUP_TIMEOUT_MS);
  const maxPromptChars = parsePositiveIntegerEnv(env, "GROK_WEB_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS, "character count");
  return {
    provider: "grok-web",
    display_name: "Grok Web",
    auth_mode: "subscription_web",
    transport: "web",
    requested_transport: options.requestedTransport ?? "web",
    fallback_from: options.fallbackFrom ?? null,
    fallback_reason: options.fallbackReason ?? null,
    base_url: normalizeBaseUrl(env.GROK_WEB_BASE_URL),
    model: env.GROK_WEB_MODEL || DEFAULT_MODEL,
    timeout_ms: timeoutMs,
    doctor_timeout_ms: doctorTimeoutMs,
    chat_doctor_timeout_ms: chatDoctorTimeoutMs,
    tunnel_start_timeout_ms: tunnelStartTimeoutMs,
    tunnel_cleanup_timeout_ms: tunnelCleanupTimeoutMs,
    max_prompt_chars: maxPromptChars,
    credential_ref: env.GROK_WEB_TUNNEL_API_KEY ? "GROK_WEB_TUNNEL_API_KEY" : null,
    credential_value: env.GROK_WEB_TUNNEL_API_KEY || null,
    grok2api_base_url: normalizeGrok2ApiBaseUrl(env.GROK2API_BASE_URL, env.GROK_WEB_BASE_URL),
    grok2api_admin_key: env.GROK2API_ADMIN_KEY || DEFAULT_GROK2API_ADMIN_KEY,
    api_capability: providerApiCapability("grok"),
  };
}

function config(env = process.env, options = {}) {
  const transport = transportMode(options, env);
  if (transport === "cli") return cliConfig(env, { requestedTransport: "cli" });
  if (transport === "auto") return cliConfig(env, { requestedTransport: "auto" });
  return webConfig(env, { requestedTransport: "web" });
}

function fallbackConfig(env = process.env, options = {}) {
  const transport = transportMode(options, env);
  if (transport === "cli" || transport === "auto") return cliConfig(env, { requestedTransport: transport });
  return {
    provider: "grok-web",
    display_name: "Grok Web",
    auth_mode: "subscription_web",
    transport: "web",
    requested_transport: "web",
    fallback_from: null,
    fallback_reason: null,
    base_url: normalizeBaseUrl(env.GROK_WEB_BASE_URL),
    model: env.GROK_WEB_MODEL || DEFAULT_MODEL,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    doctor_timeout_ms: DEFAULT_DOCTOR_TIMEOUT_MS,
    chat_doctor_timeout_ms: DEFAULT_CHAT_DOCTOR_TIMEOUT_MS,
    tunnel_start_timeout_ms: DEFAULT_TUNNEL_START_TIMEOUT_MS,
    tunnel_cleanup_timeout_ms: DEFAULT_TUNNEL_CLEANUP_TIMEOUT_MS,
    max_prompt_chars: DEFAULT_MAX_PROMPT_CHARS,
    credential_ref: env.GROK_WEB_TUNNEL_API_KEY ? "GROK_WEB_TUNNEL_API_KEY" : null,
    credential_value: env.GROK_WEB_TUNNEL_API_KEY || null,
    api_capability: providerApiCapability("grok"),
  };
}

function webAutoFallbackConfig(env = process.env, reason = null) {
  return webConfig(env, {
    requestedTransport: "auto",
    fallbackFrom: "cli",
    fallbackReason: reason,
  });
}

function parsePositiveIntegerEnv(env, name, fallback, unit = "number of milliseconds") {
  const value = env[name];
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`bad_args: ${name} must be a positive integer ${unit}; got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function envFlagEnabled(env, name, fallback = true) {
  const value = env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(?:0|false|no|off)$/i.test(String(value).trim());
}

function isLoopbackHost(hostnameValue) {
  const host = String(hostnameValue || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function grok2ApiStartTarget(cfg) {
  let baseUrl;
  let apiUrl;
  try {
    baseUrl = new URL(cfg.grok2api_base_url);
    apiUrl = new URL(cfg.base_url);
  } catch {
    return { ok: false, error_code: "grok2api_endpoint_invalid", reason: "GROK_WEB_BASE_URL or GROK2API_BASE_URL is not a valid URL." };
  }
  if (baseUrl.protocol !== "http:" || apiUrl.protocol !== "http:") {
    return { ok: false, error_code: "grok2api_endpoint_not_local_http", reason: "automatic tunnel start is limited to local http endpoints." };
  }
  if (!isLoopbackHost(baseUrl.hostname) || !isLoopbackHost(apiUrl.hostname)) {
    return { ok: false, error_code: "grok2api_endpoint_not_loopback", reason: "automatic tunnel start is limited to loopback endpoints." };
  }
  if (apiUrl.pathname !== "/v1") {
    return { ok: false, error_code: "grok2api_endpoint_not_grok2api", reason: "automatic tunnel start only supports grok2api-style /v1 endpoints." };
  }
  const port = Number(baseUrl.port || "80");
  if (!Number.isSafeInteger(port) || port <= 1024 || port > 65535) {
    return { ok: false, error_code: "grok2api_port_unsupported", reason: "automatic tunnel start requires an unprivileged loopback port." };
  }
  return {
    ok: true,
    host: baseUrl.hostname === "::1" || baseUrl.hostname === "[::1]" ? "::1" : baseUrl.hostname,
    port,
    base_url: cfg.grok2api_base_url,
  };
}

function grok2ApiHomeCandidates(env = process.env) {
  const candidates = [];
  if (env.GROK2API_HOME) return [{ path: resolve(env.GROK2API_HOME), source: "GROK2API_HOME" }];
  if (env.GROK2API_BOOTSTRAP_DIR) {
    return [{ path: resolve(env.GROK2API_BOOTSTRAP_DIR), source: "GROK2API_BOOTSTRAP_DIR" }];
  }
  candidates.push({ path: defaultGrok2ApiBootstrapDir(env), source: "default_bootstrap_dir" });
  const home = homedir();
  for (const rel of [
    "grok2api",
    join("Projects", "grok2api"),
    join("Projects", "Claude", "grok2api"),
    join("Developer", "grok2api"),
    join("Code", "grok2api"),
    join("src", "grok2api"),
  ]) {
    candidates.push({ path: resolve(home, rel), source: "well_known_path" });
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function defaultGrok2ApiBootstrapDir(env = process.env) {
  return resolve(env.GROK2API_BOOTSTRAP_DIR || join(defaultManagedRuntimeDir(env), "grok2api"));
}

function defaultManagedRuntimeDir(env = process.env) {
  return resolve(env.CODEX_PLUGIN_MULTI_RUNTIME_DIR || join(homedir(), ".codex-plugin-multi", "runtime"));
}

function legacyTmpGrok2ApiBootstrapDir(env = process.env) {
  return resolve(join(env.TMPDIR || tmpdir(), "codex-plugin-multi", "runtime", "grok2api"));
}

function defaultGrok2ApiUvCacheDir() {
  return resolve(join(tmpdir(), "codex-plugin-multi", "runtime", "uv-cache"));
}

async function isDirectory(pathValue) {
  try {
    return (await stat(pathValue)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(pathValue) {
  try {
    return (await stat(pathValue)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(pathValue) {
  try {
    await stat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeGrok2ApiHome(pathValue) {
  return await isDirectory(pathValue)
    && await isFile(resolve(pathValue, "app", "main.py"))
    && (await isFile(resolve(pathValue, "pyproject.toml")) || await isFile(resolve(pathValue, "uv.lock")));
}

async function resolveGrok2ApiHome(env = process.env) {
  const candidates = grok2ApiHomeCandidates(env);
  for (const candidate of candidates) {
    if (await looksLikeGrok2ApiHome(candidate.path)) {
      return {
        ok: true,
        path: candidate.path,
        source: candidate.source,
        checked_candidate_count: candidates.length,
      };
    }
    if (candidate.source === "GROK2API_HOME" && await isDirectory(candidate.path)) {
      return {
        ok: false,
        error_code: "grok2api_home_invalid",
        error_message: "GROK2API_HOME exists but does not look like a grok2api checkout with app/main.py and pyproject.toml or uv.lock.",
        source: candidate.source,
        path: candidate.path,
        checked_candidate_count: candidates.length,
      };
    }
  }
  return {
    ok: false,
    error_code: "grok2api_home_missing",
    error_message: "No local grok2api checkout was found. Set GROK2API_HOME to a chenyme/grok2api checkout; Docker is not required.",
    checked_candidate_count: candidates.length,
  };
}

function bootstrapTarget(env = process.env) {
  if (env.GROK2API_HOME) return { path: resolve(env.GROK2API_HOME), source: "GROK2API_HOME" };
  if (env.GROK2API_BOOTSTRAP_DIR) {
    return { path: resolve(env.GROK2API_BOOTSTRAP_DIR), source: "GROK2API_BOOTSTRAP_DIR" };
  }
  return { path: defaultGrok2ApiBootstrapDir(env), source: "default_bootstrap_dir" };
}

function safeGrok2ApiRepoUrl(env = process.env) {
  const value = env.GROK2API_REPO_URL || DEFAULT_GROK2API_REPO_URL;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error_code: "grok2api_bootstrap_url_invalid", message: "GROK2API_REPO_URL is not a valid URL." };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return {
      ok: false,
      error_code: "grok2api_bootstrap_url_invalid",
      message: "GROK2API_REPO_URL must be an https URL without embedded credentials.",
    };
  }
  return { ok: true, url: parsed.toString() };
}

function shortCommandOutput(result, env = process.env) {
  const redact = redactor(env);
  const text = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  if (!text) return null;
  const safe = redact(text).replace(/\s+/g, " ").trim();
  return safe.length > 240 ? `${safe.slice(0, 240)}...` : safe;
}

async function maybeBootstrapGrok2ApiHome(env = process.env) {
  const enabled = envFlagEnabled(env, "GROK_WEB_TUNNEL_AUTO_BOOTSTRAP", true);
  if (!enabled) {
    return {
      ok: false,
      status: "not_configured",
      attempted: false,
      error_code: "grok2api_auto_bootstrap_disabled",
      message: "GROK_WEB_TUNNEL_AUTO_BOOTSTRAP disabled missing-checkout bootstrap.",
    };
  }
  const repoUrl = safeGrok2ApiRepoUrl(env);
  if (!repoUrl.ok) {
    return {
      ok: false,
      status: "blocked",
      attempted: false,
      error_code: repoUrl.error_code,
      message: repoUrl.message,
    };
  }
  const target = bootstrapTarget(env);
  if (await pathExists(target.path)) {
    return {
      ok: false,
      status: "blocked",
      attempted: false,
      error_code: "grok2api_bootstrap_dir_invalid",
      message: "The configured grok2api bootstrap directory already exists but is not a valid grok2api checkout.",
      home_source: target.source,
      home_path: target.path,
    };
  }

  let gitBinary;
  try {
    gitBinary = resolveGitBinary({ cwd: process.cwd(), env });
  } catch (error) {
    return {
      ok: false,
      status: "blocked",
      attempted: false,
      error_code: "grok2api_git_unavailable",
      message: `Cannot bootstrap grok2api because Git is unavailable or rejected: ${error?.message ?? String(error)}`,
      home_source: target.source,
      home_path: target.path,
    };
  }

  try {
    await mkdir(dirname(target.path), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      attempted: true,
      error_code: "grok2api_bootstrap_failed",
      message: `Failed to create grok2api bootstrap parent directory: ${error?.message ?? String(error)}`,
      home_source: target.source,
      home_path: target.path,
    };
  }

  const clonePath = `${target.path}.clone-${process.pid}-${randomUUID()}`;
  const result = spawnSync(gitBinary, ["clone", "--depth", "1", repoUrl.url, clonePath], {
    env: gitEnv(env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    try { await rm(clonePath, { recursive: true, force: true }); } catch { /* best-effort failed clone cleanup */ }
    return {
      ok: false,
      status: "failed",
      attempted: true,
      error_code: "grok2api_bootstrap_failed",
      message: "Failed to clone grok2api for local tunnel bootstrap.",
      detail: shortCommandOutput(result, env),
      home_source: target.source,
      home_path: target.path,
    };
  }
  if (!await looksLikeGrok2ApiHome(clonePath)) {
    try { await rm(clonePath, { recursive: true, force: true }); } catch { /* best-effort invalid clone cleanup */ }
    return {
      ok: false,
      status: "failed",
      attempted: true,
      error_code: "grok2api_bootstrap_invalid",
      message: "The cloned grok2api checkout does not contain app/main.py and pyproject.toml or uv.lock.",
      home_source: target.source,
      home_path: target.path,
    };
  }
  try {
    await rename(clonePath, target.path);
  } catch (error) {
    try { await rm(clonePath, { recursive: true, force: true }); } catch { /* best-effort failed rename cleanup */ }
    return {
      ok: false,
      status: "failed",
      attempted: true,
      error_code: "grok2api_bootstrap_failed",
      message: `Failed to finalize grok2api bootstrap checkout: ${error?.message ?? String(error)}`,
      home_source: target.source,
      home_path: target.path,
    };
  }
  return {
    ok: true,
    status: "bootstrapped",
    attempted: true,
    error_code: null,
    message: "Bootstrapped local grok2api checkout without Docker.",
    path: target.path,
    source: target.source,
    home_path: target.path,
    home_source: target.source,
  };
}

function uvExecutionEnv(env = process.env) {
  return {
    ...env,
    PATH: GROK2API_FIXED_EXEC_PATH,
    // Empty UV_CACHE_DIR is treated as unset; see the doctor auto-start smoke coverage.
    UV_CACHE_DIR: env.UV_CACHE_DIR || defaultGrok2ApiUvCacheDir(),
  };
}

function uvBinaryCandidates(env = process.env) {
  const configured = env[GROK2API_UV_BINARY_ENV];
  if (!configured) {
    return {
      ok: true,
      candidates: GROK2API_UV_BINARY_CANDIDATES.map((command) => ({
        command,
        source: isAbsolute(command) ? "fixed_candidate" : "fixed_path",
      })),
    };
  }
  if (!isAbsolute(configured)) {
    return {
      ok: false,
      error_code: "grok2api_uv_binary_invalid",
      message: `${GROK2API_UV_BINARY_ENV} must be an absolute path.`,
    };
  }
  return {
    ok: true,
    candidates: [{ command: configured, source: GROK2API_UV_BINARY_ENV }],
  };
}

function uvAvailable(cwd, command, env = process.env) {
  const result = spawnSync(command, ["--version"], {
    cwd,
    env: uvExecutionEnv(env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function findUvBinary(cwd, env = process.env) {
  const candidates = uvBinaryCandidates(env);
  if (!candidates.ok) return candidates;
  for (const candidate of candidates.candidates) {
    if (uvAvailable(cwd, candidate.command, env)) {
      return { ok: true, ...candidate };
    }
  }
  return {
    ok: false,
    error_code: "grok2api_uv_missing",
    message: `uv is required to start grok2api without Docker, but no fixed uv candidate worked. Set ${GROK2API_UV_BINARY_ENV} to an absolute uv path if uv is installed elsewhere.`,
  };
}

function tunnelStartCommand(target, uvBinary) {
  return [
    uvBinary,
    "run",
    "granian",
    "--interface",
    "asgi",
    "--host",
    target.host,
    "--port",
    String(target.port),
    "--workers",
    "1",
    "app.main:app",
  ];
}

function redactor(env = process.env) {
  return buildPrivacyRedactor({ env }).text;
}

function cleanGitEnv(baseEnv = process.env) {
  const out = cleanCanonicalGitEnv(baseEnv);
  for (const key of Object.keys(out)) {
    if (
      /^(?:GROK|XAI)_/u.test(key) ||
      /(?:API_KEY|TOKEN|COOKIE|SESSION|SSO)/iu.test(key)
    ) {
      delete out[key];
    }
  }
  return out;
}

function redactValue(value, redact) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, redactValue(entryValue, redact)]));
  }
  return value;
}

function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
    shell: false,
    windowsHide: true,
  });
  return {
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

function gitCommitForPrompt(cwd, ref, workspaceRoot = null) {
  if (!ref) return null;
  try {
    return git(["rev-parse", "--verify", `${ref}^{commit}`], cwd, { allowFailure: true, workspaceRoot }) || null;
  } catch (error) {
    if (isGitBinaryPolicyError(error)) throw error;
    return null;
  }
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
      if (remaining <= 0) {
        throw new Error(`scope_file_too_large:${normalizedRel}: exceeds ${MAX_SCOPE_FILE_BYTES} byte limit`);
      }
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

function fileContentDelimiter(file, index) {
  let delimiter = `GROK FILE ${index}: ${file.path}`;
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

function repositoryIdentity(cwd, workspaceRoot) {
  const remote = git(["remote", "get-url", "origin"], cwd, { allowFailure: true, workspaceRoot });
  if (!remote) return workspaceRoot;
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return match ? match[1] : remote;
}

function promptFor(cfg, mode, userPrompt, scopeInfo) {
  const modeLine = mode === "adversarial-review"
    ? "You are performing an adversarial code review. Prioritize correctness bugs, security risks, regressions, and missing tests."
    : "You are performing a code review. Prioritize bugs, behavioral regressions, and missing tests.";
  const files = scopeInfo.files.map((file, index) => promptFileBlock(file, index + 1)).join("\n\n");
  const transportLine = cfg.transport === "cli"
    ? "This request is routed through the subscription-backed Grok CLI, not paid xAI API billing."
    : "This request is routed through a local subscription-backed Grok web tunnel, not paid xAI API billing.";
  return buildReviewPrompt({
    provider: cfg.display_name,
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
      transportLine,
      `Selected files:\n${files}`,
    ],
  });
}

function hasPromptText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function promptHead(value) {
  return hasPromptText(value) ? value.slice(0, 200) : "";
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function trimText(value) {
  return String(value ?? "").trim();
}

function firstLine(value) {
  return trimText(value).split(/\r?\n/, 1)[0] ?? "";
}

function grokCliCommandError(command, result, redact = redactor()) {
  if (result.error) return redact(result.error.message ?? String(result.error));
  const stderr = trimText(result.stderr);
  const stdout = trimText(result.stdout);
  return redact(stderr || stdout || `${command} exited ${result.status ?? "unknown"}`);
}

const GROK_CLI_SAFE_ENV_KEYS = new Set([
  "CI",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "TERM",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
]);

function isProxyEnvKey(key) {
  return String(key ?? "").toUpperCase().endsWith("_PROXY");
}

function isGrokCliSensitiveEnvKey(key) {
  const upper = String(key ?? "").toUpperCase();
  return (
    upper.endsWith("_API_KEY") ||
    /(?:^|_)(?:TOKEN|COOKIE|SESSION|SSO|SECRET|ACCESS_KEY|PRIVATE_KEY|PASSWORD|CREDENTIALS?)(?:_|$)/u.test(upper)
  );
}

function safeGrokCliPath(pathValue, { cwd = process.cwd(), workspaceRoot = null } = {}) {
  const entries = [];
  const seen = new Set();
  const realWorkspaceRoot = workspaceRoot
    ? (() => {
        try {
          return realpathSync(workspaceRoot);
        } catch {
          return resolve(workspaceRoot);
        }
      })()
    : null;
  for (const rawEntry of String(pathValue ?? "").split(delimiter)) {
    if (!rawEntry) continue;
    const candidate = isAbsolute(rawEntry) ? rawEntry : resolve(cwd, rawEntry);
    let realCandidate = candidate;
    try {
      realCandidate = realpathSync(candidate);
    } catch {
      // Nonexistent PATH entries are not useful for the reviewer process.
      continue;
    }
    if (pathHasNodeModulesBin(realCandidate)) continue;
    if (realWorkspaceRoot && pathIsInsideOrEqual(realCandidate, realWorkspaceRoot)) continue;
    if (seen.has(realCandidate)) continue;
    seen.add(realCandidate);
    entries.push(realCandidate);
  }
  return entries.length > 0 ? entries.join(delimiter) : GROK2API_FIXED_EXEC_PATH;
}

function commandEnv(extraEnv = {}, parentEnv = process.env, options = {}) {
  const sanitizedParent = sanitizeTargetEnv(parentEnv);
  const env = {};
  for (const [key, value] of Object.entries(sanitizedParent)) {
    if (value == null) continue;
    if (key === "PATH") continue;
    if (!GROK_CLI_SAFE_ENV_KEYS.has(key) && !isProxyEnvKey(key)) continue;
    if (isGrokCliSensitiveEnvKey(key)) continue;
    env[key] = String(value);
  }
  env.PATH = safeGrokCliPath(parentEnv.PATH, options);
  const home = extraEnv.GROK_HOME ?? grokCliAuthHome(parentEnv);
  if (home) {
    env.HOME = String(home);
    env.GROK_HOME = String(home);
  }
  env.NO_COLOR = "1";
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value == null) {
      delete env[key];
    } else if (key === "PATH") {
      env.PATH = safeGrokCliPath(value, options);
    } else if (!isGrokCliSensitiveEnvKey(key)) {
      env[key] = String(value);
    }
  }
  for (const key of Object.keys(env)) {
    if (isGrokCliSensitiveEnvKey(key)) {
      delete env[key];
    } else {
      env[key] = String(env[key]);
    }
  }
  return env;
}

function runGrokCliCommand(cfg, args, { cwd = process.cwd(), timeoutMs = cfg.timeout_ms, env = {} } = {}) {
  const workspaceRoot = cfg.trusted_workspace_root ?? bestEffortWorkspaceRoot(cwd);
  return spawnSync(cfg.binary, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: commandEnv(env, process.env, { cwd, workspaceRoot }),
  });
}

function runGrokCliCommandAsync(cfg, args, { cwd = process.cwd(), timeoutMs = cfg.timeout_ms, env = {} } = {}) {
  const workspaceRoot = cfg.trusted_workspace_root ?? bestEffortWorkspaceRoot(cwd);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cfg.binary, args, {
        cwd,
        env: commandEnv(env, process.env, { cwd, workspaceRoot }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        status: 1,
        signal: null,
        stdout: "",
        stderr: "",
        error,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutError = null;
    let settled = false;
    let killTimer = null;
    const timer = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          timeoutError = Object.assign(new Error(`grok CLI timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" });
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, GROK_CLI_TIMEOUT_KILL_GRACE_MS);
          killTimer.unref?.();
        }, timeoutMs)
      : null;
    timer?.unref?.();

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      settle({
        status: 1,
        signal: null,
        stdout,
        stderr,
        error,
      });
    });
    child.once("close", (status, signal) => {
      settle({
        status: status ?? (signal || timedOut ? 1 : 0),
        signal: signal ?? null,
        stdout,
        stderr,
        error: timeoutError,
      });
    });
  });
}

function parseGrokCliModels(stdout, cfg) {
  const text = trimText(stdout);
  return {
    logged_in: /logged in with grok\.com/i.test(text),
    default_model: /Default model:[^\S\r\n]*([^\r\n]+)/i.exec(text)?.[1]?.trim() ?? null,
    model_ready: new RegExp(`\\b${cfg.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
    raw_head: text.slice(0, 500),
  };
}

function isGrokCliLoginRequired(modelsInfo) {
  return modelsInfo?.logged_in !== true;
}

function isGrokCliAuthPromptFailure(stderr) {
  const text = String(stderr ?? "");
  return /failed to get default browser|open this url to sign in|login timed out|auth:\s*timed out|OSStatus error -10661/i.test(text);
}

function grokCliAuthHttpStatus(stderr) {
  const text = String(stderr ?? "");
  if (/\b401\s+Unauthorized\b/i.test(text)) return 401;
  if (/\b403\s+Forbidden\b/i.test(text)) return 403;
  const match = text.match(/(?:http_status["'\s:=]+|status["'\s:=]+)(401|403)\b/i);
  return match ? Number(match[1]) : null;
}

function isGrokCliAuthRepairCode(errorCode) {
  return errorCode === "grok_cli_login_required"
    || errorCode === "grok_cli_auth_timeout"
    || errorCode === "grok_cli_auth_unavailable";
}

function providerCapabilitiesForConfig(cfg) {
  const capabilities = {
    subscription: { kind: cfg.transport, auth_path: cfg.auth_mode },
  };
  if (cfg.api_capability) capabilities.api = cfg.api_capability;
  return capabilities;
}

function modeSendsSelectedSource(mode) {
  return VALID_MODES.has(mode);
}

const LARGE_SOURCE_PACKET_FLAG = "--allow-large-source-packet";

function sourcePacketOverrideRouteFields(options = {}) {
  const approved = options["allow-large-source-packet"] === true;
  return {
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

function sourcePacketPolicyPreflight({ cfg, mode, prompt, scopeInfo, options = {} }) {
  const providerCapabilities = providerCapabilitiesForConfig(cfg);
  const sourceBearing = modeSendsSelectedSource(mode);
  const route = selectProviderRoute({
    requestedRoute: "subscription",
    providerCapabilities,
    sourceBearing,
  });
  const auditManifest = buildReviewAuditManifest({
    prompt,
    sourceFiles: scopeInfo.files ?? [],
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
      timeoutMs: cfg.timeout_ms ?? null,
      maxTokens: null,
      temperature: null,
      stream: false,
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
      selectedRoute: route.selected_route,
      routeStep: route.route_step,
      routeSteps: route.route_steps,
      fallbackReason: cfg.fallback_reason ?? route.fallback_reason,
      approvalScope: null,
      authPath: route.auth_path,
      billingPath: route.billing_path,
      sourceBearing,
      sourceContentTransmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
      sourceSendApprovalRequired: route.source_send_approval_required,
      sourceSendApprovalState: route.source_send_approval_state,
      providerCapabilities,
      reviewSlot: reviewSlotRouteFields(options, {
        priorAttempts: options.reviewSlotPriorAttempts ?? [],
      }),
      ...sourcePacketOverrideRouteFields(options),
    },
    status: "preflight_failed",
    errorCode: "source_packet_policy_preflight",
  });
  const policy = auditManifest.source_packet_policy ?? null;
  if (!policy || policy.source_send_allowed !== false) return null;
  const errorCode = policy.source_packet_policy_error_code ?? "source_packet_policy_blocked";
  const execution = providerFailureWithDiagnostic(
    errorCode,
    `${errorCode}: ${policy.suggested_action ?? "source packet policy blocked selected source send"}`,
    null,
    null,
    false,
    { source_packet_policy: policy },
  );
  execution.prompt = prompt;
  return execution;
}

function subscriptionRouteForConfig(cfg, env = process.env, sourceBearing = false) {
  return selectProviderRoute({
    requestedRoute: "subscription",
    providerCapabilities: providerCapabilitiesForConfig(cfg),
    env,
    sourceBearing,
  });
}

function ignoredGrokDirectApiEnvKeys(cfg, env = process.env) {
  return subscriptionRouteForConfig(cfg, env, false).ignored_env_credentials ?? [];
}

function ignoredGrokDirectApiEnvMessage(cfg, env = process.env, ignoredKeys = ignoredGrokDirectApiEnvKeys(cfg, env)) {
  if (ignoredKeys.length === 0) return "";
  return " Direct API env variables are present and ignored by subscription_cli mode; they do not prove Grok subscription CLI login.";
}

function grokCliLoginRequiredMessage(cfg, env = process.env) {
  const ignoredKeys = ignoredGrokDirectApiEnvKeys(cfg, env);
  const ignored = ignoredGrokDirectApiEnvMessage(cfg, env, ignoredKeys);
  return `Grok CLI model list is reachable, but the CLI is not logged in.${ignored} Run \`grok login --device-auth\` or \`grok login --oauth\` in a normal terminal, ensure \`grok models\` reports a logged-in account and lists the configured model, then retry.`;
}

function grokCliAuthHome(env = process.env) {
  return resolve(env.GROK_CLI_AUTH_HOME || env.GROK_HOME || join(homedir(), ".grok"));
}

async function copyGrokCliHomeFile(sourceHome, runtimeHome, relPath, copiedFiles) {
  const source = resolve(sourceHome, relPath);
  const destination = resolve(runtimeHome, relPath);
  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) return;
  await copyFile(source, destination);
  copiedFiles.push(relPath);
}

async function prepareGrokCliRuntimeHome(env = process.env) {
  const sourceHome = grokCliAuthHome(env);
  const runtimeHome = resolve(tmpdir(), `grok-cli-home-${randomUUID()}`);
  await mkdir(runtimeHome, { mode: 0o700 });
  const copiedFiles = [];
  try {
    for (const relPath of ["auth.json", "config.toml", "pager.toml"]) {
      await copyGrokCliHomeFile(sourceHome, runtimeHome, relPath, copiedFiles);
    }
  } catch (error) {
    try {
      await rm(runtimeHome, { recursive: true, force: true });
    } catch {
      // Preserve the source copy error; cleanup failure is reported by source-bearing run cleanup.
    }
    throw error;
  }
  return {
    dir: runtimeHome,
    source_home: sourceHome,
    copied_files: copiedFiles,
    linked_files: [],
  };
}

async function cleanupGrokCliRuntimeHome(runtimeHome) {
  if (!runtimeHome?.dir) return "not_created";
  try {
    await rm(runtimeHome.dir, { recursive: true, force: true });
  } catch {
    return "unverified";
  }
  return await pathExists(runtimeHome.dir) ? "unverified" : "deleted";
}

async function writePrivatePromptFile(contents) {
  const dir = resolve(tmpdir(), `grok-cli-prompt-${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  const file = resolve(dir, "prompt.txt");
  await writeFile(file, contents, { mode: 0o600 });
  return { dir, file };
}

async function cleanupPromptFile(file, dir) {
  let fileDeleted = false;
  let dirDeleted = false;
  try {
    await unlink(file);
    fileDeleted = true;
  } catch (error) {
    if (error?.code === "ENOENT") fileDeleted = true;
  }
  try {
    await rmdir(dir);
    dirDeleted = true;
  } catch (error) {
    if (error?.code === "ENOENT") dirDeleted = true;
  }
  if (fileDeleted && dirDeleted) return "deleted";
  if (fileDeleted) return "file_deleted";
  return "unverified";
}

function parseGrokCliOutput(stdout) {
  const text = trimText(stdout);
  const parsed = parseJson(text);
  if (parsed.ok && parsed.value && typeof parsed.value === "object") {
    const result = parsed.value.text ?? parsed.value.result ?? parsed.value.output;
    if (typeof result === "string" && result.trim()) {
      return {
        ok: true,
        result,
        raw_model: typeof parsed.value.model === "string" ? parsed.value.model : null,
        usage: parsed.value.usage ?? null,
        parse_mode: "json",
      };
    }
    return { ok: false, reason: "grok_cli_parse_failed", error: "Grok CLI JSON output did not include text/result/output." };
  }
  if (text) {
    return {
      ok: true,
      result: text,
      raw_model: null,
      usage: null,
      parse_mode: "plain",
    };
  }
  return { ok: false, reason: "grok_cli_parse_failed", error: "Grok CLI returned empty output." };
}

async function grokCliReadinessPreflight(cfg, env = process.env) {
  const redact = redactor();
  const version = runGrokCliCommand(cfg, ["--version"], { timeoutMs: Math.min(cfg.timeout_ms, 10000) });
  if (version.error || version.status !== 0) {
    return providerFailureWithDiagnostic(
      "grok_cli_unavailable",
      grokCliCommandError("grok --version", version, redact),
      null,
      null,
      false,
      {
        transport: "cli",
        grok_version: null,
        model: cfg.model,
        configured_timeout_ms: cfg.timeout_ms,
      },
    );
  }
  const versionText = firstLine(version.stdout);

  const models = runGrokCliCommand(cfg, ["models"], { timeoutMs: Math.min(cfg.timeout_ms, 15000) });
  if (models.error || models.status !== 0) {
    return providerFailureWithDiagnostic(
      "grok_cli_auth_unavailable",
      grokCliCommandError("grok models", models, redact),
      null,
      null,
      false,
      {
        transport: "cli",
        grok_version: versionText,
        model: cfg.model,
        configured_timeout_ms: cfg.timeout_ms,
      },
    );
  }
  const modelsInfo = parseGrokCliModels(models.stdout, cfg);
  if (isGrokCliLoginRequired(modelsInfo)) {
    const ignoredEnvCredentials = ignoredGrokDirectApiEnvKeys(cfg, env);
    return providerFailureWithDiagnostic(
      "grok_cli_login_required",
      grokCliLoginRequiredMessage(cfg, env),
      null,
      null,
      false,
      {
        transport: "cli",
        grok_version: versionText,
        model: cfg.model,
        default_model: modelsInfo.default_model,
        logged_in: false,
        model_ready: modelsInfo.model_ready,
        configured_timeout_ms: cfg.timeout_ms,
        ignored_env_credentials: ignoredEnvCredentials,
        auth_policy: ignoredEnvCredentials.length > 0 ? "api_key_env_ignored" : null,
      },
    );
  }
  if (!modelsInfo.model_ready) {
    return providerFailureWithDiagnostic(
      "grok_cli_model_unavailable",
      `Grok CLI default model ${JSON.stringify(cfg.model)} was not listed by grok models.`,
      null,
      null,
      false,
      {
        transport: "cli",
        grok_version: versionText,
        model: cfg.model,
        default_model: modelsInfo.default_model,
        logged_in: modelsInfo.logged_in,
        model_ready: false,
        configured_timeout_ms: cfg.timeout_ms,
      },
    );
  }

  const sourceFree = await callGrokCli(cfg, REVIEW_READINESS_PREFLIGHT_PROMPT, {
    sourceBearing: false,
    env,
    baseDiagnostics: {
      grok_version: versionText,
      default_model: modelsInfo.default_model,
      logged_in: modelsInfo.logged_in,
      model_ready: true,
    },
  });
  if (sourceFree.exitCode !== 0 || sourceFree.parsed?.ok !== true) {
    return {
      ...sourceFree,
      diagnostics: {
        ...sourceFree.diagnostics,
        source_free_parse_mode: sourceFree.parsed?.parse_mode ?? null,
        source_free_prompt_cleanup: sourceFree.diagnostics?.prompt_cleanup ?? null,
        source_free_grok_home_cleanup: sourceFree.diagnostics?.grok_home_cleanup ?? null,
        prompt_cleanup: null,
        grok_home_cleanup: null,
      },
      parsed: {
        ...sourceFree.parsed,
        reason: sourceFree.parsed?.reason ?? "grok_cli_preflight_failed",
      },
      payload_sent: false,
    };
  }
  return {
    ok: true,
    diagnostics: {
      grok_version: versionText,
      default_model: modelsInfo.default_model,
      logged_in: modelsInfo.logged_in,
      model_ready: true,
      source_free_parse_mode: sourceFree.parsed?.parse_mode ?? null,
      source_free_prompt_cleanup: sourceFree.diagnostics?.prompt_cleanup ?? null,
      source_free_grok_home_cleanup: sourceFree.diagnostics?.grok_home_cleanup ?? null,
      grok_home_source: sourceFree.diagnostics?.grok_home_source ?? null,
      grok_home_copied_files: sourceFree.diagnostics?.grok_home_copied_files ?? [],
      grok_home_linked_files: sourceFree.diagnostics?.grok_home_linked_files ?? [],
      grok_home_cleanup: sourceFree.diagnostics?.grok_home_cleanup ?? null,
    },
  };
}

async function callGrokCli(cfg, prompt, { sourceBearing = true, baseDiagnostics = {}, env = process.env } = {}) {
  const neutralCwd = resolve(tmpdir(), `grok-cli-cwd-${randomUUID()}`);
  let promptDir = null;
  let promptFile = null;
  let runtimeHome = null;
  let result = null;
  let setupError = null;
  let promptCleanup = "not_created";
  let grokHomeCleanup = "not_created";
  let neutralCwdCleanup = "not_created";
  try {
    await mkdir(neutralCwd, { mode: 0o700 });
    const promptInfo = await writePrivatePromptFile(prompt);
    promptDir = promptInfo.dir;
    promptFile = promptInfo.file;
    runtimeHome = await prepareGrokCliRuntimeHome(env);
    const args = [
      "--prompt-file", promptFile,
      "--output-format", "json",
      "--max-turns", String(cfg.max_turns),
      "--cwd", neutralCwd,
      "--permission-mode", "dontAsk",
      "--disable-web-search",
      "--no-memory",
      "--no-alt-screen",
      "--model", cfg.model,
    ];
    result = await runGrokCliCommandAsync(cfg, args, {
      cwd: neutralCwd,
      timeoutMs: cfg.timeout_ms,
      env: {
        GROK_HOME: runtimeHome.dir,
        GROK_MEMORY: "0",
      },
    });
  } catch (error) {
    setupError = error;
  } finally {
    if (promptFile && promptDir) promptCleanup = await cleanupPromptFile(promptFile, promptDir);
    grokHomeCleanup = await cleanupGrokCliRuntimeHome(runtimeHome);
    try {
      await rmdir(neutralCwd);
      neutralCwdCleanup = "deleted";
    } catch (error) {
      if (error?.code === "ENOENT") neutralCwdCleanup = "deleted";
      else neutralCwdCleanup = "unverified";
    }
  }
  const diagnostics = {
    ...baseDiagnostics,
    transport: "cli",
    model: cfg.model,
    exit_status: result?.status ?? null,
    exit_signal: result?.signal ?? null,
    stderr_head: result ? (trimText(redactor()(result.stderr)).slice(0, 500) || null) : null,
    configured_timeout_ms: cfg.timeout_ms,
    max_turns: cfg.max_turns,
    prompt_chars: prompt.length,
    neutral_cwd: neutralCwd,
    neutral_cwd_cleanup: neutralCwdCleanup,
    prompt_cleanup: promptCleanup,
    grok_home_source: runtimeHome?.source_home ?? grokCliAuthHome(env),
    grok_home_copied_files: runtimeHome?.copied_files ?? [],
    grok_home_linked_files: runtimeHome?.linked_files ?? [],
    grok_home_cleanup: grokHomeCleanup,
  };

  if (setupError || !result) {
    return providerFailureWithDiagnostic(
      "grok_cli_setup_failed",
      redactor()(setupError?.message ?? "Grok CLI setup failed before launch."),
      null,
      null,
      false,
      diagnostics,
    );
  }

  if (promptCleanup !== "deleted" || grokHomeCleanup !== "deleted" || neutralCwdCleanup !== "deleted") {
    return providerFailureWithDiagnostic(
      "privacy_persistence",
      "Grok CLI temporary prompt/runtime/cwd cleanup was not verified.",
      null,
      trimText(result.stdout).slice(0, 2000) || null,
      grokCliSourceTransmissionForResult(sourceBearing, result),
      diagnostics,
    );
  }

  if (result.error || result.status !== 0) {
    const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
    const authPromptFailed = !sourceBearing && isGrokCliAuthPromptFailure(result.stderr);
    const authHttpStatus = !sourceBearing ? grokCliAuthHttpStatus(result.stderr) : null;
    const authRejected = authHttpStatus === 401 || authHttpStatus === 403;
    const reason = authPromptFailed
      ? "grok_cli_auth_timeout"
      : (authRejected ? "grok_cli_auth_unavailable" : (timedOut ? "grok_cli_timeout" : "grok_cli_failed"));
    return providerFailureWithDiagnostic(
      reason,
      grokCliCommandError("grok --prompt-file", result),
      authHttpStatus,
      trimText(result.stdout).slice(0, 2000) || null,
      grokCliSourceTransmissionForResult(sourceBearing, result),
      diagnostics,
    );
  }

  const parsed = parseGrokCliOutput(result.stdout);
  if (!parsed.ok) {
    return providerFailureWithDiagnostic(
      parsed.reason,
      parsed.error,
      null,
      trimText(result.stdout).slice(0, 2000) || null,
      sourceBearing,
      diagnostics,
    );
  }
  return {
    exitCode: 0,
    parsed: {
      ok: true,
      result: parsed.result,
      raw_model: parsed.raw_model ?? cfg.model,
      usage: parsed.usage,
      parse_mode: parsed.parse_mode,
    },
    http_status: null,
    payload_sent: sourceBearing,
    diagnostics: {
      ...diagnostics,
      parse_mode: parsed.parse_mode,
    },
  };
}

function providerFailure(reason, message, httpStatus, raw = null, payloadSent = null) {
  return {
    exitCode: 1,
    parsed: { ok: false, reason, error: message, raw },
    http_status: httpStatus,
    payload_sent: payloadSent,
  };
}

function providerFailureWithDiagnostic(reason, message, httpStatus, raw = null, payloadSent = null, diagnostics = null) {
  return {
    ...providerFailure(reason, message, httpStatus, raw, payloadSent),
    diagnostics,
  };
}

function grokCliSourceTransmissionForResult(sourceBearing, result) {
  if (!sourceBearing) return false;
  if (!result) return false;
  if (result.error?.message?.includes("ENOENT")) return false;
  if (result.error || result.status !== 0) return SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT;
  return true;
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

function isNoRuntimeAccountsDetail(detail) {
  return /\bno\s+available\s+accounts?\b|no_available_accounts|\bno\s+active\s+runtime\s+(?:session\s+)?tokens?\b|\bruntime\s+account\s+pool\s+is\s+empty\b|runtime_account_pool["\s:,_-]+empty|\baccount[_ -]?count\s*[:=]\s*0\b|\bpool[_ -]?count\s*[:=]\s*0\b/i.test(String(detail ?? ""));
}

function classifyHttpFailure(status, parsed, text = "") {
  const detail = parsed.ok ? providerFailureDetailText(parsed) : String(text ?? "");
  if (isNoRuntimeAccountsDetail(detail)) return "grok_session_no_runtime_tokens";
  if (status === 401 || status === 403) return "session_expired";
  if (status === 408 || status === 409 || status === 425 || status >= 500) return "tunnel_error";
  if (status === 402 || status === 429 || isUsageLimitDetail(detail)) return "usage_limited";
  return "tunnel_error";
}

function errorMessageFromResponse(parsed, text, redact, { safeUsageLimit = false } = {}) {
  if (safeUsageLimit) return USAGE_LIMIT_SAFE_MESSAGE;
  if (parsed.ok) {
    const message = parsed.value?.error?.message ?? parsed.value?.message ?? JSON.stringify(parsed.value);
    return redact(message).slice(0, 800);
  }
  return redact(text).slice(0, 800);
}

function chatBadRequestCode(parsed, text) {
  const value = parsed.ok ? parsed.value : null;
  const usageDetail = [
    value?.error?.code,
    value?.error?.type,
    value?.error?.message,
    value?.message,
    text,
  ].filter(Boolean).join(" ");
  if (isNoRuntimeAccountsDetail(usageDetail)) return "grok_session_no_runtime_tokens";
  if (isUsageLimitDetail(usageDetail)) return "usage_limited";
  const codeOrType = [
    value?.error?.code,
    value?.error?.type,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(model_not_found|invalid_model|unknown_model)\b/.test(codeOrType)) {
    return "grok_chat_model_rejected";
  }
  const haystack = [
    value?.error?.message,
    value?.message,
    text,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(?:model|model id|model name)\b.{0,80}\b(?:not found|unknown|unsupported|does not exist|not accepted)\b/.test(haystack)) {
    return "grok_chat_model_rejected";
  }
  return "models_ok_chat_400";
}

function payloadSentForFetchError(error) {
  if (error?.name === "AbortError") return null;
  const code = error?.cause?.code || error?.code;
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN"].includes(code)) return false;
  if (/bad port/i.test(`${error?.message ?? ""} ${error?.cause?.message ?? ""}`)) return false;
  return null;
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstCounterValue(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = safeNonNegativeInteger(obj[key]);
    if (value !== null) return value;
  }
  return null;
}

function modelCountFromPayload(value) {
  if (Array.isArray(value?.data)) return value.data.length;
  if (Array.isArray(value?.models)) return value.models.length;
  return null;
}

function sessionTokenDiagnostics(payload) {
  const source = Array.isArray(payload) ? { tokens: payload } : (payload && typeof payload === "object" ? payload : {});
  const entries = Array.isArray(source.tokens) ? source.tokens : [];
  const active = entries.filter((entry) => {
    const status = String(entry?.status ?? "").toLowerCase();
    return entry?.deleted !== true && status !== "deleted" && status !== "inactive";
  });
  const malformedActive = active.filter((entry) => !isJwtShapedToken(entry?.token));
  const deleted = entries.filter((entry) => entry?.deleted === true || String(entry?.status ?? "").toLowerCase() === "deleted");
  const totalTokenCount = firstCounterValue(source, ["total_token_count", "totalTokenCount", "total", "count"]) ?? entries.length;
  const activeTokenCount = firstCounterValue(source, ["active_token_count", "activeTokenCount", "active"]) ?? active.length;
  const deletedTokenCount = firstCounterValue(source, ["deleted_token_count", "deletedTokenCount", "deleted"]) ?? deleted.length;
  const malformedActiveTokenCount = firstCounterValue(source, [
    "malformed_active_token_count",
    "malformedActiveTokenCount",
    "malformed",
  ]) ?? malformedActive.length;
  const accountCount = firstCounterValue(source, ["account_count", "accountCount", "total_accounts", "totalAccounts"]);
  const poolCount = firstCounterValue(source, ["pool_count", "poolCount", "runtime_pool_count", "runtimePoolCount"]);
  const accountPoolEmpty = accountCount === 0 || poolCount === 0;
  const errorCode = activeTokenCount === 0 || accountPoolEmpty
    ? "grok_session_no_runtime_tokens"
    : (malformedActiveTokenCount > 0 ? "grok_session_malformed_active_token" : null);
  return {
    status: "checked",
    total_token_count: totalTokenCount,
    active_token_count: activeTokenCount,
    malformed_active_token_count: malformedActiveTokenCount,
    deleted_token_count: deletedTokenCount,
    account_count: accountCount,
    pool_count: poolCount,
    error_code: errorCode,
  };
}

async function probeGrokRuntimeStatus(cfg, env = process.env) {
  const endpoint = `${cfg.grok2api_base_url}/status`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.doctor_timeout_ms);
  const redact = redactor(env);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? parseJson(text) : { ok: true, value: null };
    if (!response.ok || !parsed.ok) {
      return {
        status: "unknown",
        error_code: "grok_runtime_status_unavailable",
        error_message: response.ok ? "grok2api runtime status response was not valid JSON." : errorMessageFromResponse(parsed, text, redact),
        http_status: response.status,
        probe_endpoint: endpoint,
      };
    }
    const size = safeNonNegativeInteger(parsed.value?.size);
    const accountCount = firstCounterValue(parsed.value, ["account_count", "accountCount", "total_accounts", "totalAccounts"]);
    const poolCount = firstCounterValue(parsed.value, ["pool_count", "poolCount", "runtime_pool_count", "runtimePoolCount"]) ?? size;
    return {
      status: "checked",
      runtime_size: size,
      account_count: accountCount,
      pool_count: poolCount,
      runtime_revision: Number.isSafeInteger(parsed.value?.revision) ? parsed.value.revision : null,
      runtime_selection_strategy: typeof parsed.value?.selection_strategy === "string" ? parsed.value.selection_strategy : null,
      error_code: null,
      error_message: null,
      http_status: response.status,
      probe_endpoint: endpoint,
    };
  } catch (error) {
    return {
      status: "unknown",
      error_code: error?.name === "AbortError" ? "grok_runtime_status_timeout" : "grok_runtime_status_unavailable",
      error_message: tunnelTransportMessage(error, cfg, env, redact),
      http_status: null,
      probe_endpoint: endpoint,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeGrokSessionDiagnostics(cfg, env = process.env) {
  const endpoint = `${cfg.grok2api_base_url}/admin/api/tokens`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.doctor_timeout_ms);
  const redact = redactor(env);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${cfg.grok2api_admin_key}` },
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? parseJson(text) : { ok: true, value: null };
    if (!response.ok || !parsed.ok) {
      return {
        status: "unknown",
        error_code: response.ok ? "grok_session_diagnostics_unavailable" : classifyHttpFailure(response.status, parsed, text),
        error_message: response.ok ? "grok2api admin token response was not valid JSON." : errorMessageFromResponse(parsed, text, redact),
        http_status: response.status,
        probe_endpoint: endpoint,
      };
    }
    const tokenDiagnostics = sessionTokenDiagnostics(parsed.value);
    const runtimeDiagnostics = await probeGrokRuntimeStatus(cfg, env);
    const runtimeDiverged = runtimeDiagnostics.status === "checked"
      && tokenDiagnostics.active_token_count > 0
      && runtimeDiagnostics.runtime_size === 0;
    const runtimeProbeFailed = tokenDiagnostics.active_token_count > 0
      && tokenDiagnostics.error_code === null
      && runtimeDiagnostics.status === "unknown";
    return {
      ...tokenDiagnostics,
      ...(runtimeDiagnostics.status === "checked" ? {
        runtime_size: runtimeDiagnostics.runtime_size,
        runtime_account_count: runtimeDiagnostics.account_count,
        runtime_pool_count: runtimeDiagnostics.pool_count,
        runtime_revision: runtimeDiagnostics.runtime_revision,
        runtime_selection_strategy: runtimeDiagnostics.runtime_selection_strategy,
      } : {}),
      ...(runtimeProbeFailed ? {
        runtime_status: runtimeDiagnostics.status,
        runtime_error_code: runtimeDiagnostics.error_code,
        runtime_http_status: runtimeDiagnostics.http_status,
        runtime_probe_endpoint: runtimeDiagnostics.probe_endpoint,
      } : {}),
      error_code: runtimeDiverged
        ? "grok_session_runtime_admin_divergence"
        : (runtimeProbeFailed ? runtimeDiagnostics.error_code : tokenDiagnostics.error_code),
      error_message: runtimeProbeFailed ? runtimeDiagnostics.error_message : null,
      http_status: response.status,
      probe_endpoint: endpoint,
    };
  } catch (error) {
    return {
      status: "unknown",
      error_code: error?.name === "AbortError" ? "grok_session_diagnostics_timeout" : "grok_session_diagnostics_unavailable",
      error_message: tunnelTransportMessage(error, cfg, env, redact),
      http_status: null,
      probe_endpoint: endpoint,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tunnelTransportMessage(error, cfg, env, redact) {
  const detail = redact(error?.message ?? String(error));
  const ignoredKeys = subscriptionRouteForConfig(cfg, env, false).ignored_env_credentials ?? [];
  if (ignoredKeys.length > 0 && !env.GROK_WEB_TUNNEL_API_KEY) {
    const ignored = ignoredKeys.map((key) => `${key} is ignored`).join("; ");
    return `${detail}. ${ignored} by grok-web subscription_web mode; start the local Grok web tunnel and set GROK_WEB_TUNNEL_API_KEY only if that tunnel requires bearer auth.`;
  }
  return detail;
}

function safeSessionId(value) {
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9._:/=+@-]{1,200}$/.test(value) ? value : null;
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

async function callGrokTunnel(cfg, prompt, env = process.env) {
  const endpoint = `${cfg.base_url}/chat/completions`;
  const requestBody = {
    model: cfg.model,
    stream: false,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  };
  const headers = { "content-type": "application/json" };
  if (cfg.credential_value) headers.authorization = `Bearer ${cfg.credential_value}`;
  const redact = redactor(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);
  const started = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseJson(text);
    if (!response.ok) {
      const errorCode = classifyHttpFailure(response.status, parsed, text);
      return providerFailureWithDiagnostic(
        errorCode,
        errorMessageFromResponse(parsed, text, redact, { safeUsageLimit: errorCode === "usage_limited" }),
        response.status,
        parsed.ok ? parsed.value : null,
        true,
        {
          configured_timeout_ms: cfg.timeout_ms,
          elapsed_ms: Date.now() - started,
          endpoint_class: "chat_completions",
          model: cfg.model,
          stream: false,
          message_count: requestBody.messages.length,
          prompt_chars: prompt.length,
          cost_quota: costQuotaDiagnostics(errorCode, response.status, parsed),
        },
      );
    }
    if (!parsed.ok) return providerFailureWithDiagnostic("malformed_response", parsed.error, response.status, null, true, {
      configured_timeout_ms: cfg.timeout_ms,
      elapsed_ms: Date.now() - started,
      prompt_chars: prompt.length,
      max_tokens: null,
      temperature: requestBody.temperature ?? null,
      stream: false,
    });
    const content = parsed.value?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return providerFailureWithDiagnostic(
        "malformed_response",
        "response did not include choices[0].message.content",
        response.status,
        parsed.value,
        true,
        {
          configured_timeout_ms: cfg.timeout_ms,
          prompt_chars: prompt.length,
          max_tokens: null,
          temperature: requestBody.temperature ?? null,
          stream: false,
        },
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
      session_id: safeSessionId(parsed.value?.id),
      http_status: response.status,
      credential_ref: cfg.credential_ref,
      endpoint: cfg.base_url,
      diagnostics: {
        configured_timeout_ms: cfg.timeout_ms,
        prompt_chars: prompt.length,
        max_tokens: null,
        temperature: requestBody.temperature ?? null,
        stream: false,
      },
    };
  } catch (e) {
    const reason = e?.name === "AbortError" ? "tunnel_timeout" : "tunnel_unavailable";
    return providerFailureWithDiagnostic(reason, tunnelTransportMessage(e, cfg, env, redact), null, null, payloadSentForFetchError(e), {
      configured_timeout_ms: cfg.timeout_ms,
      prompt_chars: prompt.length,
      max_tokens: null,
      temperature: requestBody.temperature ?? null,
      stream: false,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeGrokTunnel(cfg, env = process.env) {
  const endpoint = `${cfg.base_url}/models`;
  const headers = {};
  if (cfg.credential_value) headers.authorization = `Bearer ${cfg.credential_value}`;
  const redact = redactor(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.doctor_timeout_ms);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? parseJson(text) : { ok: true, value: null };
    if (!response.ok) {
      const errorCode = classifyHttpFailure(response.status, parsed, text);
      return {
        reachable: false,
        models_ready: false,
        model_count: null,
        error_code: errorCode,
        error_message: errorMessageFromResponse(parsed, text, redact, { safeUsageLimit: errorCode === "usage_limited" }),
        http_status: response.status,
        probe_endpoint: endpoint,
      };
    }
    if (!parsed.ok) {
      return {
        reachable: true,
        models_ready: false,
        model_count: null,
        error_code: "malformed_response",
        error_message: "grok2api /models response was not valid JSON.",
        http_status: response.status,
        probe_endpoint: endpoint,
      };
    }
    const modelCount = parsed.ok ? modelCountFromPayload(parsed.value) : null;
    if (modelCount === null) {
      return {
        reachable: true,
        models_ready: false,
        model_count: null,
        error_code: "malformed_response",
        error_message: "grok2api /models response did not include a data or models array.",
        http_status: response.status,
        probe_endpoint: endpoint,
      };
    }
    const modelsReady = modelCount > 0;
    return {
      reachable: true,
      models_ready: modelsReady,
      model_count: modelCount,
      error_code: modelsReady ? null : "grok_session_no_runtime_tokens",
      error_message: modelsReady ? null : "grok2api /models returned no models; the runtime account/session pool appears empty.",
      http_status: response.status,
      probe_endpoint: endpoint,
    };
  } catch (e) {
    return {
      reachable: false,
      models_ready: false,
      model_count: null,
      error_code: e?.name === "AbortError" ? "tunnel_timeout" : "tunnel_unavailable",
      error_message: tunnelTransportMessage(e, cfg, env, redact),
      http_status: null,
      probe_endpoint: endpoint,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForGrokTunnel(cfg, env, deadlineMs) {
  const started = Date.now();
  let lastProbe = null;
  while (Date.now() - started < deadlineMs) {
    await sleep(TUNNEL_START_POLL_MS);
    lastProbe = await probeGrokTunnel(cfg, env);
    if (lastProbe.reachable === true) {
      return { reachable: true, probe: lastProbe, elapsed_ms: Date.now() - started };
    }
  }
  return { reachable: false, probe: lastProbe, elapsed_ms: Date.now() - started };
}

async function maybeStartGrokTunnel(cfg, env = process.env) {
  const enabled = envFlagEnabled(env, "GROK_WEB_TUNNEL_AUTO_START", true);
  if (!enabled) {
    return {
      status: "disabled",
      attempted: false,
      error_code: "grok2api_auto_start_disabled",
      message: "GROK_WEB_TUNNEL_AUTO_START disabled local tunnel auto-start.",
    };
  }
  const target = grok2ApiStartTarget(cfg);
  if (!target.ok) {
    return {
      status: "not_applicable",
      attempted: false,
      error_code: target.error_code,
      message: target.reason,
    };
  }
  let home = await resolveGrok2ApiHome(env);
  let bootstrap = null;
  if (!home.ok && home.error_code === "grok2api_home_missing") {
    bootstrap = await maybeBootstrapGrok2ApiHome(env);
    if (bootstrap.ok) {
      home = {
        ok: true,
        path: bootstrap.path,
        source: bootstrap.source,
        checked_candidate_count: home.checked_candidate_count,
      };
    }
  }
  if (!home.ok) {
    return {
      status: bootstrap?.status ?? "not_configured",
      attempted: bootstrap?.attempted ?? false,
      error_code: bootstrap?.error_code ?? home.error_code,
      message: bootstrap?.message ?? home.error_message,
      checked_candidate_count: home.checked_candidate_count,
      ...(home.source ? { home_source: home.source } : {}),
      ...(bootstrap?.detail ? { detail: bootstrap.detail } : {}),
      ...(bootstrap?.home_source ? { home_source: bootstrap.home_source } : {}),
      ...(bootstrap?.home_path ? { home_path: bootstrap.home_path } : {}),
      ...(bootstrap ? { bootstrap } : {}),
    };
  }
  const uvBinary = findUvBinary(home.path, env);
  if (!uvBinary.ok) {
    return {
      status: "blocked",
      attempted: false,
      error_code: uvBinary.error_code,
      message: uvBinary.message,
      home_source: home.source,
      home_path: home.path,
      ...(bootstrap ? { bootstrap } : {}),
    };
  }

  const command = tunnelStartCommand(target, uvBinary.command);
  let child;
  try {
    child = spawn(command[0], command.slice(1), {
      cwd: home.path,
      env: uvExecutionEnv(env),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch (error) {
    return {
      status: "failed",
      attempted: true,
      error_code: "grok2api_start_failed",
      message: `Failed to start grok2api: ${error?.message ?? String(error)}`,
      home_source: home.source,
      home_path: home.path,
      uv_source: uvBinary.source,
      command: command.join(" "),
      ...(bootstrap ? { bootstrap } : {}),
    };
  }

  const wait = await waitForGrokTunnel(cfg, env, cfg.tunnel_start_timeout_ms);
  if (wait.reachable) {
    return {
      status: "started",
      attempted: true,
      error_code: null,
      message: "Started local grok2api tunnel without Docker; leaving it running for reuse.",
      pid: child.pid,
      cleanup_policy: "persistent_reuse",
      cleanup_on_exit: false,
      home_source: home.source,
      home_path: home.path,
      uv_source: uvBinary.source,
      command: command.join(" "),
      elapsed_ms: wait.elapsed_ms,
      probe: wait.probe,
      ...(bootstrap ? { bootstrap } : {}),
    };
  }
  const cleanup = await terminateStartedGrokTunnel(child, cfg, env);
  return {
    status: "started_unreachable",
    attempted: true,
    error_code: "grok2api_start_timeout",
    last_probe_error_code: wait.probe?.error_code ?? null,
    message: `Started grok2api process but ${cfg.base_url}/models did not become reachable before GROK_WEB_TUNNEL_START_TIMEOUT_MS.`,
    pid: child.pid,
    home_source: home.source,
    home_path: home.path,
    uv_source: uvBinary.source,
    command: command.join(" "),
    elapsed_ms: wait.elapsed_ms,
    probe: wait.probe,
    cleanup,
    ...(bootstrap ? { bootstrap } : {}),
  };
}

function signalStartedGrokTunnel(child, signal) {
  if (!child?.pid) {
    return { attempted: false, signal, target: null, error: null };
  }
  const target = process.platform === "win32" ? "process" : "process_group";
  try {
    if (process.platform === "win32") {
      process.kill(child.pid, signal);
    } else {
      process.kill(-child.pid, signal);
    }
    return { attempted: true, signal, target, error: null };
  } catch (error) {
    return {
      attempted: true,
      signal,
      target,
      error: error?.message ?? String(error),
    };
  }
}

async function waitForGrokTunnelUnavailable(cfg, env, deadlineMs) {
  const started = Date.now();
  let probe = null;
  do {
    probe = await probeGrokTunnel(cfg, env);
    if (!probe.reachable) {
      return {
        unreachable: true,
        elapsed_ms: Date.now() - started,
        probe,
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, TUNNEL_START_POLL_MS));
  } while (Date.now() - started < deadlineMs);
  return {
    unreachable: false,
    elapsed_ms: Date.now() - started,
    probe,
  };
}

function startedGrokTunnelExited(child) {
  return Boolean(child) && (child.exitCode !== null || child.signalCode !== null);
}

async function waitForStartedGrokTunnelAfterSignal(child, cfg, env, deadlineMs) {
  const started = Date.now();
  let probe = null;
  do {
    if (startedGrokTunnelExited(child)) {
      return {
        exited: true,
        reachable: false,
        elapsed_ms: Date.now() - started,
        probe,
      };
    }
    probe = await probeGrokTunnel(cfg, env);
    if (probe.reachable) {
      return {
        exited: startedGrokTunnelExited(child),
        reachable: true,
        elapsed_ms: Date.now() - started,
        probe,
      };
    }
    if (startedGrokTunnelExited(child)) {
      return {
        exited: true,
        reachable: false,
        elapsed_ms: Date.now() - started,
        probe,
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, TUNNEL_START_POLL_MS));
  } while (Date.now() - started < deadlineMs);
  return {
    exited: startedGrokTunnelExited(child),
    reachable: probe?.reachable === true,
    elapsed_ms: Date.now() - started,
    probe,
  };
}

async function terminateStartedGrokTunnel(child, cfg, env = process.env) {
  const cleanup = signalStartedGrokTunnel(child, "SIGTERM");
  if (!cleanup.attempted || cleanup.error) return cleanup;

  const afterSignal = await waitForStartedGrokTunnelAfterSignal(child, cfg, env, cfg.tunnel_cleanup_timeout_ms);
  cleanup.reachable_after_signal = afterSignal.reachable === true;
  cleanup.exited_after_signal = afterSignal.exited === true;
  cleanup.verify_elapsed_ms = afterSignal.elapsed_ms;
  if (afterSignal.exited && !afterSignal.reachable) return cleanup;

  const force = signalStartedGrokTunnel(child, "SIGKILL");
  cleanup.force_signal = force.signal;
  cleanup.force_target = force.target;
  cleanup.force_error = force.error;
  if (force.error) return cleanup;

  const afterForce = await waitForGrokTunnelUnavailable(cfg, env, cfg.tunnel_cleanup_timeout_ms);
  cleanup.unreachable_after_force = afterForce.unreachable === true;
  cleanup.force_verify_elapsed_ms = afterForce.elapsed_ms;
  return cleanup;
}

async function ensureGrokTunnelReachable(cfg, env = process.env, initialProbe = null) {
  const probe = initialProbe ?? await probeGrokTunnel(cfg, env);
  if (probe.reachable === true) {
    return {
      probe,
      tunnel_start: {
        status: "not_needed",
        attempted: false,
        error_code: null,
      },
    };
  }
  if (probe.error_code !== "tunnel_unavailable" && probe.error_code !== "tunnel_timeout") {
    return {
      probe,
      tunnel_start: {
        status: "not_attempted",
        attempted: false,
        error_code: "probe_failed_before_start",
        message: "The tunnel endpoint responded, but not with a startable transport failure.",
      },
    };
  }
  const tunnelStart = await maybeStartGrokTunnel(cfg, env);
  return {
    probe: tunnelStart.probe ?? probe,
    tunnel_start: {
      ...tunnelStart,
      probe: undefined,
    },
  };
}

async function probeGrokChat(cfg, env = process.env, options = {}) {
  const endpoint = `${cfg.base_url}/chat/completions`;
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (cfg.credential_value) headers.authorization = `Bearer ${cfg.credential_value}`;
  const redact = redactor(env);
  const prompt = options.prompt ?? REVIEW_READINESS_PREFLIGHT_PROMPT;
  const requestBody = {
    model: cfg.model,
    stream: false,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  };
  const controller = new AbortController();
  const timeoutMs = options.timeout_ms ?? cfg.chat_doctor_timeout_ms;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? parseJson(text) : { ok: true, value: null };
    if (!response.ok) {
      const errorCode = response.status === 400 ? chatBadRequestCode(parsed, text) : classifyHttpFailure(response.status, parsed, text);
      return {
        chat_ready: false,
        error_code: errorCode,
        error_message: errorMessageFromResponse(parsed, text, redact, { safeUsageLimit: errorCode === "usage_limited" }),
        http_status: response.status,
        probe_endpoint: endpoint,
      };
    }
    return {
      chat_ready: true,
      error_code: null,
      error_message: null,
      http_status: response.status,
      probe_endpoint: endpoint,
    };
  } catch (e) {
    return {
      chat_ready: false,
      error_code: e?.name === "AbortError" ? "grok_chat_timeout" : "tunnel_unavailable",
      error_message: tunnelTransportMessage(e, cfg, env, redact),
      http_status: null,
      probe_endpoint: endpoint,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tunnelFailureMode(chatProbe) {
  if (!chatProbe || chatProbe.chat_ready === true) return null;
  const code = chatProbe.error_code ?? null;
  if (code === "tunnel_unavailable") return "connect_refused";
  if (code === "tunnel_timeout" || code === "grok_chat_timeout") return "connect_timeout";
  if (code === "session_expired") return "session_expired";
  if (code === "usage_limited") return "usage_limited";
  if (code === "grok_chat_model_rejected") return "chat_model_rejected";
  if (code === "models_ok_chat_400") return "chat_unavailable";
  if (code && code.startsWith("grok_session_")) return "session_state_invalid";
  if (code) return code;
  return chatProbe.http_status != null ? `http_${chatProbe.http_status}` : "unknown";
}

function sessionTokensStatusForRuntime(sessionDiagnostics, chatProbe) {
  if (!sessionDiagnostics) return "not_checked";
  if (sessionDiagnostics.status === "unknown") {
    if (chatProbe?.chat_ready === false && chatProbe.error_code === "tunnel_unavailable") {
      return "unknown_tunnel_unreachable";
    }
    return "unknown";
  }
  const errorCode = sessionDiagnostics.error_code ?? null;
  if (errorCode === "grok_session_no_runtime_tokens") return "empty";
  if (errorCode === "grok_session_malformed_active_token") return "malformed";
  if (errorCode === "grok_session_runtime_admin_divergence") return "runtime_admin_divergence";
  if (errorCode === "grok_runtime_status_unavailable") return "runtime_status_unavailable";
  if (errorCode === "grok_runtime_status_timeout") return "runtime_status_timeout";
  if (errorCode) return errorCode;
  if ((sessionDiagnostics.active_token_count ?? 0) > 0) return "active";
  return "unknown";
}

function webTunnelStateDiagnostics(cfg, chatProbe, tunnelStart = null) {
  const reachable = chatProbe?.chat_ready === true
    || (typeof chatProbe?.http_status === "number" && chatProbe.http_status > 0);
  return {
    transport: cfg.transport,
    reachable,
    chat_ready: chatProbe?.chat_ready === true,
    failure_mode: chatProbe?.chat_ready === true ? null : tunnelFailureMode(chatProbe),
    error_code: chatProbe?.error_code ?? null,
    http_status: chatProbe?.http_status ?? null,
    probe_endpoint: chatProbe?.probe_endpoint ?? null,
    auto_start_attempted: tunnelStart?.attempted === true,
  };
}

function webSessionTokensDiagnostics(sessionDiagnostics, chatProbe) {
  return {
    status: sessionTokensStatusForRuntime(sessionDiagnostics, chatProbe),
    total_token_count: sessionDiagnostics?.total_token_count ?? null,
    active_token_count: sessionDiagnostics?.active_token_count ?? null,
    malformed_active_token_count: sessionDiagnostics?.malformed_active_token_count ?? null,
    deleted_token_count: sessionDiagnostics?.deleted_token_count ?? null,
    account_count: sessionDiagnostics?.account_count ?? null,
    pool_count: sessionDiagnostics?.pool_count ?? null,
    runtime_size: sessionDiagnostics?.runtime_size ?? null,
    runtime_revision: sessionDiagnostics?.runtime_revision ?? null,
    diagnostics_status: sessionDiagnostics?.status ?? null,
    diagnostics_error_code: sessionDiagnostics?.error_code ?? null,
    probe_endpoint: sessionDiagnostics?.probe_endpoint ?? null,
    repair_attempted: false,
  };
}

function webReadinessDiagnostics(cfg, chatProbe, sessionDiagnostics = null) {
  return {
    preflight: true,
    configured_timeout_ms: cfg.chat_doctor_timeout_ms,
    endpoint_class: "chat_completions_preflight",
    model: cfg.model,
    stream: false,
    message_count: 1,
    prompt_chars: REVIEW_READINESS_PREFLIGHT_PROMPT.length,
    max_tokens: null,
    temperature: 0,
    cost_quota: {
      classification: chatProbe?.error_code === "usage_limited" ? "usage_limited" : "not_reported",
      http_status: chatProbe?.http_status ?? null,
      provider_error_code: null,
      provider_error_type: null,
      billing_mutation: "not_attempted",
    },
    session_diagnostics: sessionDiagnostics,
    tunnel_state: webTunnelStateDiagnostics(cfg, chatProbe),
    session_tokens: webSessionTokensDiagnostics(sessionDiagnostics, chatProbe),
  };
}

async function grokReviewReadinessPreflight(cfg, env = process.env) {
  const chatProbe = await probeGrokChat(cfg, env, {
    headers: { [REVIEW_READINESS_PREFLIGHT_HEADER]: "1" },
  });
  if (chatProbe.chat_ready === true) {
    return { ok: true, diagnostics: webReadinessDiagnostics(cfg, chatProbe) };
  }

  const sessionDiagnostics = await probeGrokSessionDiagnostics(cfg, env);
  const sessionErrorCode = sessionDiagnostics.status === "checked" ? sessionDiagnostics.error_code : null;
  const sessionErrorMessage = sessionDiagnostics.status === "checked" ? sessionDiagnostics.error_message : null;
  const errorCode = sessionErrorCode ?? chatProbe.error_code ?? "tunnel_error";
  const diagnostics = webReadinessDiagnostics(cfg, chatProbe, sessionDiagnostics);
  diagnostics.cost_quota.classification = errorCode === "usage_limited" ? "usage_limited" : "not_reported";
  const execution = providerFailureWithDiagnostic(
    errorCode,
    sessionErrorMessage ?? chatProbe.error_message ?? errorCode,
    chatProbe.http_status,
    null,
    false,
    diagnostics,
  );
  execution.credential_ref = cfg.credential_ref;
  execution.endpoint = cfg.base_url;
  return { ok: false, execution };
}

function isTunnelTransportExecution(execution) {
  const reason = execution?.parsed?.reason;
  return reason === "tunnel_unavailable" || reason === "tunnel_timeout";
}

function sourceContentTransmissionForPayload({ completed, payloadSent, errorCode = null, pidInfo = null }) {
  if (payloadSent === SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT) return SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT;
  if (payloadSent === SOURCE_CONTENT_TRANSMISSION.SENT) return SOURCE_CONTENT_TRANSMISSION.SENT;
  if (payloadSent === SOURCE_CONTENT_TRANSMISSION.NOT_SENT) return SOURCE_CONTENT_TRANSMISSION.NOT_SENT;
  if (completed || payloadSent === true) return SOURCE_CONTENT_TRANSMISSION.SENT;
  if (payloadSent === false) return SOURCE_CONTENT_TRANSMISSION.NOT_SENT;
  return sourceContentTransmissionForExecution({
    status: completed ? "completed" : "failed",
    errorCode,
    pidInfo,
  });
}

function disclosure(cfg, completed, payloadSent, errorCode = null, pidInfo = null) {
  const transmission = sourceContentTransmissionForPayload({ completed, payloadSent, errorCode, pidInfo });
  const route = cfg.transport === "cli"
    ? "through the subscription-backed Grok CLI"
    : "through a subscription-backed web session";
  const unavailable = cfg.transport === "cli"
    ? "the Grok CLI was unavailable before delivery"
    : "the local subscription-backed tunnel was unavailable before delivery";
  if (transmission === "sent" && completed) {
    return `Selected source content was sent to ${cfg.display_name} ${route}.`;
  }
  if (transmission === "sent") {
    return `Selected source content was sent to ${cfg.display_name} ${route}, but the reviewer did not return a clean result.`;
  }
  if (transmission === "not_sent") {
    return `Selected source content was not sent to ${cfg.display_name}; ${unavailable}.`;
  }
  return `Selected source content may have been sent to ${cfg.display_name} ${route}.`;
}

function reviewQualityReasons(errorMessage) {
  const prefix = "review_quality_failed:";
  const text = String(errorMessage ?? "");
  if (!text.startsWith(prefix)) return [];
  return text.slice(prefix.length).split(",").map((reason) => reason.trim()).filter(Boolean);
}

function suggestedAction(errorCode, errorMessage = "", tunnelStart = null) {
  const sharedDiagnostic = buildExternalModelFailureDiagnostic(errorCode, "Grok");
  if (tunnelStart?.error_code === "grok2api_home_missing") {
    return "Set GROK2API_HOME to a local chenyme/grok2api checkout, or clone it once, then rerun setup. Docker is not required; after GROK2API_HOME is available the plugin will start the local tunnel with uv automatically.";
  }
  if (tunnelStart?.error_code === "grok2api_home_invalid") {
    return "Point GROK2API_HOME at a valid chenyme/grok2api checkout containing app/main.py and pyproject.toml or uv.lock, then rerun setup.";
  }
  if (tunnelStart?.error_code === "grok2api_auto_bootstrap_disabled") {
    return "Unset GROK_WEB_TUNNEL_AUTO_BOOTSTRAP=0, set GROK2API_HOME to an existing checkout, or start the configured local Grok web tunnel yourself.";
  }
  if (tunnelStart?.error_code === "grok2api_bootstrap_failed") {
    return "Automatic grok2api bootstrap failed. Inspect tunnel_start.detail, fix Git/network access or set GROK2API_HOME to an existing checkout, then retry. Docker is not required.";
  }
  if (tunnelStart?.error_code === "grok2api_git_unavailable") {
    return "Install Git or set CODEX_PLUGIN_MULTI_GIT_BINARY to an approved absolute Git path, then rerun setup. Docker is not required.";
  }
  if (tunnelStart?.error_code === "grok2api_bootstrap_dir_invalid") {
    return "Point GROK2API_BOOTSTRAP_DIR or GROK2API_HOME at an empty path or a valid grok2api checkout, then rerun setup.";
  }
  if (tunnelStart?.error_code === "grok2api_bootstrap_url_invalid") {
    return "Use the default grok2api source or set GROK2API_REPO_URL to an https URL without embedded credentials.";
  }
  if (tunnelStart?.error_code === "grok2api_uv_missing") {
    return "Install uv or put it on PATH, then rerun setup. Docker is not required; the plugin starts grok2api with `uv run granian ... app.main:app`.";
  }
  if (tunnelStart?.error_code === "grok2api_auto_start_disabled") {
    return "Unset GROK_WEB_TUNNEL_AUTO_START=0 or start the local Grok web tunnel yourself, then retry.";
  }
  if (tunnelStart?.error_code === "grok2api_endpoint_not_grok2api") {
    return "Automatic start only supports grok2api /v1 endpoints. Start the configured non-grok2api tunnel yourself or set GROK_WEB_BASE_URL to a local grok2api /v1 endpoint.";
  }
  if (tunnelStart?.status === "started_unreachable") {
    return "The plugin started grok2api, but the /models endpoint did not become reachable in time. Inspect the local grok2api process/logs, raise GROK_WEB_TUNNEL_START_TIMEOUT_MS if startup is slow, then retry.";
  }
  if (errorCode === "bad_args") return "Correct the grok-web command arguments and retry.";
  if (errorCode === "prompt_too_large") {
    if (/GROK_CLI_MAX_PROMPT_CHARS/i.test(errorMessage)) {
      return "Rendered prompt exceeds the Grok CLI prompt budget before launch. Use a narrower scope, split the review into explicit custom-review shards, or raise GROK_CLI_MAX_PROMPT_CHARS only after confirming the Grok CLI/model accepts larger prompts.";
    }
    return "Rendered prompt exceeds the Grok prompt budget before launch. Use a narrower scope, split the review into explicit custom-review shards, or raise GROK_WEB_MAX_PROMPT_CHARS only after confirming the selected Grok transport accepts larger prompts.";
  }
  if (errorCode === "scope_failed") {
    if (/scope_empty:\s*branch-diff selected no files/i.test(errorMessage)) {
      return "Branch-diff selected no files before tunnel launch. Branch-diff reviews committed HEAD-vs-base changes only; it does not include dirty working-tree edits. Choose a different --scope-base <ref> if this branch should have committed changes, use --scope-base HEAD~1 to review the last commit, or use custom-review with explicit --scope-paths for uncommitted, already-merged, or no-diff branches.";
    }
    if (/scope_base_invalid:/i.test(errorMessage)) {
      return "Use a concrete branch, tag, remote ref, or commit SHA for --scope-base; option-shaped values beginning with '-' are rejected before git branch-diff runs.";
    }
    return "Adjust --scope, --scope-base, or --scope-paths and retry.";
  }
  if (errorCode === "tunnel_unavailable") return "The plugin could not bootstrap or start the non-Docker grok2api tunnel. Inspect tunnel_start, fix the reported Git/uv/path/start issue, or start the configured local Grok web tunnel yourself and retry.";
  if (errorCode === "tunnel_timeout") return "The local Grok web tunnel did not respond before GROK_WEB_TIMEOUT_MS; inspect the tunnel and retry.";
  if (errorCode === "session_expired") return "Refresh the Grok web login/session used by the local tunnel, then retry.";
  if (errorCode === "usage_limited") return "Wait for Grok subscription usage to recover, reduce concurrency, or inspect the local tunnel. Any billing, credit, or tier change must be a separate manual action with explicit user approval.";
  if (errorCode === "grok_chat_model_rejected") return "The tunnel lists models, but the configured GROK_WEB_MODEL is not accepted by chat; correct GROK_WEB_MODEL or tunnel model routing, then retry.";
  if (errorCode === "grok_chat_timeout") return "The Grok chat readiness probe exceeded GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS; inspect the local tunnel latency or raise that timeout, then retry.";
  if (errorCode === "grok_session_no_runtime_tokens") return "The local Grok tunnel has no active runtime session tokens. Configure a durable GROK2API_HOME outside temporary directories, then only after explicit operator approval run npm run grok:sync-browser-session or refresh the browser-backed session state, restart the tunnel, and retry.";
  if (errorCode === "grok_session_malformed_active_token") return "The local Grok tunnel has a malformed active Grok session token. Configure a durable GROK2API_HOME outside temporary directories, refresh the browser-backed session state only after explicit operator approval, restart or refresh the tunnel, then retry.";
  if (errorCode === "grok_session_runtime_admin_divergence") return "The grok2api admin token list has active tokens but the runtime token table is empty; restart or refresh the local Grok tunnel, then retry.";
  if (errorCode === "grok_runtime_status_unavailable") return "The grok2api admin token list has active tokens, but the runtime status endpoint is unavailable; restart or refresh the local Grok tunnel, then retry.";
  if (errorCode === "grok_runtime_status_timeout") return "The grok2api admin token list has active tokens, but the runtime status endpoint timed out; inspect local tunnel latency, restart or refresh the tunnel, then retry.";
  if (errorCode === "models_ok_chat_400") return "The tunnel lists models but chat is not review-capable; refresh the Grok web session, inspect tunnel logs and rate-limit endpoint health, then retry.";
  if (errorCode === "review_not_completed") {
    const reasons = reviewQualityReasons(errorMessage);
    if (hasSubstantiveInvalidVerdictReason(reasons)) {
      return "Treat this Grok slot as failed. Do not automatically resend selected source. " +
        "Retry by narrowing the scope, sharding the source packet, or relaying the prompt to another ready reviewer. " +
        "Retry the same Grok reviewer route only after the source packet and prompt are intentionally chosen again.";
    }
    return "Treat this Grok slot as failed. Inspect the raw result and runtime diagnostics, then retry only with a source packet and prompt contract the reviewer can inspect and answer substantively.";
  }
  if (errorCode === "malformed_response") return "Inspect or update the local Grok web tunnel; it returned an unsupported response shape.";
  if (errorCode === "git_binary_rejected") return sharedDiagnostic?.suggested_action ?? `Set ${GIT_BINARY_ENV} to a trusted Git executable outside the workspace, or unset it to use the default Git binary.`;
  if (errorCode === "grok_cli_untrusted_binary") {
    return "Set GROK_CLI_BINARY to a trusted absolute Grok CLI path outside the workspace and node_modules, or remove workspace-controlled directories from PATH before retrying.";
  }
  if (errorCode === "privacy_persistence") {
    return "Treat this Grok CLI slot as failed. Inspect runtime diagnostics, remove any reported temporary Grok CLI runtime/prompt artifacts if present, and retry only after cleanup is proven.";
  }
  if (errorCode === "grok_cli_login_required") {
    const apiKeyHint = /Direct API env variables are present and ignored/i.test(errorMessage)
      ? "Direct API env vars do not count as subscription CLI login. "
      : "";
    return `${apiKeyHint}Run \`grok login --device-auth\` or \`grok login --oauth\` in a normal terminal, ensure \`grok models\` reports a logged-in account and lists grok-build, then retry the Grok CLI reviewer. Do not switch provider or transport in default CLI mode.`;
  }
  if (errorCode === "grok_cli_auth_timeout") {
    return "Complete `grok login` in a normal terminal or fix default-browser auth handling, ensure `grok models` reports a logged-in account and lists grok-build, then retry the Grok CLI reviewer. Do not switch provider or transport in default CLI mode.";
  }
  if (errorCode === "grok_cli_auth_unavailable") {
    return "Refresh Grok CLI auth with `grok login --device-auth` or `grok login --oauth`, ensure a source-free `grok --prompt-file` request can complete, then retry the Grok CLI reviewer. Do not switch provider or transport in default CLI mode.";
  }
  if (String(errorCode ?? "").startsWith("grok_cli_")) return "Treat this Grok CLI slot as failed. Inspect runtime diagnostics, repair the local Grok CLI auth/binary/runtime issue, and retry without falling back to another provider or transport.";
  return sharedDiagnostic?.suggested_action ?? "Inspect error_message and repair the local Grok web tunnel before retrying.";
}

function errorCauseFor(errorCode) {
  if (errorCode === "bad_args") return "caller";
  if (errorCode === "scope_failed") return "scope_resolution";
  if (errorCode === "source_packet_too_large" || errorCode === "resend_confirmation_required") {
    return buildExternalModelFailureDiagnostic(errorCode, "Grok")?.error_cause ?? "source_packet_policy";
  }
  if (errorCode === "git_binary_rejected") return "git_binary_policy";
  if (errorCode === "usage_limited") return "cost_quota_usage_limit";
  if (String(errorCode ?? "").startsWith("grok_session_")) return "session_tokens";
  if (errorCode === "grok2api_start_timeout") return "process_start_timeout";
  if (errorCode === "review_not_completed") return "review_quality";
  if (errorCode === "privacy_persistence") return "privacy_persistence";
  if (String(errorCode ?? "").startsWith("grok_cli_")) return "grok_cli";
  return "grok_web_tunnel";
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
  if (keys.length !== GROK_EXPECTED_KEYS.length
      || keys.some((key, index) => key !== GROK_EXPECTED_KEYS[index])) {
    throw new Error(`Grok JobRecord keys drifted: ${keys.join(",")}`);
  }
  return Object.freeze(record);
}

function buildLaunchExternalReview({ cfg, mode, options, scopeInfo }) {
  return freezeExternalReview({
    marker: "EXTERNAL REVIEW",
    provider: cfg.display_name,
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
    disclosure: `Selected source content may be sent to ${cfg.display_name} for external review.`,
  });
}

function buildTerminalExternalReview({ cfg, mode, options, scopeInfo, execution, transmission, reviewDisclosure, reviewSlot = null }) {
  return freezeExternalReview({
    marker: "EXTERNAL REVIEW",
    provider: cfg.display_name,
    run_kind: "foreground",
    job_id: options.jobId,
    session_id: execution.session_id ?? null,
    parent_job_id: null,
    mode,
    scope: scopeInfo?.scope ?? null,
    scope_base: scopeInfo?.scope_base ?? null,
    scope_paths: scopeInfo?.scope_paths ?? null,
    source_content_transmission: transmission,
    review_slot: reviewSlot,
    disclosure: reviewDisclosure,
  });
}

function buildReviewMetadata(cfg, scopeInfo, execution = null, startedAt = null, endedAt = null, options = {}) {
  const sourceBearing = execution?.payload_sent ?? (execution?.exitCode === 0 && execution?.parsed?.ok === true);
  const processCompleted = execution?.exitCode === 0 && execution?.parsed?.ok === true;
  const sourceContentTransmission = sourceContentTransmissionForPayload({
    completed: processCompleted,
    payloadSent: execution?.payload_sent ?? (processCompleted ? true : null),
    errorCode: execution?.parsed?.reason ?? null,
    pidInfo: execution?.pidInfo ?? null,
  });
  const route = selectProviderRoute({
    requestedRoute: "subscription",
    providerCapabilities: providerCapabilitiesForConfig(cfg),
    sourceBearing,
  });
  const auditManifest = execution?.prompt ? buildReviewAuditManifest({
    prompt: execution.prompt,
    sourceFiles: scopeInfo.files ?? [],
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
      timeoutMs: execution.diagnostics?.configured_timeout_ms ?? cfg.timeout_ms ?? null,
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
      selectedRoute: route.selected_route,
      routeStep: route.route_step,
      routeSteps: route.route_steps,
      fallbackReason: cfg.fallback_reason ?? route.fallback_reason,
      approvalScope: null,
      authPath: route.auth_path,
      billingPath: route.billing_path,
      sourceBearing,
      sourceContentTransmission,
      sourceSendApprovalRequired: route.source_send_approval_required,
      sourceSendApprovalState: route.source_send_approval_state,
      providerCapabilities: providerCapabilitiesForConfig(cfg),
      reviewSlot: reviewSlotRouteFields(options, {
        priorAttempts: options.reviewSlotPriorAttempts ?? [],
      }),
      ...sourcePacketOverrideRouteFields(options),
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
      elapsed_ms: elapsedMs(startedAt, endedAt),
    } : null,
    audit_manifest: auditManifest,
  };
}

function buildRecord({ cfg, mode, options, scopeInfo, execution, startedAt, endedAt }) {
  const reviewMetadata = buildReviewMetadata(cfg, scopeInfo, execution, startedAt, endedAt, options);
  const processCompleted = execution.exitCode === 0 && execution.parsed?.ok === true;
  const redactSensitiveText = buildPrivacyRedactor({
    env: process.env,
    sourceFiles: scopeInfo.files,
  }).text;
  const safeDiagnostics = execution.diagnostics
    ? redactValue(execution.diagnostics, redactSensitiveText)
    : null;
  const reviewQuality = reviewMetadata?.audit_manifest?.review_quality ?? null;
  const reviewQualityState = processCompleted
    ? reviewQualityFailureState(reviewQuality, {
      missingReasonsMessage: "review_quality_failed:unknown",
      emptyReasonsMessage: "review_quality_failed:unknown",
    })
    : null;
  const completed = processCompleted && !reviewQualityState;
  const qualityReasons = reviewQuality?.semantic_failure_reasons ?? [];
  const errorCode = completed ? null : (reviewQualityState ? reviewQualityState.error_code : (execution.parsed?.reason ?? "tunnel_error"));
  const rawErrorMessage = completed ? null : (
    reviewQualityState
      ? reviewQualityState.error_message
      : (execution.parsed?.error ?? "")
  );
  const errorMessage = rawErrorMessage == null ? null : redactSensitiveText(rawErrorMessage);
  const diagnostic = reviewQualityState
    ? `review did not complete as a usable external review (${qualityReasons.join(", ") || "review_quality_failed"})`
    : (safeDiagnostics
      ? `${errorMessage || errorCode} (${formatDiagnosticPairs(safeDiagnostics)})`
      : (errorMessage || errorCode));
  const payloadSent = execution.payload_sent ?? (processCompleted ? true : null);
  const reviewDisclosure = disclosure(cfg, completed, payloadSent, errorCode, execution.pidInfo ?? null);
  const transmission = sourceContentTransmissionForPayload({
    completed,
    payloadSent,
    errorCode,
    pidInfo: execution.pidInfo ?? null,
  });
  const runtimeDiagnostics = safeDiagnostics ? (cfg.transport === "cli" ? {
    cli_request: {
      transport: "cli",
      binary: cfg.binary,
      model: safeDiagnostics.model ?? cfg.model,
      grok_version: safeDiagnostics.grok_version ?? null,
      default_model: safeDiagnostics.default_model ?? null,
      logged_in: safeDiagnostics.logged_in ?? null,
      model_ready: safeDiagnostics.model_ready ?? null,
      exit_status: safeDiagnostics.exit_status ?? null,
      exit_signal: safeDiagnostics.exit_signal ?? null,
      stderr_head: safeDiagnostics.stderr_head ?? null,
      parse_mode: safeDiagnostics.parse_mode ?? null,
      source_free_parse_mode: safeDiagnostics.source_free_parse_mode ?? null,
      source_free_prompt_cleanup: safeDiagnostics.source_free_prompt_cleanup ?? null,
      source_free_grok_home_cleanup: safeDiagnostics.source_free_grok_home_cleanup ?? null,
      prompt_chars: safeDiagnostics.prompt_chars ?? null,
      configured_timeout_ms: safeDiagnostics.configured_timeout_ms ?? null,
      max_turns: safeDiagnostics.max_turns ?? null,
      prompt_cleanup: safeDiagnostics.prompt_cleanup ?? null,
      neutral_cwd: safeDiagnostics.neutral_cwd ?? null,
      neutral_cwd_cleanup: safeDiagnostics.neutral_cwd_cleanup ?? null,
      grok_home_source: safeDiagnostics.grok_home_source ?? null,
      grok_home_copied_files: safeDiagnostics.grok_home_copied_files ?? [],
      grok_home_linked_files: safeDiagnostics.grok_home_linked_files ?? [],
      grok_home_cleanup: safeDiagnostics.grok_home_cleanup ?? null,
    },
    cost_quota: null,
  } : {
    ...(safeDiagnostics.cli_request ? { cli_request: safeDiagnostics.cli_request } : {}),
    tunnel_request: {
      endpoint_class: safeDiagnostics.endpoint_class ?? null,
      model: safeDiagnostics.model ?? cfg.model,
      stream: safeDiagnostics.stream ?? null,
      message_count: safeDiagnostics.message_count ?? null,
      prompt_chars: safeDiagnostics.prompt_chars ?? null,
      configured_timeout_ms: safeDiagnostics.configured_timeout_ms ?? null,
      max_tokens: safeDiagnostics.max_tokens ?? null,
      temperature: safeDiagnostics.temperature ?? null,
    },
    tunnel_start: safeDiagnostics.tunnel_start ?? null,
    cost_quota: safeDiagnostics.cost_quota ?? null,
    tunnel_state: safeDiagnostics.tunnel_state ? {
      ...safeDiagnostics.tunnel_state,
      auto_start_attempted: safeDiagnostics.tunnel_start?.attempted ?? safeDiagnostics.tunnel_state.auto_start_attempted ?? false,
    } : null,
    session_tokens: safeDiagnostics.session_tokens ?? null,
  }) : null;
  return freezeRecord({
    id: options.jobId,
    job_id: options.jobId,
    target: cfg.provider,
    provider: cfg.provider,
    fallback_from: cfg.fallback_from ?? null,
    transport: cfg.transport,
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
    binary: cfg.binary ?? null,
    status: completed ? "completed" : "failed",
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: execution.exitCode,
    error_code: errorCode,
    error_message: errorMessage,
    error_summary: completed ? null : diagnostic,
    error_cause: completed ? null : errorCauseFor(errorCode),
    suggested_action: completed ? null : suggestedAction(errorCode, errorMessage, execution.diagnostics?.tunnel_start),
    external_review: buildTerminalExternalReview({
      cfg,
      mode,
      options,
      scopeInfo,
      execution,
      transmission,
      reviewDisclosure,
      reviewSlot: reviewMetadata?.audit_manifest?.review_slot ?? null,
    }),
    disclosure_note: reviewDisclosure,
    runtime_diagnostics: runtimeDiagnostics,
    result: processCompleted ? redactSensitiveText(execution.parsed.result) : null,
    structured_output: null,
    permission_denials: [],
    mutations: [],
    cost_usd: null,
    usage: execution.parsed?.usage ?? null,
    auth_mode: cfg.auth_mode,
    credential_ref: execution.credential_ref ?? null,
    endpoint: execution.endpoint ?? cfg.base_url ?? null,
    http_status: execution.http_status ?? null,
    raw_model: execution.parsed?.raw_model ?? null,
    schema_version: SCHEMA_VERSION,
  });
}

function formatDiagnosticPairs(diagnostics) {
  return Object.entries(diagnostics)
    .filter(([, value]) => value == null || typeof value !== "object")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function defaultDataRoot(pluginName, cwd = process.cwd()) {
  const workspace = resolve(cwd);
  const slug = basename(workspace).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return resolve(tmpdir(), "codex-plugin-multi", pluginName, `${slug}-${hash}`);
}

function dataRoot(env = process.env, cwd = process.cwd()) {
  return resolve(env.GROK_PLUGIN_DATA ?? defaultDataRoot("grok", cwd));
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
  const jobsDir = resolve(root, "jobs");
  let entries = [];
  try {
    entries = await readdir(jobsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const attempts = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^job_[0-9a-f-]{36}$/iu.test(entry.name)) continue;
    if (currentJobId !== null && entry.name === currentJobId) continue;
    try {
      const record = JSON.parse(await readFile(resolve(jobsDir, entry.name, "meta.json"), "utf8"));
      if (record?.job_id !== entry.name) continue;
      const slot = reviewSlotFromRecord(record);
      if (priorSlotCountsTowardRetry(slot)) attempts.push({ review_slot: slot });
    } catch {
      // Malformed legacy artifacts are not trusted as retry-policy evidence.
    }
  }
  return attempts;
}

async function writeJsonFile(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    try { await unlink(tmp); } catch { /* already gone */ }
    throw e;
  }
}

function summaryFromRecord(record) {
  return {
    id: record.job_id,
    job_id: record.job_id,
    target: record.target,
    provider: record.provider,
    status: record.status,
    transport: record.transport,
    mode: record.mode,
    scope: record.scope,
    scope_base: record.scope_base,
    scope_paths: record.scope_paths,
    updatedAt: record.ended_at,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLivePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function staleLockReason(lockDir) {
  let info;
  try {
    info = await stat(lockDir);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const ageMs = Date.now() - info.mtimeMs;
  const identity = { dev: info.dev, ino: info.ino };
  let owner = null;
  let ownerRaw = null;
  try {
    ownerRaw = await readFile(resolve(lockDir, "owner.json"), "utf8");
    owner = JSON.parse(ownerRaw);
  } catch {
    // Missing or malformed owner metadata can only be reclaimed by age.
  }
  const ownerPid = Number(owner?.pid);
  if (owner?.host === hostname() && Number.isSafeInteger(ownerPid) && ownerPid > 0) {
    return isLivePid(ownerPid) ? null : { reason: "dead_owner", ownerRaw, identity };
  }
  if (ageMs > STATE_LOCK_STALE_MS) {
    return { reason: "stale_age", ownerRaw, identity };
  }
  return null;
}

function sameFileIdentity(a, b) {
  return a?.dev === b?.dev && a?.ino === b?.ino;
}

async function maybeRecoverStateLock(lockDir) {
  const stale = await staleLockReason(lockDir);
  if (!stale) return false;
  const staleDir = `${lockDir}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockDir, staleDir);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const renamedInfo = await stat(staleDir);
  let renamedOwnerRaw = null;
  try {
    renamedOwnerRaw = await readFile(resolve(staleDir, "owner.json"), "utf8");
  } catch {
    // Missing owner files are only recoverable when that is what we inspected.
  }
  if (!sameFileIdentity(stale.identity, renamedInfo) || renamedOwnerRaw !== stale.ownerRaw) {
    try { await rename(staleDir, lockDir); } catch { /* best-effort: do not delete a lock we did not inspect */ }
    return false;
  }
  await rm(staleDir, { recursive: true, force: true });
  return true;
}

async function releaseStateLock(lockDir, ownerRaw) {
  try {
    const currentOwnerRaw = await readFile(resolve(lockDir, "owner.json"), "utf8");
    if (currentOwnerRaw !== ownerRaw) return;
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try { await unlink(resolve(lockDir, "owner.json")); } catch { /* best-effort */ }
  try {
    await rmdir(lockDir);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
}

async function withStateLock(root, fn) {
  const lockDir = resolve(root, "state.json.lock");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      const ownerRaw = `${JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt: new Date().toISOString(),
      })}\n`;
      await writeFile(resolve(lockDir, "owner.json"), ownerRaw, { mode: 0o600 });
      let result;
      let fnError;
      try {
        result = await fn();
      } catch (error) {
        fnError = error;
      }
      // Release after capturing fnError so cleanup cannot mask callback failures.
      try {
        await releaseStateLock(lockDir, ownerRaw);
      } catch (releaseError) {
        if (!fnError) throw releaseError;
      }
      if (fnError) throw fnError;
      return result;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await maybeRecoverStateLock(lockDir)) continue;
      await sleep(Math.min(5 + attempt, 50));
    }
  }
  throw new Error("state_lock_timeout: could not acquire Grok state lock");
}

function sortTimestamp(updatedAt) {
  const t = Date.parse(updatedAt ?? "");
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

function sortJobSummaries(jobs) {
  return [...jobs].sort((a, b) => sortTimestamp(b.updatedAt) - sortTimestamp(a.updatedAt));
}

async function discoverJobSummaries(root) {
  const jobsDir = resolve(root, "jobs");
  let entries = [];
  try {
    entries = await readdir(jobsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return [];
  }
  const summaries = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^job_[0-9a-f-]{36}$/iu.test(entry.name)) continue;
    try {
      const record = JSON.parse(await readFile(resolve(jobsDir, entry.name, "meta.json"), "utf8"));
      if (record?.job_id === entry.name) summaries.push(summaryFromRecord(record));
    } catch {
      // Malformed per-job records are reported by `result`; keep the index repair best-effort.
    }
  }
  return sortJobSummaries(summaries);
}

async function persistRecord(record, env = process.env, cwd = record.workspace_root ?? record.cwd ?? process.cwd()) {
  const root = dataRoot(env, cwd);
  const stateFile = resolve(root, "state.json");
  await writeJsonFile(resolve(root, "jobs", record.job_id, "meta.json"), record);

  await withStateLock(root, async () => {
    let priorJobs = [];
    let needsRebuild = false;
    try {
      const parsed = JSON.parse(await readFile(stateFile, "utf8"));
      if (Array.isArray(parsed?.jobs)) priorJobs = parsed.jobs;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) needsRebuild = true;
      else throw error;
    }
    let discoveredJobs = [];
    if (needsRebuild) {
      try {
        discoveredJobs = await discoverJobSummaries(root);
      } catch {
        // The per-job meta.json for this run is already canonical; keep the state update best-effort.
      }
    }
    const summary = summaryFromRecord(record);
    const seen = new Set();
    const jobs = [summary, ...priorJobs, ...discoveredJobs]
      .filter((job) => {
        const id = job?.job_id ?? job?.id;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => sortTimestamp(b.updatedAt) - sortTimestamp(a.updatedAt))
      .slice(0, MAX_STATE_JOBS);
    await writeJsonFile(stateFile, {
      version: 1,
      jobs,
    });
  });
}

async function persistRecordBestEffort(record, env = process.env, cwd = record.workspace_root ?? record.cwd ?? process.cwd()) {
  try {
    await persistRecord(record, env, cwd);
    return record;
  } catch (e) {
    const printable = {
      ...record,
      disclosure_note: `${record.disclosure_note} JobRecord persistence failed: ${redactor(env)(e?.message ?? String(e))}`,
    };
    try {
      await writeJsonFile(resolve(dataRoot(env, cwd), "jobs", record.job_id, "meta.json"), printable);
    } catch {
      // The original failure is already surfaced in disclosure_note.
    }
    return printable;
  }
}

function safeJobId(value) {
  if (typeof value !== "string" || !/^job_[0-9a-f-]{36}$/iu.test(value)) {
    throw new Error("bad_args: --job-id must be a Grok job id");
  }
  return value;
}

async function cmdResult(options, env = process.env) {
  const jobId = safeJobId(options["job-id"] ?? options.job);
  const lookupCwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const root = dataRoot(env, bestEffortWorkspaceRoot(lookupCwd));
  const recordFile = resolve(root, "jobs", jobId, "meta.json");
  try {
    const parsed = JSON.parse(await readFile(recordFile, "utf8"));
    printJson(redactValue(parsed, redactor(env)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      printJson({
        ok: false,
        error_code: "not_found",
        job_id: jobId,
        data_root: root,
        suggested_action:
          `Run result with --job-id ${jobId} --cwd <workspace used when the job was launched>, ` +
          "and reuse the same GROK_PLUGIN_DATA value if one was set.",
      });
      process.exit(1);
    }
    if (error instanceof SyntaxError) {
      printJson({ ok: false, error_code: "malformed_record", job_id: jobId });
      process.exit(1);
    }
    throw error;
  }
}

async function cmdList(env = process.env) {
  const root = dataRoot(env, bestEffortWorkspaceRoot(process.cwd()));
  const stateFile = resolve(root, "state.json");
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    printJson(redactValue({ ok: true, jobs }, redactor(env)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      printJson({ ok: true, jobs: [] });
      return;
    }
    if (error instanceof SyntaxError) {
      try {
        let jobs = [];
        await withStateLock(root, async () => {
          jobs = sortJobSummaries(await discoverJobSummaries(root)).slice(0, MAX_STATE_JOBS);
          await writeJsonFile(stateFile, { version: 1, jobs });
        });
        printJson(redactValue({ ok: true, jobs, repaired_from_disk: true }, redactor(env)));
        return;
      } catch (repairError) {
        const rawMessage = repairError?.message ?? String(repairError);
        const repairCode = String(rawMessage).startsWith("state_lock_timeout")
          ? "state_lock_timeout"
          : "malformed_state";
        printJson({
          ok: false,
          error_code: repairCode,
          error_message: redactor(env)(rawMessage),
        });
        process.exit(1);
      }
    }
    throw error;
  }
}

function pathIsUnder(childPath, parentPath) {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === "" || (rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function grok2ApiDurabilityWarning(homeSource, homePath) {
  if (!homePath) return null;
  if (!pathIsUnder(homePath, tmpdir())) return null;
  return {
    code: "grok2api_ephemeral_bootstrap_home",
    home_source: homeSource ?? null,
    message: "grok2api is using a home under TMPDIR, so synced runtime account/session state can disappear after OS cleanup or reboot.",
    recommendation: "Set GROK2API_HOME or CODEX_PLUGIN_MULTI_RUNTIME_DIR to a durable location before syncing browser session state.",
  };
}

async function durabilityWarningsForDoctor(tunnelStart, env = process.env) {
  const warning = grok2ApiDurabilityWarning(tunnelStart?.home_source, tunnelStart?.home_path);
  if (warning) return [warning];
  const home = await resolveGrok2ApiHome(env);
  if (home.ok) {
    const resolvedWarning = grok2ApiDurabilityWarning(home.source, home.path);
    if (resolvedWarning) return [resolvedWarning];
    return [];
  }
  const legacyTmpHome = legacyTmpGrok2ApiBootstrapDir(env);
  if (await looksLikeGrok2ApiHome(legacyTmpHome)) {
    const legacyWarning = grok2ApiDurabilityWarning("legacy_tmp_bootstrap_dir", legacyTmpHome);
    if (legacyWarning) return [legacyWarning];
  }
  return [];
}

function sessionPoolStatus(sessionDiagnostics) {
  if (sessionDiagnostics?.status !== "checked") return "not_checked";
  if (sessionDiagnostics.error_code === "grok_session_no_runtime_tokens") return "empty";
  if (sessionDiagnostics.error_code === "grok_session_malformed_active_token") return "malformed";
  if (sessionDiagnostics.error_code) return "failed";
  return "ready";
}

function chatProbeStatus(chatProbe) {
  if (chatProbe?.chat_ready === true) return "ready";
  if (chatProbe?.error_code === "grok_session_no_runtime_tokens") return "session_tokens_missing";
  if (chatProbe?.error_code === "usage_limited") return "usage_limited";
  if (chatProbe?.error_code) return "failed";
  return "not_checked";
}

function processStartStatus(tunnelStart) {
  if (!tunnelStart?.attempted) return tunnelStart?.status ?? "not_attempted";
  if (tunnelStart.status === "started") return "started";
  if (tunnelStart.error_code === "grok2api_start_timeout") return "timeout";
  if (tunnelStart.error_code) return "failed";
  return tunnelStart.status ?? "unknown";
}

function modelsLayerStatus(probe) {
  if (probe?.reachable !== true) return "not_checked";
  if (probe.error_code === "grok_session_no_runtime_tokens") return "empty";
  if (probe.models_ready === false) return "failed";
  return "available";
}

function buildReadinessLayers({ probe, tunnelStart, chatProbe, sessionDiagnostics }) {
  return {
    uv_cache: {
      status: tunnelStart?.uv_source ? "ready" : (tunnelStart?.error_code === "grok2api_uv_missing" ? "blocked" : "not_checked"),
      error_code: tunnelStart?.error_code === "grok2api_uv_missing" ? tunnelStart.error_code : null,
    },
    checkout_bootstrap: {
      status: tunnelStart?.home_source ? "ready" : (tunnelStart?.error_code === "grok2api_home_missing" ? "missing" : "not_checked"),
      home_source: tunnelStart?.home_source ?? null,
      bootstrap_status: tunnelStart?.bootstrap?.status ?? null,
      error_code: ["grok2api_home_missing", "grok2api_home_invalid", "grok2api_bootstrap_failed", "grok2api_bootstrap_dir_invalid"].includes(tunnelStart?.error_code)
        ? tunnelStart.error_code
        : null,
    },
    process_start: {
      status: processStartStatus(tunnelStart),
      attempted: tunnelStart?.attempted === true,
      error_code: tunnelStart?.error_code ?? null,
    },
    listener: {
      status: probe?.reachable === true ? "reachable" : "unreachable",
      error_code: probe?.reachable === true ? null : (probe?.error_code ?? null),
      http_status: probe?.http_status ?? null,
    },
    models: {
      status: modelsLayerStatus(probe),
      model_count: probe?.model_count ?? null,
      error_code: probe?.models_ready === false ? (probe.error_code ?? "grok_session_no_runtime_tokens") : null,
      http_status: probe?.http_status ?? null,
    },
    session_pool: {
      status: sessionPoolStatus(sessionDiagnostics),
      error_code: sessionDiagnostics?.error_code ?? null,
      total_token_count: sessionDiagnostics?.total_token_count ?? null,
      active_token_count: sessionDiagnostics?.active_token_count ?? null,
      account_count: sessionDiagnostics?.account_count ?? null,
      pool_count: sessionDiagnostics?.pool_count ?? null,
      runtime_size: sessionDiagnostics?.runtime_size ?? null,
    },
    chat_probe: {
      status: chatProbeStatus(chatProbe),
      error_code: chatProbe?.error_code ?? null,
      http_status: chatProbe?.http_status ?? null,
    },
  };
}

function doctorErrorCode({ ready, probe, tunnelStart, chatProbe, sessionDiagnostics }) {
  if (ready) return null;
  const sessionErrorCode = sessionDiagnostics?.status === "checked" ? sessionDiagnostics.error_code : null;
  if (String(sessionErrorCode ?? "").startsWith("grok_session_")) return sessionErrorCode;
  if (chatProbe?.error_code === "grok_session_no_runtime_tokens") return chatProbe.error_code;
  if (probe?.error_code === "grok_session_no_runtime_tokens") return probe.error_code;
  if (probe?.error_code === "malformed_response") return probe.error_code;
  if (sessionErrorCode) return sessionErrorCode;
  if (tunnelStart?.error_code === "grok2api_start_timeout") return tunnelStart.error_code;
  return chatProbe?.error_code ?? probe?.error_code ?? tunnelStart?.error_code ?? "tunnel_error";
}

async function cliDoctorFields(cfg, env = process.env) {
  const preflight = await grokCliReadinessPreflight(cfg, env);
  const ready = preflight?.ok === true;
  const diagnostics = preflight?.diagnostics ?? {};
  const errorCode = ready ? null : (preflight?.parsed?.reason ?? "grok_cli_unavailable");
  const loginStatus = diagnostics.logged_in === true
    ? "ready"
    : (errorCode === "grok_cli_auth_unavailable" ? "unknown" : "failed");
  const sourceFreeStatus = ready
    ? "ready"
    : (errorCode === "grok_cli_login_required" ? "skipped" : "failed");
  return {
    provider: cfg.provider,
    status: "ok",
    ready,
    reachable: ready,
    models_ready: diagnostics.model_ready ?? (ready ? true : null),
    model_count: null,
    chat_ready: ready,
    summary: ready
      ? "Grok subscription-backed CLI reviewer is configured and source-free preflight-ready."
      : "Grok subscription-backed CLI reviewer is not source-free preflight-ready.",
    next_action: ready
      ? "Run a Grok CLI review."
      : suggestedAction(errorCode, preflight?.parsed?.error ?? ""),
    auth_mode: cfg.auth_mode,
    selected_route: cfg.auth_mode,
    credential_ref: null,
    endpoint: null,
    probe_endpoint: null,
    chat_probe_endpoint: null,
    model: cfg.model,
    binary: cfg.binary,
    grok_version: diagnostics.grok_version ?? preflight?.diagnostics?.grok_version ?? null,
    default_model: diagnostics.default_model ?? null,
    logged_in: diagnostics.logged_in ?? null,
    model_ready: diagnostics.model_ready ?? null,
    ignored_env_credentials: diagnostics.ignored_env_credentials ?? [],
    auth_policy: diagnostics.auth_policy ?? null,
    timeout_ms: cfg.timeout_ms,
    max_turns: cfg.max_turns,
    transport: cfg.transport,
    readiness_layers: {
      cli_binary: {
        status: diagnostics.grok_version ? "ready" : "failed",
        version: diagnostics.grok_version ?? null,
      },
      models: {
        status: diagnostics.model_ready ? "available" : "failed",
        model: cfg.model,
        default_model: diagnostics.default_model ?? null,
      },
      cli_login: {
        status: loginStatus,
        logged_in: diagnostics.logged_in ?? null,
      },
      source_free_prompt: {
        status: sourceFreeStatus,
        parse_mode: diagnostics.source_free_parse_mode ?? null,
        prompt_cleanup: diagnostics.source_free_prompt_cleanup ?? null,
        grok_home_cleanup: diagnostics.grok_home_cleanup ?? null,
      },
    },
    error_code: errorCode,
    error_message: ready ? null : (preflight?.parsed?.error ?? null),
    http_status: null,
    chat_http_status: null,
  };
}

function doctorRouteSummary(doctor) {
  return {
    provider: doctor.provider ?? null,
    ready: doctor.ready === true,
    auth_mode: doctor.auth_mode ?? null,
    transport: doctor.transport ?? null,
    selected_transport: doctor.selected_transport ?? doctor.transport ?? null,
    selected_route: doctor.selected_route ?? null,
    fallback_from: doctor.fallback_from ?? null,
    fallback_reason: doctor.fallback_reason ?? null,
    error_code: doctor.error_code ?? null,
    logged_in: doctor.logged_in ?? null,
    model_ready: doctor.model_ready ?? null,
    models_ready: doctor.models_ready ?? null,
    chat_ready: doctor.chat_ready ?? null,
    readiness_layers: doctor.readiness_layers ?? null,
    next_action: doctor.next_action ?? null,
  };
}

function trustedCliDoctorFailure(cfg, errorMessage, env = process.env) {
  const ignoredEnvCredentials = ignoredGrokDirectApiEnvKeys(cfg, env);
  return {
    provider: cfg.provider,
    status: "ok",
    ready: false,
    reachable: false,
    models_ready: null,
    model_count: null,
    chat_ready: false,
    summary: "Grok subscription-backed CLI reviewer binary is not trusted.",
    next_action: suggestedAction("grok_cli_untrusted_binary", errorMessage),
    auth_mode: cfg.auth_mode,
    selected_route: cfg.auth_mode,
    credential_ref: null,
    endpoint: null,
    probe_endpoint: null,
    chat_probe_endpoint: null,
    model: cfg.model,
    binary: cfg.binary,
    grok_version: null,
    default_model: null,
    logged_in: null,
    model_ready: null,
    ignored_env_credentials: ignoredEnvCredentials,
    auth_policy: ignoredEnvCredentials.length > 0 ? "api_key_env_ignored" : null,
    timeout_ms: cfg.timeout_ms,
    max_turns: cfg.max_turns,
    transport: cfg.transport,
    readiness_layers: {
      cli_binary: {
        status: "failed",
        error_code: "grok_cli_untrusted_binary",
      },
      models: {
        status: "not_checked",
        model: cfg.model,
        default_model: null,
      },
      cli_login: {
        status: "not_checked",
        logged_in: null,
      },
      source_free_prompt: {
        status: "skipped",
        parse_mode: null,
        prompt_cleanup: null,
        grok_home_cleanup: null,
      },
    },
    error_code: "grok_cli_untrusted_binary",
    error_message: errorMessage,
    http_status: null,
    chat_http_status: null,
  };
}

async function autoDoctorFields(cfg, env = process.env) {
  let primary;
  try {
    const trustedCfg = resolveTrustedGrokCliConfig(cfg, {
      cwd: process.cwd(),
      workspaceRoot: bestEffortWorkspaceRoot(process.cwd()),
      env,
    });
    primary = await cliDoctorFields(trustedCfg, env);
  } catch (error) {
    primary = trustedCliDoctorFailure(cfg, redactor(env)(error?.message ?? String(error)), env);
  }

  if (primary.ready === true || !GROK_CLI_AUTO_FALLBACK_CODES.has(primary.error_code)) {
    return {
      ...primary,
      requested_transport: "auto",
      transport: "auto",
      selected_transport: "cli",
      selected_route: "subscription_cli",
      fallback_from: null,
      fallback_reason: null,
      auto_transport: {
        primary: doctorRouteSummary(primary),
        fallback: null,
      },
    };
  }

  const fallback = await doctorFields(env, { transport: "web" });
  const fallbackReady = fallback.ready === true;
  const fallbackReason = primary.error_code ?? "grok_cli_unavailable";
  return {
    ...fallback,
    provider: "grok",
    status: fallbackReady ? "fallback_ready" : "fallback_not_ready",
    ready: fallbackReady,
    reachable: fallback.reachable ?? false,
    models_ready: fallback.models_ready ?? null,
    model_count: fallback.model_count ?? null,
    chat_ready: fallback.chat_ready ?? false,
    summary: fallbackReady
      ? "Grok auto transport CLI primary is not ready, but the local web fallback is ready."
      : "Grok auto transport CLI primary and local web fallback are not ready.",
    next_action: fallbackReady
      ? `${primary.next_action} Until CLI auth is repaired, rerun with --transport auto to use the ready local web fallback while preserving the CLI failure metadata.`
      : `${primary.next_action} Local web fallback is also not ready: ${fallback.next_action}`,
    auth_mode: fallback.auth_mode ?? primary.auth_mode,
    credential_ref: fallback.credential_ref ?? primary.credential_ref,
    endpoint: fallback.endpoint ?? primary.endpoint,
    probe_endpoint: fallback.probe_endpoint ?? primary.probe_endpoint,
    chat_probe_endpoint: fallback.chat_probe_endpoint ?? primary.chat_probe_endpoint,
    model: fallback.model ?? primary.model,
    timeout_ms: fallback.timeout_ms ?? primary.timeout_ms,
    transport: "auto",
    requested_transport: "auto",
    selected_transport: "web",
    selected_route: "subscription_web",
    fallback_from: "cli",
    fallback_reason: fallbackReason,
    auto_transport: {
      primary: doctorRouteSummary(primary),
      fallback: doctorRouteSummary(fallback),
    },
    error_code: fallbackReady ? null : (fallback.error_code ?? fallbackReason),
    error_message: fallbackReady ? null : (fallback.error_message ?? primary.error_message ?? null),
    http_status: fallback.http_status ?? primary.http_status ?? null,
    chat_http_status: fallback.chat_http_status ?? primary.chat_http_status ?? null,
  };
}

async function doctorFields(env = process.env, options = {}) {
  let cfg = config(env, options);
  if (cfg.transport === "cli" && cfg.requested_transport === "auto") return autoDoctorFields(cfg, env);
  if (cfg.transport === "cli") {
    try {
      cfg = resolveTrustedGrokCliConfig(cfg, {
        cwd: process.cwd(),
        workspaceRoot: bestEffortWorkspaceRoot(process.cwd()),
        env,
      });
    } catch (error) {
      const errorMessage = redactor(env)(error?.message ?? String(error));
      return trustedCliDoctorFailure(cfg, errorMessage, env);
    }
    return cliDoctorFields(cfg, env);
  }
  const costQuotaReadiness = {
    status: "unknown_not_probed",
    source: "doctor_does_not_call_billing_or_usage_endpoints",
    billing_mutation: "not_supported",
  };
  const readiness = await ensureGrokTunnelReachable(cfg, env);
  const probe = readiness.probe;
  const tunnelStart = readiness.tunnel_start;
  const chatProbe = probe.reachable ? await probeGrokChat(cfg, env) : {
    chat_ready: false,
    error_code: probe.error_code,
    error_message: probe.error_message,
    http_status: null,
    probe_endpoint: `${cfg.base_url}/chat/completions`,
  };
  const sessionDiagnostics = probe.reachable && (chatProbe.chat_ready !== true || probe.models_ready === false)
    ? await probeGrokSessionDiagnostics(cfg, env)
    : {
      status: "not_checked",
      reason: "chat_probe_ready_or_tunnel_unreachable",
      error_code: null,
    };
  const ready = probe.reachable === true && probe.models_ready !== false && chatProbe.chat_ready === true;
  const errorCode = doctorErrorCode({ ready, probe, tunnelStart, chatProbe, sessionDiagnostics });
  const sessionErrorMessage = sessionDiagnostics.status === "checked" ? sessionDiagnostics.error_message : null;
  const readinessLayers = buildReadinessLayers({ probe, tunnelStart, chatProbe, sessionDiagnostics });
  const durabilityWarnings = await durabilityWarningsForDoctor(tunnelStart, env);
  return {
    provider: "grok-web",
    status: "ok",
    ready,
    reachable: probe.reachable,
    models_ready: probe.models_ready ?? null,
    model_count: probe.model_count ?? null,
    chat_ready: chatProbe.chat_ready,
    summary: ready
      ? "Grok subscription-backed local tunnel reviewer is configured and chat-ready."
      : (probe.reachable && probe.models_ready === false && probe.error_code === "grok_session_no_runtime_tokens"
        ? "Grok tunnel listener is reachable, but the grok2api model/account pool is empty."
        : (probe.reachable && probe.models_ready === false
        ? "Grok tunnel listener is reachable, but the grok2api models endpoint returned an unsupported response shape."
        : (probe.reachable
        ? "Grok tunnel models endpoint is reachable, but chat completion is not review-ready."
        : "Grok subscription-backed local tunnel is not reachable."))),
    next_action: ready
      ? "Run a Grok web review."
      : suggestedAction(errorCode, "", tunnelStart),
    auth_mode: cfg.auth_mode,
    selected_route: cfg.auth_mode,
    credential_ref: cfg.credential_ref,
    endpoint: cfg.base_url,
    probe_endpoint: probe.probe_endpoint,
    chat_probe_endpoint: chatProbe.probe_endpoint,
    model: cfg.model,
    timeout_ms: cfg.timeout_ms,
    doctor_timeout_ms: cfg.doctor_timeout_ms,
    chat_doctor_timeout_ms: cfg.chat_doctor_timeout_ms,
    transport: cfg.transport,
    tunnel_start_timeout_ms: cfg.tunnel_start_timeout_ms,
    tunnel_cleanup_timeout_ms: cfg.tunnel_cleanup_timeout_ms,
    tunnel_start: tunnelStart,
    durability_warnings: durabilityWarnings,
    readiness_layers: readinessLayers,
    chat_probe: {
      status: chatProbeStatus(chatProbe),
      error_code: chatProbe.error_code ?? null,
      error_message: chatProbe.error_message ?? null,
      http_status: chatProbe.http_status ?? null,
      probe_endpoint: chatProbe.probe_endpoint ?? null,
    },
    session_diagnostics: sessionDiagnostics,
    cost_quota_readiness: costQuotaReadiness,
    error_code: errorCode,
    error_message: ready ? null : (sessionErrorMessage ?? chatProbe.error_message ?? probe.error_message ?? tunnelStart?.message ?? null),
    http_status: probe.http_status,
    chat_http_status: chatProbe.http_status,
  };
}

function safeDoctorForRepair(doctor) {
  return {
    ready: doctor.ready === true,
    summary: doctor.summary ?? null,
    next_action: doctor.next_action ?? null,
    error_code: doctor.error_code ?? null,
    tunnel_start: {
      error_code: doctor.tunnel_start?.error_code ?? null,
    },
    session_diagnostics: {
      error_code: doctor.session_diagnostics?.error_code ?? null,
      total_token_count: doctor.session_diagnostics?.total_token_count ?? null,
      active_token_count: doctor.session_diagnostics?.active_token_count ?? null,
      malformed_active_token_count: doctor.session_diagnostics?.malformed_active_token_count ?? null,
      deleted_token_count: doctor.session_diagnostics?.deleted_token_count ?? null,
      account_count: doctor.session_diagnostics?.account_count ?? null,
      pool_count: doctor.session_diagnostics?.pool_count ?? null,
    },
    models_ready: doctor.models_ready ?? null,
    model_count: doctor.model_count ?? null,
    chat_probe: {
      status: doctor.chat_probe?.status ?? null,
      error_code: doctor.chat_probe?.error_code ?? null,
      http_status: doctor.chat_probe?.http_status ?? null,
    },
    durability_warning_present: Array.isArray(doctor.durability_warnings) && doctor.durability_warnings.length > 0,
  };
}

function repairNeedsSessionSync(doctor) {
  return isSessionSyncRepairableError(doctor?.error_code)
    || isSessionSyncRepairableError(doctor?.session_diagnostics?.error_code)
    || isSessionSyncRepairableError(doctor?.chat_probe?.error_code);
}

function isSessionSyncRepairableError(errorCode) {
  return errorCode === "grok_session_no_runtime_tokens"
    || errorCode === "grok_session_malformed_active_token";
}

function repairSyncApproved(options) {
  return options["approve-browser-session-sync"] === true
    || String(options["approve-browser-session-sync"] ?? "").toLowerCase() === "true";
}

function repairSyncArgs(options) {
  const args = [];
  for (const key of ["browser", "profile", "cookie-source-json", "cookie-db", "pool", "admin-timeout-ms"]) {
    if (options[key] !== undefined && options[key] !== true) args.push(`--${key}`, String(options[key]));
  }
  if (options.append === true || String(options.append ?? "").toLowerCase() === "true") args.push("--append");
  return args;
}

function summarizeSyncResult(result, env = process.env) {
  const redact = redactor(env);
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }
  if (result.status === 0 && parsed?.ok === true) {
    return {
      status: "completed",
      error_code: null,
      source: parsed.source ?? null,
      selected_cookie: parsed.selected_cookie ?? null,
      pool: parsed.pool ?? null,
      append: parsed.append ?? null,
      deleted_count: parsed.deleted_count ?? null,
      token_count: Array.isArray(parsed.tokens) ? parsed.tokens.length : null,
    };
  }
  return {
    status: "failed",
    error_code: parsed?.error_code ?? "grok_browser_session_sync_failed",
    error_message: redact(parsed?.error_message ?? result.stderr ?? result.stdout ?? `sync exited ${result.status ?? "unknown"}`),
    source: parsed?.source ?? null,
  };
}

function runBrowserSessionSync(cfg, options, env = process.env) {
  const childEnv = {
    ...env,
    GROK2API_BASE_URL: cfg.grok2api_base_url,
    GROK2API_ADMIN_KEY: cfg.grok2api_admin_key,
  };
  const result = spawnSync(process.execPath, [GROK_SESSION_SYNC_SCRIPT, ...repairSyncArgs(options)], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return summarizeSyncResult(result, childEnv);
}

async function repairFields(options = {}, env = process.env) {
  const cfg = config(env, options);
  const initialDoctor = await doctorFields(env, options);
  const initialSafe = safeDoctorForRepair(initialDoctor);
  if (initialDoctor.ready === true) {
    return {
      ok: true,
      status: "ready",
      provider: cfg.provider,
      summary: "Grok reviewer is already ready.",
      next_action: `Run a ${cfg.display_name} review.`,
      error_code: null,
      initial_doctor: initialSafe,
      sync_session: {
        status: "not_needed",
        source_content_transmission: "not_sent",
      },
      final_doctor: initialSafe,
    };
  }
  if (cfg.transport === "cli" && isGrokCliAuthRepairCode(initialDoctor.error_code)) {
    return {
      ok: false,
      status: "cli_auth_required",
      provider: cfg.provider,
      summary: initialDoctor.summary,
      next_action: initialDoctor.next_action,
      error_code: initialDoctor.error_code,
      initial_doctor: initialSafe,
      sync_session: {
        status: "not_attempted",
        source_content_transmission: "not_sent",
      },
      final_doctor: initialSafe,
    };
  }
  if (!repairNeedsSessionSync(initialDoctor)) {
    return {
      ok: false,
      status: "not_repairable",
      provider: cfg.provider,
      summary: initialDoctor.summary,
      next_action: initialDoctor.next_action,
      error_code: initialDoctor.error_code,
      initial_doctor: initialSafe,
      sync_session: {
        status: "not_attempted",
        source_content_transmission: "not_sent",
      },
      final_doctor: initialSafe,
    };
  }
  if (!repairSyncApproved(options)) {
    return {
      ok: false,
      status: "approval_required",
      provider: cfg.provider,
      summary: "Grok tunnel is reachable, but session repair requires explicit approval before browser-backed session material is read.",
      next_action: "Rerun npm run grok:repair-session -- --approve-browser-session-sync after approving browser/session sync for this invocation.",
      error_code: "browser_session_sync_approval_required",
      initial_doctor: initialSafe,
      sync_session: {
        status: "approval_required",
        error_code: "browser_session_sync_approval_required",
        source_content_transmission: "not_sent",
      },
      final_doctor: initialSafe,
    };
  }

  const syncSession = runBrowserSessionSync(cfg, options, env);
  if (syncSession.status !== "completed") {
    return {
      ok: false,
      status: "sync_failed",
      provider: cfg.provider,
      summary: "Browser/session sync failed; Grok reviewer readiness was not repaired.",
      next_action: "Inspect sync_session.error_code and rerun repair after fixing the reported browser/session sync issue.",
      error_code: syncSession.error_code,
      initial_doctor: initialSafe,
      sync_session: {
        ...syncSession,
        source_content_transmission: "sent_after_explicit_approval",
      },
      final_doctor: initialSafe,
    };
  }

  const finalDoctor = await doctorFields(env, options);
  return {
    ok: finalDoctor.ready === true,
    status: finalDoctor.ready === true ? "ready" : "not_ready",
    provider: cfg.provider,
    summary: finalDoctor.ready === true
      ? "Grok browser/session sync completed and doctor is now ready."
      : "Grok browser/session sync completed, but doctor is still not ready.",
    next_action: finalDoctor.ready === true ? `Run a ${cfg.display_name} review.` : finalDoctor.next_action,
    error_code: finalDoctor.ready === true ? null : finalDoctor.error_code,
    initial_doctor: initialSafe,
    sync_session: {
      ...syncSession,
      source_content_transmission: "sent_after_explicit_approval",
    },
    final_doctor: safeDoctorForRepair(finalDoctor),
  };
}

const GROK_CLI_AUTO_FALLBACK_CODES = new Set([
  "grok_cli_unavailable",
  "grok_cli_auth_unavailable",
  "grok_cli_login_required",
  "grok_cli_auth_timeout",
  "grok_cli_model_unavailable",
]);

function canAutoFallbackFromCliExecution(cfg, execution) {
  if (cfg?.requested_transport !== "auto" || cfg?.transport !== "cli") return false;
  if (!execution || execution.exitCode === 0 || execution.payload_sent !== false) return false;
  return GROK_CLI_AUTO_FALLBACK_CODES.has(execution.parsed?.reason);
}

function cliRequestDiagnosticsForFallback(execution) {
  const diagnostics = execution?.diagnostics ?? {};
  return {
    transport: "cli",
    error_code: execution?.parsed?.reason ?? null,
    model: diagnostics.model ?? null,
    grok_version: diagnostics.grok_version ?? null,
    default_model: diagnostics.default_model ?? null,
    logged_in: diagnostics.logged_in ?? null,
    model_ready: diagnostics.model_ready ?? null,
    exit_status: diagnostics.exit_status ?? null,
    exit_signal: diagnostics.exit_signal ?? null,
    stderr_head: diagnostics.stderr_head ?? null,
    parse_mode: diagnostics.parse_mode ?? null,
    source_free_parse_mode: diagnostics.source_free_parse_mode ?? null,
    source_free_prompt_cleanup: diagnostics.source_free_prompt_cleanup ?? null,
    source_free_grok_home_cleanup: diagnostics.source_free_grok_home_cleanup ?? null,
    prompt_chars: diagnostics.prompt_chars ?? null,
    configured_timeout_ms: diagnostics.configured_timeout_ms ?? null,
    max_turns: diagnostics.max_turns ?? null,
    prompt_cleanup: diagnostics.prompt_cleanup ?? null,
    neutral_cwd: diagnostics.neutral_cwd ?? null,
    neutral_cwd_cleanup: diagnostics.neutral_cwd_cleanup ?? null,
    grok_home_source: diagnostics.grok_home_source ?? null,
    grok_home_copied_files: diagnostics.grok_home_copied_files ?? [],
    grok_home_linked_files: diagnostics.grok_home_linked_files ?? [],
    grok_home_cleanup: diagnostics.grok_home_cleanup ?? null,
  };
}

async function executeWebReview({ cfg, mode, options, scopeInfo, prompt, lifecycleEvents }) {
  let tunnelStart = null;
  let promptSentToTunnel = false;
  let webReadiness = await grokReviewReadinessPreflight(cfg);
  let execution = webReadiness?.ok === true ? null : webReadiness?.execution;
  if (execution && isTunnelTransportExecution(execution)) {
    ({ tunnel_start: tunnelStart } = await ensureGrokTunnelReachable(cfg));
    if (tunnelStart?.status === "started") {
      webReadiness = await grokReviewReadinessPreflight(cfg);
      execution = webReadiness?.ok === true ? null : webReadiness?.execution;
    }
  }
  if (!execution && lifecycleEvents) {
    printLifecycleJson({
      event: "external_review_launched",
      job_id: options.jobId,
      target: cfg.provider,
      status: "launched",
      external_review: buildLaunchExternalReview({ cfg, mode, options, scopeInfo }),
    }, lifecycleEvents);
  }
  if (!execution) {
    const stopHeartbeat = startLifecycleHeartbeat({
      job_id: options.jobId,
      target: cfg.provider,
      mode,
      cwd: scopeInfo.cwd,
      workspace_root: scopeInfo.workspaceRoot,
      external_review: buildLaunchExternalReview({ cfg, mode, options, scopeInfo }),
    }, lifecycleEvents);
    try {
      promptSentToTunnel = true;
      execution = await callGrokTunnel(cfg, prompt);
    } finally {
      stopHeartbeat();
    }
  }
  execution.diagnostics = {
    ...(webReadiness?.ok === true ? webReadiness.diagnostics : {}),
    ...(execution.diagnostics ?? {}),
    tunnel_start: tunnelStart,
  };
  if (promptSentToTunnel) execution.prompt = prompt;
  return { execution, promptSentToTunnel, webReadiness, tunnelStart };
}

async function cmdRun(options) {
  const mode = options.mode ?? "review";
  let lifecycleEvents = null;
  const startedAt = new Date().toISOString();
  let cfg = null;
  const jobId = `job_${randomUUID()}`;
  const runOptions = { ...options, jobId };
  let scopeInfo;
  let execution;
  try {
    lifecycleEvents = parseLifecycleEventsMode(options["lifecycle-events"]);
    cfg = config(process.env, options);
    if (!VALID_MODES.has(mode)) throw new Error(`bad_args: unsupported --mode ${mode}`);
    scopeInfo = await collectScope({ ...runOptions, mode });
    runOptions.reviewSlotPriorAttempts = await collectPriorReviewSlotAttempts(
      dataRoot(process.env, scopeInfo.workspaceRoot ?? scopeInfo.cwd),
      jobId,
    );
  } catch (e) {
    cfg ??= fallbackConfig(process.env, options);
    const cwd = resolve(process.cwd());
    const policyError = isGitBinaryPolicyError(e);
    scopeInfo = {
      cwd,
      workspaceRoot: policyError ? cwd : bestEffortWorkspaceRoot(cwd),
      scope: options.scope ?? null,
      scope_base: options["scope-base"] ?? null,
      scope_paths: splitScopePaths(options["scope-paths"]),
    };
    execution = providerFailure(policyError ? "git_binary_rejected" : (e.message.startsWith("bad_args:") ? "bad_args" : "scope_failed"), redactor()(e.message), null, null, false);
  }
  if (!execution) {
    if (!hasPromptText(options.prompt)) {
      execution = providerFailure("bad_args", "prompt is required (pass --prompt <focus>)", null, null, false);
    }
  }
  if (!execution) {
    let prompt;
    let tunnelStart = null;
    let promptSentToTunnel = false;
    let webReadiness = null;
    try {
      prompt = promptFor(cfg, mode, options.prompt ?? "", scopeInfo);
      execution = sourcePacketPolicyPreflight({ cfg, mode, prompt, scopeInfo, options: runOptions });
      if (!execution && prompt.length > cfg.max_prompt_chars) {
        const capName = cfg.transport === "cli" ? "GROK_CLI_MAX_PROMPT_CHARS" : "GROK_WEB_MAX_PROMPT_CHARS";
        execution = providerFailure("prompt_too_large", redactor()(`prompt_too_large:${prompt.length} chars exceeds ${capName}=${cfg.max_prompt_chars}`), null, null, false);
        execution.prompt = prompt;
      }
    } catch (e) {
      execution = providerFailure(e.message.startsWith("bad_args:") ? "bad_args" : "scope_failed", redactor()(e.message), null, null, false);
    }
    if (!execution) try {
      if (cfg.transport === "cli") {
        try {
          cfg = resolveTrustedGrokCliConfig(cfg, {
            cwd: scopeInfo.cwd,
            workspaceRoot: scopeInfo.workspaceRoot,
            env: process.env,
          });
        } catch (error) {
          execution = providerFailure("grok_cli_untrusted_binary", redactor()(error?.message ?? String(error)), null, null, false);
        }
        const cliPreflight = execution ? null : await grokCliReadinessPreflight(cfg);
        if (cliPreflight?.ok === true) {
          execution = null;
        } else if (!execution) {
          execution = cliPreflight;
        }
        if (!execution && lifecycleEvents) {
          printLifecycleJson({
            event: "external_review_launched",
            job_id: jobId,
            target: cfg.provider,
            status: "launched",
            external_review: buildLaunchExternalReview({ cfg, mode, options: runOptions, scopeInfo }),
          }, lifecycleEvents);
        }
        if (!execution) {
          const stopHeartbeat = startLifecycleHeartbeat({
            job_id: jobId,
            target: cfg.provider,
            mode,
            cwd: scopeInfo.cwd,
            workspace_root: scopeInfo.workspaceRoot,
            external_review: buildLaunchExternalReview({ cfg, mode, options: runOptions, scopeInfo }),
          }, lifecycleEvents);
          try {
            promptSentToTunnel = true;
            execution = await callGrokCli(cfg, prompt, {
              sourceBearing: modeSendsSelectedSource(mode),
              baseDiagnostics: cliPreflight.diagnostics,
            });
          } finally {
            stopHeartbeat();
          }
        }
        if (canAutoFallbackFromCliExecution(cfg, execution)) {
          const cliFailure = execution;
          cfg = webAutoFallbackConfig(process.env, cliFailure.parsed?.reason ?? "grok_cli_unavailable");
          prompt = promptFor(cfg, mode, options.prompt ?? "", scopeInfo);
          const fallbackSourcePacketPreflight = sourcePacketPolicyPreflight({ cfg, mode, prompt, scopeInfo, options: runOptions });
          if (fallbackSourcePacketPreflight) {
            execution = fallbackSourcePacketPreflight;
            execution.diagnostics = {
              cli_request: cliRequestDiagnosticsForFallback(cliFailure),
              ...(execution.diagnostics ?? {}),
            };
          } else if (prompt.length > cfg.max_prompt_chars) {
            execution = providerFailure("prompt_too_large", redactor()(`prompt_too_large:${prompt.length} chars exceeds GROK_WEB_MAX_PROMPT_CHARS=${cfg.max_prompt_chars}`), null, null, false);
            execution.diagnostics = {
              cli_request: cliRequestDiagnosticsForFallback(cliFailure),
              ...(execution.diagnostics ?? {}),
            };
            execution.prompt = prompt;
          } else {
            const webExecution = await executeWebReview({
              cfg,
              mode,
              options: runOptions,
              scopeInfo,
              prompt,
              lifecycleEvents,
            });
            execution = webExecution.execution;
            execution.diagnostics = {
              cli_request: cliRequestDiagnosticsForFallback(cliFailure),
              ...(execution.diagnostics ?? {}),
            };
            promptSentToTunnel = webExecution.promptSentToTunnel;
          }
        }
      } else {
        const webExecution = await executeWebReview({
          cfg,
          mode,
          options: runOptions,
          scopeInfo,
          prompt,
          lifecycleEvents,
        });
        execution = webExecution.execution;
        promptSentToTunnel = webExecution.promptSentToTunnel;
      }
      if (promptSentToTunnel) execution.prompt = prompt;
    } catch (e) {
      execution = providerFailureWithDiagnostic(
        e.message.startsWith("bad_args:") ? "bad_args" : (cfg.transport === "cli" ? "grok_cli_failed" : "tunnel_error"),
        redactor()(e.message),
        null,
        null,
        payloadSentForFetchError(e),
        { configured_timeout_ms: cfg.timeout_ms, tunnel_start: tunnelStart, transport: cfg.transport },
      );
      if (promptSentToTunnel && prompt) execution.prompt = prompt;
    }
  }
  const record = redactValue(buildRecord({
    cfg,
    mode,
    options: runOptions,
    scopeInfo,
    execution,
    startedAt,
    endedAt: new Date().toISOString(),
  }), redactor());
  const printable = await persistRecordBestEffort(record, process.env, record.workspace_root ?? record.cwd);
  printLifecycleJson(printable, lifecycleEvents);
  process.exit(record.status === "completed" ? 0 : 1);
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (cmd === "doctor" || cmd === "ping") {
    printJson(redactValue(await doctorFields(process.env, options), redactor()));
    return;
  }
  if (cmd === "repair") {
    printJson(redactValue(await repairFields(options), redactor()));
    return;
  }
  if (cmd === "run") return cmdRun(options);
  if (cmd === "result") return cmdResult(options);
  if (cmd === "list") return cmdList();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    const cfg = config(process.env, options);
    printJson({
      ok: true,
      commands: ["doctor", "ping", "repair", "run", "result", "list"],
      provider: cfg.provider,
      default_auth_mode: cfg.auth_mode,
      default_transport: "cli",
      selected_transport: cfg.requested_transport ?? cfg.transport,
      legacy_transport: "web",
      default_endpoint: cfg.base_url,
    });
    return;
  }
  throw new Error(`unknown_command:${cmd}`);
}

async function runCli() {
  try {
    await main();
  } catch (e) {
    const message = e?.message ?? String(e);
    if (String(message).startsWith("bad_args:")) {
      printJson({ ok: false, error_code: "bad_args", error_message: redactor()(message) });
    } else {
      printJson({ ok: false, error: redactor()(message) });
    }
    process.exit(1);
  }
}

export {
  buildReviewMetadata,
  readUtf8ScopeFileWithinLimit,
  releaseStateLock,
  runCli,
  sameFileIdentity,
  sortJobSummaries,
  staleLockReason,
  withStateLock,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
