#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync,
  writeFileSync, chmodSync, readdirSync, statSync, lstatSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { parseArgs } from "./lib/args.mjs";
import { configureState, resolveJobsDir, resolveJobFile, writeJobFile, upsertJob, listJobs, commitJobRecord } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { resolveProfile, resolveModelForProfile, resolveModelCandidatesForProfile } from "./lib/mode-profiles.mjs";
import { setupContainment } from "./lib/containment.mjs";
import { populateScope } from "./lib/scope.mjs";
import { newJobId, verifyPidInfo } from "./lib/identity.mjs";
import { buildJobRecord, classifyExecution, externalReviewForInvocation } from "./lib/job-record.mjs";
import { reconcileActiveJobs } from "./lib/reconcile.mjs";
import { cleanGitEnv } from "./lib/git-env.mjs";
import { gitEnv, isGitBinaryPolicyError, resolveGitBinary } from "./lib/git-binary.mjs";
import { isCodexSandbox } from "./lib/codex-env.mjs";
import { spawnGemini } from "./lib/gemini.mjs";
import { writeCancelMarker, consumeCancelMarker } from "./lib/cancel-marker.mjs";
import {
  authDiagnosticFields,
  apiKeyFallbackSelection,
  apiKeyMissingFields as buildApiKeyMissingFields,
  apiKeyMissingMessage as buildApiKeyMissingMessage,
  resolveAuthSelection as resolveAuthSelectionForProvider,
} from "./lib/auth-selection.mjs";
import {
  PING_PROMPT,
  cancelNoPidInfoSuggestedAction,
  cancelUnverifiableSuggestedAction,
  consumePromptSidecar,
  effectiveProfileForOptions,
  externalReviewBackgroundLaunchedEvent,
  externalReviewLaunchedEvent,
  gitStatusLines,
  parseLifecycleEventsMode,
  parseScopePathsOption,
  preflightDisclosure,
  preflightSafetyFields,
  printJson,
  printLifecycleJson,
  runKindFromRecord,
  startExternalReviewHeartbeat,
  summarizeScopeDirectory,
  writePromptSidecar,
} from "./lib/companion-common.mjs";
import { REVIEW_PROMPT_CONTRACT_VERSION, buildReviewAuditManifest, buildReviewPrompt, buildSelectedSourcePromptBlock } from "./lib/review-prompt.mjs";

const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_CONFIG_PATH = resolvePath(PLUGIN_ROOT, "config/models.json");
const READ_ONLY_POLICY = resolvePath(PLUGIN_ROOT, "policies/read-only.toml");
const DEFAULT_GEMINI_REVIEW_TIMEOUT_MS = 900000;
const DEFAULT_GEMINI_PING_TIMEOUT_MS = 900000;
const GEMINI_READINESS_PREFLIGHT_TIMEOUT_MS = 900000;
const CONTINUABLE_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);
const RUN_MODES = Object.freeze(["review", "adversarial-review", "custom-review", "rescue"]);
const PREFLIGHT_MODES = Object.freeze(["review", "adversarial-review", "custom-review"]);

configureState({
  pluginDataEnv: "GEMINI_PLUGIN_DATA",
  sessionIdEnv: "GEMINI_COMPANION_SESSION_ID",
});

function loadModels() {
  if (!existsSync(MODELS_CONFIG_PATH)) return { review_quality: null, rescue: null };
  return JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
}

function fail(code, message, details = {}) {
  process.stderr.write(`gemini-companion: ${message}\n`);
  printJson({ ok: false, error: code, message, ...details });
  process.exit(1);
}

