#!/usr/bin/env node
// Claude-companion entry. Invokes the Claude CLI on behalf of Codex plugin
// commands and manages the per-workspace job store. Target-specific wiring
// lives here; shared machinery lives in ./lib/.
//
// Subcommands (see spec §7.1):
//   run      --mode=review|adversarial-review|custom-review|rescue [--background|--foreground]
//            [--model ID] [--cwd PATH] [--scope-base REF]
//            [--scope-paths G1,G2,…] [--override-dispose|--no-override-dispose]
//            -- PROMPT
//   preflight --mode=review|adversarial-review|custom-review [--cwd PATH]
//            [--scope-base REF] [--scope-paths G1,G2,…]
//   status   [--job ID]
//   result   --job ID
//   cancel   --job ID [--force]
//   ping
//   doctor
//
// Containment (where Claude writes) and scope (what Claude sees) are NOT
// user-facing flags — they are per-profile decisions carried by
// lib/mode-profiles.mjs (spec §21.4). `--isolated` / `--dispose` /
// `--no-dispose` are retired. The only escape hatch is
// `--override-dispose <bool>`, intentionally undocumented in command-file
// snippets.
//
// Subcommands below keep foreground/background lifecycle behavior explicit.

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, renameSync, unlinkSync, readdirSync, rmSync, statSync, readFileSync as _readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";

import { parseArgs } from "./lib/args.mjs";
import { configureState, getStateConfig, resolveJobsDir, resolveJobFile, writeJobFile, upsertJob, listJobs, commitJobRecord } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { spawnClaude } from "./lib/claude.mjs";
import { writeCancelMarker, consumeCancelMarker } from "./lib/cancel-marker.mjs";
import { resolveProfile, resolveModelForProfile } from "./lib/mode-profiles.mjs";
import { setupContainment } from "./lib/containment.mjs";
import { populateScope } from "./lib/scope.mjs";
import { newJobId, verifyPidInfo } from "./lib/identity.mjs";
import { buildJobRecord, externalReviewForInvocation } from "./lib/job-record.mjs";
import { reconcileActiveJobs } from "./lib/reconcile.mjs";
import { cleanGitEnv } from "./lib/git-env.mjs";
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
  printLifecycleJson,
  runKindFromRecord,
  summarizeScopeDirectory,
  writePromptSidecar,
} from "./lib/companion-common.mjs";
import { REVIEW_PROMPT_CONTRACT_VERSION, buildReviewPrompt } from "./lib/review-prompt.mjs";

// ——— plugin-root self-resolution (upstream pattern, spec §4.14) ———
const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// Claude-specific parametrization applied once at startup (spec §6.2).
configureState({
  pluginDataEnv: "CLAUDE_PLUGIN_DATA",
  sessionIdEnv: "CLAUDE_COMPANION_SESSION_ID",
});

const MODELS_CONFIG_PATH = resolvePath(PLUGIN_ROOT, "config/models.json");
const CONTINUABLE_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);
const RUN_MODES = Object.freeze(["review", "adversarial-review", "custom-review", "rescue"]);
const PREFLIGHT_MODES = Object.freeze(["review", "adversarial-review", "custom-review"]);
const GIT_PROMPT_BINARY = "/usr/bin/git";
const GIT_PROMPT_SAFE_PATH = "/usr/bin:/bin";

function loadModels() {
  if (!existsSync(MODELS_CONFIG_PATH)) return { review_quality: null, rescue: null };
  return JSON.parse(_readFileSync(MODELS_CONFIG_PATH, "utf8"));
}

function fail(code, message, details = {}) {
  process.stderr.write(`claude-companion: ${message}\n`);
  printJson({ ok: false, error: code, message, ...details });
  process.exit(1);
}

