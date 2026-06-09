#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";

import { parseArgs } from "./lib/args.mjs";
import { buildAgyArgs, parseAgyResult, spawnAgy } from "./lib/agy.mjs";
import { writeCancelMarker, consumeCancelMarker } from "./lib/cancel-marker.mjs";
import { setupContainment } from "./lib/containment.mjs";
import {
  cancelNoPidInfoSuggestedAction,
  cancelUnverifiableSuggestedAction,
  consumePromptSidecar,
  externalReviewLaunchedEvent,
  gitStatusLines,
  parseLifecycleEventsMode,
  parseScopePathsOption,
  preflightDisclosure,
  preflightSafetyFields,
  printJson,
  printLifecycleJson,
  scopeBaseForOptions,
  summarizeScopeDirectory,
  writePromptSidecar,
} from "./lib/companion-common.mjs";
import { diffSourceFiles } from "./lib/diff-source.mjs";
import { cleanGitEnv } from "./lib/git-env.mjs";
import { gitEnv, isGitBinaryPolicyError, resolveGitBinary } from "./lib/git-binary.mjs";
import { verifyPidInfo } from "./lib/identity.mjs";
import { buildJobRecord, externalReviewForInvocation } from "./lib/job-record.mjs";
import { sanitizeTargetEnv } from "./lib/provider-env.mjs";
import {
  REVIEW_PROMPT_CONTRACT_VERSION,
  buildReviewAuditManifest,
  buildReviewPrompt,
  buildSelectedSourcePromptBlock,
  scopeResolutionReason,
} from "./lib/review-prompt.mjs";
import {
  configureState,
  listJobs,
  resolveJobFile,
  resolveJobsDir,
  upsertJob,
  writeJobFile,
} from "./lib/state.mjs";
import { reconcileActiveJobs } from "./lib/reconcile.mjs";
import { populateScope } from "./lib/scope.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PROVIDER_DISPLAY = "Google Antigravity CLI";
const DEFAULT_TIMEOUT_MS = 900000;
const READINESS_PREFLIGHT_TIMEOUT_MS = 30000;
const READINESS_PREFLIGHT_PROMPT = "Reply with exactly: relay-agy-readiness";
const PREFLIGHT_MODES = Object.freeze(["review", "adversarial-review", "custom-review"]);

configureState({
  pluginDataEnv: "AGY_PLUGIN_DATA",
  fallbackStateRootDir: resolvePath(tmpdir(), "agy-companion"),
  sessionIdEnv: "AGY_COMPANION_SESSION_ID",
});

function commandBinary(options) {
  return typeof options.binary === "string" && options.binary ? options.binary : (process.env.AGY_BINARY || "agy");
}

function commandCwd(options) {
  return resolvePath(typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd());
}