function parseReviewTimeoutMs(cliValue, env = process.env, fallback = DEFAULT_GEMINI_REVIEW_TIMEOUT_MS) {
  const raw = cliValue ?? env.GEMINI_REVIEW_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") {
    const source = cliValue === undefined ? "GEMINI_REVIEW_TIMEOUT_MS" : "--timeout-ms";
    fail("bad_args", `${source} must be a positive integer number of milliseconds; got ${JSON.stringify(raw)}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    const source = cliValue === undefined ? "GEMINI_REVIEW_TIMEOUT_MS" : "--timeout-ms";
    fail("bad_args", `${source} must be a positive integer number of milliseconds; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function targetPromptFor(invocation, userPrompt, sourceFiles = []) {
  if (invocation.mode_profile_name === "rescue") return userPrompt;
  const selectedSource = buildSelectedSourcePromptBlock(sourceFiles, {
    delimiterPrefix: "GEMINI FILE",
  });
  return buildReviewPrompt({
    provider: "Gemini CLI",
    mode: invocation.mode,
    repository: invocation.workspace_root ?? null,
    baseRef: invocation.scope_base,
    baseCommit: gitCommitForPrompt(invocation.cwd, invocation.scope_base, invocation.workspace_root),
    headRef: "HEAD",
    headCommit: gitCommitForPrompt(invocation.cwd, "HEAD", invocation.workspace_root),
    scope: invocation.scope,
    scopePaths: invocation.scope_paths,
    userPrompt,
    extraInstructions: selectedSource ? [selectedSource] : [],
  });
}

function gitCommitForPrompt(cwd, ref, workspaceRoot = null) {
  if (!ref) return null;
  try {
    return execFileSync(resolveGitBinary({ cwd, workspaceRoot }), ["-C", cwd, "rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
      env: gitEnv(cleanGitEnv()),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (isGitBinaryPolicyError(error)) throw error;
    return null;
  }
}

function gitText(args, cwd, workspaceRoot = null) {
  try {
    return execFileSync(resolveGitBinary({ cwd, workspaceRoot }), ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(cleanGitEnv()),
    }).trim() || null;
  } catch (error) {
    if (isGitBinaryPolicyError(error)) throw error;
    return null;
  }
}

function repositoryIdentity(cwd, workspaceRoot) {
  const remote = gitText(["remote", "get-url", "origin"], cwd, workspaceRoot);
  if (!remote) return workspaceRoot;
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return match ? match[1] : remote;
}

function promptMetadata(invocation) {
  return {
    repository: repositoryIdentity(invocation.cwd, invocation.workspace_root),
    baseRef: invocation.scope_base ?? null,
    baseCommit: gitCommitForPrompt(invocation.cwd, invocation.scope_base, invocation.workspace_root),
    headRef: gitText(["branch", "--show-current"], invocation.cwd, invocation.workspace_root) ?? "HEAD",
    headCommit: gitCommitForPrompt(invocation.cwd, "HEAD", invocation.workspace_root),
  };
}

function pluginSourceCommit() {
  return gitCommitForPrompt(PLUGIN_ROOT, "HEAD");
}

function listContainedFiles(root, dir = root, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const full = resolvePath(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const lst = lstatSync(full);
    if (lst.isSymbolicLink()) continue;
    if (lst.isDirectory()) out.push(...listContainedFiles(root, full, rel));
    else out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function auditSourceFiles(containmentPath) {
  if (!containmentPath || !existsSync(containmentPath)) return [];
  return listContainedFiles(containmentPath).map((path) => ({
    path,
    content: readFileSync(resolvePath(containmentPath, path)),
  }));
}

function scopeResolutionReason(invocation) {
  const paths = invocation.scope_paths;
  if (invocation.scope === "branch-diff") {
    if (Array.isArray(paths) && paths.length > 0) {
      return `git diff -z --name-only ${invocation.scope_base ?? "main"}...HEAD -- filtered by explicit --scope-paths`;
    }
    return `git diff -z --name-only ${invocation.scope_base ?? "main"}...HEAD --`;
  }
  if (Array.isArray(paths) && paths.length > 0) return "explicit --scope-paths";
  return invocation.scope ?? null;
}

function reviewAuditManifest(invocation, prompt, containmentPath, execution) {
  if (!invocation.review_prompt_contract_version || invocation.mode_profile_name === "rescue") return null;
  const meta = promptMetadata(invocation);
  const { error_code: errorCode } = classifyExecution(execution);
  return buildReviewAuditManifest({
    prompt,
    sourceFiles: auditSourceFiles(containmentPath),
    git: {
      remote: meta.repository,
      branch: meta.headRef,
      baseRef: meta.baseRef,
      baseCommit: meta.baseCommit,
      headRef: meta.headRef,
      headCommit: meta.headCommit,
    },
    promptBuilder: {
      contractVersion: invocation.review_prompt_contract_version,
      pluginVersion: "0.1.0",
      pluginCommit: pluginSourceCommit(),
    },
    request: {
      provider: invocation.review_prompt_provider ?? "Gemini CLI",
      model: invocation.model,
      timeoutMs: invocation.timeout_ms ?? null,
      maxTokens: null,
      maxStepsPerTurn: null,
      temperature: null,
    },
    truncation: { prompt: false, source: false, output: false },
    providerIds: { sessionId: execution?.geminiSessionId ?? null },
    scope: {
      name: invocation.scope,
      base: invocation.scope_base ?? null,
      paths: invocation.scope_paths ?? null,
      reason: scopeResolutionReason(invocation),
    },
    result: execution?.parsed?.result ?? "",
    status: execution?.preflight === true
      ? "preflight_failed"
      : (execution?.exitCode === 0 && execution?.parsed?.ok === true ? "completed" : "failed"),
    errorCode,
  });
}

function scopedTargetPromptForOrExit(invocation, profile, userPrompt, lifecycleEvents) {
  if (!invocation.review_prompt_contract_version || invocation.mode_profile_name === "rescue") {
    return targetPromptFor(invocation, userPrompt);
  }
  const executionScope = setupExecutionScopeOrExit(invocation, profile, {
    foreground: true,
    lifecycleEvents,
  });
  try {
    return targetPromptFor(invocation, userPrompt, auditSourceFiles(executionScope.containment.path));
  } finally {
    cleanupScopedPromptExecutionScope(executionScope);
  }
}

// Mutation-detection git scrub: same shared list as claude-companion +
// scope.mjs. PR #21 review: previous local 5-key list missed
// GIT_CONFIG_GLOBAL — fold onto plugin lib's canonical scrub.

function gitStatus(args, cwd, workspaceRoot = null) {
  return execFileSync(resolveGitBinary({ cwd, workspaceRoot }), ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(cleanGitEnv()),
  });
}

function mutationDetectionFailure(error, context = null) {
  const stderr = String(error?.stderr ?? "").trim().split("\n").find(Boolean);
  const message = stderr ?? String(error?.message || error).split("\n").find(Boolean) ?? "unknown error";
  return `mutation_detection_failed: ${context ? `${context}: ` : ""}${message}`;
}

function retryableModelCapacityFailure(execution) {
  const detail = [
    execution?.stderr,
    execution?.stdout,
    execution?.parsed?.error,
    execution?.parsed?.raw,
  ].map((s) => typeof s === "string" ? s : JSON.stringify(s ?? ""))
    .join("\n");
  return /429|rateLimitExceeded|RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|No capacity available/i.test(detail);
}

function modelCandidatesForInvocation(profile, invocation) {
  const modelsConfig = loadModels();
  const configuredPrimary = resolveModelForProfile(profile, modelsConfig);
  if (configuredPrimary !== invocation.model) return [invocation.model];
  const candidates = resolveModelCandidatesForProfile(profile, modelsConfig);
  return candidates.length > 0 ? candidates : [invocation.model];
}

function makeGeminiPingCwd() {
  const dir = mkdtempSync(joinPath(tmpdir(), "gemini-ping-neutral-"));
  try {
    process.once("exit", () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });
  } catch {
    // Exit cleanup is best-effort; readiness must not fail because cleanup
    // registration failed.
  }
  return dir;
}

async function geminiReadinessPreflight(invocation, profile, authSelection = resolveAuthSelection(invocation.auth_mode)) {
  const readinessProfile = resolveProfile("ping");
  const candidates = modelCandidatesForInvocation(profile, invocation);
  let execution = null;
  const pingCwd = makeGeminiPingCwd();
  try {
    for (let i = 0; i < candidates.length; i++) {
      execution = await spawnGemini(readinessProfile, {
        model: candidates[i],
        promptText: PING_PROMPT,
        policyPath: READ_ONLY_POLICY,
        cwd: pingCwd,
        binary: invocation.binary,
        timeoutMs: GEMINI_READINESS_PREFLIGHT_TIMEOUT_MS,
        allowedApiKeyEnv: authSelection.allowed_env_credentials,
      });
      if (execution.parsed?.ok === true) return null;
      if (
        execution.exitCode !== 0 &&
        i < candidates.length - 1 &&
        retryableModelCapacityFailure(execution)
      ) {
        continue;
      }
      break;
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      preflight: true,
      exitCode: null,
      parsed: null,
      pidInfo: null,
      geminiSessionId: null,
      stdout: "",
      stderr: "",
      errorMessage: isGeminiCodexSandboxBlocked(detail) ? `sandbox_blocked: ${detail}` : detail,
    };
  }

  const failureText = pingFailureText(execution);
  const detail = pingFailureDetail(execution);
  let errorMessage = detail || "Gemini CLI readiness check failed before review launch.";
  if (isGeminiCodexSandboxBlocked(failureText)) {
    errorMessage = `sandbox_blocked: ${detail}`;
  } else if (PING_AUTH_RE.test(detail)) {
    errorMessage = `not_authed: ${detail}`;
  }
  return {
    ...execution,
    pidInfo: null,
    geminiSessionId: null,
    preflight: true,
    errorMessage,
  };
}

function runtimeOptionsSidecarPath(workspaceRoot, jobId) {
  return `${resolveJobsDir(workspaceRoot)}/${jobId}/runtime-options.json`;
}

function writeRuntimeOptionsSidecar(workspaceRoot, jobId, options) {
  const dir = `${resolveJobsDir(workspaceRoot)}/${jobId}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  const file = runtimeOptionsSidecarPath(workspaceRoot, jobId);
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpFile, `${JSON.stringify({ timeout_ms: options.timeout_ms }, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
    try { chmodSync(tmpFile, 0o600); } catch { /* best-effort on non-POSIX */ }
    renameSync(tmpFile, file);
  } catch (e) {
    try { unlinkSync(tmpFile); } catch { /* already gone */ }
    throw e;
  }
}

function readRuntimeOptionsSidecar(workspaceRoot, jobId) {
  const file = runtimeOptionsSidecarPath(workspaceRoot, jobId);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const timeoutMs = parsed.timeout_ms;
    return Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? { timeout_ms: timeoutMs } : {};
  } catch {
    return {};
  }
}

function invocationFromRecord(record, fallbackAuthMode = "subscription", runtimeOptions = {}) {
  return Object.freeze({
    job_id: record.job_id,
    target: record.target,
    parent_job_id: record.parent_job_id ?? null,
    resume_chain: record.resume_chain ?? [],
    mode_profile_name: record.mode_profile_name,
    mode: record.mode,
    model: record.model,
    cwd: record.cwd,
    workspace_root: record.workspace_root,
    containment: record.containment,
    scope: record.scope,
    dispose_effective: record.dispose_effective ?? false,
    scope_base: record.scope_base ?? null,
    scope_paths: record.scope_paths ?? null,
    prompt_head: record.prompt_head,
    review_prompt_contract_version: record.review_metadata?.prompt_contract_version ?? null,
    review_prompt_provider: record.review_metadata?.prompt_provider ?? null,
    schema_spec: record.schema_spec ?? null,
    run_kind: runKindFromRecord(record),
    auth_mode: record.auth_mode ?? fallbackAuthMode ?? "subscription",
    binary: record.binary,
    timeout_ms:
      runtimeOptions.timeout_ms ??
      record.review_metadata?.audit_manifest?.request?.timeout_ms ??
      DEFAULT_GEMINI_REVIEW_TIMEOUT_MS,
    started_at: record.started_at,
  });
}

async function spawnDetachedWorker(cwd, jobId, authMode) {
  let child;
  try {
    child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "_run-worker",
      "--cwd", cwd,
      "--job", jobId,
      "--auth-mode", authMode,
    ], {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    return { child: null, error };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      child.off("spawn", onSpawn);
      child.off("error", onError);
      if (!result.error) child.unref();
      resolve(result);
    };
    const onSpawn = () => settle({ child, error: null });
    const onError = (error) => settle({ child, error });
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function failBackgroundWorkerSpawn(workspaceRoot, invocation, error) {
  try { consumePromptSidecar(resolveJobsDir(workspaceRoot), invocation.job_id); } catch { /* best-effort prompt sidecar cleanup */ }
  const message = `background worker spawn failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`;
  const errorRecord = buildJobRecord(invocation, {
    exitCode: null,
    parsed: null,
    pidInfo: null,
    geminiSessionId: null,
    errorMessage: message,
  }, []);
  writeJobFile(workspaceRoot, invocation.job_id, errorRecord);
  upsertJob(workspaceRoot, errorRecord);
  fail("spawn_failed", message, { error_code: error?.code ?? null });
}

function failBackgroundPromptSidecarWrite(workspaceRoot, invocation, error) {
  const message = `background prompt sidecar write failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`;
  const errorRecord = buildJobRecord(invocation, {
    exitCode: null,
    parsed: null,
    pidInfo: null,
    geminiSessionId: null,
    errorMessage: message,
  }, []);
  writeJobFile(workspaceRoot, invocation.job_id, errorRecord);
  upsertJob(workspaceRoot, errorRecord);
  fail("sidecar_failed", message, { error_code: error?.code ?? null });
}

function cmdPreflight(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["mode", "cwd", "scope-base", "scope-paths", "binary"],
    booleanOptions: [],
  });
  const mode = options.mode;
  const cwd = options.cwd ?? process.cwd();
  if (!mode || !PREFLIGHT_MODES.includes(mode)) {
    fail("bad_args", `--mode must be one of ${PREFLIGHT_MODES.join("|")}; got ${JSON.stringify(mode)}`, {
      event: "preflight",
      target: "gemini",
      mode: mode ?? null,
      cwd,
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure("Gemini"),
    });
  }

  const profile = effectiveProfileForOptions(resolveProfile(mode), options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const scopePaths = parseScopePathsOption(options["scope-paths"]);
  let containment = null;
  let exitCode = 0;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: options["scope-base"] ?? null,
      scopePaths,
      workspaceRoot,
    }, containment);
    const summary = summarizeScopeDirectory(containment.path);
    printJson({
      ok: true,
      event: "preflight",
      target: "gemini",
      mode,
      mode_profile_name: profile.name,
      cwd,
      workspace_root: workspaceRoot,
      containment: profile.containment,
      scope: profile.scope,
      scope_base: options["scope-base"] ?? null,
      scope_paths: scopePaths,
      ...summary,
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure("Gemini"),
    });
  } catch (e) {
    exitCode = 2;
    const error = isGitBinaryPolicyError(e) ? "git_binary_rejected" : "scope_failed";
    printJson({
      ok: false,
      event: "preflight",
      target: "gemini",
      mode,
      cwd,
      workspace_root: workspaceRoot,
      containment: profile.containment,
      scope: profile.scope,
      scope_base: options["scope-base"] ?? null,
      scope_paths: scopePaths,
      error,
      error_message: e.message,
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure("Gemini"),
    });
  } finally {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
  }
  process.exit(exitCode);
}