function targetPromptFor(invocation, userPrompt) {
  if (invocation.mode_profile_name === "rescue") return userPrompt;
  return buildReviewPrompt({
    provider: "Claude",
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

// Wraps git command; reports failure separately from successful empty output
// so mutation detection can warn instead of silently reporting "clean".
// Uses execFileSync with an argv array (no shell) to prevent command injection
// through the cwd argument (audit HIGH finding, M2 gate).
// Strip inherited git env vars (GIT_DIR, GIT_CONFIG_GLOBAL, ...) via the
// shared lib/git-env.mjs scrub so a parent env can't hijack mutation
// detection's git invocations. PR #21 review: the previous local
// 5-key strip list missed GIT_CONFIG_GLOBAL → fold onto the canonical list.

function tryGit(args, cwd) {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanGitEnv(),
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error };
  }
}

function mutationDetectionFailure(error) {
  const stderr = String(error?.stderr ?? "").trim().split("\n").find(Boolean);
  const message = stderr ?? String(error?.message || error).split("\n").find(Boolean) ?? "unknown error";
  return `mutation_detection_failed: ${message}`;
}

// setupWorktree was deleted in T7.2. Containment lives in
// lib/containment.mjs; scope population lives in lib/scope.mjs. Both are
// per-profile decisions (spec §21.4).

// ——— invocation helpers (T7.4, spec §21.3) ———
//
// `invocation` is the frozen subset of a JobRecord that exists at cmdRun/
// cmdContinue entry — before Claude runs. It carries identity + invocation +
// prompt_head fields, and nothing else. Feeding it to buildJobRecord
// (execution=null) produces the queued record we persist pre-run. Feeding
// it again post-run with the execution tuple produces the terminal record.

// Project an invocation out of a JobRecord (used by the background worker
// when it re-enters executeRun). Only the invocation-phase fields are
// carried — lifecycle/result fields get re-derived from the fresh execution.
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

// Prompt handoff for background jobs. The full prompt is NEVER part of the
// JobRecord (§21.3.1). The detached worker does need it to re-invoke claude,
// so we write it to a private sidecar file `<job>/prompt.txt` with mode 0600
// and DELETE it after the worker reads it. This is a handoff buffer, not a
// persistent store — it lives only for the window between launcher exit and
// worker start, typically milliseconds.
//
// Design choice — sidecar vs stdin: stdio piping would avoid the disk
// round-trip but requires keeping child.stdin open until the worker calls
// readFileSync(0). Node's `detached: true` + `stdio: "ignore"` pattern is
// the stable way to background-launch on macOS/Linux; mixing in an inherited
// stdin complicates orphan cleanup and makes the worker's --version/--help
// debug path harder to test. The 0600 sidecar is simpler, auditable (one
// well-known path), and the worker can be re-run for diagnosis by re-seeding
// the file. The "full prompt text doesn't reach disk" invariant is preserved
// by the unlink-after-read: at no point is the prompt persisted alongside
// the record.
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
    claudeSessionId: null,
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
    claudeSessionId: null,
    errorMessage: message,
  }, []);
  writeJobFile(workspaceRoot, invocation.job_id, errorRecord);
  upsertJob(workspaceRoot, errorRecord);
  fail("sidecar_failed", message, { error_code: error?.code ?? null });
}

// ——— subcommand: preflight ———
function cmdPreflight(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["mode", "cwd", "scope-base", "scope-paths", "binary"],
    booleanOptions: [],
    aliasMap: {},
  });

  const mode = options.mode;
  const cwd = options.cwd ?? process.cwd();
  if (!mode || !PREFLIGHT_MODES.includes(mode)) {
    fail("bad_args", `--mode must be one of ${PREFLIGHT_MODES.join("|")}; got ${JSON.stringify(mode)}`, {
      event: "preflight",
      target: "claude",
      mode: mode ?? null,
      cwd,
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure("Claude"),
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
      target: "claude",
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
      disclosure_note: preflightDisclosure("Claude"),
    });
  } catch (e) {
    exitCode = 2;
    printJson({
      ok: false,
      event: "preflight",
      target: "claude",
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
      disclosure_note: preflightDisclosure("Claude"),
    });
  } finally {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
  }
  process.exit(exitCode);
}

