#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanGitEnv as cleanCanonicalGitEnv } from "./lib/git-env.mjs";

const VALID_MODES = new Set(["review", "adversarial-review", "custom-review"]);
const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const DEFAULT_MODEL = "grok-4.20-fast";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DOCTOR_TIMEOUT_MS = 2000;
const MAX_SCOPE_FILE_BYTES = 256 * 1024;
const MAX_SCOPE_TOTAL_BYTES = 1024 * 1024;
const MAX_STATE_JOBS = 50;
const STATE_LOCK_STALE_MS = 60 * 1000;
const SCHEMA_VERSION = 9;
const MIN_SECRET_REDACTION_LENGTH = 8;

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function normalizeBaseUrl(value) {
  let url = String(value || DEFAULT_BASE_URL);
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function config(env = process.env) {
  return {
    provider: "grok-web",
    display_name: "Grok Web",
    auth_mode: "subscription_web",
    base_url: normalizeBaseUrl(env.GROK_WEB_BASE_URL),
    model: env.GROK_WEB_MODEL || DEFAULT_MODEL,
    timeout_ms: parsePositiveInteger(env.GROK_WEB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    doctor_timeout_ms: parsePositiveInteger(env.GROK_WEB_DOCTOR_TIMEOUT_MS, DEFAULT_DOCTOR_TIMEOUT_MS),
    credential_ref: env.GROK_WEB_TUNNEL_API_KEY ? "GROK_WEB_TUNNEL_API_KEY" : null,
    credential_value: env.GROK_WEB_TUNNEL_API_KEY || null,
  };
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function redactor(env = process.env) {
  const secrets = [];
  for (const [name, value] of Object.entries(env)) {
    if (!/(?:API_KEY|TOKEN|COOKIE|SESSION|SSO)/i.test(name) || typeof value !== "string") continue;
    const candidates = [value];
    if (value.includes(";")) {
      candidates.push(...value.split(";").map((part) => part.trim()).filter(Boolean));
      candidates.push(...value.split(";").map((part) => part.split("=").slice(1).join("=").trim()).filter(Boolean));
    }
    for (const candidate of candidates) {
      if (candidate.length >= MIN_SECRET_REDACTION_LENGTH) secrets.push(candidate);
    }
  }
  return (text) => {
    let out = String(text ?? "");
    for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
    out = out.replace(/Authorization:\s*\S+(?:\s+\S{8,})?/gi, "Authorization: [REDACTED]");
    out = out.replace(/Bearer\s+\S{8,}/gi, "Bearer [REDACTED]");
    return out;
  };
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
  const res = runCommand("git", args, { cwd, env: cleanGitEnv() });
  if (res.error) throw new Error(`git_failed:${res.error.message}`);
  if (res.signal) throw new Error(`git_failed:signal:${res.signal}`);
  if (res.status !== 0) {
    if (options.allowFailure) return null;
    const detail = String(res.stderr || res.stdout || `git exited with status ${res.status}`).trim();
    throw new Error(`git_failed:${detail}`);
  }
  return res.stdout.trim();
}

function bestEffortWorkspaceRoot(cwd) {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd, { allowFailure: true }) || cwd;
  } catch {
    return cwd;
  }
}

function splitScopePaths(value) {
  if (!value) return [];
  return String(value).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function scopeName(options) {
  return options.scope ?? (options.mode === "custom-review" ? "custom" : "branch-diff");
}

function selectedScopePaths(scope, options, cwd) {
  if (scope === "custom") {
    const relPaths = splitScopePaths(options["scope-paths"]);
    if (relPaths.length === 0) throw new Error("scope_paths_required: custom-review requires --scope-paths");
    return relPaths;
  }
  if (scope === "branch-diff") {
    const base = options["scope-base"] ?? "main";
    const changed = git(["diff", "--name-only", `${base}...HEAD`, "--"], cwd);
    const relPaths = changed ? changed.split("\n").filter(Boolean) : [];
    if (relPaths.length === 0) throw new Error("scope_empty: branch-diff selected no files");
    return relPaths;
  }
  throw new Error(`unsupported_scope:${scope}`);
}

async function readScopeFiles(workspaceRoot, relPaths) {
  const files = [];
  let totalBytes = 0;
  const realWorkspaceRoot = await realpath(workspaceRoot);
  for (const relPath of relPaths) {
    if (relPath.includes("..") || isAbsolute(relPath) || relPath.includes("\\")) {
      throw new Error(`unsafe_scope_path:${relPath}`);
    }
    const abs = resolve(workspaceRoot, relPath);
    const normalizedRel = relative(workspaceRoot, abs);
    if (normalizedRel.startsWith("..") || normalizedRel === "") {
      throw new Error(`unsafe_scope_path:${relPath}`);
    }
    if (!existsSync(abs)) continue;
    const realAbs = await realpath(abs);
    const realRel = relative(realWorkspaceRoot, realAbs);
    if (realRel.startsWith("..") || realRel === "") {
      throw new Error(`unsafe_scope_path:${relPath}`);
    }
    const info = await stat(realAbs);
    if (!info.isFile()) continue;
    if (info.size > MAX_SCOPE_FILE_BYTES) {
      throw new Error(`scope_file_too_large:${normalizedRel}: ${info.size} bytes exceeds ${MAX_SCOPE_FILE_BYTES} byte limit`);
    }
    totalBytes += info.size;
    if (totalBytes > MAX_SCOPE_TOTAL_BYTES) {
      throw new Error(`scope_total_too_large:${totalBytes} bytes exceeds ${MAX_SCOPE_TOTAL_BYTES} byte limit`);
    }
    const text = await readFile(realAbs, "utf8");
    if (text.length === 0) continue;
    files.push({ path: normalizedRel, text });
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
  const relPaths = selectedScopePaths(scope, options, cwd);
  const files = await readScopeFiles(workspaceRoot, relPaths);
  return { cwd, workspaceRoot, scope, scope_base: scopeBase, scope_paths: relPaths, files };
}

function promptFor(mode, userPrompt, scopeInfo) {
  const modeLine = mode === "adversarial-review"
    ? "You are performing an adversarial code review. Prioritize correctness bugs, security risks, regressions, and missing tests."
    : "You are performing a code review. Prioritize bugs, behavioral regressions, and missing tests.";
  const files = scopeInfo.files.map((file, index) => promptFileBlock(file, index + 1)).join("\n\n");
  return [
    modeLine,
    "Return a concise verdict and findings. Do not edit files.",
    "This request is routed through a local subscription-backed Grok web tunnel, not paid xAI API billing.",
    userPrompt ? `User prompt:\n${userPrompt}` : null,
    "Selected files:",
    files,
  ].filter(Boolean).join("\n\n");
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function providerFailure(reason, message, httpStatus, raw = null, payloadSent = null) {
  return {
    exitCode: 1,
    parsed: { ok: false, reason, error: message, raw },
    http_status: httpStatus,
    payload_sent: payloadSent,
  };
}

function classifyHttpFailure(status) {
  if (status === 401 || status === 403) return "session_expired";
  if (status === 429) return "usage_limited";
  if (status >= 500) return "tunnel_error";
  return "tunnel_error";
}

function errorMessageFromResponse(parsed, text, redact) {
  if (parsed.ok) {
    return redact(parsed.value?.error?.message ?? parsed.value?.message ?? JSON.stringify(parsed.value)).slice(0, 800);
  }
  return redact(text).slice(0, 800);
}

function payloadSentForFetchError(error) {
  if (error?.name === "AbortError") return null;
  const code = error?.cause?.code || error?.code;
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN"].includes(code)) return false;
  if (/bad port/i.test(`${error?.message ?? ""} ${error?.cause?.message ?? ""}`)) return false;
  return null;
}

function tunnelTransportMessage(error, env, redact) {
  const detail = redact(error?.message ?? String(error));
  const ignoredKeys = ["GROK_API_KEY", "XAI_API_KEY", "XAI_KEY"].filter((key) => env[key]);
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
      return providerFailure(classifyHttpFailure(response.status), errorMessageFromResponse(parsed, text, redact), response.status, parsed.ok ? parsed.value : null, true);
    }
    if (!parsed.ok) return providerFailure("malformed_response", parsed.error, response.status, null, true);
    const content = parsed.value?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return providerFailure("malformed_response", "response did not include choices[0].message.content", response.status, parsed.value, true);
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
    };
  } catch (e) {
    const reason = e?.name === "AbortError" ? "tunnel_timeout" : "tunnel_unavailable";
    return providerFailure(reason, tunnelTransportMessage(e, env, redact), null, null, payloadSentForFetchError(e));
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
      return {
        reachable: false,
        error_code: classifyHttpFailure(response.status),
        error_message: errorMessageFromResponse(parsed, text, redact),
        http_status: response.status,
        probe_endpoint: endpoint,
      };
    }
    return {
      reachable: true,
      error_code: null,
      error_message: null,
      http_status: response.status,
      probe_endpoint: endpoint,
    };
  } catch (e) {
    return {
      reachable: false,
      error_code: e?.name === "AbortError" ? "tunnel_timeout" : "tunnel_unavailable",
      error_message: tunnelTransportMessage(e, env, redact),
      http_status: null,
      probe_endpoint: endpoint,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sourceTransmission(completed, payloadSent) {
  if (completed || payloadSent === true) return "sent";
  if (payloadSent === false) return "not_sent";
  return "unknown";
}

function disclosure(cfg, completed, payloadSent) {
  const transmission = sourceTransmission(completed, payloadSent);
  if (transmission === "sent" && completed) {
    return `Selected source content was sent to ${cfg.display_name} through a subscription-backed web session.`;
  }
  if (transmission === "sent") {
    return `Selected source content was sent to ${cfg.display_name} through a subscription-backed web session, but the tunnel did not return a clean result.`;
  }
  if (transmission === "not_sent") {
    return `Selected source content was not sent to ${cfg.display_name}; the local subscription-backed tunnel was unavailable before delivery.`;
  }
  return `Selected source content may have been sent to ${cfg.display_name} through a subscription-backed web session.`;
}

function suggestedAction(errorCode) {
  if (errorCode === "bad_args") return "Correct the grok-web command arguments and retry.";
  if (errorCode === "scope_failed") return "Adjust --scope, --scope-base, or --scope-paths and retry.";
  if (errorCode === "tunnel_unavailable") return "Start the local Grok web tunnel, verify GROK_WEB_BASE_URL, then retry.";
  if (errorCode === "tunnel_timeout") return "The local Grok web tunnel did not respond before GROK_WEB_TIMEOUT_MS; inspect the tunnel and retry.";
  if (errorCode === "session_expired") return "Refresh the Grok web login/session used by the local tunnel, then retry.";
  if (errorCode === "usage_limited") return "Wait for Grok subscription usage to recover, reduce concurrency, or inspect the local tunnel.";
  if (errorCode === "malformed_response") return "Inspect or update the local Grok web tunnel; it returned an unsupported response shape.";
  return "Inspect error_message and repair the local Grok web tunnel before retrying.";
}

function errorCauseFor(errorCode) {
  if (errorCode === "bad_args") return "caller";
  if (errorCode === "scope_failed") return "scope_resolution";
  return "grok_web_tunnel";
}

function buildRecord({ cfg, mode, options, scopeInfo, execution, startedAt, endedAt }) {
  const completed = execution.exitCode === 0 && execution.parsed?.ok === true;
  const errorCode = completed ? null : (execution.parsed?.reason ?? "tunnel_error");
  const errorMessage = completed ? null : (execution.parsed?.error ?? "");
  const reviewDisclosure = disclosure(cfg, completed, execution.payload_sent ?? null);
  const transmission = sourceTransmission(completed, execution.payload_sent ?? null);
  return {
    id: options.jobId,
    job_id: options.jobId,
    target: "grok-web",
    provider: "grok-web",
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
    prompt_head: String(options.prompt ?? "").slice(0, 200),
    schema_spec: null,
    binary: null,
    status: completed ? "completed" : "failed",
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: execution.exitCode,
    error_code: errorCode,
    error_message: errorMessage,
    error_summary: completed ? null : errorMessage || errorCode,
    error_cause: completed ? null : errorCauseFor(errorCode),
    suggested_action: completed ? null : suggestedAction(errorCode),
    external_review: {
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
      source_content_transmission: transmission,
      disclosure: reviewDisclosure,
    },
    disclosure_note: reviewDisclosure,
    result: completed ? execution.parsed.result : null,
    structured_output: null,
    permission_denials: [],
    mutations: [],
    cost_usd: null,
    usage: execution.parsed?.usage ?? null,
    auth_mode: cfg.auth_mode,
    credential_ref: execution.credential_ref ?? null,
    endpoint: execution.endpoint ?? cfg.base_url,
    http_status: execution.http_status ?? null,
    raw_model: execution.parsed?.raw_model ?? null,
    schema_version: SCHEMA_VERSION,
  };
}

function dataRoot(env = process.env) {
  return resolve(env.GROK_PLUGIN_DATA ?? ".codex-plugin-data/grok");
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

async function persistRecord(record, env = process.env) {
  const root = dataRoot(env);
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

async function persistRecordBestEffort(record, env = process.env) {
  try {
    await persistRecord(record, env);
    return record;
  } catch (e) {
    const printable = {
      ...record,
      disclosure_note: `${record.disclosure_note} JobRecord persistence failed: ${redactor(env)(e?.message ?? String(e))}`,
    };
    try {
      await writeJsonFile(resolve(dataRoot(env), "jobs", record.job_id, "meta.json"), printable);
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
  const recordFile = resolve(dataRoot(env), "jobs", jobId, "meta.json");
  try {
    const parsed = JSON.parse(await readFile(recordFile, "utf8"));
    printJson(redactValue(parsed, redactor(env)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      printJson({ ok: false, error_code: "not_found", job_id: jobId });
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
  const root = dataRoot(env);
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

async function doctorFields(env = process.env) {
  const cfg = config(env);
  const probe = await probeGrokTunnel(cfg, env);
  const ready = probe.reachable === true;
  return {
    provider: "grok-web",
    status: "ok",
    ready,
    reachable: probe.reachable,
    summary: ready
      ? "Grok subscription-backed local tunnel reviewer is configured and reachable."
      : "Grok subscription-backed local tunnel is not reachable.",
    next_action: ready
      ? "Run a Grok web review."
      : suggestedAction(probe.error_code),
    auth_mode: cfg.auth_mode,
    credential_ref: cfg.credential_ref,
    endpoint: cfg.base_url,
    probe_endpoint: probe.probe_endpoint,
    model: cfg.model,
    timeout_ms: cfg.timeout_ms,
    doctor_timeout_ms: cfg.doctor_timeout_ms,
    error_code: probe.error_code,
    error_message: probe.error_message,
    http_status: probe.http_status,
  };
}

async function cmdRun(options) {
  const mode = options.mode ?? "review";
  const startedAt = new Date().toISOString();
  const cfg = config();
  const jobId = `job_${randomUUID()}`;
  const runOptions = { ...options, jobId };
  let scopeInfo;
  let execution;
  try {
    if (!VALID_MODES.has(mode)) throw new Error(`bad_args: unsupported --mode ${mode}`);
    scopeInfo = await collectScope({ ...runOptions, mode });
  } catch (e) {
    const cwd = resolve(process.cwd());
    scopeInfo = {
      cwd,
      workspaceRoot: bestEffortWorkspaceRoot(cwd),
      scope: options.scope ?? null,
      scope_base: options["scope-base"] ?? null,
      scope_paths: splitScopePaths(options["scope-paths"]),
    };
    execution = providerFailure(e.message.startsWith("bad_args:") ? "bad_args" : "scope_failed", redactor()(e.message), null, null, false);
  }
  if (!execution) {
    let prompt;
    try {
      prompt = promptFor(mode, options.prompt ?? "", scopeInfo);
    } catch (e) {
      execution = providerFailure(e.message.startsWith("bad_args:") ? "bad_args" : "scope_failed", redactor()(e.message), null, null, false);
    }
    if (!execution) try {
      execution = await callGrokTunnel(cfg, prompt);
    } catch (e) {
      execution = providerFailure(
        e.message.startsWith("bad_args:") ? "bad_args" : "tunnel_error",
        redactor()(e.message),
        null,
        null,
        payloadSentForFetchError(e),
      );
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
  const printable = await persistRecordBestEffort(record);
  printJson(printable);
  process.exit(record.status === "completed" ? 0 : 1);
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (cmd === "doctor" || cmd === "ping") {
    printJson(redactValue(await doctorFields(), redactor()));
    return;
  }
  if (cmd === "run") return cmdRun(options);
  if (cmd === "result") return cmdResult(options);
  if (cmd === "list") return cmdList();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printJson({
      ok: true,
      commands: ["doctor", "ping", "run", "result", "list"],
      provider: "grok-web",
      default_auth_mode: "subscription_web",
      default_endpoint: DEFAULT_BASE_URL,
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

export { releaseStateLock, sortJobSummaries, staleLockReason, withStateLock };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