async function cmdRun(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["mode", "model", "cwd", "binary", "scope-base", "scope-paths", "override-dispose", "auth-mode", "timeout-ms", "lifecycle-events"],
    booleanOptions: ["background", "foreground"],
  });
  const mode = options.mode;
  if (!mode || !RUN_MODES.includes(mode)) {
    fail("bad_args", `--mode must be one of ${RUN_MODES.join("|")}; got ${JSON.stringify(mode)}`);
  }
  if (options.background && options.foreground) {
    fail("bad_args", "--background and --foreground are mutually exclusive");
  }
  const profile = effectiveProfileForOptions(resolveProfile(mode), options);
  const model = options.model ?? resolveModelForProfile(profile, loadModels()) ?? null;
  if (!model) fail("no_model", "no model resolved; pass --model or populate config/models.json");

  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const prompt = positionals.join(" ").trim();
  if (!prompt) fail("bad_args", "prompt is required (pass after -- separator)");

  const disposeEffective = (() => {
    if (options["override-dispose"] === undefined) return profile.dispose_default;
    const v = String(options["override-dispose"]).toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return profile.dispose_default;
  })();
  const scopePaths = parseScopePathsOption(options["scope-paths"]);
  let lifecycleEvents;
  try {
    lifecycleEvents = parseLifecycleEventsMode(options["lifecycle-events"]);
  } catch (e) {
    fail("bad_args", e.message);
  }
  const timeoutMs = parseReviewTimeoutMs(options["timeout-ms"]);
  const authSelection = resolveAuthSelection(options["auth-mode"]);
  if (authSelection.selected_auth_path === "api_key_env_missing") {
    fail("not_authed", apiKeyMissingMessage(), apiKeyMissingFields(authSelection));
  }

  const jobId = newJobId();
  const invocation = Object.freeze({
    job_id: jobId,
    target: "gemini",
    parent_job_id: null,
    resume_chain: [],
    mode_profile_name: profile.name,
    mode,
    model,
    cwd,
    workspace_root: workspaceRoot,
    containment: profile.containment,
    scope: profile.scope,
    dispose_effective: disposeEffective,
    scope_base: options["scope-base"] ?? null,
    scope_paths: scopePaths,
    prompt_head: prompt.slice(0, 200),
    review_prompt_contract_version: profile.name === "rescue" ? null : REVIEW_PROMPT_CONTRACT_VERSION,
    review_prompt_provider: profile.name === "rescue" ? null : "Gemini CLI",
    timeout_ms: timeoutMs,
    schema_spec: null,
    binary: options.binary ?? process.env.GEMINI_BINARY ?? "gemini",
    run_kind: options.background ? "background" : "foreground",
    auth_mode: authSelection.auth_mode,
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeJobFile(workspaceRoot, jobId, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  const targetPrompt = scopedTargetPromptForOrExit(invocation, profile, prompt, lifecycleEvents);

  if (options.background) {
    try {
      writePromptSidecar(resolveJobsDir(workspaceRoot), jobId, targetPrompt);
      writeRuntimeOptionsSidecar(workspaceRoot, jobId, { timeout_ms: timeoutMs });
    } catch (error) {
      failBackgroundPromptSidecarWrite(workspaceRoot, invocation, error);
    }
    const { child, error } = await spawnDetachedWorker(cwd, jobId, authSelection.auth_mode);
    if (error) failBackgroundWorkerSpawn(workspaceRoot, invocation, error);
    const launched = externalReviewBackgroundLaunchedEvent(
      invocation,
      child.pid,
      externalReviewForInvocation(invocation),
    );
    printLifecycleJson(launched, lifecycleEvents);
    process.exit(0);
  }

  await executeRun(invocation, targetPrompt, { foreground: true, lifecycleEvents });
}

async function executeRun(invocation, prompt, { foreground, lifecycleEvents = null }) {
  let authSelection = resolveAuthSelection(invocation.auth_mode);
  invocation = invocationWithAuthSelection(invocation, authSelection);
  const { job_id: jobId, workspace_root: workspaceRoot } = invocation;
  const profile = resolveProfile(invocation.mode_profile_name);
  const executionScope = setupExecutionScopeOrExit(invocation, profile, { foreground, lifecycleEvents });
  const mutationContext = prepareMutationContext(invocation, profile);
  const resumeId = latestResumeId(invocation);

  exitIfCancelledBeforeSpawn(invocation, executionScope, mutationContext, { foreground, lifecycleEvents });

  let preflightExecution = await geminiReadinessPreflight(invocation, profile, authSelection);
  if (preflightExecution) {
    const fallbackSelection = autoApiKeyFallbackSelectionForGeminiFailure(authSelection, preflightExecution);
    if (fallbackSelection) {
      authSelection = fallbackSelection;
      invocation = invocationWithAuthSelection(invocation, authSelection);
      preflightExecution = await geminiReadinessPreflight(invocation, profile, authSelection);
    }
    if (preflightExecution) {
      preflightExecution.reviewAuditManifest = reviewAuditManifest(invocation, prompt, executionScope.containment.path, preflightExecution);
      const errorRecord = buildJobRecord(invocation, {
        exitCode: preflightExecution.exitCode,
        endedAt: preflightExecution.endedAt,
        parsed: preflightExecution.parsed,
        pidInfo: null,
        geminiSessionId: null,
        errorMessage: preflightExecution.errorMessage,
        signal: preflightExecution.signal ?? null,
        timedOut: preflightExecution.timedOut === true,
        reviewAuditManifest: preflightExecution.reviewAuditManifest,
      }, mutationContext.mutations);
      writeJobFile(workspaceRoot, jobId, errorRecord);
      upsertJob(workspaceRoot, errorRecord);
      for (const [name, contents] of [
        ["stdout.log", preflightExecution.stdout],
        ["stderr.log", preflightExecution.stderr],
      ]) {
        try { writeSidecar(workspaceRoot, jobId, name, contents); }
        catch (e) {
          process.stderr.write(`gemini-companion: warning: sidecar ${name} write failed: ${e.message}\n`);
        }
      }
      cleanupExecutionResources(executionScope, mutationContext);
      if (foreground) printLifecycleJson(errorRecord, lifecycleEvents);
      process.exit(2);
    }
  }

  if (foreground && lifecycleEvents) {
    printLifecycleJson(
      externalReviewLaunchedEvent(invocation, externalReviewForInvocation(invocation)),
      lifecycleEvents,
    );
  }

  const stopHeartbeat = foreground ? startExternalReviewHeartbeat(invocation, lifecycleEvents) : () => {};
  let execution;
  let executedInvocation;
  try {
    ({ execution, executedInvocation } = await spawnGeminiOrExit(
      invocation,
      profile,
      prompt,
      executionScope,
      mutationContext,
      { foreground, lifecycleEvents, resumeId, authSelection },
    ));
  } finally {
    stopHeartbeat();
  }

  recordPostRunMutations(invocation, mutationContext);

  const cancelMarker = consumeCancelMarker(workspaceRoot, jobId);
  const finalRecord = buildGeminiFinalRecord(
    executedInvocation,
    execution,
    cancelMarker,
    mutationContext.mutations,
    prompt,
    executionScope.containment.path,
  );
  const { metaError, stateError } = commitJobRecord(workspaceRoot, jobId, finalRecord);

  writeExecutionSidecars(workspaceRoot, jobId, execution);
  exitIfFinalizationFailed(invocation, execution, finalRecord, mutationContext, executionScope, { metaError, stateError });

  cleanupExecutionResources(executionScope, mutationContext);
  if (foreground) printLifecycleJson(finalRecord, lifecycleEvents);
  process.exit(finalRecord.status === "completed" || finalRecord.status === "cancelled" ? 0 : 2);
}

function invocationWithAuthSelection(invocation, authSelection) {
  return Object.freeze({
    ...invocation,
    selected_auth_path: authSelection.selected_auth_path,
    ...(authSelection.auth_fallback ? { auth_fallback: authSelection.auth_fallback } : {}),
  });
}

function autoApiKeyFallbackSelectionForGeminiFailure(authSelection, execution) {
  const reason = geminiAuthFallbackReason(authSelection, execution);
  return reason ? apiKeyFallbackSelection(authSelection, reason) : null;
}

function geminiAuthFallbackReason(authSelection, execution) {
  if (authSelection?.auth_mode !== "auto" || authSelection.selected_auth_path !== "subscription_oauth") return null;
  const message = String(execution?.errorMessage ?? "");
  if (message.startsWith("not_authed:")) return "not_authed";
  if (message.startsWith("sandbox_blocked:")) return "sandbox_blocked";
  const failureText = pingFailureText(execution);
  const detail = pingFailureDetail(execution);
  if (isGeminiCodexSandboxBlocked(failureText)) return "sandbox_blocked";
  if (PING_AUTH_RE.test(detail)) return "not_authed";
  return null;
}

function setupExecutionScopeOrExit(invocation, profile, { foreground, lifecycleEvents }) {
  let containment = null;
  try {
    containment = setupContainment(profile, invocation.cwd);
    populateScope(profile, invocation.cwd, containment.path, {
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
      workspaceRoot: invocation.workspace_root,
    }, containment);
    return { containment, disposeEffective: invocation.dispose_effective };
  } catch (e) {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
      errorMessage: e.message,
    }, []);
    writeJobFile(invocation.workspace_root, invocation.job_id, errorRecord);
    upsertJob(invocation.workspace_root, errorRecord);
    if (foreground) printLifecycleJson(errorRecord, lifecycleEvents);
    process.exit(2);
  }
}

