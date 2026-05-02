#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { cleanGitEnv } from "./lib/git-env.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const PROVIDERS_PATH = resolve(PLUGIN_ROOT, "config/providers.json");
const VALID_MODES = new Set(["review", "adversarial-review", "custom-review"]);
const VALID_AUTH_MODES = new Set(["api_key", "auto"]);

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

function selectedCredential(cfg, env = process.env) {
  for (const keyName of cfg.env_keys ?? []) {
    if (typeof env[keyName] === "string" && env[keyName].length > 0) {
      return { keyName, value: env[keyName] };
    }
  }
  return { keyName: null, value: null };
}

function redactor(env = process.env) {
  const secrets = Object.entries(env)
    .filter(([name, value]) => /(?:^|_)API_KEY$/.test(name) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value);
  return (text) => {
    let out = String(text ?? "");
    for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
    return out;
  };
}

function baseUrlFor(cfg) {
  let url = String(cfg.base_url);
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function doctorFields(provider, cfg, env = process.env) {
  const credential = selectedCredential(cfg, env);
  const endpoint = baseUrlFor(cfg);
  if (!VALID_AUTH_MODES.has(cfg.auth_mode)) {
    return {
      provider,
      status: "config_error",
      ready: false,
      summary: `${cfg.display_name} direct API auth mode is unsupported.`,
      next_action: `Set ${provider} auth_mode to api_key or auto.`,
      auth_mode: cfg.auth_mode,
      endpoint,
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

function git(args, cwd) {
  const res = runCommand("git", args, { cwd, env: cleanGitEnv() });
  if (res.error) throw new Error(`git_failed:${res.error.message}`);
  if (res.signal) throw new Error(`git_failed:signal:${res.signal}`);
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

function bestEffortWorkspaceRoot(cwd) {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd) || cwd;
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
    const changed = git(["diff", "--name-only", base, "--"], cwd);
    const relPaths = changed ? changed.split("\n").filter(Boolean) : [];
    if (relPaths.length === 0) throw new Error("scope_empty: branch-diff selected no files");
    return relPaths;
  }
  throw new Error(`unsupported_scope:${scope}`);
}

async function readScopeFiles(workspaceRoot, relPaths) {
  const files = [];
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
    const text = await readFile(abs, "utf8");
    files.push({ path: normalizedRel, text });
  }
  if (files.length === 0) throw new Error("scope_empty: selected files are missing or empty");
  return files;
}

async function collectScope(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const workspaceRoot = git(["rev-parse", "--show-toplevel"], cwd) || cwd;
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
  const liveContext = [
    "Live verification context:",
    "- This repository has verified the configured DeepSeek and GLM direct API endpoints/models from Codex-managed runs.",
    "- Do not reject model IDs or endpoint hosts solely because they differ from general public documentation; require current run failure evidence or repo-local contradictory evidence.",
    "- The JobRecord will include the actual endpoint, HTTP status, raw model, credential key name, and usage metadata when the provider returns them.",
  ].join("\n");
  const files = scopeInfo.files.map((file) => [
    `### ${file.path}`,
    "```",
    file.text,
    "```",
  ].join("\n")).join("\n\n");
  return [
    modeLine,
    "Return a concise verdict and findings. Do not edit files.",
    liveContext,
    userPrompt ? `User prompt:\n${userPrompt}` : null,
    "Selected files:",
    files,
  ].filter(Boolean).join("\n\n");
}

function requestFieldMatches(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function mockProviderExecution(cfg, prompt, credential, env, requestBody) {
  const expectedPromptText = env.API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES;
  if (expectedPromptText && !prompt.includes(expectedPromptText)) {
    return providerFailure("mock_assertion_failed", `prompt missing expected text: ${expectedPromptText}`, 200, null);
  }
  if (env.API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY) {
    const parsedExpected = parseJson(env.API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY);
    if (!parsedExpected.ok || !parsedExpected.value || typeof parsedExpected.value !== "object" || Array.isArray(parsedExpected.value)) {
      return providerFailure("mock_assertion_failed", "API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY must be a JSON object", 200, null);
    }
    for (const [key, expected] of Object.entries(parsedExpected.value)) {
      if (!requestFieldMatches(requestBody[key], expected)) {
        return providerFailure(
          "mock_assertion_failed",
          `request body field ${key} expected ${JSON.stringify(expected)} but got ${JSON.stringify(requestBody[key])}`,
          200,
          null
        );
      }
    }
  }
  const parsed = parseJson(env.API_REVIEWERS_MOCK_RESPONSE);
  if (!parsed.ok) return providerFailure("malformed_response", parsed.error, 200, null);
  const content = parsed.value?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return providerFailure("malformed_response", "response did not include choices[0].message.content", 200, parsed.value);
  }
  return {
    exitCode: 0,
    parsed: {
      ok: true,
      result: content,
      usage: parsed.value.usage ?? null,
      raw_model: parsed.value.model ?? null,
    },
    http_status: 200,
    credential_ref: credential.keyName,
    endpoint: baseUrlFor(cfg),
  };
}

async function callProvider(provider, cfg, prompt, env = process.env) {
  const credential = selectedCredential(cfg, env);
  if (!credential.value) {
    return providerFailure("missing_key", `${cfg.display_name} API key is not available`, null);
  }
  const endpoint = `${baseUrlFor(cfg)}/chat/completions`;
  const requestBody = {
    model: cfg.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  };
  if (cfg.request_defaults) Object.assign(requestBody, cfg.request_defaults);
  if (env.API_REVIEWERS_MAX_TOKENS !== undefined && env.API_REVIEWERS_MAX_TOKENS !== "") {
    requestBody.max_tokens = Number(env.API_REVIEWERS_MAX_TOKENS);
  } else if (!Object.prototype.hasOwnProperty.call(requestBody, "max_tokens")) {
    requestBody.max_tokens = 4096;
  }
  if (env.API_REVIEWERS_MOCK_RESPONSE) {
    return mockProviderExecution(cfg, prompt, credential, env, requestBody);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.API_REVIEWERS_TIMEOUT_MS ?? "120000"));
  const redact = redactor(env);
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
      return providerFailure(classifyHttpFailure(response.status, parsed), providerErrorMessage(parsed, text, redact), response.status, parsed);
    }
    if (!parsed.ok) {
      return providerFailure("malformed_response", parsed.error, response.status, null);
    }
    const content = parsed.value?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return providerFailure("malformed_response", "response did not include choices[0].message.content", response.status, parsed.value);
    }
    return {
      exitCode: 0,
      parsed: {
        ok: true,
        result: content,
        usage: parsed.value.usage ?? null,
        raw_model: parsed.value.model ?? null,
      },
      http_status: response.status,
      credential_ref: credential.keyName,
      endpoint: baseUrlFor(cfg),
    };
  } catch (e) {
    const reason = e?.name === "AbortError" ? "timeout" : "provider_unavailable";
    return providerFailure(reason, redact(e?.message ?? String(e)), null);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function providerErrorMessage(parsed, text, redact) {
  if (parsed.ok) {
    const message = parsed.value?.error?.message ?? parsed.value?.message ?? JSON.stringify(parsed.value).slice(0, 800);
    return redact(message);
  }
  return redact(text).slice(0, 800);
}

function classifyHttpFailure(status, parsed) {
  const detail = parsed.ok ? JSON.stringify(parsed.value?.error ?? parsed.value ?? {}) : "";
  if (status === 401 || status === 403) return "auth_rejected";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 409 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504 || /capacity|resource|overload|unavailable/i.test(detail)) {
    return "provider_unavailable";
  }
  return "provider_error";
}