function parseReviewTimeoutMs(cliValue, fallback = DEFAULT_TIMEOUT_MS) {
  const raw = cliValue ?? null;
  if (raw === null || raw === "") return fallback;
  if (typeof raw !== "string") {
    fail("bad_args", `--timeout-ms must be a positive integer number of milliseconds; got ${JSON.stringify(raw)}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail("bad_args", `--timeout-ms must be a positive integer number of milliseconds; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function doctor(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["binary", "cwd"] });
  const binary = commandBinary(options);
  const cwd = commandCwd(options);
  const env = sanitizeTargetEnv(process.env);
  const result = spawnSync(binary, ["models"], { cwd, env, encoding: "utf8", timeout: 30000 });
  if (result.error) {
    printJson({
      provider: "agy",
      ready: false,
      error_code: "not_found",
      error_message: result.error.message,
      source_content_transmission: "not_sent",
    });
    process.exit(1);
  }
  if (result.status !== 0) {
    printJson({
      provider: "agy",
      ready: false,
      error_code: "not_ready",
      error_message: String(result.stderr ?? "").trim() || "agy models failed",
      source_content_transmission: "not_sent",
    });
    process.exit(1);
  }
  const models = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  printJson({
    provider: "agy",
    ready: true,
    status: "ok",
    models,
    source_content_transmission: "not_sent",
  });
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

function resolveReviewScope({ mode, requestedScope, scopeBase, scopePaths }) {
  const scope = mode === "custom-review" || requestedScope === "custom" ? "custom" : "branch-diff";
  if (scope === "custom") {
    return {
      scope,
      scopeBase: null,
      scopePaths,
    };
  }
  return {
    scope,
    scopeBase,
    scopePaths,
  };
}

function selectedFilesForPrompt({ cwd, workspaceRoot, scope, scopeBase, scopePaths, containmentPath }) {
  if (scope === "branch-diff") {
    const diffFiles = diffSourceFiles(cwd, scopeBase, {
      scopePaths,
      workspaceRoot,
    });
    if (diffFiles.length > 0) return diffFiles;
  }
  return auditSourceFiles(containmentPath);
}

function promptFor({ userPrompt, selectedFiles, mode, cwd, scope, scopeBase, scopePaths }) {
  const contractPrompt = buildReviewPrompt({
    provider: PROVIDER_DISPLAY,
    mode,
    repository: cwd,
    baseRef: scopeBase,
    scope,
    scopePaths,
    userPrompt,
  });
  const selectedSource = buildSelectedSourcePromptBlock(selectedFiles, {
    title: "Selected source",
    delimiterPrefix: "AGY FILE",
  });
  return [contractPrompt, selectedSource].filter(Boolean).join("\n\n");
}

function hasSubstantiveReview(text) {
  return /Verdict:\s*(APPROVE|REQUEST_CHANGES|COMMENT|FAIL|REJECT)/i.test(text)
    && /Blocking findings/i.test(text);
}

function sourceFilesForRedaction(selectedFiles) {
  return selectedFiles.map(({ path, text, content }) => ({
    path,
    text: typeof text === "string"
      ? text
      : Buffer.from(content ?? "").toString("utf8"),
  }));
}

function jobsDir(cwd) {
  return resolveJobsDir(cwd);
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

function prepareMutationContext(invocation) {
  const context = { checkMutations: true, gitStatusBefore: null, mutations: [] };
  try {
    context.gitStatusBefore = gitStatus(
      ["status", "-s", "--untracked-files=all"],
      invocation.cwd,
      invocation.workspace_root,
    );
    writeSidecar(invocation.workspace_root, invocation.job_id, "git-status-before.txt", context.gitStatusBefore);
  } catch (e) {
    if (isGitBinaryPolicyError(e)) throw e;
    context.mutations.push(mutationDetectionFailure(e));
  }
  return context;
}

function recordPostRunMutations(invocation, mutationContext) {
  if (!mutationContext.checkMutations || mutationContext.gitStatusBefore === null) return;
  let gitStatusAfter = null;
  try {
    gitStatusAfter = gitStatus(
      ["status", "-s", "--untracked-files=all"],
      invocation.cwd,
      invocation.workspace_root,
    );
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
    process.stderr.write(`agy-companion: warning: sidecar git-status-after.txt write failed: ${e.message}\n`);
  }
}

function withMutationReviewFailure(manifest, mutations) {
  const sourceMutations = Array.isArray(mutations)
    ? mutations.filter((mutation) => !String(mutation).startsWith("mutation_detection_failed:"))
    : [];
  if (!manifest || sourceMutations.length === 0) return manifest;
  const reviewQuality = manifest.review_quality ?? {};
  const reasons = new Set(Array.isArray(reviewQuality.semantic_failure_reasons)
    ? reviewQuality.semantic_failure_reasons
    : []);
  reasons.add("source_mutation_detected");
  return {
    ...manifest,
    status: "failed",
    review_quality: {
      ...reviewQuality,
      failed_review_slot: true,
      semantic_failure_reasons: [...reasons],
    },
  };
}

function buildInvocation({ jobId, mode, cwd, workspaceRoot, binary, model, scope, scopeBase, scopePaths, userPrompt, startedAt }) {
  return {
    job_id: jobId,
    target: "agy",
    parent_job_id: null,
    resume_chain: [],
    mode_profile_name: mode,
    mode,
    model: model ?? null,
    cwd,
    workspace_root: workspaceRoot,
    containment: "worktree",
    scope,
    run_kind: "foreground",
    dispose_effective: true,
    scope_base: scopeBase ?? null,
    scope_paths: Array.isArray(scopePaths) ? scopePaths : null,
    prompt_head: userPrompt.slice(0, 200),
    review_prompt_contract_version: REVIEW_PROMPT_CONTRACT_VERSION,
    review_prompt_provider: PROVIDER_DISPLAY,
    schema_spec: null,
    binary,
    started_at: startedAt,
  };
}

function buildAuditManifest({ promptText, selectedFiles, timeoutMs, invocation, result, status, errorCode }) {
  return buildReviewAuditManifest({
    prompt: promptText,
    sourceFiles: selectedFiles,
    request: {
      provider: "agy",
      model: invocation.model,
      timeoutMs,
    },
    promptBuilder: {
      contractVersion: REVIEW_PROMPT_CONTRACT_VERSION,
    },
    scope: {
      name: invocation.scope,
      base: invocation.scope_base,
      paths: invocation.scope_paths,
      reason: scopeResolutionReason({
        scope: invocation.scope,
        scope_base: invocation.scope_base,
        scope_paths: invocation.scope_paths,
      }),
    },
    route: {
      providerId: "agy",
      mode: invocation.mode,
      selectedRoute: "companion_cli",
      routeStep: "agy_print",
      sourceSendApprovalRequired: false,
    },
    result,
    status,
    errorCode,
  });
}

function persistRecord(workspaceRoot, record) {
  writeJobFile(workspaceRoot, record.job_id, record);
  upsertJob(workspaceRoot, record);
}

function executionForRecord({ status, pidInfo = null, parsed = null, exitCode = null, endedAt = null, reviewAuditManifest, selectedFiles }) {
  return {
    status,
    exitCode,
    endedAt,
    parsed,
    pidInfo,
    agySessionId: parsed?.sessionId ?? null,
    reviewAuditManifest,
    sourceFilesForRedaction: sourceFilesForRedaction(selectedFiles),
    sourceRedactionRequired: true,
  };
}

function writeRunningRecord(invocation, pidInfo, mutations, { promptText, selectedFiles, timeoutMs }) {
  const reviewAuditManifest = buildAuditManifest({
    promptText,
    selectedFiles,
    timeoutMs,
    invocation,
    result: "",
    status: "running",
    errorCode: null,
  });
  const record = buildJobRecord(
    invocation,
    executionForRecord({ status: "running", pidInfo, reviewAuditManifest, selectedFiles }),
    mutations,
  );
  persistRecord(invocation.workspace_root, record);
}

function profileForScope(mode, scope) {
  return {
    name: mode,
    sandbox: true,
    add_dir: true,
    containment: "worktree",
    scope,
  };
}

function persistAndPrintScopeFailure(invocation, lifecycleEvents, error) {
  const record = buildJobRecord(
    invocation,
    {
      exitCode: null,
      parsed: null,
      pidInfo: null,
      agySessionId: null,
      errorMessage: error?.message ?? String(error),
    },
    [],
  );
  persistRecord(invocation.workspace_root, record);
  printLifecycleJson(record, lifecycleEvents);
  process.exit(2);
}

function persistAndPrintPreSpawnFailure(
  invocation,
  lifecycleEvents,
  code,
  error,
  { promptText = "", selectedFiles = [], timeoutMs = DEFAULT_TIMEOUT_MS, exitCode = 1 } = {},
) {
  const message = error?.message ?? String(error);
  const reviewAuditManifest = buildAuditManifest({
    promptText,
    selectedFiles,
    timeoutMs,
    invocation,
    result: "",
    status: "failed",
    errorCode: code,
  });
  const record = buildJobRecord(
    invocation,
    executionForRecord({
      status: "failed",
      pidInfo: null,
      parsed: { ok: false, reason: code, error: message, result: null },
      exitCode,
      endedAt: new Date().toISOString(),
      reviewAuditManifest,
      selectedFiles,
    }),
    [],
  );
  persistRecord(invocation.workspace_root, record);
  printLifecycleJson(record, lifecycleEvents);
  process.exit(exitCode);
}

function agyReadinessPreflight({ binary, model }) {
  const preflightTimeoutMs = READINESS_PREFLIGHT_TIMEOUT_MS;
  const args = buildAgyArgs(
    { name: "ping", sandbox: false, add_dir: false },
    {
      model,
      promptText: READINESS_PREFLIGHT_PROMPT,
      timeoutMs: preflightTimeoutMs,
    },
  );
  const result = spawnSync(binary, args, {
    cwd: tmpdir(),
    env: sanitizeTargetEnv(process.env),
    encoding: "utf8",
    timeout: preflightTimeoutMs + 1000,
  });
  if (result.error) {
    const message = result.error.code === "ETIMEDOUT"
      ? "AGY readiness check timed out before source transmission"
      : `AGY readiness check failed before source transmission: ${result.error.message}`;
    return {
      code: result.error.code === "ETIMEDOUT" ? "preflight_stale" : "spawn_failed",
      error: new Error(message),
    };
  }
  const parsed = parseAgyResult(result.stdout ?? "", result.stderr ?? "");
  if (result.status === 0 && parsed.ok === true) return null;
  if (parsed.reason === "not_authed") {
    return { code: "not_authed", error: new Error(parsed.error ?? "AGY authentication is required") };
  }
  if (parsed.reason === "sandbox_blocked") {
    return { code: "sandbox_blocked", error: new Error(parsed.error ?? "AGY sandbox access is blocked") };
  }
  const detail = parsed.error ?? parsed.stderr ?? `exit ${result.status}`;
  return {
    code: "preflight_stale",
    error: new Error(`AGY readiness check failed before source transmission: ${detail}`),
  };
}

function cmdPreflight(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["mode", "cwd", "binary", "scope", "scope-base", "scope-paths"],
  });
  const mode = options.mode;
  const cwd = commandCwd(options);
  if (!mode || !PREFLIGHT_MODES.includes(mode)) {
    fail("bad_args", `--mode must be one of ${PREFLIGHT_MODES.join("|")}; got ${JSON.stringify(mode)}`, {
      event: "preflight",
      target: "agy",
      mode: mode ?? null,
      cwd,
      source_content_transmission: "not_sent",
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure(PROVIDER_DISPLAY),
    });
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const scopeBase = scopeBaseForOptions(options);
  const scopePaths = parseScopePathsOption(options["scope-paths"]);
  const {
    scope,
    scopeBase: resolvedScopeBase,
    scopePaths: resolvedScopePaths,
  } = resolveReviewScope({
    mode,
    requestedScope: options.scope ?? null,
    scopeBase,
    scopePaths,
  });
  const profile = profileForScope(mode, scope);
  let containment = null;
  let exitCode = 0;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: resolvedScopeBase,
      scopePaths: resolvedScopePaths,
      workspaceRoot,
    }, containment);
    const summary = summarizeScopeDirectory(containment.path);
    printJson({
      ok: true,
      event: "preflight",
      target: "agy",
      mode,
      mode_profile_name: profile.name,
      cwd,
      workspace_root: workspaceRoot,
      containment: profile.containment,
      scope: profile.scope,
      scope_base: resolvedScopeBase,
      scope_paths: resolvedScopePaths,
      source_content_transmission: "not_sent",
      ...summary,
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure(PROVIDER_DISPLAY),
    });
  } catch (e) {
    exitCode = 2;
    const error = isGitBinaryPolicyError(e) ? "git_binary_rejected" : "scope_failed";
    printJson({
      ok: false,
      event: "preflight",
      target: "agy",
      mode,
      cwd,
      workspace_root: workspaceRoot,
      containment: profile.containment,
      scope: profile.scope,
      scope_base: resolvedScopeBase,
      scope_paths: resolvedScopePaths,
      source_content_transmission: "not_sent",
      error,
      error_message: e.message,
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure(PROVIDER_DISPLAY),
    });
  } finally {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
  }
  process.exit(exitCode);
}

