#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanGitEnv as cleanCanonicalGitEnv } from "./lib/git-env.mjs";
import { GIT_BINARY_ENV, gitEnv, isGitBinaryPolicyError, resolveGitBinary } from "./lib/git-binary.mjs";
import { REVIEW_PROMPT_CONTRACT_VERSION, buildReviewAuditManifest, buildReviewPrompt, scopeResolutionReason } from "./lib/review-prompt.mjs";
import { USAGE_LIMIT_SAFE_MESSAGE, isUsageLimitDetail } from "./lib/usage-limit.mjs";
import { elapsedMs } from "./lib/time.mjs";
import {
  EXTERNAL_REVIEW_KEYS,
  SOURCE_CONTENT_TRANSMISSION,
} from "./lib/external-review.mjs";
import { isJwtShapedToken } from "./lib/jwt.mjs";

const VALID_MODES = new Set(["review", "adversarial-review", "custom-review"]);
const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const DEFAULT_GROK2API_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_GROK2API_ADMIN_KEY = "grok2api";
const DEFAULT_MODEL = "grok-4.20-fast";
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_DOCTOR_TIMEOUT_MS = 2000;
const DEFAULT_CHAT_DOCTOR_TIMEOUT_MS = 10000;
const DEFAULT_MAX_PROMPT_CHARS = 400000;
const MAX_SCOPE_FILE_BYTES = 256 * 1024;
const MAX_SCOPE_TOTAL_BYTES = 1024 * 1024;
const GIT_SHOW_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_STATE_JOBS = 50;
const STATE_LOCK_STALE_MS = 60 * 1000;
const SCHEMA_VERSION = 10;
const MIN_SECRET_REDACTION_LENGTH = 8;
const ACCOUNT_PAYMENT_TOKEN_RE = /\b(?:stripe-[^\s,;:)]+|cus_[A-Za-z0-9]{6,}|acct_(?:test_)?[A-Za-z0-9]{5,}|cs_(?:test|live)_[A-Za-z0-9]{6,}|(?:pi|sub|in|ii|ch|seti|setp|price|prod|iv)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,})/gi;
const ACCOUNT_PAYMENT_DIAGNOSTIC_RE = /^(?:stripe-.+|cus_[A-Za-z0-9]{6,}|acct_(?:test_)?[A-Za-z0-9]{5,}|cs_(?:test|live)_[A-Za-z0-9]{6,}|(?:pi|sub|in|ii|ch|seti|setp|price|prod|iv)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,})$/i;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE_FILE_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const GROK_EXPECTED_KEYS = Object.freeze([
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
  throw new Error("bad_args: --lifecycle-events must be jsonl");
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

function config(env = process.env) {
  const timeoutMs = parsePositiveIntegerEnv(env, "GROK_WEB_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const doctorTimeoutMs = parsePositiveIntegerEnv(env, "GROK_WEB_DOCTOR_TIMEOUT_MS", DEFAULT_DOCTOR_TIMEOUT_MS);
  const chatDoctorTimeoutMs = parsePositiveIntegerEnv(env, "GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS", DEFAULT_CHAT_DOCTOR_TIMEOUT_MS);
  const maxPromptChars = parsePositiveIntegerEnv(env, "GROK_WEB_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS, "character count");
  return {
    provider: "grok-web",
    display_name: "Grok Web",
    auth_mode: "subscription_web",
    base_url: normalizeBaseUrl(env.GROK_WEB_BASE_URL),
    model: env.GROK_WEB_MODEL || DEFAULT_MODEL,
    timeout_ms: timeoutMs,
    doctor_timeout_ms: doctorTimeoutMs,
    chat_doctor_timeout_ms: chatDoctorTimeoutMs,
    max_prompt_chars: maxPromptChars,
    credential_ref: env.GROK_WEB_TUNNEL_API_KEY ? "GROK_WEB_TUNNEL_API_KEY" : null,
    credential_value: env.GROK_WEB_TUNNEL_API_KEY || null,
    grok2api_base_url: normalizeGrok2ApiBaseUrl(env.GROK2API_BASE_URL, env.GROK_WEB_BASE_URL),
    grok2api_admin_key: env.GROK2API_ADMIN_KEY || DEFAULT_GROK2API_ADMIN_KEY,
  };
}

function fallbackConfig(env = process.env) {
  return {
    provider: "grok-web",
    display_name: "Grok Web",
    auth_mode: "subscription_web",
    base_url: normalizeBaseUrl(env.GROK_WEB_BASE_URL),
    model: env.GROK_WEB_MODEL || DEFAULT_MODEL,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    doctor_timeout_ms: DEFAULT_DOCTOR_TIMEOUT_MS,
    chat_doctor_timeout_ms: DEFAULT_CHAT_DOCTOR_TIMEOUT_MS,
    max_prompt_chars: DEFAULT_MAX_PROMPT_CHARS,
    credential_ref: env.GROK_WEB_TUNNEL_API_KEY ? "GROK_WEB_TUNNEL_API_KEY" : null,
    credential_value: env.GROK_WEB_TUNNEL_API_KEY || null,
  };
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

async function readGitScopeFiles(gitCwd, workspaceRoot, relPaths) {
  const files = [];
  const totalBytes = { value: 0 };
  for (const relPath of relPaths) {
    const { normalizedRel } = validateScopePath(workspaceRoot, relPath);
    const blobSpec = `HEAD:${relPath}`;
    const sizeText = gitRaw(["cat-file", "-s", blobSpec], gitCwd, { allowFailure: true, workspaceRoot });
    if (sizeText === null) continue;
    const blobBytes = Number.parseInt(sizeText.trim(), 10);
    if (!Number.isSafeInteger(blobBytes) || blobBytes < 0) {
      throw new Error(`scope_invalid_git_blob_size:${normalizedRel}`);
    }
    if (blobBytes > MAX_SCOPE_FILE_BYTES) {
      throw new Error(`scope_file_too_large:${normalizedRel}:${blobBytes}`);
    }
    const text = gitRaw(["show", blobSpec], gitCwd, {
      allowFailure: true,
      maxBuffer: GIT_SHOW_MAX_BUFFER_BYTES,
      workspaceRoot,
    });
    if (text === null) continue;
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

function repositoryIdentity(cwd, workspaceRoot) {
  const remote = git(["remote", "get-url", "origin"], cwd, { allowFailure: true, workspaceRoot });
  if (!remote) return workspaceRoot;
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return match ? match[1] : remote;
}

function promptFor(mode, userPrompt, scopeInfo) {
  const modeLine = mode === "adversarial-review"
    ? "You are performing an adversarial code review. Prioritize correctness bugs, security risks, regressions, and missing tests."
    : "You are performing a code review. Prioritize bugs, behavioral regressions, and missing tests.";
  const files = scopeInfo.files.map((file, index) => promptFileBlock(file, index + 1)).join("\n\n");
  return buildReviewPrompt({
    provider: "Grok Web",
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
      "This request is routed through a local subscription-backed Grok web tunnel, not paid xAI API billing.",
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

function sessionTokenDiagnostics(tokens) {
  const entries = Array.isArray(tokens) ? tokens : [];
  const active = entries.filter((entry) => {
    const status = String(entry?.status ?? "").toLowerCase();
    return entry?.deleted !== true && status !== "deleted" && status !== "inactive";
  });
  const malformedActive = active.filter((entry) => !isJwtShapedToken(entry?.token));
  const deleted = entries.filter((entry) => entry?.deleted === true || String(entry?.status ?? "").toLowerCase() === "deleted");
  const errorCode = active.length === 0
    ? "grok_session_no_runtime_tokens"
    : (malformedActive.length > 0 ? "grok_session_malformed_active_token" : null);
  return {
    status: "checked",
    total_token_count: entries.length,
    active_token_count: active.length,
    malformed_active_token_count: malformedActive.length,
    deleted_token_count: deleted.length,
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
    const size = Number.isSafeInteger(parsed.value?.size) ? parsed.value.size : null;
    return {
      status: "checked",
      runtime_size: size,
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
      error_message: tunnelTransportMessage(error, env, redact),
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
    const tokenDiagnostics = sessionTokenDiagnostics(parsed.value?.tokens);
    const runtimeDiagnostics = tokenDiagnostics.active_token_count > 0 && tokenDiagnostics.error_code === null
      ? await probeGrokRuntimeStatus(cfg, env)
      : { status: "not_checked", error_code: null };
    const runtimeDiverged = runtimeDiagnostics.status === "checked"
      && tokenDiagnostics.active_token_count > 0
      && runtimeDiagnostics.runtime_size === 0;
    return {
      ...tokenDiagnostics,
      ...(runtimeDiagnostics.status === "checked" ? {
        runtime_size: runtimeDiagnostics.runtime_size,
        runtime_revision: runtimeDiagnostics.runtime_revision,
        runtime_selection_strategy: runtimeDiagnostics.runtime_selection_strategy,
      } : {}),
      error_code: runtimeDiverged ? "grok_session_runtime_admin_divergence" : tokenDiagnostics.error_code,
      error_message: null,
      http_status: response.status,
      probe_endpoint: endpoint,
    };
  } catch (error) {
    return {
      status: "unknown",
      error_code: error?.name === "AbortError" ? "grok_session_diagnostics_timeout" : "grok_session_diagnostics_unavailable",
      error_message: tunnelTransportMessage(error, env, redact),
      http_status: null,
      probe_endpoint: endpoint,
    };
  } finally {
    clearTimeout(timer);
  }
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
    return providerFailureWithDiagnostic(reason, tunnelTransportMessage(e, env, redact), null, null, payloadSentForFetchError(e), {
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
        error_code: errorCode,
        error_message: errorMessageFromResponse(parsed, text, redact, { safeUsageLimit: errorCode === "usage_limited" }),
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

async function probeGrokChat(cfg, env = process.env) {
  const endpoint = `${cfg.base_url}/chat/completions`;
  const headers = { "content-type": "application/json" };
  if (cfg.credential_value) headers.authorization = `Bearer ${cfg.credential_value}`;
  const redact = redactor(env);
  const requestBody = {
    model: cfg.model,
    stream: false,
    messages: [{ role: "user", content: "Return exactly: ok" }],
    temperature: 0,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.chat_doctor_timeout_ms);
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
      error_message: tunnelTransportMessage(e, env, redact),
      http_status: null,
      probe_endpoint: endpoint,
    };
  } finally {
    clearTimeout(timer);
  }
}

function sourceTransmission(completed, payloadSent) {
  if (completed || payloadSent === true) return SOURCE_CONTENT_TRANSMISSION.SENT;
  if (payloadSent === false) return SOURCE_CONTENT_TRANSMISSION.NOT_SENT;
  return SOURCE_CONTENT_TRANSMISSION.UNKNOWN;
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

function suggestedAction(errorCode, errorMessage = "") {
  if (errorCode === "bad_args") return "Correct the grok-web command arguments and retry.";
  if (errorCode === "scope_failed") {
    if (/scope_empty:\s*branch-diff selected no files/i.test(errorMessage)) {
      return "Branch-diff selected no files before tunnel launch. Branch-diff reviews committed HEAD-vs-base changes only; it does not include dirty working-tree edits. Choose a different --scope-base <ref> if this branch should have committed changes, use --scope-base HEAD~1 to review the last commit, or use custom-review with explicit --scope-paths for uncommitted, already-merged, or no-diff branches.";
    }
    if (/scope_base_invalid:/i.test(errorMessage)) {
      return "Use a concrete branch, tag, remote ref, or commit SHA for --scope-base; option-shaped values beginning with '-' are rejected before git branch-diff runs.";
    }
    if (/prompt_too_large:/i.test(errorMessage)) {
      return "Rendered prompt exceeds the Grok prompt budget before tunnel launch. Use a narrower scope, split the review into explicit custom-review shards, or raise GROK_WEB_MAX_PROMPT_CHARS only after confirming the local tunnel/model accepts larger prompts.";
    }
    return "Adjust --scope, --scope-base, or --scope-paths and retry.";
  }
  if (errorCode === "tunnel_unavailable") return "Start the local Grok web tunnel, verify GROK_WEB_BASE_URL, then retry.";
  if (errorCode === "tunnel_timeout") return "The local Grok web tunnel did not respond before GROK_WEB_TIMEOUT_MS; inspect the tunnel and retry.";
  if (errorCode === "session_expired") return "Refresh the Grok web login/session used by the local tunnel, then retry.";
  if (errorCode === "usage_limited") return "Wait for Grok subscription usage to recover, reduce concurrency, or inspect the local tunnel. Any billing, credit, or tier change must be a separate manual action with explicit user approval.";
  if (errorCode === "grok_chat_model_rejected") return "The tunnel lists models, but the configured GROK_WEB_MODEL is not accepted by chat; correct GROK_WEB_MODEL or tunnel model routing, then retry.";
  if (errorCode === "grok_chat_timeout") return "The Grok chat readiness probe exceeded GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS; inspect the local tunnel latency or raise that timeout, then retry.";
  if (errorCode === "grok_session_no_runtime_tokens") return "The local Grok tunnel has no active runtime session tokens; sync the browser session or import a valid Grok cookie, then retry.";
  if (errorCode === "grok_session_malformed_active_token") return "The local Grok tunnel has a malformed active Grok session token; remove the malformed token, import a JWT-shaped Grok cookie, restart or refresh the tunnel, then retry.";
  if (errorCode === "grok_session_runtime_admin_divergence") return "The grok2api admin token list has active tokens but the runtime token table is empty; restart or refresh the local Grok tunnel, then retry.";
  if (errorCode === "models_ok_chat_400") return "The tunnel lists models but chat is not review-capable; refresh the Grok web session, inspect tunnel logs and rate-limit endpoint health, then retry.";
  if (errorCode === "review_not_completed") return "Treat this Grok slot as failed. Inspect the raw result and runtime diagnostics, then retry only with a source packet and prompt contract the reviewer can inspect and answer substantively.";
  if (errorCode === "malformed_response") return "Inspect or update the local Grok web tunnel; it returned an unsupported response shape.";
  if (errorCode === "git_binary_rejected") return `Set ${GIT_BINARY_ENV} to a trusted Git executable outside the workspace, or unset it to use the default Git binary.`;
  return "Inspect error_message and repair the local Grok web tunnel before retrying.";
}

function errorCauseFor(errorCode) {
  if (errorCode === "bad_args") return "caller";
  if (errorCode === "scope_failed") return "scope_resolution";
  if (errorCode === "git_binary_rejected") return "git_binary_policy";
  if (errorCode === "usage_limited") return "cost_quota_usage_limit";
  if (errorCode === "review_not_completed") return "review_quality";
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
    disclosure: `Selected source content may be sent to ${cfg.display_name} for external review.`,
  });
}

function buildTerminalExternalReview({ cfg, mode, options, scopeInfo, execution, transmission, reviewDisclosure }) {
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
    disclosure: reviewDisclosure,
  });
}

function buildReviewMetadata(cfg, scopeInfo, execution = null, startedAt = null, endedAt = null) {
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
  const reviewMetadata = buildReviewMetadata(cfg, scopeInfo, execution, startedAt, endedAt);
  const processCompleted = execution.exitCode === 0 && execution.parsed?.ok === true;
  const reviewQuality = reviewMetadata?.audit_manifest?.review_quality ?? null;
  const reviewQualityFailed = processCompleted && reviewQuality?.failed_review_slot === true;
  const completed = processCompleted && !reviewQualityFailed;
  const qualityReasons = reviewQuality?.semantic_failure_reasons ?? [];
  const errorCode = completed ? null : (reviewQualityFailed ? "review_not_completed" : (execution.parsed?.reason ?? "tunnel_error"));
  const errorMessage = completed ? null : (
    reviewQualityFailed
      ? `review_quality_failed:${qualityReasons.join(",") || "unknown"}`
      : (execution.parsed?.error ?? "")
  );
  const diagnostic = reviewQualityFailed
    ? `review did not complete as a usable external review (${qualityReasons.join(", ") || "review_quality_failed"})`
    : (execution.diagnostics
      ? `${errorMessage || errorCode} (${formatDiagnosticPairs(execution.diagnostics)})`
      : (errorMessage || errorCode));
  const payloadSent = execution.payload_sent ?? (processCompleted ? true : null);
  const reviewDisclosure = disclosure(cfg, completed, payloadSent);
  const transmission = sourceTransmission(completed, payloadSent);
  const runtimeDiagnostics = execution.diagnostics ? {
    tunnel_request: {
      endpoint_class: execution.diagnostics.endpoint_class ?? null,
      model: execution.diagnostics.model ?? cfg.model,
      stream: execution.diagnostics.stream ?? null,
      message_count: execution.diagnostics.message_count ?? null,
      prompt_chars: execution.diagnostics.prompt_chars ?? null,
      configured_timeout_ms: execution.diagnostics.configured_timeout_ms ?? null,
      max_tokens: execution.diagnostics.max_tokens ?? null,
      temperature: execution.diagnostics.temperature ?? null,
    },
    cost_quota: execution.diagnostics.cost_quota ?? null,
  } : null;
  return freezeRecord({
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
    prompt_head: promptHead(options.prompt),
    review_metadata: reviewMetadata,
    schema_spec: null,
    binary: null,
    status: completed ? "completed" : "failed",
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: execution.exitCode,
    error_code: errorCode,
    error_message: errorMessage,
    error_summary: completed ? null : diagnostic,
    error_cause: completed ? null : errorCauseFor(errorCode),
    suggested_action: completed ? null : suggestedAction(errorCode, errorMessage),
    external_review: buildTerminalExternalReview({ cfg, mode, options, scopeInfo, execution, transmission, reviewDisclosure }),
    disclosure_note: reviewDisclosure,
    runtime_diagnostics: runtimeDiagnostics,
    result: processCompleted ? execution.parsed.result : null,
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
  });
}

function formatDiagnosticPairs(diagnostics) {
  return Object.entries(diagnostics)
    .filter(([, value]) => value == null || typeof value !== "object")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
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
  const costQuotaReadiness = {
    status: "unknown_not_probed",
    source: "doctor_does_not_call_billing_or_usage_endpoints",
    billing_mutation: "not_supported",
  };
  const probe = await probeGrokTunnel(cfg, env);
  const chatProbe = probe.reachable ? await probeGrokChat(cfg, env) : {
    chat_ready: false,
    error_code: probe.error_code,
    error_message: probe.error_message,
    http_status: null,
    probe_endpoint: `${cfg.base_url}/chat/completions`,
  };
  const sessionDiagnostics = probe.reachable && chatProbe.chat_ready !== true
    ? await probeGrokSessionDiagnostics(cfg, env)
    : {
      status: "not_checked",
      reason: "chat_probe_ready_or_tunnel_unreachable",
      error_code: null,
    };
  const ready = probe.reachable === true && chatProbe.chat_ready === true;
  const sessionErrorCode = sessionDiagnostics.status === "checked" ? sessionDiagnostics.error_code : null;
  const errorCode = ready ? null : (sessionErrorCode ?? chatProbe.error_code ?? probe.error_code);
  return {
    provider: "grok-web",
    status: "ok",
    ready,
    reachable: probe.reachable,
    chat_ready: chatProbe.chat_ready,
    summary: ready
      ? "Grok subscription-backed local tunnel reviewer is configured and chat-ready."
      : (probe.reachable
        ? "Grok tunnel models endpoint is reachable, but chat completion is not review-ready."
        : "Grok subscription-backed local tunnel is not reachable."),
    next_action: ready
      ? "Run a Grok web review."
      : suggestedAction(errorCode),
    auth_mode: cfg.auth_mode,
    credential_ref: cfg.credential_ref,
    endpoint: cfg.base_url,
    probe_endpoint: probe.probe_endpoint,
    chat_probe_endpoint: chatProbe.probe_endpoint,
    model: cfg.model,
    timeout_ms: cfg.timeout_ms,
    doctor_timeout_ms: cfg.doctor_timeout_ms,
    chat_doctor_timeout_ms: cfg.chat_doctor_timeout_ms,
    session_diagnostics: sessionDiagnostics,
    cost_quota_readiness: costQuotaReadiness,
    error_code: errorCode,
    error_message: ready ? null : (chatProbe.error_message ?? probe.error_message),
    http_status: probe.http_status,
    chat_http_status: chatProbe.http_status,
  };
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
    cfg = config();
    if (!VALID_MODES.has(mode)) throw new Error(`bad_args: unsupported --mode ${mode}`);
    scopeInfo = await collectScope({ ...runOptions, mode });
  } catch (e) {
    cfg ??= fallbackConfig();
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
    try {
      prompt = promptFor(mode, options.prompt ?? "", scopeInfo);
      if (prompt.length > cfg.max_prompt_chars) {
        execution = providerFailure("scope_failed", redactor()(`prompt_too_large:${prompt.length} chars exceeds GROK_WEB_MAX_PROMPT_CHARS=${cfg.max_prompt_chars}`), null, null, false);
        execution.prompt = prompt;
      }
    } catch (e) {
      execution = providerFailure(e.message.startsWith("bad_args:") ? "bad_args" : "scope_failed", redactor()(e.message), null, null, false);
    }
    if (!execution) try {
      if (lifecycleEvents) {
        printLifecycleJson({
          event: "external_review_launched",
          job_id: jobId,
          target: "grok-web",
          status: "launched",
          external_review: buildLaunchExternalReview({ cfg, mode, options: runOptions, scopeInfo }),
        }, lifecycleEvents);
      }
      execution = await callGrokTunnel(cfg, prompt);
      execution.prompt = prompt;
    } catch (e) {
      execution = providerFailureWithDiagnostic(
        e.message.startsWith("bad_args:") ? "bad_args" : "tunnel_error",
        redactor()(e.message),
        null,
        null,
        payloadSentForFetchError(e),
        { configured_timeout_ms: cfg.timeout_ms },
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
  printLifecycleJson(printable, lifecycleEvents);
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

export {
  buildReviewMetadata,
  readUtf8ScopeFileWithinLimit,
  releaseStateLock,
  sameFileIdentity,
  sortJobSummaries,
  staleLockReason,
  withStateLock,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