// ——— subcommand: run ———
async function cmdRun(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["mode", "model", "cwd", "schema", "binary", "scope-base", "scope-paths", "override-dispose", "auth-mode", "lifecycle-events"],
    booleanOptions: ["background", "foreground"],
    aliasMap: {},
  });

  const mode = options.mode;
  if (!mode || !RUN_MODES.includes(mode)) {
    fail("bad_args", `--mode must be one of ${RUN_MODES.join("|")}; got ${JSON.stringify(mode)}`);
  }
  if (options.background && options.foreground) {
    fail("bad_args", "--background and --foreground are mutually exclusive");
  }

  // Mode → profile, resolved EXACTLY ONCE at entry (spec §21.2). No downstream
  // code branches on `mode` to pick a flag — everything flows from `profile`.
  const profile = resolveProfile(mode);

  // Model resolution goes through the profile's tier — the historical
  // ternary that branched on mode but returned "default" on both sides
  // (silent Opus billing, Claude-review finding C2) is gone. `--model`
  // override still wins.
  const model = options.model ?? resolveModelForProfile(profile, loadModels()) ?? null;
  if (!model) {
    fail("no_model", "no model resolved; pass --model or populate config/models.json");
  }

  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // Dispose default lives in the profile (§21.2 field `dispose_default`).
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
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail("bad_args", "prompt is required (pass after -- separator)");
  }
  const authSelection = resolveAuthSelection(options["auth-mode"]);
  if (authSelection.selected_auth_path === "api_key_env_missing") {
    fail("not_authed", apiKeyMissingMessage(), apiKeyMissingFields(authSelection));
  }

  const jobId = newJobId();
  const startedAt = new Date().toISOString();

  // The single invocation object — frozen, passed unchanged through the
  // pre-run and post-run buildJobRecord calls. No downstream code mutates
  // invocation; adding new invocation fields is a one-place change.
  const invocation = Object.freeze({
    job_id: jobId,
    target: "claude",
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
    prompt_head: prompt.slice(0, 200),          // §21.3.1 — no full prompt
    review_prompt_contract_version: profile.name === "rescue" ? null : REVIEW_PROMPT_CONTRACT_VERSION,
    review_prompt_provider: profile.name === "rescue" ? null : "Claude",
    schema_spec: options.schema ?? null,
    binary: options.binary ?? process.env.CLAUDE_BINARY ?? "claude",
    run_kind: options.background ? "background" : "foreground",
    auth_mode: authSelection.auth_mode,
    started_at: startedAt,
  });

  // Pre-run record: status=queued. Goes to disk + state before any child
  // process is launched, so a concurrent `status` can see the new job.
  const queuedRecord = buildJobRecord(invocation, null, []);
  writeJobFile(workspaceRoot, jobId, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  const targetPrompt = targetPromptFor(invocation, prompt);

  if (options.background) {
    // Write prompt to private sidecar (§21.3.1 handoff buffer). Worker reads
    // and deletes — prompt text does NOT live on the JobRecord.
    try {
      writePromptSidecar(resolveJobsDir(workspaceRoot), jobId, targetPrompt);
    } catch (error) {
      failBackgroundPromptSidecarWrite(workspaceRoot, invocation, error);
    }

    // Detach a worker process that will execute the run and overwrite the
    // terminal-state meta when done (spec §7.3 / M4).
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

// Shared execution body. Foreground path calls this directly with the live
// prompt; background worker calls it after reading the prompt sidecar.
// EXACTLY ONE buildJobRecord call per terminal state — §21.3.2 convergence.
async function executeRun(invocation, prompt, { foreground, lifecycleEvents = null }) {
  const {
    job_id: jobId, mode, model, cwd, workspace_root: workspaceRoot,
    dispose_effective: disposeEffective,
  } = invocation;
  const profile = resolveProfile(invocation.mode_profile_name);
  const executionScope = setupExecutionScopeOrExit(invocation, profile, { foreground, lifecycleEvents });
  const mutationContext = prepareMutationContext(invocation, profile);
  const resumeId = latestResumeId(invocation);

  exitIfCancelledBeforeSpawn(invocation, executionScope, mutationContext, { foreground, lifecycleEvents });

  if (foreground && lifecycleEvents) {
    printLifecycleJson(
      externalReviewLaunchedEvent(invocation, externalReviewForInvocation(invocation)),
      lifecycleEvents,
    );
  }

  const execution = await spawnClaudeOrExit(invocation, profile, prompt, executionScope, mutationContext, {
    foreground,
    lifecycleEvents,
    resumeId,
  });

  recordPostRunMutations(invocation, mutationContext);

  const cancelMarker = consumeCancelMarker(workspaceRoot, jobId);
  const finalRecord = buildClaudeFinalRecord(invocation, execution, cancelMarker, mutationContext.mutations);
  const { metaError, stateError } = commitJobRecord(workspaceRoot, jobId, finalRecord);

  writeExecutionSidecars(workspaceRoot, jobId, execution);
  exitIfFinalizationFailed(invocation, execution, finalRecord, mutationContext, executionScope, { metaError, stateError });

  cleanupExecutionResources(executionScope, mutationContext);

  if (foreground) printLifecycleJson(finalRecord, lifecycleEvents);
  process.exit(finalRecord.status === "completed" ? 0 : 2);
}

function setupExecutionScopeOrExit(invocation, profile, { foreground, lifecycleEvents }) {
  let containment = null;
  try {
    containment = setupContainment(profile, invocation.cwd);
    populateScope(profile, invocation.cwd, containment.path, {
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
    }, containment);
    return {
      containment,
      childCwd: containment.path,
      addDir: containment.path,
      disposeEffective: invocation.dispose_effective,
    };
  } catch (e) {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
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
    context.neutralCwd = mkdtempSync(joinPath(tmpdir(), "claude-neutral-cwd-"));
  } catch (e) {
    context.mutations.push(mutationDetectionFailure(e));
  }
  const before = tryGit(["status", "-s", "--untracked-files=all"], invocation.cwd);
  if (!before.ok) {
    context.mutations.push(mutationDetectionFailure(before.error));
    return context;
  }
  context.gitStatusBefore = before.stdout;
  try {
    writeSidecar(invocation.workspace_root, invocation.job_id, "git-status-before.txt", before.stdout);
  } catch (e) {
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
    claudeSessionId: null,
  }, mutationContext.mutations);
  writeJobFile(invocation.workspace_root, invocation.job_id, cancelledRecord);
  upsertJob(invocation.workspace_root, cancelledRecord);
  if (foreground) printLifecycleJson(cancelledRecord, lifecycleEvents);
  process.exit(0);
}

async function spawnClaudeOrExit(invocation, profile, prompt, executionScope, mutationContext, options) {
  try {
    const authSelection = resolveAuthSelection(invocation.auth_mode);
    return await spawnClaude(profile, {
      model: invocation.model,
      promptText: prompt,
      sessionId: invocation.job_id,
      addDirPath: executionScope.addDir,
      cwd: mutationContext.neutralCwd ?? executionScope.childCwd,
      binary: invocation.binary,
      jsonSchema: invocation.schema_spec,
      resumeId: options.resumeId,
      timeoutMs: 0,
      allowedApiKeyEnv: authSelection.allowed_env_credentials,
      onSpawn: (pidInfo) => writeRunningRecord(invocation, pidInfo, mutationContext.mutations),
    });
  } catch (e) {
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
      errorMessage: e.message,
    }, mutationContext.mutations);
    writeJobFile(invocation.workspace_root, invocation.job_id, errorRecord);
    upsertJob(invocation.workspace_root, errorRecord);
    cleanupExecutionResources(executionScope, mutationContext);
    if (options.foreground) printLifecycleJson(errorRecord, options.lifecycleEvents);
    process.exit(2);
  }
}