async function run(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: [
      "mode", "model", "cwd", "binary", "scope", "scope-base", "scope-paths",
      "timeout-ms", "lifecycle-events",
    ],
    booleanOptions: ["foreground", "background"],
  });
  const mode = options.mode;
  if (!["review", "adversarial-review", "custom-review"].includes(mode)) {
    printJson({ target: "agy", status: "failed", error_code: "bad_mode", source_content_transmission: "not_sent" });
    process.exit(1);
  }
  const cwd = commandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const binary = commandBinary(options);
  const timeoutMs = parseReviewTimeoutMs(options["timeout-ms"]);
  const scopeBase = scopeBaseForOptions(options);
  const scopePaths = parseScopePathsOption(options["scope-paths"]);
  const lifecycleEvents = parseLifecycleEventsMode(options["lifecycle-events"]);
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const userPrompt = positionals.join(" ").trim();
  const {
    scope,
    scopeBase: resolvedScopeBase,
    scopePaths: resolvedScopePaths,
  } = resolveReviewScope({
    mode,
    requestedScope: options.scope ?? null,
    scopeBase,
    scopePaths,
  });
  const invocation = buildInvocation({
    jobId,
    mode,
    cwd,
    workspaceRoot,
    binary,
    model: options.model ?? null,
    scope,
    scopeBase: resolvedScopeBase,
    scopePaths: resolvedScopePaths,
    userPrompt,
    startedAt,
  });
  const profile = profileForScope(mode, scope);
  const queuedRecord = buildJobRecord(invocation, null, []);
  persistRecord(invocation.workspace_root, queuedRecord);
  let containment = null;
  let selectedFiles = [];
  let promptText;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
      workspaceRoot,
    }, containment);
    selectedFiles = selectedFilesForPrompt({
      cwd,
      workspaceRoot,
      scope,
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
      containmentPath: containment.path,
    });
    promptText = promptFor({
      userPrompt,
      selectedFiles,
      mode,
      cwd,
      scope,
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
    });
  } catch (error) {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    persistAndPrintScopeFailure(invocation, lifecycleEvents, error);
  }
  let sidecarPrompt;
  try {
    writePromptSidecar(jobsDir(workspaceRoot), jobId, promptText);
    sidecarPrompt = consumePromptSidecar(jobsDir(workspaceRoot), jobId) ?? promptText;
  } catch (error) {
    try { consumePromptSidecar(jobsDir(workspaceRoot), jobId); } catch { /* best-effort prompt sidecar cleanup */ }
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    persistAndPrintPreSpawnFailure(invocation, lifecycleEvents, "prompt_sidecar_failed", error, {
      promptText,
      selectedFiles,
      timeoutMs,
    });
  }
  let mutationContext;
  try {
    mutationContext = prepareMutationContext(invocation);
  } catch (error) {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    persistAndPrintPreSpawnFailure(invocation, lifecycleEvents, "git_binary_rejected", error, {
      promptText: sidecarPrompt,
      selectedFiles,
      timeoutMs,
    });
  }
  const readinessFailure = agyReadinessPreflight({
    binary,
    model: options.model ?? null,
  });
  if (readinessFailure) {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    persistAndPrintPreSpawnFailure(invocation, lifecycleEvents, readinessFailure.code, readinessFailure.error, {
      promptText: sidecarPrompt,
      selectedFiles,
      timeoutMs,
    });
  }
  printLifecycleJson(
    externalReviewLaunchedEvent(invocation, externalReviewForInvocation(invocation, null)),
    lifecycleEvents,
  );

  if (consumeCancelMarker(workspaceRoot, jobId)) {
    const reviewAuditManifest = buildAuditManifest({
      promptText: sidecarPrompt,
      selectedFiles,
      timeoutMs,
      invocation,
      result: "",
      status: "cancelled",
      errorCode: null,
    });
    const cancelledRecord = buildJobRecord(
      invocation,
      executionForRecord({
        status: "cancelled",
        pidInfo: null,
        parsed: null,
        exitCode: null,
        endedAt: new Date().toISOString(),
        reviewAuditManifest,
        selectedFiles,
      }),
      mutationContext.mutations,
    );
    persistRecord(invocation.workspace_root, cancelledRecord);
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    printLifecycleJson(cancelledRecord, lifecycleEvents);
    process.exit(0);
  }

  let execution;
  try {
    execution = await spawnAgy(
      profile,
      {
        binary,
        cwd: containment.path,
        env: process.env,
        includeDirPath: containment.path,
        model: options.model ?? null,
        promptText: sidecarPrompt,
        timeoutMs,
        onSpawn: (pidInfo) => writeRunningRecord(invocation, pidInfo, mutationContext.mutations, {
          promptText: sidecarPrompt,
          selectedFiles,
          timeoutMs,
        }),
      },
    );
  } catch (error) {
    execution = {
      exitCode: null,
      signal: null,
      timedOut: false,
      endedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      agySessionId: null,
      pidInfo: null,
      parsed: { ok: false, reason: "spawn_failed", error: error.message, result: null },
      errorMessage: error.message,
      retryCount: 0,
    };
  }
  const cancelRequested = consumeCancelMarker(invocation.workspace_root, invocation.job_id);
  if (cancelRequested) {
    const reviewAuditManifest = buildAuditManifest({
      promptText: sidecarPrompt,
      selectedFiles,
      timeoutMs,
      invocation,
      result: "",
      status: "cancelled",
      errorCode: null,
    });
    const cancelledRecord = buildJobRecord(
      invocation,
      executionForRecord({
        status: "cancelled",
        pidInfo: execution.pidInfo ?? null,
        parsed: null,
        exitCode: execution.exitCode ?? null,
        endedAt: execution.endedAt ?? new Date().toISOString(),
        reviewAuditManifest,
        selectedFiles,
      }),
      mutationContext.mutations,
    );
    persistRecord(invocation.workspace_root, cancelledRecord);
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    printLifecycleJson(cancelledRecord, lifecycleEvents);
    process.exit(0);
  }
  const preliminarilyCompleted = execution.parsed.ok
    && execution.exitCode === 0
    && hasSubstantiveReview(execution.parsed.result ?? "");
  let parsed = preliminarilyCompleted
    ? execution.parsed
    : {
      ...execution.parsed,
      ok: false,
      reason: execution.parsed.reason ?? "review_not_completed",
      error: execution.parsed.error ?? "AGY did not produce a substantive review verdict",
      result: null,
    };
  let recordStatus = preliminarilyCompleted ? "completed" : "failed";
  let recordErrorCode = preliminarilyCompleted ? null : (parsed.reason ?? execution.parsed.reason ?? "review_not_completed");
  let reviewAuditManifest = buildAuditManifest({
    promptText: sidecarPrompt,
    selectedFiles,
    timeoutMs,
    invocation,
    result: preliminarilyCompleted ? (parsed.result ?? "") : "",
    status: recordStatus,
    errorCode: recordErrorCode,
  });
  let postRunPolicyError = null;
  try {
    recordPostRunMutations(invocation, mutationContext);
  } catch (error) {
    if (isGitBinaryPolicyError(error)) {
      postRunPolicyError = error;
      parsed = {
        ...parsed,
        ok: false,
        reason: "git_binary_rejected",
        error: error?.message ?? String(error),
        result: null,
      };
      recordStatus = "failed";
      recordErrorCode = "git_binary_rejected";
    } else {
      mutationContext.mutations.push(mutationDetectionFailure(error));
    }
  }
  reviewAuditManifest = withMutationReviewFailure(reviewAuditManifest, mutationContext.mutations);
  const reviewCompleted = !postRunPolicyError
    && preliminarilyCompleted
    && reviewAuditManifest.review_quality?.failed_review_slot !== true;
  if (!reviewCompleted) {
    parsed = {
      ...parsed,
      ok: false,
      reason: parsed.reason ?? "review_not_completed",
      error: parsed.error ?? "AGY did not produce a usable review under the shared review-quality contract",
      result: null,
    };
    recordStatus = "failed";
    recordErrorCode = parsed.reason ?? "review_not_completed";
    reviewAuditManifest = buildAuditManifest({
      promptText: sidecarPrompt,
      selectedFiles,
      timeoutMs,
      invocation,
      result: "",
      status: recordStatus,
      errorCode: recordErrorCode,
    });
    reviewAuditManifest = withMutationReviewFailure(reviewAuditManifest, mutationContext.mutations);
  }
  const record = buildJobRecord(invocation, {
    ...execution,
    parsed,
    reviewAuditManifest,
    sourceFilesForRedaction: sourceFilesForRedaction(selectedFiles),
    sourceRedactionRequired: true,
  }, mutationContext.mutations);
  persistRecord(invocation.workspace_root, record);
  if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
  printLifecycleJson(record, lifecycleEvents);
  process.exit(record.status === "completed" ? 0 : 1);
}