function prepareMutationContext(invocation, profile) {
  const checkMutations = profile.permission_mode === "plan";
  const context = { checkMutations, gitStatusBefore: null, neutralCwd: null, mutations: [] };
  if (!checkMutations) return context;
  try {
    context.neutralCwd = mkdtempSync(joinPath(tmpdir(), "gemini-neutral-cwd-"));
  } catch (e) {
    context.mutations.push(mutationDetectionFailure(e, "neutral cwd setup failed"));
  }
  try {
    context.gitStatusBefore = gitStatus(["status", "-s", "--untracked-files=all"], invocation.cwd, invocation.workspace_root);
    writeSidecar(invocation.workspace_root, invocation.job_id, "git-status-before.txt", context.gitStatusBefore);
  } catch (e) {
    if (isGitBinaryPolicyError(e)) throw e;
    context.mutations.push(mutationDetectionFailure(e));
  }
  return context;
}

function latestResumeId(invocation) {
  return invocation.resume_chain && invocation.resume_chain.length > 0
    ? invocation.resume_chain[invocation.resume_chain.length - 1]
    : null;
}

function exitIfCancelledBeforeSpawn(invocation, executionScope, mutationContext, { foreground, lifecycleEvents }) {
  if (!consumeCancelMarker(invocation.workspace_root, invocation.job_id)) return;
  cleanupExecutionResources(executionScope, mutationContext);
  const cancelledRecord = buildJobRecord(invocation, {
    status: "cancelled",
    exitCode: null,
    parsed: null,
    pidInfo: null,
    geminiSessionId: null,
  }, mutationContext.mutations);
  writeJobFile(invocation.workspace_root, invocation.job_id, cancelledRecord);
  upsertJob(invocation.workspace_root, cancelledRecord);
  if (foreground) printLifecycleJson(cancelledRecord, lifecycleEvents);
  process.exit(0);
}

async function spawnGeminiOrExit(invocation, profile, prompt, executionScope, mutationContext, options) {
  try {
    return await spawnGeminiWithFallbacks(invocation, profile, prompt, executionScope, mutationContext, options);
  } catch (e) {
    const executedInvocation = e.executedInvocation ?? invocation;
    const errorRecord = buildJobRecord(executedInvocation, {
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
      errorMessage: e.message,
    }, mutationContext.mutations);
    writeJobFile(invocation.workspace_root, invocation.job_id, errorRecord);
    upsertJob(invocation.workspace_root, errorRecord);
    cleanupExecutionResources(executionScope, mutationContext);
    if (options.foreground) printLifecycleJson(errorRecord, options.lifecycleEvents);
    process.exit(2);
  }
}

async function spawnGeminiWithFallbacks(invocation, profile, prompt, executionScope, mutationContext, options) {
  const authSelection = options.authSelection ?? resolveAuthSelection(invocation.auth_mode);
  const modelCandidates = modelCandidatesForInvocation(profile, invocation);
  let execution;
  let executedInvocation = invocation;
  for (let i = 0; i < modelCandidates.length; i++) {
    const attemptModel = modelCandidates[i];
    const attemptInvocation = Object.freeze({ ...invocation, model: attemptModel });
    try {
      execution = await spawnOneGeminiAttempt(attemptInvocation, profile, prompt, executionScope, mutationContext, {
        allowedApiKeyEnv: authSelection.allowed_env_credentials,
        resumeId: options.resumeId,
      });
    } catch (e) {
      e.executedInvocation = attemptInvocation;
      throw e;
    }
    executedInvocation = attemptInvocation;
    if (!shouldRetryGeminiModel(execution, modelCandidates, i)) break;
    warnGeminiModelRetry(attemptModel, modelCandidates[i + 1]);
  }
  return { execution, executedInvocation };
}