function providerFailure(reason, message, httpStatus, raw = null) {
  return {
    exitCode: 1,
    parsed: {
      ok: false,
      reason,
      error: message,
      raw,
    },
    http_status: httpStatus,
  };
}

function suggestedAction(errorCode, provider, cfg) {
  if (errorCode === "missing_key") return `Expose one of these key names to Codex: ${(cfg.env_keys ?? []).join(", ")}.`;
  if (errorCode === "auth_rejected") return `Check the ${cfg.display_name} API key and billing/plan for ${cfg.model}.`;
  if (errorCode === "rate_limited") return `Wait and retry, or lower concurrency for ${provider}.`;
  if (errorCode === "provider_unavailable") return `Retry later or switch reviewer provider.`;
  if (errorCode === "scope_failed") return "Adjust --scope, --scope-base, or --scope-paths and retry.";
  return "Inspect error_message and retry after correcting the provider or request configuration.";
}

function buildRecord({ provider, cfg, mode, options, scopeInfo, execution, startedAt, endedAt }) {
  const completed = execution.exitCode === 0 && execution.parsed?.ok === true;
  const errorCode = completed ? null : (execution.parsed?.reason ?? "provider_error");
  const target = provider;
  return {
    id: options.jobId,
    job_id: options.jobId,
    target,
    provider,
    parent_job_id: null,
    claude_session_id: null,
    gemini_session_id: null,
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
    scope_paths: scopeInfo.scope_paths,
    prompt_head: String(options.prompt ?? "").slice(0, 200),
    schema_spec: null,
    binary: null,
    status: completed ? "completed" : "failed",
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: execution.exitCode,
    error_code: errorCode,
    error_message: completed ? null : execution.parsed?.error ?? null,
    error_summary: completed ? null : execution.parsed?.error ?? errorCode,
    error_cause: completed ? null : "direct_api_provider",
    suggested_action: completed ? null : suggestedAction(errorCode, provider, cfg),
    disclosure_note: `Selected files were sent to ${cfg.display_name} through direct API auth.`,
    result: completed ? execution.parsed.result : null,
    structured_output: null,
    permission_denials: [],
    mutations: [],
    cost_usd: null,
    usage: execution.parsed?.usage ?? null,
    auth_mode: cfg.auth_mode,
    credential_ref: execution.credential_ref ?? null,
    endpoint: execution.endpoint ?? baseUrlFor(cfg),
    http_status: execution.http_status ?? null,
    raw_model: execution.parsed?.raw_model ?? null,
    schema_version: 7,
  };
}

