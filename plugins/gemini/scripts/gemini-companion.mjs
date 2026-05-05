#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync,
  writeFileSync, chmodSync, readdirSync, statSync,
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
import { spawnGemini } from "./lib/gemini.mjs";
import { writeCancelMarker, consumeCancelMarker } from "./lib/cancel-marker.mjs";
import {
  authDiagnosticFields,
  apiKeyMissingFields as buildApiKeyMissingFields,
  apiKeyMissingMessage as buildApiKeyMissingMessage,
  resolveAuthSelection as resolveAuthSelectionForProvider,
} from "./lib/auth-selection.mjs";
import {
  PING_PROMPT,
  consumePromptSidecar,
  externalReviewBackgroundLaunchedEvent,
  externalReviewLaunchedEvent,
  gitStatusLines,
  parseLifecycleEventsMode,
  parseScopePathsOption,
  preflightDisclosure,
  preflightSafetyFields,
  printJson,
  printJsonLine,
  printLifecycleJson,
  runKindFromRecord,
  summarizeScopeDirectory,
  writePromptSidecar,
} from "./lib/companion-common.mjs";
import { REVIEW_PROMPT_CONTRACT_VERSION, buildReviewPrompt } from "./lib/review-prompt.mjs";

const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_CONFIG_PATH = resolvePath(PLUGIN_ROOT, "config/models.json");
const READ_ONLY_POLICY = resolvePath(PLUGIN_ROOT, "policies/read-only.toml");
const CONTINUABLE_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);
const RUN_MODES = Object.freeze(["review", "adversarial-review", "custom-review", "rescue"]);
const PREFLIGHT_MODES = Object.freeze(["review", "adversarial-review", "custom-review"]);
const GIT_PROMPT_BINARY = "/usr/bin/git";
const GIT_PROMPT_SAFE_PATH = "/usr/bin:/bin";

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