function spawnOneGeminiAttempt(invocation, profile, prompt, executionScope, mutationContext, options) {
  return spawnGemini(profile, {
    model: invocation.model,
    promptText: prompt,
    policyPath: profile.permission_mode === "plan" ? READ_ONLY_POLICY : null,
    includeDirPath: executionScope.containment.path,
    cwd: mutationContext.neutralCwd ?? executionScope.containment.path,
    binary: invocation.binary,
    resumeId: options.resumeId,
    timeoutMs: invocation.timeout_ms,
    allowedApiKeyEnv: options.allowedApiKeyEnv,
    onSpawn: (pidInfo) => writeRunningRecord(invocation, pidInfo, mutationContext.mutations),
  });
}

function shouldRetryGeminiModel(execution, modelCandidates, index) {
  return execution.exitCode !== 0
    && index < modelCandidates.length - 1
    && retryableModelCapacityFailure(execution);
}

function warnGeminiModelRetry(fromModel, toModel) {
  process.stderr.write(
    `gemini-companion: warning: model ${fromModel ?? "<native>"} capacity-limited; ` +
    `retrying with ${toModel}\n`,
  );
}

function writeRunningRecord(invocation, pidInfo, mutations) {
  const runningRecord = buildJobRecord(invocation, {
    status: "running",
    exitCode: null,
    parsed: null,
    pidInfo,
    geminiSessionId: null,
  }, mutations);
  writeJobFile(invocation.workspace_root, invocation.job_id, runningRecord);
  upsertJob(invocation.workspace_root, runningRecord);
}

function recordPostRunMutations(invocation, mutationContext) {
  if (!mutationContext.checkMutations || mutationContext.gitStatusBefore === null) return;
  let gitStatusAfter = null;
  try {
    gitStatusAfter = gitStatus(["status", "-s", "--untracked-files=all"], invocation.cwd, invocation.workspace_root);
    writeGitStatusAfterSidecar(invocation, gitStatusAfter);
  } catch (e) {
    if (isGitBinaryPolicyError(e)) throw e;
    mutationContext.mutations.push(mutationDetectionFailure(e));
  }
  if (!gitStatusAfter || gitStatusAfter === mutationContext.gitStatusBefore) return;
  const beforeLines = new Set(gitStatusLines(mutationContext.gitStatusBefore));
  mutationContext.mutations.push(...gitStatusLines(gitStatusAfter).filter((line) => !beforeLines.has(line)));
}

function writeGitStatusAfterSidecar(invocation, gitStatusAfter) {
  try {
    writeSidecar(invocation.workspace_root, invocation.job_id, "git-status-after.txt", gitStatusAfter);
  } catch (e) {
    process.stderr.write(`gemini-companion: warning: sidecar git-status-after.txt write failed: ${e.message}\n`);
  }
}

function buildGeminiFinalRecord(invocation, execution, cancelMarker, mutations, prompt, containmentPath) {
  execution.reviewAuditManifest = reviewAuditManifest(invocation, prompt, containmentPath, execution);
  return buildJobRecord(invocation, {
    exitCode: execution.exitCode,
    endedAt: execution.endedAt,
    parsed: execution.parsed,
    pidInfo: execution.pidInfo,
    geminiSessionId: execution.geminiSessionId,
    ...(cancelMarker ? { status: "cancelled" } : {}),
    signal: execution.signal ?? null,
    timedOut: execution.timedOut === true,
    reviewAuditManifest: execution.reviewAuditManifest,
  }, mutations);
}

function writeExecutionSidecars(workspaceRoot, jobId, execution) {
  for (const [name, contents] of [["stdout.log", execution.stdout], ["stderr.log", execution.stderr]]) {
    try { writeSidecar(workspaceRoot, jobId, name, contents); }
    catch (e) {
      process.stderr.write(`gemini-companion: warning: sidecar ${name} write failed: ${e.message}\n`);
    }
  }
}

function exitIfFinalizationFailed(invocation, execution, finalRecord, mutationContext, executionScope, errors) {
  const { metaError, stateError } = errors;
  if (!metaError && !stateError) return;
  const detail = [
    metaError && `meta=${metaError.message}`,
    stateError && `state=${stateError.message}`,
  ].filter(Boolean).join("; ");
  persistFinalizationFallback(invocation, execution, finalRecord, mutationContext.mutations, errors, detail);
  cleanupExecutionResources(executionScope, mutationContext);
  fail("finalization_failed", detail, {
    error_code: (metaError ?? stateError)?.code ?? null,
  });
}

function persistFinalizationFallback(invocation, execution, finalRecord, mutations, errors, detail) {
  let fallbackRecord = null;
  try {
    fallbackRecord = buildJobRecord(invocation, {
      exitCode: execution.exitCode,
      endedAt: execution.endedAt,
      parsed: execution.parsed,
      pidInfo: execution.pidInfo,
      geminiSessionId: execution.geminiSessionId ?? null,
      errorMessage: `finalization_failed: ${detail}`,
    }, mutations);
  } catch { /* defense in depth */ }
  if (!fallbackRecord) return;
  if (errors.metaError) {
    try { writeJobFile(invocation.workspace_root, invocation.job_id, fallbackRecord); } catch { /* exhausted */ }
    try { upsertJob(invocation.workspace_root, fallbackRecord); } catch { /* exhausted */ }
  } else if (errors.stateError) {
    try { upsertJob(invocation.workspace_root, finalRecord); }
    catch {
      try { upsertJob(invocation.workspace_root, fallbackRecord); } catch { /* exhausted */ }
    }
  }
}

