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
import { buildJobRecord, externalReviewForInvocation } from "./lib/job-record.mjs";
import { reconcileActiveJobs } from "./lib/reconcile.mjs";
import { cleanGitEnv } from "./lib/git-env.mjs";
import { spawnKimi } from "./lib/kimi.mjs";
import { writeCancelMarker, consumeCancelMarker } from "./lib/cancel-marker.mjs";
import { isCodexSandbox } from "./lib/codex-env.mjs";
import {
  PING_PROMPT,
  consumePromptSidecar,
  credentialNameDiagnostics,
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
  summarizeScopeDirectory,
  writePromptSidecar,
} from "./lib/companion-common.mjs";
import { REVIEW_PROMPT_CONTRACT_VERSION, buildReviewAuditManifest, buildReviewPrompt } from "./lib/review-prompt.mjs";

const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_CONFIG_PATH = resolvePath(PLUGIN_ROOT, "config/models.json");
const CONTINUABLE_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);
const RUN_MODES = Object.freeze(["review", "adversarial-review", "custom-review", "rescue"]);
const PREFLIGHT_MODES = Object.freeze(["review", "adversarial-review", "custom-review"]);
const DEFAULT_KIMI_REVIEW_TIMEOUT_MS = 600000;
const GIT_PROMPT_BINARY = "/usr/bin/git";
const GIT_PROMPT_SAFE_PATH = "/usr/bin:/bin";

configureState({
  pluginDataEnv: "KIMI_PLUGIN_DATA",
  sessionIdEnv: "KIMI_COMPANION_SESSION_ID",
});

function loadModels() {
  if (!existsSync(MODELS_CONFIG_PATH)) return { review_quality: null, rescue: null };
  return JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
}

function fail(code, message, details = {}) {
  process.stderr.write(`kimi-companion: ${message}\n`);
  printJson({ ok: false, error: code, message, ...details });
  process.exit(1);
}

function targetPromptFor(profile, userPrompt, invocation = {}) {
  if (profile.permission_mode !== "plan") return userPrompt;
  const modeLine = profile.name === "adversarial-review"
    ? "You are performing an adversarial code review. Prioritize correctness bugs, security risks, regressions, and missing tests."
    : "You are performing a code review. Prioritize bugs, behavioral regressions, and missing tests.";
  const liveContext = [
    "Live verification context:",
    "- This repository has verified the configured DeepSeek and GLM direct API endpoints/models from Codex-managed runs.",
    "- Do not reject model IDs or endpoint hosts solely because they differ from general public documentation; require current run failure evidence or repo-local contradictory evidence.",
    "- API reviewer JobRecords include the actual endpoint, HTTP status, raw model, credential key name, and usage metadata when the provider returns them.",
  ].join("\n");
  return buildReviewPrompt({
    provider: "Kimi",
    mode: profile.name,
    repository: invocation.workspace_root ?? null,
    baseRef: invocation.scope_base ?? null,
    baseCommit: gitCommitForPrompt(invocation.cwd, invocation.scope_base),
    headRef: "HEAD",
    headCommit: gitCommitForPrompt(invocation.cwd, "HEAD"),
    scope: invocation.scope ?? profile.scope,
    scopePaths: invocation.scope_paths ?? null,
    userPrompt,
    extraInstructions: [
      modeLine,
      "Your final answer must be self-contained and must not refer to prior, previous, above, or already-provided answers.",
      liveContext,
    ],
  });
}

function gitCommitForPrompt(cwd, ref) {
  if (!ref) return null;
  try {
    return execFileSync(GIT_PROMPT_BINARY, ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
      env: cleanGitPromptEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitText(args, cwd) {
  try {
    return execFileSync(GIT_PROMPT_BINARY, ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: cleanGitPromptEnv(),
    }).trim() || null;
  } catch {
    return null;
  }
}

function repositoryIdentity(cwd, workspaceRoot) {
  const remote = gitText(["remote", "get-url", "origin"], cwd);
  if (!remote) return workspaceRoot;
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return match ? match[1] : remote;
}

function promptMetadata(invocation) {
  return {
    repository: repositoryIdentity(invocation.cwd, invocation.workspace_root),
    baseRef: invocation.scope_base ?? null,
    baseCommit: gitCommitForPrompt(invocation.cwd, invocation.scope_base),
    headRef: gitText(["branch", "--show-current"], invocation.cwd) ?? "HEAD",
    headCommit: gitCommitForPrompt(invocation.cwd, "HEAD"),
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
      provider: invocation.review_prompt_provider ?? "Kimi",
      model: invocation.model,
      timeoutMs: invocation.timeout_ms ?? null,
      maxTokens: null,
      maxStepsPerTurn: invocation.max_steps_per_turn ?? null,
      temperature: null,
    },
    truncation: { prompt: false, source: false, output: false },
    providerIds: { sessionId: execution?.kimiSessionId ?? null },
    scope: {
      name: invocation.scope,
      base: invocation.scope_base ?? null,
      paths: invocation.scope_paths ?? null,
      reason: scopeResolutionReason(invocation),
    },
    result: execution?.parsed?.result ?? "",
    status: execution?.exitCode === 0 && execution?.parsed?.ok === true ? "completed" : "failed",
    errorCode: execution?.parsed?.reason ?? null,
  });
}