function fail(code, message, details = {}) {
  printJson({
    ok: false,
    error: code,
    error_code: code,
    message,
    error_message: message,
    source_content_transmission: "not_sent",
    ...details,
  });
  process.exit(1);
}

function status(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["job", "cwd"], booleanOptions: ["all"] });
  const cwd = commandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot);
  const jobs = listJobs(workspaceRoot);
  if (options.job) {
    const match = jobs.find((job) => job.id === options.job);
    if (!match) fail("not_found", `no job with id ${options.job} in workspace ${workspaceRoot}`);
    printJson(match);
    return;
  }
  const defaultStatuses = new Set(["running", "completed", "failed", "cancelled", "stale"]);
  printJson({
    workspace_root: workspaceRoot,
    jobs: options.all ? jobs : jobs.filter((job) => defaultStatuses.has(job.status)),
  });
}

function result(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["job", "job-id", "cwd"] });
  const jobId = options.job ?? options["job-id"];
  if (!jobId) fail("bad_args", "--job <id> is required");
  const cwd = commandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot);
  let jobFile;
  try {
    jobFile = resolveJobFile(workspaceRoot, jobId);
  } catch (error) {
    fail("bad_args", error.message);
  }
  if (!existsSync(jobFile)) {
    fail("not_found", `no meta.json for job ${jobId}`);
  }
  try {
    printJson(JSON.parse(readFileSync(jobFile, "utf8")));
  } catch (error) {
    fail("read_failed", `cannot read meta.json for job ${jobId}: ${error.message}`);
  }
}