async function persistRecord(record, env = process.env) {
  const root = resolve(env.API_REVIEWERS_PLUGIN_DATA ?? ".codex-plugin-data/api-reviewers");
  const dir = resolve(root, "jobs", record.job_id);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "meta.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function cmdDoctor(options) {
  const providers = await loadProviders();
  const provider = options.provider;
  if (!provider) throw new Error("bad_args: --provider is required");
  const cfg = providerConfig(providers, provider);
  printJson(doctorFields(provider, cfg));
}

async function cmdRun(options) {
  const providers = await loadProviders();
  const provider = options.provider;
  if (!provider) throw new Error("bad_args: --provider is required");
  const mode = options.mode ?? "review";
  if (!VALID_MODES.has(mode)) throw new Error(`bad_args: unsupported --mode ${mode}`);
  const cfg = providerConfig(providers, provider);
  if (cfg.auth_mode !== "api_key" && cfg.auth_mode !== "auto") {
    throw new Error(`bad_args: ${provider} auth_mode must be api_key or auto`);
  }
  const startedAt = new Date().toISOString();
  const jobId = `job_${randomUUID()}`;
  const runOptions = { ...options, jobId };
  let scopeInfo;
  let execution;
  try {
    scopeInfo = await collectScope({ ...runOptions, mode });
    execution = await callProvider(provider, cfg, promptFor(mode, options.prompt ?? "", scopeInfo));
  } catch (e) {
    const cwd = resolve(process.cwd());
    scopeInfo = {
      cwd,
      workspaceRoot: bestEffortWorkspaceRoot(cwd),
      scope: options.scope ?? null,
      scope_base: options["scope-base"] ?? null,
      scope_paths: splitScopePaths(options["scope-paths"]),
    };
    execution = {
      exitCode: 1,
      parsed: { ok: false, reason: "scope_failed", error: e.message },
    };
  }
  const record = buildRecord({
    provider,
    cfg,
    mode,
    options: runOptions,
    scopeInfo,
    execution,
    startedAt,
    endedAt: new Date().toISOString(),
  });
  await persistRecord(record);
  printJson(record);
  process.exit(record.status === "completed" ? 0 : 1);
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (cmd === "doctor" || cmd === "ping") return cmdDoctor(options);
  if (cmd === "run") return cmdRun(options);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printJson({ ok: true, commands: ["doctor", "ping", "run"], providers: Object.keys(await loadProviders()) });
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