function writeRunningRecord(invocation, pidInfo, mutations) {
  const runningRecord = buildJobRecord(invocation, {
    status: "running",
    exitCode: null,
    parsed: null,
    pidInfo,
    claudeSessionId: null,
  }, mutations);
  writeJobFile(invocation.workspace_root, invocation.job_id, runningRecord);
  upsertJob(invocation.workspace_root, runningRecord);
}

function recordPostRunMutations(invocation, mutationContext) {
  if (!mutationContext.checkMutations || mutationContext.gitStatusBefore === null) return;
  const after = tryGit(["status", "-s", "--untracked-files=all"], invocation.cwd);
  if (!after.ok) {
    mutationContext.mutations.push(mutationDetectionFailure(after.error));
    return;
  }
  try {
    writeSidecar(invocation.workspace_root, invocation.job_id, "git-status-after.txt", after.stdout);
  } catch (e) {
    process.stderr.write(`claude-companion: warning: sidecar git-status-after.txt write failed: ${e.message}\n`);
  }
  if (!after.stdout || after.stdout === mutationContext.gitStatusBefore) return;
  const beforeLines = new Set(gitStatusLines(mutationContext.gitStatusBefore));
  mutationContext.mutations.push(...gitStatusLines(after.stdout).filter((line) => !beforeLines.has(line)));
}