function cancel(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["job", "cwd"], booleanOptions: ["force"] });
  if (!options.job) fail("bad_args", "--job <id> is required");
  const cwd = commandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot);
  const job = listJobs(workspaceRoot).find((entry) => entry.id === options.job);
  if (!job) fail("not_found", `no job with id ${options.job}`);
  if (["completed", "failed", "cancelled", "stale"].includes(job.status)) {
    printJson({ ok: true, status: "already_terminal", job_status: job.status, job_id: options.job });
    return;
  }
  if (job.status === "queued") {
    writeCancelMarker(workspaceRoot, options.job);
    printJson({ ok: true, status: "cancel_pending", job_status: job.status, job_id: options.job });
    return;
  }
  if (job.status !== "running") {
    fail("bad_state", `unexpected job status ${JSON.stringify(job.status)} for job ${options.job}`);
  }
  const pidInfo = job.pid_info ?? null;
  if (!pidInfo || !Number.isInteger(pidInfo.pid)) {
    printJson({
      ok: false,
      status: "no_pid_info",
      detail: "job has no pid_info; cannot safely signal",
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
  const check = verifyPidInfo(pidInfo);
  if (!check.match) {
    if (check.reason === "process_gone") {
      printJson({ ok: true, status: "already_dead", job_id: options.job, pid: pidInfo.pid });
      return;
    }
    printJson({
      ok: false,
      status: check.reason === "capture_error" ? "unverifiable" : "stale_pid",
      reason: check.reason,
      job_id: options.job,
      pid: pidInfo.pid,
      suggested_action: check.reason === "capture_error" ? cancelUnverifiableSuggestedAction(pidInfo.pid) : null,
    });
    process.exit(2);
  }
  writeCancelMarker(workspaceRoot, options.job);
  const signal = options.force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pidInfo.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") {
      printJson({ ok: true, status: "already_dead", job_id: options.job, pid: pidInfo.pid });
      return;
    }
    fail("signal_failed", error.message, { pid: pidInfo.pid, signal });
  }
  printJson({ ok: true, status: "signaled", signal, job_id: options.job, pid: pidInfo.pid });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "doctor" || command === "setup") {
    doctor(rest);
    return;
  }
  if (command === "preflight") {
    cmdPreflight(rest);
    return;
  }
  if (command === "run") {
    await run(rest);
    return;
  }
  if (command === "status") {
    status(rest);
    return;
  }
  if (command === "result") {
    result(rest);
    return;
  }
  if (command === "cancel") {
    cancel(rest);
    return;
  }
  process.stderr.write("Usage: agy-companion.mjs <doctor|preflight|run|status|result|cancel> [options]\n");
  process.exit(1);
}

main().catch((error) => {
  if (isGitBinaryPolicyError(error)) {
    fail("git_binary_rejected", error.message, { target: "agy" });
  }
  printJson({
    target: "agy",
    status: "failed",
    error_code: "agy_companion_error",
    error_message: error.message,
    source_content_transmission: "not_sent",
  });
  process.exit(1);
});