function cleanGitPromptEnv() {
  const env = cleanGitEnv();
  env.PATH = GIT_PROMPT_SAFE_PATH;
  return env;
}

// Mutation-detection git scrub: same shared list as claude-companion +
// scope.mjs. PR #21 review: previous local 5-key list missed
// GIT_CONFIG_GLOBAL — fold onto plugin lib's canonical scrub.

function gitStatus(args, cwd) {
  return execFileSync(GIT_PROMPT_BINARY, ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanGitPromptEnv(),
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

function runtimeOptionsSidecarPath(workspaceRoot, jobId) {
  return `${resolveJobsDir(workspaceRoot)}/${jobId}/runtime-options.json`;
}

function runtimeOptionsForRecord(record, runtimeOptions = {}) {
  const profile = resolveProfile(record.mode_profile_name ?? record.mode);
  return {
    timeout_ms:
      runtimeOptions.timeout_ms ??
      record.review_metadata?.audit_manifest?.request?.timeout_ms ??
      DEFAULT_KIMI_REVIEW_TIMEOUT_MS,
    max_steps_per_turn:
      runtimeOptions.max_steps_per_turn ??
      profile.max_steps_per_turn ??
      8,
  };
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
  const payload = {
    timeout_ms: options.timeout_ms,
    max_steps_per_turn: options.max_steps_per_turn,
  };
  try {
    writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
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
    const maxSteps = parsed.max_steps_per_turn;
    const options = {};
    if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) options.timeout_ms = timeoutMs;
    if (Number.isSafeInteger(maxSteps) && maxSteps > 0) options.max_steps_per_turn = maxSteps;
    return options;
  } catch {
    return {};
  }
}

function invocationFromRecord(record, runtimeOptions = {}) {
  const resolvedRuntimeOptions = runtimeOptionsForRecord(record, runtimeOptions);
  return {
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
    binary: record.binary,
    timeout_ms: resolvedRuntimeOptions.timeout_ms,
    run_kind: runKindFromRecord(record),
    max_steps_per_turn: resolvedRuntimeOptions.max_steps_per_turn,
    started_at: record.started_at,
  };
}

function parsePositiveTimeoutMs(value, fallback, { envName = null } = {}) {
  const raw = value === undefined || value === null || value === ""
    ? (envName ? process.env[envName] : undefined)
    : value;
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") {
    const source = value === undefined || value === null || value === "" ? envName : "--timeout-ms";
    fail("bad_args", `${source} must be a positive integer number of milliseconds; got ${JSON.stringify(raw)}`);
  }
  const parsed = Number(raw);
  if (parsed <= 0 || !Number.isSafeInteger(parsed)) {
    const source = value === undefined || value === null || value === "" ? envName : "--timeout-ms";
    fail("bad_args", `${source} must be a positive integer number of milliseconds; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parsePositiveMaxStepsPerTurn(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (parsed <= 0 || !Number.isSafeInteger(parsed)) {
    fail("bad_args", `--max-steps-per-turn must be a positive integer; got ${JSON.stringify(value)}`);
  }
  return parsed;
}

async function spawnDetachedWorker(cwd, jobId) {
  let child;
  try {
    child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "_run-worker",
      "--cwd", cwd,
      "--job", jobId,
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
    kimiSessionId: null,
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
    kimiSessionId: null,
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
      target: "kimi",
      mode: mode ?? null,
      cwd,
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure("Kimi"),
    });
  }

  const profile = resolveProfile(mode);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const scopePaths = parseScopePathsOption(options["scope-paths"]);
  let containment = null;
  let exitCode = 0;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: options["scope-base"] ?? null,
      scopePaths,
    }, containment);
    const summary = summarizeScopeDirectory(containment.path);
    printJson({
      ok: true,
      event: "preflight",
      target: "kimi",
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
      disclosure_note: preflightDisclosure("Kimi"),
    });
  } catch (e) {
    exitCode = 2;
    printJson({
      ok: false,
      event: "preflight",
      target: "kimi",
      mode,
      cwd,
      workspace_root: workspaceRoot,
      containment: profile.containment,
      scope: profile.scope,
      scope_base: options["scope-base"] ?? null,
      scope_paths: scopePaths,
      error: "scope_failed",
      error_message: e.message,
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure("Kimi"),
    });
  } finally {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
  }
  process.exit(exitCode);
}

async function cmdRun(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["mode", "model", "cwd", "binary", "scope-base", "scope-paths", "override-dispose", "timeout-ms", "max-steps-per-turn", "lifecycle-events"],
    booleanOptions: ["background", "foreground"],
  });
  const mode = options.mode;
  if (!mode || !RUN_MODES.includes(mode)) {
    fail("bad_args", `--mode must be one of ${RUN_MODES.join("|")}; got ${JSON.stringify(mode)}`);
  }
  if (options.background && options.foreground) {
    fail("bad_args", "--background and --foreground are mutually exclusive");
  }
  const profile = resolveProfile(mode);
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
  const timeoutMs = parsePositiveTimeoutMs(options["timeout-ms"], DEFAULT_KIMI_REVIEW_TIMEOUT_MS, {
    envName: "KIMI_REVIEW_TIMEOUT_MS",
  });
  const maxStepsPerTurn = parsePositiveMaxStepsPerTurn(
    options["max-steps-per-turn"],
    profile.max_steps_per_turn ?? 8,
  );

  const jobId = newJobId();
  const invocation = Object.freeze({
    job_id: jobId,
    target: "kimi",
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
    review_prompt_provider: profile.name === "rescue" ? null : "Kimi",
    schema_spec: null,
    binary: options.binary ?? process.env.KIMI_BINARY ?? "kimi",
    run_kind: options.background ? "background" : "foreground",
    timeout_ms: timeoutMs,
    max_steps_per_turn: maxStepsPerTurn,
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeRuntimeOptionsSidecar(workspaceRoot, jobId, { timeout_ms: timeoutMs, max_steps_per_turn: maxStepsPerTurn });
  writeJobFile(workspaceRoot, jobId, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  const targetPrompt = targetPromptFor(profile, prompt, invocation);

  if (options.background) {
    validateBackgroundExecutionScopeOrExit(invocation, lifecycleEvents);
    try {
      writePromptSidecar(resolveJobsDir(workspaceRoot), jobId, targetPrompt);
    } catch (error) {
      failBackgroundPromptSidecarWrite(workspaceRoot, invocation, error);
    }
    const { child, error } = await spawnDetachedWorker(cwd, jobId);
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
  const { job_id: jobId, cwd, workspace_root: workspaceRoot, dispose_effective: disposeEffective } = invocation;
  const profile = resolveProfile(invocation.mode_profile_name);
  let containment = null;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
    }, containment);
  } catch (e) {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, kimiSessionId: null,
      errorMessage: e.message,
    }, []);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (foreground) printLifecycleJson(errorRecord, lifecycleEvents);
    process.exit(2);
  }

  const checkMutations = profile.permission_mode === "plan";
  let gitStatusBefore = null;
  let neutralCwd = null;
  const mutations = [];
  if (checkMutations) {
    try {
      neutralCwd = mkdtempSync(joinPath(tmpdir(), "kimi-neutral-cwd-"));
    } catch (e) {
      mutations.push(mutationDetectionFailure(e, "neutral cwd setup failed"));
    }
    try {
      gitStatusBefore = gitStatus(["status", "-s", "--untracked-files=all"], cwd);
      writeSidecar(workspaceRoot, jobId, "git-status-before.txt", gitStatusBefore);
    } catch (e) {
      mutations.push(mutationDetectionFailure(e));
    }
  }

  const resumeId = invocation.resume_chain && invocation.resume_chain.length > 0
    ? invocation.resume_chain[invocation.resume_chain.length - 1]
    : null;

  // Pre-spawn cancel-marker check (Class 1 + Finding A, race window α).
  // cmdRunWorker has its own check at the top of the worker body, but a
  // cancel issued during containment setup / scope copy lands AFTER that
  // check while state.json still says "queued". Rechecking immediately
  // before spawnKimi narrows the window from "containment + scope +
  // pre-snapshot + spawn" (potentially seconds with a large repo) to the
  // microseconds between this check and child.once('spawn'). The post-run
  // consumer at the close handler is the safety net for that residual gap.
  // This check also covers the foreground path (cmdRun bypasses
  // cmdRunWorker entirely).
  if (consumeCancelMarker(workspaceRoot, jobId)) {
    if (neutralCwd) {
      try { rmSync(neutralCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (disposeEffective) {
      try { containment.cleanup(); } catch { /* best-effort */ }
    }
    const cancelledRecord = buildJobRecord(invocation, {
      status: "cancelled",
      exitCode: null, parsed: null, pidInfo: null, kimiSessionId: null,
    }, mutations);
    writeJobFile(workspaceRoot, jobId, cancelledRecord);
    upsertJob(workspaceRoot, cancelledRecord);
    if (foreground) printLifecycleJson(cancelledRecord, lifecycleEvents);
    process.exit(0);
  }

  if (foreground && lifecycleEvents) {
    printLifecycleJson(
      externalReviewLaunchedEvent(invocation, externalReviewForInvocation(invocation)),
      lifecycleEvents,
    );
  }

  let execution;
  let executedInvocation = invocation;
  try {
    const modelCandidates = modelCandidatesForInvocation(profile, invocation);
    for (let i = 0; i < modelCandidates.length; i++) {
      const attemptModel = modelCandidates[i];
      const attemptInvocation = Object.freeze({ ...invocation, model: attemptModel });
      execution = await spawnKimi(profile, {
        model: attemptModel,
        promptText: prompt,
        includeDirPath: containment.path,
        cwd: neutralCwd ?? containment.path,
        binary: invocation.binary,
        resumeId,
        timeoutMs: invocation.timeout_ms,
        maxStepsPerTurn: invocation.max_steps_per_turn,
        onSpawn: (pidInfo) => {
          const runningRecord = buildJobRecord(attemptInvocation, {
            status: "running",
            exitCode: null,
            parsed: null,
            pidInfo,
            kimiSessionId: null,
          }, mutations);
          writeJobFile(workspaceRoot, jobId, runningRecord);
          upsertJob(workspaceRoot, runningRecord);
        },
      });
      executedInvocation = attemptInvocation;
      if (
        execution.exitCode !== 0 &&
        i < modelCandidates.length - 1 &&
        retryableModelCapacityFailure(execution)
      ) {
        process.stderr.write(
          `kimi-companion: warning: model ${attemptModel ?? "<native>"} capacity-limited; ` +
          `retrying with ${modelCandidates[i + 1]}\n`,
        );
        continue;
      }
      break;
    }
  } catch (e) {
    const errorRecord = buildJobRecord(executedInvocation, {
      exitCode: null, parsed: null, pidInfo: null, kimiSessionId: null,
      errorMessage: e.message,
    }, mutations);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
    if (disposeEffective) containment.cleanup();
    if (foreground) printLifecycleJson(errorRecord, lifecycleEvents);
    process.exit(2);
  }

  // ——— finalization (#16 follow-up 1) ————————————————————————————————
  // See claude-companion.mjs for the three-tier persistence policy.
  // Briefly: meta + state are contractual (fatal on failure with a
  // best-effort failed-fallback record so onSpawn's running entry doesn't
  // persist forever), sidecars are diagnostic (stderr warning, never
  // changes the terminal status).

  if (checkMutations && gitStatusBefore !== null) {
    let gitStatusAfter;
    try {
      gitStatusAfter = gitStatus(["status", "-s", "--untracked-files=all"], cwd);
      try { writeSidecar(workspaceRoot, jobId, "git-status-after.txt", gitStatusAfter); }
      catch (e) { process.stderr.write(`kimi-companion: warning: sidecar git-status-after.txt write failed: ${e.message}\n`); }
    } catch (e) {
      mutations.push(mutationDetectionFailure(e));
      gitStatusAfter = null;
    }
    if (gitStatusAfter && gitStatusAfter !== gitStatusBefore) {
      const beforeLines = new Set(gitStatusLines(gitStatusBefore));
      mutations.push(...gitStatusLines(gitStatusAfter).filter((line) => !beforeLines.has(line)));
    }
  }

  // Issue #22 sub-task 2: cancel-marker check. cmdCancel writes the
  // marker BEFORE signaling so finalization can force status=cancelled
  // even when the target traps SIGTERM and exits 0 with valid output.
  const cancelMarker = consumeCancelMarker(workspaceRoot, jobId);
  execution.reviewAuditManifest = reviewAuditManifest(executedInvocation, prompt, containment.path, execution);

  // signal + timedOut feed classifyExecution: a SIGTERM/SIGKILL exit without
  // timedOut is an operator cancel → status="cancelled" (#16 follow-up 2);
  // timedOut wins so wall-clock kills classify as timeout failures.
  const finalRecord = buildJobRecord(executedInvocation, {
    exitCode: execution.exitCode,
    parsed: execution.parsed,
    pidInfo: execution.pidInfo,
    kimiSessionId: execution.kimiSessionId,
    ...(cancelMarker ? { status: "cancelled" } : {}),
    signal: execution.signal ?? null,
    timedOut: execution.timedOut === true,
    reviewAuditManifest: execution.reviewAuditManifest,
  }, mutations);

  // BLOCKER 2 fix: atomic-under-lock meta + state commit. See
  // claude-companion.mjs::executeRun for the race-class rationale.
  const { metaError, stateError } = commitJobRecord(workspaceRoot, jobId, finalRecord);

  for (const [name, contents] of [
    ["stdout.log", execution.stdout],
    ["stderr.log", execution.stderr],
  ]) {
    try { writeSidecar(workspaceRoot, jobId, name, contents); }
    catch (e) {
      process.stderr.write(`kimi-companion: warning: sidecar ${name} write failed: ${e.message}\n`);
    }
  }

  if (metaError || stateError) {
    // BLOCKER 1 fix: only overwrite the side that actually failed —
    // an unconditional fallback writeJobFile would clobber a successful
    // meta when only state.json failed (lock timeout).
    const detail = [
      metaError && `meta=${metaError.message}`,
      stateError && `state=${stateError.message}`,
    ].filter(Boolean).join("; ");
    let fallbackRecord = null;
    try {
      fallbackRecord = buildJobRecord(invocation, {
        exitCode: execution.exitCode,
        parsed: execution.parsed,
        pidInfo: execution.pidInfo,
        kimiSessionId: execution.kimiSessionId ?? null,
        errorMessage: `finalization_failed: ${detail}`,
      }, mutations);
    } catch { /* defense in depth */ }
    if (fallbackRecord) {
      if (metaError) {
        // commitJobRecord aborted in writeJobFile → state was NOT mutated
        // either. Overwrite both sides with the fallback failed-record.
        try { writeJobFile(workspaceRoot, jobId, fallbackRecord); } catch { /* exhausted */ }
        try { upsertJob(workspaceRoot, fallbackRecord); } catch { /* exhausted */ }
      } else if (stateError) {
        // meta is the good terminal record. Don't touch it (BLOCKER 1).
        // Retry the state upsert with the GOOD record; fall back to the
        // failed-record only if that retry also fails.
        try { upsertJob(workspaceRoot, finalRecord); }
        catch {
          try { upsertJob(workspaceRoot, fallbackRecord); } catch { /* exhausted */ }
        }
      }
    }
    if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
    if (containment.disposed && disposeEffective) {
      try { containment.cleanup(); } catch { /* best-effort */ }
    }
    fail("finalization_failed", detail, {
      error_code: (metaError ?? stateError)?.code ?? null,
    });
  }

  if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
  if (containment.disposed && disposeEffective) containment.cleanup();
  if (foreground) printLifecycleJson(finalRecord, lifecycleEvents);
  process.exit(finalRecord.status === "completed" || finalRecord.status === "cancelled" ? 0 : 2);
}

function validateBackgroundExecutionScopeOrExit(invocation, lifecycleEvents) {
  const { job_id: jobId, cwd, workspace_root: workspaceRoot, dispose_effective: disposeEffective } = invocation;
  const profile = resolveProfile(invocation.mode_profile_name);
  let containment = null;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
    }, containment);
  } catch (e) {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, kimiSessionId: null,
      errorMessage: e.message,
    }, []);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    printLifecycleJson(errorRecord, lifecycleEvents);
    process.exit(2);
  }
  if (disposeEffective) {
    try { containment.cleanup(); } catch { /* best-effort */ }
  }
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
    valueOptions: ["cwd", "job"],
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

  const runtimeOptions = readRuntimeOptionsSidecar(workspaceRoot, options.job);

  // Honor a cancel that arrived while we were queued. The worker MUST check
  // this before spawning the target — otherwise the run completes (model
  // call, side effects) and only the post-run consumer at executeRun would
  // convert "completed" → "cancelled".
  if (consumeCancelMarker(workspaceRoot, options.job)) {
    try { consumePromptSidecar(resolveJobsDir(workspaceRoot), options.job); } catch { /* best-effort privacy cleanup */ }
    const cancelledRecord = buildJobRecord(invocationFromRecord(meta, runtimeOptions), {
      status: "cancelled",
      exitCode: null, parsed: null, pidInfo: null, kimiSessionId: null,
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
    const errorRecord = buildJobRecord(invocationFromRecord(meta, runtimeOptions), {
      exitCode: null, parsed: null, pidInfo: null, kimiSessionId: null,
      errorMessage,
    }, []);
    writeJobFile(workspaceRoot, options.job, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("bad_state", errorMessage);
  }
  if (prompt == null) {
    const errorRecord = buildJobRecord(invocationFromRecord(meta, runtimeOptions), {
      exitCode: null, parsed: null, pidInfo: null, kimiSessionId: null,
      errorMessage: "worker: prompt sidecar missing; job cannot resume",
    }, []);
    writeJobFile(workspaceRoot, options.job, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("bad_state", "prompt sidecar missing for job " + options.job);
  }

  const invocation = invocationFromRecord(meta, runtimeOptions);
  await executeRun(invocation, prompt, { foreground: false });
}

async function cmdContinue(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["job", "cwd", "model", "binary", "timeout-ms", "max-steps-per-turn", "lifecycle-events"],
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

  const priorKimiSessionId = prior.kimi_session_id ?? null;
  if (!priorKimiSessionId) {
    // PR #21 review HIGH 4: surface an actionable next step when the prior
    // record is a stale orphan that never produced a session ID.
    const isStaleOrphan = prior.status === "stale";
    const reason = isStaleOrphan
      ? "the worker exited before Kimi returned a session ID, so there is no chat to resume."
      : "this record carries no session ID and cannot be chained.";
    const suggestion = isStaleOrphan
      ? ` Re-run from scratch: kimi-companion run --mode ${prior.mode_profile_name ?? prior.mode} --cwd ${JSON.stringify(prior.cwd)} -- "<your prompt>"`
      : "";
    fail("no_session_to_resume",
      `prior job ${options.job} has no kimi_session_id to resume — ${reason}${suggestion}`);
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
    DEFAULT_KIMI_REVIEW_TIMEOUT_MS;
  const timeoutMs = parsePositiveTimeoutMs(options["timeout-ms"], priorTimeoutMs, { envName: "KIMI_REVIEW_TIMEOUT_MS" });
  const maxStepsPerTurn = parsePositiveMaxStepsPerTurn(
    options["max-steps-per-turn"],
    priorRuntimeOptions.max_steps_per_turn ?? priorProfile.max_steps_per_turn ?? 8,
  );
  const invocation = Object.freeze({
    job_id: newJobId_,
    target: "kimi",
    parent_job_id: options.job,
    resume_chain: [...priorResumeChain, priorKimiSessionId],
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
    review_prompt_provider: priorProfile.name === "rescue" ? null : "Kimi",
    schema_spec: prior.schema_spec ?? null,
    binary: options.binary ?? process.env.KIMI_BINARY ?? "kimi",
    run_kind: options.background ? "background" : "foreground",
    timeout_ms: timeoutMs,
    max_steps_per_turn: maxStepsPerTurn,
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeRuntimeOptionsSidecar(workspaceRoot, newJobId_, { timeout_ms: timeoutMs, max_steps_per_turn: maxStepsPerTurn });
  writeJobFile(workspaceRoot, newJobId_, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  const targetPrompt = targetPromptFor(priorProfile, prompt, invocation);

  if (options.background) {
    validateBackgroundExecutionScopeOrExit(invocation, lifecycleEvents);
    try {
      writePromptSidecar(resolveJobsDir(workspaceRoot), newJobId_, targetPrompt);
    } catch (error) {
      failBackgroundPromptSidecarWrite(workspaceRoot, invocation, error);
    }
    const { child, error } = await spawnDetachedWorker(cwd, newJobId_);
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
  // (KIMI_MOCK_META_CONFLICT, or a half-finalized job) produces a
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
const PING_PROVIDER_API_KEY_ENV = ["KIMI_CODE_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"];

function ignoredApiKeyAuthFields() {
  return credentialNameDiagnostics(PING_PROVIDER_API_KEY_ENV);
}

function pingOkFields(modelFallback = null) {
  return {
    ready: true,
    summary: modelFallback
      ? "Kimi Code CLI is ready; the preferred model was capacity-limited and a configured fallback was used."
      : "Kimi Code CLI is ready using first-party CLI auth.",
    next_action: "Run a Kimi review command.",
    ...(modelFallback ? { model_fallback: modelFallback } : {}),
  };
}

function pingNotAuthedFields() {
  return {
    ready: false,
    summary: "Kimi subscription/OAuth auth is not available to this companion process.",
    next_action: "In a normal terminal, run: kimi login. API-key env vars are ignored by subscription-mode policy.",
  };
}

function pingRateLimitedFields() {
  return {
    ready: false,
    summary: "Kimi auth works, but every configured model candidate is currently rate-limited or capacity-limited.",
    next_action: "Retry later, or update plugins/kimi/config/models.json with an available full model ID.",
  };
}

function pingTimeoutFields(timeoutMs) {
  return {
    ready: false,
    summary: "Kimi Code CLI ping timed out before readiness could be confirmed.",
    next_action: "Retry setup after a short wait. If it repeats, check Kimi service status or run `kimi` interactively.",
    timeout_ms: timeoutMs,
  };
}

function pingNotFoundFields() {
  return {
    ready: false,
    summary: "Kimi Code CLI binary was not found on PATH.",
    next_action: "Install Kimi Code CLI from https://moonshotai.github.io/kimi-cli/, or rerun setup with --binary pointing at your kimi executable.",
  };
}

function pingErrorFields() {
  return {
    ready: false,
    summary: "Kimi Code CLI ping failed before readiness could be confirmed.",
    next_action: "Inspect detail, fix the Kimi Code CLI error, then rerun setup.",
  };
}

function pingSandboxBlockedFields() {
  return {
    ready: false,
    summary: "Kimi Code CLI is blocked by Codex sandbox access to Kimi state.",
    next_action: "First add ~/.kimi/logs to [sandbox_workspace_write].writable_roots in ~/.codex/config.toml, keep KIMI_SHARE_DIR unset so Kimi uses its normal auth/config, then start a fresh Codex session and rerun setup. If the next denial is an OAuth/session file under ~/.kimi, fall back to ~/.kimi as the writable root. Alternatively, run this check outside sandbox.",
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
  const detail = [
    execution?.stderr,
    parsedError,
    execution?.parsed?.result,
    execution?.stdout,
    rawText,
    execution?.timedOut ? "target CLI exceeded the configured timeoutMs" : "",
    execution?.signal ? `signal ${execution.signal}` : "",
    execution?.exitCode == null ? "" : `exit ${execution.exitCode}`,
  ].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
  return detail;
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

function isKimiCodexSandboxBlocked(detail) {
  if (!isCodexSandbox(process.env)) return false;
  const permissionRe = /Operation not permitted|Permission denied|PermissionError|EACCES|EPERM/i;
  const kimiPathRe = /(?:^|[/\\])\.kimi(?:[/\\]|['"\s:)]|$)/;
  const lines = String(detail ?? "").split("\n");
  return lines.some((line, i) => {
    if (permissionRe.test(line) && kimiPathRe.test(line)) return true;
    const nextLine = lines[i + 1] ?? "";
    return permissionRe.test(line) && /^\s/.test(nextLine) && kimiPathRe.test(nextLine);
  });
}

async function cmdPing(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["model", "binary", "timeout-ms"], booleanOptions: [] });
  const profile = resolveProfile("ping");
  const modelsConfig = loadModels();
  const model = options.model ?? resolveModelForProfile(profile, modelsConfig);
  const modelCandidates = options.model
    ? [options.model]
    : resolveModelCandidatesForProfile(profile, modelsConfig);
  const candidates = modelCandidates.length > 0 ? modelCandidates : [model];
  const timeoutMs = parsePositiveTimeoutMs(options["timeout-ms"], 30000);
  try {
    let execution = null;
    let selectedModel = model;
    let modelFallback = null;
    const modelFallbackHops = [];
    for (let i = 0; i < candidates.length; i++) {
      selectedModel = candidates[i];
      execution = await spawnKimi(profile, {
        model: selectedModel,
        promptText: PING_PROMPT,
        cwd: "/tmp",
        binary: options.binary ?? process.env.KIMI_BINARY ?? "kimi",
        timeoutMs,
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
          `kimi-companion: warning: ping model ${selectedModel ?? "<native>"} capacity-limited; ` +
          `retrying with ${candidates[i + 1]}\n`,
        );
        continue;
      }
      break;
    }
    if (execution.parsed?.ok) {
      const payload = { status: "ok", ...pingOkFields(modelFallback), ...ignoredApiKeyAuthFields(), model: selectedModel ?? null,
        session_id: execution.kimiSessionId, usage: execution.parsed?.usage };
      printJson(payload);
      process.exit(0);
    }
    const failureText = pingFailureText(execution);
    const detail = pingFailureDetail(execution);
    if (execution?.timedOut === true) {
      printJson({ status: "transient_timeout", ...pingTimeoutFields(timeoutMs), ...ignoredApiKeyAuthFields(), detail });
      process.exit(2);
    }
    if (isKimiCodexSandboxBlocked(failureText)) {
      printJson({ status: "sandbox_blocked", ...pingSandboxBlockedFields(), ...ignoredApiKeyAuthFields(), exit_code: execution.exitCode, detail });
      process.exit(2);
    }
    if (/rate limit|429|overloaded/i.test(detail)) {
      printJson({ status: "rate_limited", ...pingRateLimitedFields(), ...ignoredApiKeyAuthFields(), detail });
      process.exit(2);
    }
    if (PING_AUTH_RE.test(detail)) {
      printJson({ status: "not_authed", ...pingNotAuthedFields(), detail,
        ...ignoredApiKeyAuthFields(),
        hint: "Run `kimi` interactively to complete OAuth. API-key env vars are ignored by plugin policy." });
      process.exit(2);
    }
    printJson({ status: "error", ...pingErrorFields(), ...ignoredApiKeyAuthFields(), exit_code: execution.exitCode, detail });
    process.exit(2);
  } catch (e) {
    if (e.code === "ENOENT") {
      printJson({ status: "not_found", ...pingNotFoundFields(),
        ...ignoredApiKeyAuthFields(),
        detail: "kimi binary not found on PATH (or KIMI_BINARY override)",
        install_url: "https://moonshotai.github.io/kimi-cli/" });
      process.exit(2);
    }
    const detail = e.message;
    if (isKimiCodexSandboxBlocked(detail)) {
      printJson({ status: "sandbox_blocked", ...pingSandboxBlockedFields(), ...ignoredApiKeyAuthFields(), detail });
      process.exit(2);
    }
    printJson({ status: "error", ...pingErrorFields(), ...ignoredApiKeyAuthFields(), detail });
    process.exit(2);
  }
}

// ——— subcommand: cancel (signal a running job) ———
//
// Mirror of claude-companion.mjs's cmdCancel. Issue #22 sub-task 1: prior
// to this commit the dispatch routed `cancel` to fail("not_implemented"),
// so users had no way to cancel a Kimi background job through the
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
    });
    process.exit(2);
  }
  if (pidInfo.capture_error || !pidInfo.starttime || !pidInfo.argv0) {
    printJson({
      ok: false,
      status: "no_pid_info",
      detail: "job has pid but no complete ownership proof; refusing to signal",
      job_id: options.job,
      pid: pidInfo.pid,
      capture_error: pidInfo.capture_error ?? null,
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
        `kimi-companion: unverifiable — could not verify pid ${pidInfo.pid} ` +
        `ownership (ps/proc unavailable). Refusing to signal.\n`
      );
      printJson({
        ok: false,
        status: "unverifiable",
        detail: "could not verify pid ownership; refusing to signal",
        job_id: options.job,
        pid: pidInfo.pid,
      });
      process.exit(2);
    }
    process.stderr.write(
      `kimi-companion: stale_pid (${check.reason}) — refusing to signal pid ${pidInfo.pid}\n`
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
    process.stderr.write(`kimi-companion: warning: cancel marker write failed: ${e.message}\n`);
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
    case "doctor": return cmdPing(rest);
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write("kimi-companion: see docs/superpowers/specs/ §7 for subcommand surface.\n");
      process.exit(0);
    default:
      fail("bad_args", `unknown subcommand ${JSON.stringify(sub)}`);
  }
}

main().catch((e) => {
  process.stderr.write(`kimi-companion: unhandled: ${e.stack ?? e.message ?? e}\n`);
  process.exit(1);
});