function buildClaudeFinalRecord(invocation, execution, cancelMarker, mutations) {
  return buildJobRecord(invocation, {
    exitCode: execution.exitCode,
    parsed: execution.parsed,
    pidInfo: execution.pidInfo,
    claudeSessionId: execution.claudeSessionId ?? null,
    ...(cancelMarker ? { status: "cancelled" } : {}),
    signal: execution.signal ?? null,
    timedOut: execution.timedOut === true,
  }, mutations);
}

function writeExecutionSidecars(workspaceRoot, jobId, execution) {
  for (const [name, contents] of [["stdout.log", execution.stdout], ["stderr.log", execution.stderr]]) {
    try { writeSidecar(workspaceRoot, jobId, name, contents); }
    catch (e) {
      process.stderr.write(`claude-companion: warning: sidecar ${name} write failed: ${e.message}\n`);
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
      parsed: execution.parsed,
      pidInfo: execution.pidInfo,
      claudeSessionId: execution.claudeSessionId ?? null,
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
  cleanupNeutralCwd(mutationContext.neutralCwd);
  if (executionScope.disposeEffective) {
    try { executionScope.containment.cleanup(); } catch { /* best-effort */ }
  }
}

function cleanupNeutralCwd(neutralCwd) {
  if (!neutralCwd) return;
  try { rmSync(neutralCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ——— subcommand: _run-worker (hidden; detached worker for --background) ———
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
    meta = JSON.parse(_readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }
  if (["completed", "failed", "cancelled", "stale"].includes(meta.status)) {
    fail("bad_state", `job ${options.job} is already terminal (${meta.status}); refusing worker re-entry`);
  }

  // Honor a cancel that arrived while we were queued. The worker MUST check
  // this before spawning the target — otherwise the run completes (model
  // call, side effects) and only the post-run consumer at executeRun would
  // convert "completed" → "cancelled".
  if (consumeCancelMarker(workspaceRoot, options.job)) {
    const cancelledRecord = buildJobRecord(invocationFromRecord(meta), {
      status: "cancelled",
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
    }, []);
    writeJobFile(workspaceRoot, options.job, cancelledRecord);
    upsertJob(workspaceRoot, cancelledRecord);
    process.exit(0);
  }

  // Read+delete the prompt sidecar (§21.3.1 handoff buffer). Missing sidecar
  // means either the launcher crashed before writing it, or this is a
  // pre-T7.4 legacy record — either way, we can't run.
  let prompt;
  try {
    prompt = consumePromptSidecar(resolveJobsDir(workspaceRoot), options.job);
  } catch (error) {
    const errorMessage = `worker: prompt sidecar consume failed: ${error?.message ?? String(error)}`;
    const errorRecord = buildJobRecord(invocationFromRecord(meta), {
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
      errorMessage,
    }, []);
    writeJobFile(workspaceRoot, options.job, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("bad_state", errorMessage);
  }
  if (prompt == null) {
    const errorRecord = buildJobRecord(invocationFromRecord(meta), {
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
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
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
      errorMessage: `worker: ${apiKeyMissingMessage()}`,
    }, []);
    writeJobFile(workspaceRoot, options.job, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("not_authed", apiKeyMissingMessage(), apiKeyMissingFields(authSelection));
  }
  await executeRun(invocation, prompt, { foreground: false });
}

// ——— subcommand: continue (resume a prior session with --resume) ———
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
    prior = JSON.parse(_readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }
  if (!CONTINUABLE_STATUSES.has(prior.status)) {
    fail("bad_state", `cannot continue job in status ${JSON.stringify(prior.status)}; wait for terminal status or cancel first`);
  }
  const prompt = positionals.join(" ").trim();
  if (!prompt) fail("bad_args", "prompt is required (pass after -- separator)");
  // §21.1: read the PRIOR `claude_session_id`. Legacy `session_id` fallback
  // covers pre-T7.3 records; same caveat as before — first-gen resumes work,
  // resume-from-resume on legacy records hits a dead UUID.
  const priorClaudeSessionId = prior.claude_session_id ?? prior.session_id ?? null;
  if (!priorClaudeSessionId) {
    // PR #21 review HIGH 4: the most common stale-record case is a
    // background worker that died before Claude echoed a session ID. Give
    // the operator an actionable next step instead of a bare "no session".
    const isStaleOrphan = prior.status === "stale";
    const reason = isStaleOrphan
      ? "the worker exited before Claude returned a session ID, so there is no chat to resume."
      : "pre-T7.3 records missing this field cannot be chained.";
    const suggestion = isStaleOrphan
      ? ` Re-run from scratch: claude-companion run --mode ${prior.mode_profile_name ?? prior.mode} --cwd ${JSON.stringify(prior.cwd)} -- "<your prompt>"`
      : "";
    fail("no_session_to_resume",
      `prior job ${options.job} has no claude_session_id to resume — ${reason}${suggestion}`);
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

  // §21.1: resume_chain grows newest-last. The LAST entry is the UUID that
  // executeRun passes to spawnClaude via --resume (see the resumeId
  // derivation in executeRun). Do NOT persist a separate `resume_id` field
  // on the invocation — the chain is the source of truth.
  const invocation = Object.freeze({
    job_id: newJobId_,
    target: "claude",
    parent_job_id: options.job,
    resume_chain: [...priorResumeChain, priorClaudeSessionId],
    mode_profile_name: priorProfile.name,
    mode: priorModeName,
    model,
    cwd,
    workspace_root: workspaceRoot,
    // T7.2: inherit containment/scope from the profile freshly. dispose_effective
    // carries from prior so an --override-dispose on the original run persists.
    containment: priorProfile.containment,
    scope: priorProfile.scope,
    dispose_effective: prior.dispose_effective ?? priorProfile.dispose_default,
    scope_base: prior.scope_base ?? null,
    scope_paths: prior.scope_paths ?? null,
    prompt_head: prompt.slice(0, 200),    // §21.3.1 — no full prompt
    review_prompt_contract_version: priorProfile.name === "rescue" ? null : REVIEW_PROMPT_CONTRACT_VERSION,
    review_prompt_provider: priorProfile.name === "rescue" ? null : "Claude",
    schema_spec: prior.schema_spec ?? prior.schema ?? null,
    binary: options.binary ?? process.env.CLAUDE_BINARY ?? "claude",
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

function writeSidecar(workspaceRoot, jobId, name, contents) {
  const jobsDir = resolveJobsDir(workspaceRoot);
  const dir = `${jobsDir}/${jobId}`;
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

async function cmdNotImplemented(name) {
  fail("not_implemented", `'${name}' lands in a later milestone; only 'run --foreground' is wired at M2`);
}

const PING_AUTH_RE = /\b(auth(?:enticat\w*)?|login|credential\w*|oauth2?|unauthenticated|signin|sign-in)\b/i;
const PING_PROVIDER_API_KEY_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"];

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
    providerName: "Claude",
    providerApiKeyEnvNames: PING_PROVIDER_API_KEY_ENV,
  });
}

function pingOkFields() {
  return {
    ready: true,
    summary: "Claude Code is ready using first-party CLI auth.",
    next_action: "Run a Claude review command.",
  };
}

function pingNotAuthedFields() {
  return {
    ready: false,
    summary: "Claude Code subscription/OAuth auth is not available to this companion process.",
    next_action: "In a normal terminal, unset ANTHROPIC_API_KEY and CLAUDE_API_KEY, then run: claude auth login",
  };
}

function pingRateLimitedFields() {
  return {
    ready: false,
    summary: "Claude Code auth works, but the provider is currently rate-limited or overloaded.",
    next_action: "Retry in a few minutes.",
  };
}

function pingNotFoundFields() {
  return {
    ready: false,
    summary: "Claude Code binary was not found on PATH.",
    next_action: "Install Claude Code from https://claude.com/claude-code, or rerun setup with --binary pointing at your claude executable.",
  };
}

function pingErrorFields() {
  return {
    ready: false,
    summary: "Claude Code ping failed before readiness could be confirmed.",
    next_action: "Inspect detail, fix the Claude CLI error, then rerun setup.",
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

// ——— subcommand: ping (OAuth health probe per spec §7.5) ———
async function cmdPing(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["model", "binary", "timeout-ms", "auth-mode"],
    booleanOptions: [],
  });
  const profile = resolveProfile("ping");
  const model = options.model ?? resolveModelForProfile(profile, loadModels());
  const binary = options.binary ?? process.env.CLAUDE_BINARY ?? "claude";
  const timeoutMs = Number(options["timeout-ms"] ?? 15000);
  const authSelection = resolveAuthSelection(options["auth-mode"]);
  if (authSelection.selected_auth_path === "api_key_env_missing") {
    printJson({ status: "not_authed", ...apiKeyMissingFields(authSelection, pingNotAuthedFields()) });
    process.exit(2);
  }
  // Ping is ephemeral (no durable record), so reuse newJobId() purely for its
  // UUIDv4 guarantee — Claude rejects a non-v4 --session-id. Nothing persists.
  const sessionId = newJobId();
  let execution;
  try {
    execution = await spawnClaude(profile, {
      model,
      promptText: PING_PROMPT,
      sessionId,
      cwd: process.cwd(),
      binary,
      timeoutMs,
      allowedApiKeyEnv: authSelection.allowed_env_credentials,
    });
  } catch (e) {
    if (e.code === "ENOENT") {
      printJson({ status: "not_found", ...pingNotFoundFields(),
        ...authDiagnosticFields(authSelection),
        detail: `claude binary not found on PATH (or CLAUDE_BINARY override)`,
        install_url: "https://claude.com/claude-code" });
      process.exit(2);
    }
    printJson({ status: "error", ...pingErrorFields(), ...authDiagnosticFields(authSelection), detail: e.message });
    process.exit(2);
  }
  // Classify. Real Claude error texts change per version; match on signals only.
  if (execution.parsed.ok && (execution.parsed.result || execution.parsed.structured)) {
    // T7.4: drop the legacy `.sessionId` alias. Ping uses claudeSessionId
    // (Claude's echo) with sessionIdSent fallback when the mock short-circuits.
    const payload = { status: "ok", ...pingOkFields(), ...authDiagnosticFields(authSelection), model: model ?? null,
      session_id: execution.claudeSessionId ?? execution.sessionIdSent,
      cost_usd: execution.parsed.costUsd, usage: execution.parsed.usage };
    printJson(payload);
    process.exit(0);
  }
  if (execution.exitCode !== 0) {
    const detail = pingFailureDetail(execution);
    if (/rate limit|429|overloaded/i.test(detail)) {
      printJson({ status: "rate_limited", ...pingRateLimitedFields(), ...authDiagnosticFields(authSelection), detail });
      process.exit(2);
    }
    if (PING_AUTH_RE.test(detail)) {
      printJson({ status: "not_authed", ...pingNotAuthedFields(), detail,
        ...authDiagnosticFields(authSelection),
        hint: authSelection.selected_auth_path === "api_key_env"
          ? "Claude was launched with explicit API-key auth. Check the provider key and CLI support."
          : "Run `claude` interactively to complete OAuth. API-key env vars are ignored by subscription-mode policy." });
      process.exit(2);
    }
    printJson({ status: "error", ...pingErrorFields(), ...authDiagnosticFields(authSelection), exit_code: execution.exitCode, detail });
    process.exit(2);
  }
  printJson({ status: "error", ...pingErrorFields(), ...authDiagnosticFields(authSelection),
    detail: "parsed result missing", raw: execution.parsed.raw });
  process.exit(2);
}

// ——— subcommand: status (list running + recent jobs) ———
async function cmdStatus(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["job", "cwd"],
    booleanOptions: ["all"],
  });
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // #16 follow-up 3: reconcile orphan active jobs (queued/running with
  // dead pid_info or never-spawned older than the orphan window) before
  // listing. Promotes them to status=stale so they stop counting against
  // active history and operators can `continue --job` them. Silent on
  // success — the next listJobs call sees the updated records.
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
  const filtered = options.all ? jobs : jobs.filter((j) => DEFAULT_STATUSES.has(j.status));
  printJson({ workspace_root: workspaceRoot, jobs: filtered });
}

// ——— subcommand: result (render result of a finished job) ———
async function cmdResult(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["job", "cwd"],
    booleanOptions: [],
  });
  if (!options.job) fail("bad_args", "--job <id> is required");
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Validate jobId before resolving to file path (belt + suspenders;
  // resolveJobFile asserts too).
  let jobFile;
  try {
    jobFile = resolveJobFile(workspaceRoot, options.job);
  } catch (e) {
    fail("bad_args", e.message);
  }
  if (!existsSync(jobFile)) fail("not_found", `no meta.json for job ${options.job}`);
  // PR #21 review MED 1: wrap the read so a directory-at-meta-path
  // (CLAUDE_MOCK_META_CONFLICT, or a half-finalized job) produces a
  // friendly error instead of an unhandled EISDIR stacktrace.
  let meta;
  try {
    meta = JSON.parse(_readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("read_failed",
      `cannot read meta.json for job ${options.job}: ${e.message}`,
      { error_code: e.code ?? null });
  }
  printJson(meta);
}

// ——— subcommand: cancel (signal a running job) ———
//
// §21.1: signal target is resolved through `pid_info = {pid, starttime, argv0}`,
// not through `pid` alone. The `ps`/`/proc` re-read is both the liveness
// check AND the ownership proof — if starttime or argv0 drift, we refuse
// to signal (`stale_pid`) because the pid has been reused by an unrelated
// process. This is finding #7.
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
    // Legacy records (pre-T7.3) or races where the spawn aborted before
    // pidInfo was persisted. The job claims status=running but we have
    // nothing to verify. Refusing is safe; exit 2 is the contract.
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
  // Non-throwing ownership check: compares {starttime, argv0} of the live
  // process against the tuple captured at spawn. Mismatch → refuse.
  const check = verifyPidInfo(pidInfo);
  if (!check.match) {
    if (check.reason === "process_gone") {
      // Nothing alive at that pid — safely terminal. Legacy behavior emitted
      // "already_dead"; preserve so ops tooling keeps parsing.
      printJson({ ok: true, status: "already_dead", job_id: options.job, pid: pidInfo.pid });
      return;
    }
    if (check.reason === "capture_error") {
      // Issue #22 sub-task 3: ps/proc was unavailable (PATH stripped,
      // sandbox-denied exec, hidepid mount). The pid may well be alive — we
      // just couldn't verify ownership. Refusing to signal is the safe
      // default; the distinct status lets operators tell "I can't ask"
      // apart from "the pid was reused" (stale_pid).
      process.stderr.write(
        `claude-companion: unverifiable — could not verify pid ${pidInfo.pid} ` +
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
    // starttime_mismatch / argv0_mismatch / invalid — PID reuse or tampering.
    process.stderr.write(
      `claude-companion: stale_pid (${check.reason}) — refusing to signal pid ${pidInfo.pid}\n`
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
  // Issue #22 sub-task 2: write the cancel-requested marker BEFORE
  // signaling. See lib/cancel-marker.mjs for the full SIGTERM-trap
  // rationale. Best-effort — if the write fails the cancel still goes
  // through; we just lose the lifecycle override.
  try {
    writeCancelMarker(workspaceRoot, options.job);
  } catch (e) {
    process.stderr.write(`claude-companion: warning: cancel marker write failed: ${e.message}\n`);
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

// ——— dispatch ———
async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "preflight": return cmdPreflight(rest);
    case "run":     return cmdRun(rest);
    case "ping":    return cmdPing(rest);
    case "status":  return cmdStatus(rest);
    case "result":  return cmdResult(rest);
    case "cancel":  return cmdCancel(rest);
    case "continue": return cmdContinue(rest);
    case "_run-worker": return cmdRunWorker(rest);
    case "doctor":  return cmdPing(rest);
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write("claude-companion: see docs/superpowers/specs/ §7 for subcommand surface.\n");
      process.exit(0);
    default:
      fail("bad_args", `unknown subcommand ${JSON.stringify(sub)}`);
  }
}

main().catch((e) => {
  process.stderr.write(`claude-companion: unhandled: ${e.stack ?? e.message ?? e}\n`);
  process.exit(1);
});
