#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";

import { parseArgs } from "./lib/args.mjs";
import { spawnAgy } from "./lib/agy.mjs";
import { writeCancelMarker, consumeCancelMarker } from "./lib/cancel-marker.mjs";
import {
  cancelNoPidInfoSuggestedAction,
  cancelUnverifiableSuggestedAction,
  consumePromptSidecar,
  externalReviewLaunchedEvent,
  parseLifecycleEventsMode,
  parseScopePathsOption,
  printJson,
  printLifecycleJson,
  scopeBaseForOptions,
  writePromptSidecar,
} from "./lib/companion-common.mjs";
import { gitEnv, resolveGitBinary } from "./lib/git-binary.mjs";
import { cleanGitEnv } from "./lib/git-env.mjs";
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
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PROVIDER_DISPLAY = "Google Antigravity CLI";
const DEFAULT_TIMEOUT_MS = 900000;

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

function git(cwd, workspaceRoot, args) {
  const result = spawnSync(resolveGitBinary({ cwd, workspaceRoot }), ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(cleanGitEnv()),
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr ?? "").trim() || `git ${args.join(" ")} failed`);
  }
  return String(result.stdout ?? "");
}

function realpathOrResolved(filePath) {
  try {
    return realpathSync.native(filePath);
  } catch {
    return resolvePath(filePath);
  }
}

function assertInsideWorkspace(rootReal, candidateReal, originalPath) {
  const relPath = relative(rootReal, candidateReal);
  if (!relPath || relPath === ".." || relPath.startsWith("../") || relPath.startsWith("..\\") || isAbsolute(relPath)) {
    throw new Error(`scope_base_invalid: custom scope path escapes workspace: ${originalPath}`);
  }
  return relPath.replace(/\\/g, "/");
}

function resolveScopedReadPath(cwd, filePath, { mustExist }) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("scope_paths_required: custom-review requires explicit --scope-paths");
  }
  if (isAbsolute(filePath)) {
    throw new Error(`scope_base_invalid: custom scope path must be relative: ${filePath}`);
  }
  const rootReal = realpathOrResolved(cwd);
  const lexicalPath = resolvePath(rootReal, filePath);
  assertInsideWorkspace(rootReal, lexicalPath, filePath);
  if (!existsSync(lexicalPath)) {
    if (mustExist) throw new Error(`scope_empty: custom scope path does not exist: ${filePath}`);
    return null;
  }
  const realPath = realpathSync.native(lexicalPath);
  assertInsideWorkspace(rootReal, realPath, filePath);
  return realPath;
}

function selectedFilesForBranchDiff(cwd, workspaceRoot, base) {
  const diffBase = typeof base === "string" && base ? base : "HEAD";
  const names = git(cwd, workspaceRoot, ["diff", "--name-only", diffBase, "HEAD"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return names.map((filePath) => {
    const absPath = resolveScopedReadPath(cwd, filePath, { mustExist: false });
    const content = absPath ? readFileSync(absPath, "utf8") : "";
    return {
      path: filePath,
      bytes: Buffer.byteLength(content),
      content_hash: createHash("sha256").update(content).digest("hex"),
      text: content,
    };
  });
}

function assertScopedRelativePath(cwd, filePath) {
  return resolveScopedReadPath(cwd, filePath, { mustExist: true });
}

function selectedFilesForCustomScope(cwd, scopePaths) {
  if (!Array.isArray(scopePaths) || scopePaths.length === 0) {
    throw new Error("scope_paths_required: custom-review requires explicit --scope-paths");
  }
  return scopePaths.map((filePath) => {
    const absPath = assertScopedRelativePath(cwd, filePath);
    const content = readFileSync(absPath, "utf8");
    return {
      path: filePath,
      bytes: Buffer.byteLength(content),
      content_hash: createHash("sha256").update(content).digest("hex"),
      text: content,
    };
  });
}

function resolveReviewScope({ mode, requestedScope, scopeBase, scopePaths, cwd, workspaceRoot }) {
  const scope = mode === "custom-review" || requestedScope === "custom" ? "custom" : "branch-diff";
  if (scope === "custom") {
    return {
      scope,
      scopeBase: null,
      scopePaths,
      selectedFiles: selectedFilesForCustomScope(cwd, scopePaths),
    };
  }
  return {
    scope,
    scopeBase,
    scopePaths: null,
    selectedFiles: selectedFilesForBranchDiff(cwd, workspaceRoot, scopeBase),
  };
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
  return selectedFiles.map(({ path, text }) => ({ path, text }));
}

function jobsDir(cwd) {
  return resolveJobsDir(cwd);
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

function writeRunningRecord(invocation, pidInfo, { promptText, selectedFiles, timeoutMs }) {
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
    [],
  );
  persistRecord(invocation.workspace_root, record);
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
  const timeoutMs = options["timeout-ms"] ? Number(options["timeout-ms"]) : DEFAULT_TIMEOUT_MS;
  const scopeBase = scopeBaseForOptions(options);
  const scopePaths = parseScopePathsOption(options["scope-paths"]);
  const lifecycleEvents = parseLifecycleEventsMode(options["lifecycle-events"]);
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const userPrompt = positionals.join(" ").trim();
  const {
    scope,
    selectedFiles,
  } = resolveReviewScope({
    mode,
    requestedScope: options.scope ?? null,
    scopeBase,
    scopePaths,
    cwd,
    workspaceRoot,
  });
  const invocation = buildInvocation({
    jobId,
    mode,
    cwd,
    workspaceRoot,
    binary,
    model: options.model ?? null,
    scope,
    scopeBase,
    scopePaths,
    userPrompt,
    startedAt,
  });
  const promptText = promptFor({
    userPrompt,
    selectedFiles,
    mode,
    cwd,
    scope,
    scopeBase,
    scopePaths,
  });
  writePromptSidecar(jobsDir(workspaceRoot), jobId, promptText);
  const sidecarPrompt = consumePromptSidecar(jobsDir(workspaceRoot), jobId) ?? promptText;
  printLifecycleJson(
    externalReviewLaunchedEvent(invocation, externalReviewForInvocation(invocation, null)),
    lifecycleEvents,
  );

  let execution;
  try {
    execution = await spawnAgy(
      { name: mode, sandbox: true, add_dir: true },
      {
        binary,
        cwd,
        env: process.env,
        includeDirPath: cwd,
        model: options.model ?? null,
        promptText: sidecarPrompt,
        timeoutMs,
        onSpawn: (pidInfo) => writeRunningRecord(invocation, pidInfo, {
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
      [],
    );
    persistRecord(invocation.workspace_root, cancelledRecord);
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
  const reviewCompleted = preliminarilyCompleted
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
  }
  const record = buildJobRecord(invocation, {
    ...execution,
    parsed,
    reviewAuditManifest,
    sourceFilesForRedaction: sourceFilesForRedaction(selectedFiles),
    sourceRedactionRequired: true,
  }, []);
  persistRecord(invocation.workspace_root, record);
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
    ...details,
  });
  process.exit(1);
}

function status(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["job", "cwd"], booleanOptions: ["all"] });
  const cwd = commandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
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
  process.stderr.write("Usage: agy-companion.mjs <doctor|run|status|result|cancel> [options]\n");
  process.exit(1);
}

main().catch((error) => {
  printJson({
    target: "agy",
    status: "failed",
    error_code: "agy_companion_error",
    error_message: error.message,
    source_content_transmission: "not_sent",
  });
  process.exit(1);
});