function cleanupExecutionResources(executionScope, mutationContext) {
  if (mutationContext.neutralCwd) {
    try { rmSync(mutationContext.neutralCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  if (executionScope.disposeEffective) {
    try { executionScope.containment.cleanup(); } catch { /* best-effort */ }
  }
}

function cleanupScopedPromptExecutionScope(executionScope) {
  try { executionScope.containment.cleanup(); } catch { /* best-effort */ }
}

function writeSidecar(workspaceRoot, jobId, name, contents) {
  const dir = `${resolveJobsDir(workspaceRoot)}/${jobId}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  const file = `${dir}/${name}`;
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpFile, contents ?? "", "utf8");
    renameSync(tmpFile, file);
  } catch (e) {
    try { unlinkSync(tmpFile); } catch { /* already gone */ }
    throw e;
  }
}

async function cmdRunWorker(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["cwd", "job", "auth-mode"],
    booleanOptions: [],
  });
  if (!options.cwd || !options.job) {
    fail("bad_args", "_run-worker requires --cwd and --job");
  }

  const workspaceRoot = resolveWorkspaceRoot(options.cwd);
  let meta;
  try {
    const jobFile = resolveJobFile(workspaceRoot, options.job);
    if (!existsSync(jobFile)) fail("not_found", `no meta.json for job ${options.job}`);
    meta = JSON.parse(readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }

  if (["completed", "failed", "cancelled", "stale"].includes(meta.status)) {
    fail("bad_state", `_run-worker refuses terminal job ${options.job}`);
  }

  // Honor a cancel that arrived while we were queued. The worker MUST check
  // this before spawning the target — otherwise the run completes (model
  // call, side effects) and only the post-run consumer at executeRun would
  // convert "completed" → "cancelled".
  if (consumeCancelMarker(workspaceRoot, options.job)) {
    try { consumePromptSidecar(resolveJobsDir(workspaceRoot), options.job); } catch { /* best-effort privacy cleanup */ }
    const cancelledRecord = buildJobRecord(invocationFromRecord(meta), {
      status: "cancelled",
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
    }, []);
    writeJobFile(workspaceRoot, options.job, cancelledRecord);
    upsertJob(workspaceRoot, cancelledRecord);
    process.exit(0);
  }

  let prompt;
  try {
    prompt = consumePromptSidecar(resolveJobsDir(workspaceRoot), options.job);
  } catch (error) {
    const errorMessage = `worker: prompt sidecar consume failed: ${error?.message ?? String(error)}`;
    const errorRecord = buildJobRecord(invocationFromRecord(meta), {
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
      errorMessage,
    }, []);
    writeJobFile(workspaceRoot, options.job, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("bad_state", errorMessage);
  }
  if (prompt == null) {
    const errorRecord = buildJobRecord(invocationFromRecord(meta), {
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
      errorMessage: "worker: prompt sidecar missing; job cannot resume",
    }, []);
    writeJobFile(workspaceRoot, options.job, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("bad_state", "prompt sidecar missing for job " + options.job);
  }

  const runtimeOptions = readRuntimeOptionsSidecar(workspaceRoot, options.job);
  const invocation = invocationFromRecord(meta, options["auth-mode"], runtimeOptions);
  const authSelection = resolveAuthSelection(invocation.auth_mode);
  if (authSelection.selected_auth_path === "api_key_env_missing") {
    // The prompt sidecar was already consumed above, so auth refusal cannot leave it on disk.
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
      errorMessage: `worker: ${apiKeyMissingMessage()}`,
    }, []);
    writeJobFile(workspaceRoot, options.job, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("not_authed", apiKeyMissingMessage(), apiKeyMissingFields(authSelection));
  }
  await executeRun(invocation, prompt, { foreground: false });
}

async function cmdContinue(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["job", "cwd", "model", "binary", "auth-mode", "timeout-ms", "lifecycle-events"],
    booleanOptions: ["background", "foreground"],
  });
  if (!options.job) fail("bad_args", "--job <id> is required");
  if (options.background && options.foreground) {
    fail("bad_args", "--background and --foreground are mutually exclusive");
  }
  let lifecycleEvents;
  try {
    lifecycleEvents = parseLifecycleEventsMode(options["lifecycle-events"]);
  } catch (error) {
    fail("bad_args", error.message);
  }

  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let prior;
  try {
    const jobFile = resolveJobFile(workspaceRoot, options.job);
    if (!existsSync(jobFile)) fail("not_found", `no meta.json for job ${options.job}`);
    prior = JSON.parse(readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }

  if (!CONTINUABLE_STATUSES.has(prior.status)) {
    fail("bad_state", `cannot continue job in status ${JSON.stringify(prior.status)}; wait for terminal status or cancel first`);
  }

  const prompt = positionals.join(" ").trim();
  if (!prompt) fail("bad_args", "prompt is required (pass after -- separator)");

  const priorGeminiSessionId = prior.gemini_session_id ?? null;
  if (!priorGeminiSessionId) {
    // PR #21 review HIGH 4: surface an actionable next step when the prior
    // record is a stale orphan that never produced a session ID.
    const isStaleOrphan = prior.status === "stale";
    const reason = isStaleOrphan
      ? "the worker exited before Gemini returned a session ID, so there is no chat to resume."
      : "this record carries no session ID and cannot be chained.";
    const suggestion = isStaleOrphan
      ? ` Re-run from scratch: gemini-companion run --mode ${prior.mode_profile_name ?? prior.mode} --cwd ${JSON.stringify(prior.cwd)} -- "<your prompt>"`
      : "";
    fail("no_session_to_resume",
      `prior job ${options.job} has no gemini_session_id to resume — ${reason}${suggestion}`);
  }

  const newJobId_ = newJobId();
  const model = options.model ?? prior.model;
  const priorModeName = prior.mode_profile_name ?? prior.mode;
  const priorProfile = resolveProfile(priorModeName);
  const priorResumeChain = Array.isArray(prior.resume_chain) ? prior.resume_chain : [];
  const priorRuntimeOptions = readRuntimeOptionsSidecar(workspaceRoot, options.job);
  const priorTimeoutMs =
    priorRuntimeOptions.timeout_ms ??
    prior.review_metadata?.audit_manifest?.request?.timeout_ms ??
    DEFAULT_GEMINI_REVIEW_TIMEOUT_MS;
  const timeoutMs = parseReviewTimeoutMs(options["timeout-ms"], process.env, priorTimeoutMs);
  const authSelection = resolveAuthSelection(options["auth-mode"]);
  if (authSelection.selected_auth_path === "api_key_env_missing") {
    fail("not_authed", apiKeyMissingMessage(), apiKeyMissingFields(authSelection));
  }
  const invocation = Object.freeze({
    job_id: newJobId_,
    target: "gemini",
    parent_job_id: options.job,
    resume_chain: [...priorResumeChain, priorGeminiSessionId],
    mode_profile_name: priorProfile.name,
    mode: priorModeName,
    model,
    cwd,
    workspace_root: workspaceRoot,
    containment: priorProfile.containment,
    scope: priorProfile.scope,
    dispose_effective: prior.dispose_effective ?? priorProfile.dispose_default,
    scope_base: prior.scope_base ?? null,
    scope_paths: prior.scope_paths ?? null,
    prompt_head: prompt.slice(0, 200),
    review_prompt_contract_version: priorProfile.name === "rescue" ? null : REVIEW_PROMPT_CONTRACT_VERSION,
    review_prompt_provider: priorProfile.name === "rescue" ? null : "Gemini CLI",
    timeout_ms: timeoutMs,
    schema_spec: prior.schema_spec ?? null,
    binary: options.binary ?? process.env.GEMINI_BINARY ?? "gemini",
    run_kind: options.background ? "background" : "foreground",
    auth_mode: authSelection.auth_mode,
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeJobFile(workspaceRoot, newJobId_, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  const targetPrompt = scopedTargetPromptForOrExit(invocation, priorProfile, prompt, lifecycleEvents);

  if (options.background) {
    try {
      writePromptSidecar(resolveJobsDir(workspaceRoot), newJobId_, targetPrompt);
      writeRuntimeOptionsSidecar(workspaceRoot, newJobId_, { timeout_ms: timeoutMs });
    } catch (error) {
      failBackgroundPromptSidecarWrite(workspaceRoot, invocation, error);
    }
    const { child, error } = await spawnDetachedWorker(cwd, newJobId_, authSelection.auth_mode);
    if (error) failBackgroundWorkerSpawn(workspaceRoot, invocation, error);
    const launched = externalReviewBackgroundLaunchedEvent(
      invocation,
      child.pid,
      externalReviewForInvocation(invocation),
    );
    printLifecycleJson(launched, lifecycleEvents);
    process.exit(0);
  }

  await executeRun(invocation, targetPrompt, { foreground: true, lifecycleEvents });
}

async function cmdStatus(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["job", "cwd"], booleanOptions: ["all"] });
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // #16 follow-up 3: reconcile orphan active jobs before listing.
  reconcileActiveJobs(workspaceRoot);
  const jobs = listJobs(workspaceRoot);
  if (options.job) {
    const match = jobs.find((j) => j.id === options.job);
    if (!match) fail("not_found", `no job with id ${options.job} in workspace ${workspaceRoot}`);
    printJson(match);
    return;
  }
  // Default status view: every continuable + actionable state. cancelled
  // and stale are continuable terminal states (#16 follow-up 2/4) so they
  // belong in the default view alongside running/completed/failed; --all
  // is the only way to surface queued (transient pre-spawn).
  const DEFAULT_STATUSES = new Set(["running", "completed", "failed", "cancelled", "stale"]);
  const filtered = options.all
    ? jobs
    : jobs.filter((j) => DEFAULT_STATUSES.has(j.status));
  printJson({ workspace_root: workspaceRoot, jobs: filtered });
}

async function cmdResult(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["job", "cwd"], booleanOptions: [] });
  if (!options.job) fail("bad_args", "--job <id> is required");
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let jobFile;
  try { jobFile = resolveJobFile(workspaceRoot, options.job); }
  catch (e) { fail("bad_args", e.message); }
  if (!existsSync(jobFile)) fail("not_found", `no meta.json for job ${options.job}`);
  // PR #21 review MED 1: wrap the read so a directory-at-meta-path
  // (GEMINI_MOCK_META_CONFLICT, or a half-finalized job) produces a
  // friendly error instead of an unhandled EISDIR stacktrace.
  let meta;
  try {
    meta = JSON.parse(readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("read_failed",
      `cannot read meta.json for job ${options.job}: ${e.message}`,
      { error_code: e.code ?? null });
  }
  printJson(meta);
}

const PING_AUTH_RE = /\b(auth(?:enticat\w*)?|login|credential\w*|oauth2?|unauthenticated|signin|sign-in)\b/i;
const PING_PROVIDER_API_KEY_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];

function resolveAuthSelection(requestedMode = "subscription") {
  return resolveAuthSelectionForProvider({
    requestedMode,
    providerApiKeyEnvNames: PING_PROVIDER_API_KEY_ENV,
    fail,
  });
}

function apiKeyMissingMessage() {
  return buildApiKeyMissingMessage(PING_PROVIDER_API_KEY_ENV);
}

function apiKeyMissingFields(selection, notAuthedFields = {}) {
  return buildApiKeyMissingFields({
    selection,
    notAuthedFields,
    providerName: "Gemini",
    providerApiKeyEnvNames: PING_PROVIDER_API_KEY_ENV,
  });
}

function pingOkFields(authSelection = null, modelFallback = null) {
  const authSummary = authSelection?.selected_auth_path === "api_key_env"
    ? "Gemini CLI is ready using API-key auth."
    : "Gemini CLI is ready using first-party CLI auth.";
  return {
    ready: true,
    summary: modelFallback
      ? "Gemini CLI is ready; the preferred model was capacity-limited and a configured fallback was used."
      : authSummary,
    next_action: "Run a Gemini review command.",
    ...(modelFallback ? { model_fallback: modelFallback } : {}),
  };
}

function pingNotAuthedFields() {
  return {
    ready: false,
    summary: "Gemini subscription/OAuth auth is not available to this companion process.",
    next_action: "In a normal terminal, unset GEMINI_API_KEY and GOOGLE_API_KEY, then run: gemini and complete /auth if prompted.",
  };
}

function pingRateLimitedFields() {
  return {
    ready: false,
    summary: "Gemini auth works, but every configured model candidate is currently rate-limited or capacity-limited.",
    next_action: "Retry later, or update plugins/gemini/config/models.json with an available full model ID.",
  };
}

function pingNotFoundFields() {
  return {
    ready: false,
    summary: "Gemini CLI binary was not found on PATH.",
    next_action: "Install Gemini CLI from https://github.com/google-gemini/gemini-cli, or rerun setup with --binary pointing at your gemini executable.",
  };
}

function pingErrorFields() {
  return {
    ready: false,
    summary: "Gemini CLI ping failed before readiness could be confirmed.",
    next_action: "Inspect detail, fix the Gemini CLI error, then rerun setup.",
  };
}

function pingSandboxBlockedFields() {
  return {
    ready: false,
    summary: "Gemini CLI is blocked by Codex sandbox access to Gemini state.",
    next_action: "Add ~/.gemini to [sandbox_workspace_write].writable_roots in ~/.codex/config.toml, start a fresh Codex session, then rerun /gemini-setup. Alternatively, run this check outside sandbox.",
  };
}

function pingFailureText(execution) {
  const raw = execution?.parsed?.raw;
  const rawText = typeof raw === "string"
    ? raw
    : (raw == null ? "" : JSON.stringify(raw));
  const parsedError = execution?.parsed?.reason === "json_parse_error"
    ? null
    : execution?.parsed?.error;
  return [
    execution?.stderr,
    parsedError,
    execution?.parsed?.result,
    execution?.stdout,
    rawText,
    execution?.timedOut ? "target CLI exceeded the configured timeoutMs" : "",
    execution?.signal ? `signal ${execution.signal}` : "",
    execution?.exitCode == null ? "" : `exit ${execution.exitCode}`,
  ].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
}

function pingFailureDetail(execution) {
  const detail = pingFailureText(execution);
  const firstLine = detail.split("\n").map((line) => line.trim()).find(Boolean);
  const hasStackFrame = detail
    .split("\n")
    .some((line) => line.trimStart().startsWith("at "));
  const concise = hasStackFrame && firstLine ? firstLine : detail;
  return concise.slice(0, 500);
}

function isGeminiCodexSandboxBlocked(detail) {
  if (!isCodexSandbox(process.env)) return false;
  const permissionRe = /Operation not permitted|Permission denied|PermissionError|EACCES|EPERM/i;
  const geminiPathRe = /(?:^|[/\\])\.gemini(?:[/\\]|['"\s:)]|$)/;
  const lines = String(detail ?? "").split("\n");
  return lines.some((line, i) => {
    if (permissionRe.test(line) && geminiPathRe.test(line)) return true;
    const nextLine = lines[i + 1] ?? "";
    return permissionRe.test(line) && /^\s/.test(nextLine) && geminiPathRe.test(nextLine);
  });
}

async function runGeminiPingAttempts({ profile, candidates, model, binary, timeoutMs, authSelection }) {
  let execution = null;
  let selectedModel = model;
  let modelFallback = null;
  const modelFallbackHops = [];
  for (let i = 0; i < candidates.length; i++) {
    selectedModel = candidates[i];
    execution = await spawnGemini(profile, {
      model: selectedModel,
      promptText: PING_PROMPT,
      policyPath: READ_ONLY_POLICY,
      cwd: makeGeminiPingCwd(),
      binary,
      timeoutMs,
      allowedApiKeyEnv: authSelection.allowed_env_credentials,
    });
    if (
      execution.exitCode !== 0 &&
      i < candidates.length - 1 &&
      retryableModelCapacityFailure(execution)
    ) {
      const hop = {
        from: selectedModel,
        to: candidates[i + 1],
        reason: "capacity_limited",
      };
      modelFallbackHops.push(hop);
      modelFallback = {
        ...hop,
        hops: [...modelFallbackHops],
      };
      process.stderr.write(
        `gemini-companion: warning: ping model ${selectedModel ?? "<native>"} capacity-limited; ` +
        `retrying with ${candidates[i + 1]}\n`,
      );
      continue;
    }
    break;
  }
  return { execution, selectedModel, modelFallback };
}

async function cmdPing(rest, { readinessProfileName = "ping" } = {}) {
  const { options } = parseArgs(rest, { valueOptions: ["model", "binary", "timeout-ms", "auth-mode"], booleanOptions: [] });
  const profile = resolveProfile(readinessProfileName);
  const modelsConfig = loadModels();
  const model = options.model ?? resolveModelForProfile(profile, modelsConfig);
  const modelCandidates = options.model
    ? [options.model]
    : resolveModelCandidatesForProfile(profile, modelsConfig);
  const candidates = modelCandidates.length > 0 ? modelCandidates : [model];
  let authSelection = resolveAuthSelection(options["auth-mode"]);
  if (authSelection.selected_auth_path === "api_key_env_missing") {
    printJson({ status: "not_authed", ...apiKeyMissingFields(authSelection, pingNotAuthedFields()) });
    process.exit(2);
  }
  try {
    const pingInputs = {
      profile,
      candidates,
      model,
      binary: options.binary ?? process.env.GEMINI_BINARY ?? "gemini",
      timeoutMs: Number(options["timeout-ms"] ?? DEFAULT_GEMINI_PING_TIMEOUT_MS),
    };
    let { execution, selectedModel, modelFallback } = await runGeminiPingAttempts({
      ...pingInputs,
      authSelection,
    });
    const fallbackSelection = autoApiKeyFallbackSelectionForGeminiFailure(authSelection, execution);
    if (fallbackSelection) {
      authSelection = fallbackSelection;
      ({ execution, selectedModel, modelFallback } = await runGeminiPingAttempts({
        ...pingInputs,
        authSelection,
      }));
    }
    if (execution.parsed.ok) {
      const payload = { status: "ok", ...pingOkFields(authSelection, modelFallback), ...authDiagnosticFields(authSelection), model: selectedModel ?? null,
        session_id: execution.geminiSessionId, usage: execution.parsed.usage };
      printJson(payload);
      process.exit(0);
    }
    const detail = pingFailureDetail(execution);
    const failureText = pingFailureText(execution);
    if (isGeminiCodexSandboxBlocked(failureText)) {
      printJson({ status: "sandbox_blocked", ...pingSandboxBlockedFields(), ...authDiagnosticFields(authSelection), exit_code: execution.exitCode, detail });
      process.exit(2);
    }
    if (/rate limit|429|overloaded/i.test(detail)) {
      printJson({ status: "rate_limited", ...pingRateLimitedFields(), ...authDiagnosticFields(authSelection), detail });
      process.exit(2);
    }
    if (PING_AUTH_RE.test(detail)) {
      printJson({ status: "not_authed", ...pingNotAuthedFields(), detail,
        ...authDiagnosticFields(authSelection),
        hint: authSelection.selected_auth_path === "api_key_env"
          ? "Gemini was launched with explicit API-key auth. Check the provider key and CLI support."
          : "Run `gemini` interactively to complete OAuth. API-key env vars are ignored by subscription-mode policy." });
      process.exit(2);
    }
    printJson({ status: "error", ...pingErrorFields(), ...authDiagnosticFields(authSelection), exit_code: execution.exitCode, detail });
    process.exit(2);
  } catch (e) {
    if (e.code === "ENOENT") {
      printJson({ status: "not_found", ...pingNotFoundFields(),
        ...authDiagnosticFields(authSelection),
        detail: "gemini binary not found on PATH (or GEMINI_BINARY override)",
        install_url: "https://github.com/google-gemini/gemini-cli" });
      process.exit(2);
    }
    if (isGeminiCodexSandboxBlocked(e.message)) {
      printJson({ status: "sandbox_blocked", ...pingSandboxBlockedFields(), ...authDiagnosticFields(authSelection), detail: e.message });
      process.exit(2);
    }
    printJson({ status: "error", ...pingErrorFields(), ...authDiagnosticFields(authSelection), detail: e.message });
    process.exit(2);
  }
}

// ——— subcommand: cancel (signal a running job) ———
//
// Mirror of claude-companion.mjs's cmdCancel. Issue #22 sub-task 1: prior
// to this commit the dispatch routed `cancel` to fail("not_implemented"),
// so users had no way to cancel a Gemini background job through the
// documented interface.
//
// §21.1: signal target is resolved through `pid_info = {pid, starttime,
// argv0}`, never through pid alone. The ps/proc re-read is both the
// liveness check AND the ownership proof — if starttime or argv0 drift,
// we refuse to signal (`stale_pid`) because the pid has been reused by
// an unrelated process.
async function cmdCancel(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["job", "cwd"],
    booleanOptions: ["force"],
  });
  if (!options.job) fail("bad_args", "--job <id> is required");
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  const job = jobs.find((j) => j.id === options.job);
  if (!job) fail("not_found", `no job with id ${options.job}`);
  if (job.status !== "running") {
    // "Truly terminal" — the job has reached a stop state, nothing to do.
    if (["completed", "failed", "cancelled", "stale"].includes(job.status)) {
      printJson({ ok: true, status: "already_terminal", job_status: job.status, job_id: options.job });
      return;
    }
    // From here, only "queued" is a valid non-running state worth marker-
    // writing. Any other unknown status reflects a state-corruption bug
    // elsewhere; surface it via bad_state instead of silently treating it
    // as queued and writing a marker the worker may never see.
    if (job.status !== "queued") {
      fail("bad_state", `unexpected job status ${JSON.stringify(job.status)} for job ${options.job}`);
    }
    // Queued: the worker hasn't spawned the target binary yet. Drop a
    // cancel marker so the worker refuses to spawn on pickup. The marker
    // IS the cancel mechanism here (no SIGTERM fallback), so a write
    // failure must NOT report cancel_pending — exit 1 with cancel_failed.
    try {
      writeCancelMarker(workspaceRoot, options.job);
    } catch (e) {
      fail("cancel_failed",
        "could not durably record cancel intent (marker write failed); job may still spawn",
        { job_id: options.job, detail: e.message });
    }
    printJson({ ok: true, status: "cancel_pending", job_status: job.status, job_id: options.job });
    return;
  }
  // From here on, job.status === "running". Verification failures must not
  // exit 0: an exit-0 contract means "the cancel post-condition holds"
  // (process gone or never running). We can't promise either when ownership
  // proof is missing, so these paths exit 2 (refused for safety).
  const pidInfo = job.pid_info ?? null;
  if (!pidInfo || !Number.isInteger(pidInfo.pid)) {
    printJson({
      ok: false,
      status: "no_pid_info",
      detail: "job has no pid_info; cannot safely signal (legacy record or race)",
      job_id: options.job,
      suggested_action: cancelNoPidInfoSuggestedAction(),
    });
    process.exit(2);
  }
  if (pidInfo.capture_error) {
    printJson({
      ok: false,
      status: "unverifiable",
      detail: "could not verify pid ownership because process inspection was blocked; refusing to signal",
      job_id: options.job,
      pid: pidInfo.pid,
      capture_error: pidInfo.capture_error,
      suggested_action: cancelUnverifiableSuggestedAction(pidInfo.pid),
    });
    process.exit(2);
  }
  if (!pidInfo.starttime || !pidInfo.argv0) {
    printJson({
      ok: false,
      status: "no_pid_info",
      detail: "job has pid but no complete ownership proof; refusing to signal",
      job_id: options.job,
      pid: pidInfo.pid,
      capture_error: null,
      suggested_action: cancelNoPidInfoSuggestedAction(),
    });
    process.exit(2);
  }
  const check = verifyPidInfo(pidInfo);
  if (!check.match) {
    if (check.reason === "process_gone") {
      printJson({ ok: true, status: "already_dead", job_id: options.job, pid: pidInfo.pid });
      return;
    }
    if (check.reason === "capture_error") {
      // Issue #22 sub-task 3: ps/proc was unavailable (PATH stripped,
      // sandbox-denied exec, hidepid mount). Refusing to signal is safe;
      // the distinct status lets operators tell "I can't ask" apart from
      // "the pid was reused".
      process.stderr.write(
        `gemini-companion: unverifiable — could not verify pid ${pidInfo.pid} ` +
        `ownership (ps/proc unavailable). Refusing to signal.\n`
      );
      printJson({
        ok: false,
        status: "unverifiable",
        detail: "could not verify pid ownership; refusing to signal",
        job_id: options.job,
        pid: pidInfo.pid,
        suggested_action: cancelUnverifiableSuggestedAction(pidInfo.pid),
      });
      process.exit(2);
    }
    process.stderr.write(
      `gemini-companion: stale_pid (${check.reason}) — refusing to signal pid ${pidInfo.pid}\n`
    );
    printJson({
      ok: false,
      status: "stale_pid",
      reason: check.reason,
      job_id: options.job,
      pid: pidInfo.pid,
    });
    process.exit(2);
  }
  // Issue #22 sub-task 2: see lib/cancel-marker.mjs for SIGTERM-trap rationale.
  try {
    writeCancelMarker(workspaceRoot, options.job);
  } catch (e) {
    process.stderr.write(`gemini-companion: warning: cancel marker write failed: ${e.message}\n`);
  }

  const signal = options.force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pidInfo.pid, signal);
  } catch (e) {
    if (e?.code === "ESRCH") {
      printJson({ ok: true, status: "already_dead", job_id: options.job, pid: pidInfo.pid });
      return;
    }
    fail("signal_failed", e.message, { pid: pidInfo.pid, signal });
  }
  printJson({ ok: true, status: "signaled", signal, job_id: options.job, pid: pidInfo.pid });
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "preflight": return cmdPreflight(rest);
    case "run": return cmdRun(rest);
    case "_run-worker": return cmdRunWorker(rest);
    case "ping": return cmdPing(rest);
    case "status": return cmdStatus(rest);
    case "result": return cmdResult(rest);
    case "continue": return cmdContinue(rest);
    case "cancel": return cmdCancel(rest);
    case "doctor": return cmdPing(rest, { readinessProfileName: "review" });
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write("gemini-companion: see docs/superpowers/specs/ §7 for subcommand surface.\n");
      process.exit(0);
    default:
      fail("bad_args", `unknown subcommand ${JSON.stringify(sub)}`);
  }
}

main().catch((e) => {
  if (isGitBinaryPolicyError(e)) {
    fail("git_binary_rejected", e.message);
  }
  process.stderr.write(`gemini-companion: unhandled: ${e.stack ?? e.message ?? e}\n`);
  process.exit(1);
});