function targetPromptFor(invocation, userPrompt) {
  if (invocation.mode_profile_name === "rescue") return userPrompt;
  return buildReviewPrompt({
    provider: "Gemini",
    mode: invocation.mode_profile_name,
    repository: invocation.workspace_root ?? null,
    baseRef: invocation.scope_base,
    baseCommit: gitCommitForPrompt(invocation.cwd, invocation.scope_base),
    headRef: "HEAD",
    headCommit: gitCommitForPrompt(invocation.cwd, "HEAD"),
    scope: invocation.scope,
    scopePaths: invocation.scope_paths,
    userPrompt,
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

function cleanGitPromptEnv() {
  const env = cleanGitEnv();
  env.PATH = GIT_PROMPT_SAFE_PATH;
  return env;
}

// Mutation-detection git scrub: same shared list as claude-companion +
// scope.mjs. PR #21 review: previous local 5-key list missed
// GIT_CONFIG_GLOBAL — fold onto plugin lib's canonical scrub.

function gitStatus(args, cwd) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanGitEnv(),
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

function invocationFromRecord(record, fallbackAuthMode = "subscription") {
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
      error: "scope_failed",
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
    valueOptions: ["mode", "model", "cwd", "binary", "scope-base", "scope-paths", "override-dispose", "auth-mode", "lifecycle-events"],
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
    review_prompt_provider: profile.name === "rescue" ? null : "Gemini",
    schema_spec: null,
    binary: options.binary ?? process.env.GEMINI_BINARY ?? "gemini",
    run_kind: options.background ? "background" : "foreground",
    auth_mode: authSelection.auth_mode,
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeJobFile(workspaceRoot, jobId, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  const targetPrompt = targetPromptFor(invocation, prompt);

  if (options.background) {
    try {
      writePromptSidecar(resolveJobsDir(workspaceRoot), jobId, targetPrompt);
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
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
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
      neutralCwd = mkdtempSync(joinPath(tmpdir(), "gemini-neutral-cwd-"));
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
  // before spawnGemini narrows the window from "containment + scope +
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
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
    }, mutations);
    writeJobFile(workspaceRoot, jobId, cancelledRecord);
    upsertJob(workspaceRoot, cancelledRecord);
    if (foreground) printLifecycleJson(cancelledRecord, lifecycleEvents);
    process.exit(0);
  }

  if (foreground && lifecycleEvents === "jsonl") {
    printJsonLine(externalReviewLaunchedEvent(invocation, externalReviewForInvocation(invocation)));
  }

  let execution;
  let executedInvocation = invocation;
  try {
    const authSelection = resolveAuthSelection(invocation.auth_mode);
    const modelCandidates = modelCandidatesForInvocation(profile, invocation);
    for (let i = 0; i < modelCandidates.length; i++) {
      const attemptModel = modelCandidates[i];
      const attemptInvocation = Object.freeze({ ...invocation, model: attemptModel });
      execution = await spawnGemini(profile, {
        model: attemptModel,
        promptText: prompt,
        policyPath: profile.permission_mode === "plan" ? READ_ONLY_POLICY : null,
        includeDirPath: containment.path,
        cwd: neutralCwd ?? containment.path,
        binary: invocation.binary,
        resumeId,
        allowedApiKeyEnv: authSelection.allowed_env_credentials,
        onSpawn: (pidInfo) => {
          const runningRecord = buildJobRecord(attemptInvocation, {
            status: "running",
            exitCode: null,
            parsed: null,
            pidInfo,
            geminiSessionId: null,
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
          `gemini-companion: warning: model ${attemptModel ?? "<native>"} capacity-limited; ` +
          `retrying with ${modelCandidates[i + 1]}\n`,
        );
        continue;
      }
      break;
    }
  } catch (e) {
    const errorRecord = buildJobRecord(executedInvocation, {
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
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
      catch (e) { process.stderr.write(`gemini-companion: warning: sidecar git-status-after.txt write failed: ${e.message}\n`); }
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

  // signal + timedOut feed classifyExecution: a SIGTERM/SIGKILL exit without
  // timedOut is an operator cancel → status="cancelled" (#16 follow-up 2);
  // timedOut wins so wall-clock kills classify as timeout failures.
  const finalRecord = buildJobRecord(executedInvocation, {
    exitCode: execution.exitCode,
    parsed: execution.parsed,
    pidInfo: execution.pidInfo,
    geminiSessionId: execution.geminiSessionId,
    ...(cancelMarker ? { status: "cancelled" } : {}),
    signal: execution.signal ?? null,
    timedOut: execution.timedOut === true,
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
      process.stderr.write(`gemini-companion: warning: sidecar ${name} write failed: ${e.message}\n`);
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
        geminiSessionId: execution.geminiSessionId ?? null,
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
  process.exit(finalRecord.status === "completed" ? 0 : 2);
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

  const invocation = invocationFromRecord(meta, options["auth-mode"]);
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
    valueOptions: ["job", "cwd", "model", "binary", "auth-mode", "lifecycle-events"],
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
    review_prompt_provider: priorProfile.name === "rescue" ? null : "Gemini",
    schema_spec: prior.schema_spec ?? null,
    binary: options.binary ?? process.env.GEMINI_BINARY ?? "gemini",
    run_kind: options.background ? "background" : "foreground",
    auth_mode: authSelection.auth_mode,
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeJobFile(workspaceRoot, newJobId_, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  const targetPrompt = targetPromptFor(invocation, prompt);

  if (options.background) {
    try {
      writePromptSidecar(resolveJobsDir(workspaceRoot), newJobId_, targetPrompt);
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

function pingOkFields(modelFallback = null) {
  return {
    ready: true,
    summary: modelFallback
      ? "Gemini CLI is ready; the preferred model was capacity-limited and a configured fallback was used."
      : "Gemini CLI is ready using first-party CLI auth.",
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

function pingFailureDetail(execution) {
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
    execution?.exitCode == null ? "" : `exit ${execution.exitCode}`,
  ].map((s) => String(s ?? "").trim()).find(Boolean) ?? "";
  const firstLine = detail.split("\n").map((line) => line.trim()).find(Boolean);
  const hasStackFrame = detail
    .split("\n")
    .some((line) => line.trimStart().startsWith("at "));
  const concise = hasStackFrame && firstLine ? firstLine : detail;
  return concise.slice(0, 500);
}

async function cmdPing(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["model", "binary", "timeout-ms", "auth-mode"], booleanOptions: [] });
  const profile = resolveProfile("ping");
  const modelsConfig = loadModels();
  const model = options.model ?? resolveModelForProfile(profile, modelsConfig);
  const modelCandidates = options.model
    ? [options.model]
    : resolveModelCandidatesForProfile(profile, modelsConfig);
  const candidates = modelCandidates.length > 0 ? modelCandidates : [model];
  const authSelection = resolveAuthSelection(options["auth-mode"]);
  if (authSelection.selected_auth_path === "api_key_env_missing") {
    printJson({ status: "not_authed", ...apiKeyMissingFields(authSelection, pingNotAuthedFields()) });
    process.exit(2);
  }
  try {
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
        cwd: "/tmp",
        binary: options.binary ?? process.env.GEMINI_BINARY ?? "gemini",
        timeoutMs: Number(options["timeout-ms"] ?? 15000),
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
    if (execution.parsed.ok) {
      const payload = { status: "ok", ...pingOkFields(modelFallback), ...authDiagnosticFields(authSelection), model: selectedModel ?? null,
        session_id: execution.geminiSessionId, usage: execution.parsed.usage };
      printJson(payload);
      process.exit(0);
    }
    const detail = pingFailureDetail(execution);
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
        `gemini-companion: unverifiable — could not verify pid ${pidInfo.pid} ` +
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
    case "doctor": return cmdPing(rest);
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
  process.stderr.write(`gemini-companion: unhandled: ${e.stack ?? e.message ?? e}\n`);
  process.exit(1);
});
