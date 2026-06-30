#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { basename as basenamePath, dirname as dirnamePath, join as joinPath, resolve as resolvePath } from "node:path";
import { homedir, tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { parseArgs } from "./lib/args.mjs";
import { MAX_TIMER_DELAY_MS, buildAgyArgs, parseAgyResult, spawnAgy } from "./lib/agy.mjs";
import { writeCancelMarker, consumeCancelMarker } from "./lib/cancel-marker.mjs";
import { setupContainment } from "./lib/containment.mjs";
import {
  cancelNoPidInfoSuggestedAction,
  cancelUnverifiableSuggestedAction,
  consumePromptSidecar,
  assertRealJobDirectory,
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
  runtimeOptionsSidecarPath as commonRuntimeOptionsSidecarPath,
  writeFileAtomicDurable,
  writePromptSidecar,
} from "./lib/companion-common.mjs";
import { diffSourceFiles } from "./lib/diff-source.mjs";
import { cleanGitEnv } from "./lib/git-env.mjs";
import { gitEnv, isGitBinaryPolicyError, resolveGitBinary } from "./lib/git-binary.mjs";
import { verifyPidInfo } from "./lib/identity.mjs";
import { buildJobRecord, externalReviewForInvocation, resolveErrorSinkDisclosure } from "./lib/job-record.mjs";
import { sourceContentTransmissionForExecution } from "./lib/external-review.mjs";
import { sanitizeTargetEnv } from "./lib/provider-env.mjs";
import {
  CONCURRENCY_FACTS,
  latestSourcePacketPreviousAttempt,
  resolveConcurrencyAdmission,
  selectProviderRoute,
  sourcePacketPreviousAttemptFromJobRecord,
} from "./lib/provider-route-policy.mjs";
import {
  acquireProviderWorkloadLease,
  concurrencyAdmissionBlockedExecution,
  providerWorkloadBlockedExecution,
  releaseProviderWorkloadLease,
} from "./lib/review-workload.mjs";
import {
  REVIEW_PROMPT_CONTRACT_VERSION,
  buildReviewAuditManifest,
  buildReviewPrompt,
  buildSelectedSourcePromptBlock,
  scopeResolutionReason,
  selectedSourceFilesFromPrompt,
} from "./lib/review-prompt.mjs";
import {
  commitJobRecord,
  configureState,
  listJobs,
  resolveJobFile,
  resolveJobsDir,
  writeJobRecordToFile,
} from "./lib/state.mjs";
import { reconcileActiveJobs } from "./lib/reconcile.mjs";
import { populateScope } from "./lib/scope.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PROVIDER_DISPLAY = "Google Antigravity CLI";
const DEFAULT_TIMEOUT_MS = 900000;
const MAX_REVIEW_TIMEOUT_MS = MAX_TIMER_DELAY_MS;
const READINESS_PREFLIGHT_TIMEOUT_MS = 30000;
const READINESS_PREFLIGHT_PROMPT = "Reply with exactly: relay-agy-readiness";
const PREFLIGHT_MODES = Object.freeze(["review", "adversarial-review", "custom-review"]);
const REVIEW_PROMPT_SOURCE_DELIMITER_PREFIX = "AGY FILE";
// AGY receives the rendered prompt as one --print argv value. Linux caps a
// single argv string near 128 KiB. The source-packet budget keeps normal review
// packets below that after framing, and the rendered-prompt cap below is a hard
// transport preflight for pathological many-small-file packets or huge focus text.
const AGY_SOURCE_PACKET_MAX_BYTES = 96 * 1024;
const AGY_RENDERED_PROMPT_ARGV_MAX_BYTES = 112 * 1024;
const LARGE_SOURCE_PACKET_FLAG = "--allow-large-source-packet";
const AGY_WRITABLE_SIDECARS = new Set([
  "git-status-before.txt",
  "git-status-after.txt",
  "stdout.log",
  "stderr.log",
]);

// Set true once the AGY target process has spawned (onSpawn fires on execve), which is
// the point the selected source packet is delivered to it via --print argv. The top-level
// error sinks fail() and main().catch have no execution object in scope and would
// otherwise hard-code source_content_transmission:"not_sent"; once the target has spawned
// that is a FALSE disclosure (the source already left this process) — a disclosure
// inversion that under-warns the operator. This module-scoped latch is the process-level
// mirror of pidInfo for those sinks, so they disclose SENT for ANY post-spawn failure,
// including throws from post-spawn workspace-root re-resolution (e.g. consumeCancelMarker
// / state-dir resolution under a mid-run .git boundary topology change) that escape cmdRun
// to main().catch. One CLI invocation per process, so a set-once latch is sufficient.
let sourceSentToTarget = false;

// Read/query commands (status/result/cancel) inspect an existing job's persisted state — they
// spawn no target and transmit nothing, so a bare top-level "not_sent" on their error envelopes
// is misleading (the job's real disclosure is nested at external_review.source_content_transmission
// on the record). They omit the field (#240). EVERY other command keeps disclosing: run carries
// the honest sent/not_sent, and continue/resume fail-closes with "not_sent" to assert that no
// source was resent. Fail-safe — the default is to DISCLOSE; only this explicit read set omits.
const DISCLOSURE_OMITTING_COMMANDS = new Set(["status", "result", "cancel"]);
let commandOmitsErrorDisclosure = false;

// Disclosure field for the top-level error sinks (fail / main().catch). The decision (and its
// full truth table / rationale) is the single-source resolveErrorSinkDisclosure in lib/job-record.mjs,
// beside classifyExecution; this just feeds it the two runtime flags so the fail() and main().catch
// sinks cannot drift. Read/query commands omit; the latch overrides so a genuinely-sent source is
// ALWAYS disclosed (never the dangerous under-warning direction).
function errorSinkDisclosure() {
  return resolveErrorSinkDisclosure({ commandOmitsErrorDisclosure, sourceSentToTarget });
}

// Diagnostic commands (doctor / preflight) invoke AGY for readiness or run a local scope dry-run
// only — they NEVER spawn the review target with the source packet, so their disclosure is a
// structural constant, NOT the latch-aware error-sink decision (resolveErrorSinkDisclosure). One
// home for that constant so the invariant ("this command transmits no source") cannot drift.
const NON_TRANSMITTING_DISCLOSURE = Object.freeze({ source_content_transmission: "not_sent" });

const ROUTE_CAPABILITIES = Object.freeze({
  subscription: Object.freeze({
    kind: "oauth",
    auth_path: "subscription_oauth",
    source_packet: Object.freeze({
      max_bytes: AGY_SOURCE_PACKET_MAX_BYTES,
      resume_without_resend_supported: false,
    }),
  }),
});

configureState({
  pluginDataEnv: "AGY_PLUGIN_DATA",
  fallbackStateRootDir: resolvePath(tmpdir(), "agy-companion"),
  sessionIdEnv: "AGY_COMPANION_SESSION_ID",
});

function processHomeDir(env = process.env) {
  return env.HOME || homedir();
}

function resolveAgyHomeDir(env = process.env) {
  return resolvePath(env.ANTIGRAVITY_HOME || joinPath(processHomeDir(env), ".antigravity"));
}

function resolveSharedStateDir(pathValue) {
  mkdirSync(pathValue, { recursive: true });
  return realpathSync(pathValue);
}

function resolveAgyAdmissionContext(provider, route, env = process.env) {
  const fact = CONCURRENCY_FACTS[provider]?.[route];
  if (!fact) {
    throw new Error(`missing concurrency fact for source-bearing route ${provider}.${route}`);
  }
  const sharedStateIdentity = resolveSharedStateDir(resolveAgyHomeDir(env));
  return resolveConcurrencyAdmission({
    category: fact.category,
    declaredLimit: fact.limit,
    limitEnv: fact.limit_env,
    sharedStateIdentity,
    provider,
    route,
    env,
  });
}

function assertSourceBearingWorkloadLease(workloadAdmission, sourceBearing) {
  if (workloadAdmission.ok && sourceBearing && workloadAdmission.lease == null) {
    process.stderr.write("agy-companion: source-bearing admission returned no workload lease\n");
    process.exit(2);
  }
}

function commandBinary(options) {
  return typeof options.binary === "string" && options.binary ? options.binary : (process.env.AGY_BINARY || "agy");
}

function commandCwd(options) {
  return resolvePath(typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd());
}

function promptFromOptions(positionals, options) {
  const promptFile = options["prompt-file"];
  if (promptFile !== undefined) {
    if (positionals.length > 0) {
      fail("bad_args", "pass prompt either with --prompt-file or after -- separator, not both");
    }
    let promptText;
    try {
      promptText = readFileSync(promptFile, "utf8").trim();
    } catch (e) {
      fail("bad_args", `could not read --prompt-file: ${e.message}`);
    }
    if (promptText.length === 0) fail("bad_args", "--prompt-file must contain a non-empty prompt");
    return promptText;
  }

  const promptText = positionals.join(" ").trim();
  if (promptText.length === 0) fail("bad_args", "prompt is required (pass after -- separator or with --prompt-file)");
  return promptText;
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
  if (parsed > MAX_REVIEW_TIMEOUT_MS) {
    fail("bad_args", `--timeout-ms must be between 1 and ${MAX_REVIEW_TIMEOUT_MS} milliseconds; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function afterQueueTestDelayMs(env = process.env) {
  const parsed = Number(env.RELAY_TEST_AGY_AFTER_QUEUE_DELAY_MS ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 5000 ? parsed : 0;
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
      ...NON_TRANSMITTING_DISCLOSURE,
    });
    process.exit(1);
  }
  if (result.status !== 0) {
    printJson({
      provider: "agy",
      ready: false,
      error_code: "not_ready",
      error_message: String(result.stderr ?? "").trim() || "agy models failed",
      ...NON_TRANSMITTING_DISCLOSURE,
    });
    process.exit(1);
  }
  const models = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  printJson({
    provider: "agy",
    ready: true,
    status: "ok",
    models,
    ...NON_TRANSMITTING_DISCLOSURE,
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

function auditSourceFilesForPrompt(prompt, containmentPath) {
  return selectedSourceFilesFromPrompt(prompt, {
    delimiterPrefix: REVIEW_PROMPT_SOURCE_DELIMITER_PREFIX,
  }) ?? auditSourceFiles(containmentPath);
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
    delimiterPrefix: REVIEW_PROMPT_SOURCE_DELIMITER_PREFIX,
  });
  return [contractPrompt, selectedSource].filter(Boolean).join("\n\n");
}

function sourceFilesForRedaction(selectedFiles = []) {
  return selectedFiles.map(({ path, text, content }) => ({
    path,
    text: typeof text === "string"
      ? text
      : Buffer.from(content ?? "").toString("utf8"),
  }));
}

function sourceFilesHaveBodies(sourceFiles) {
  return Array.isArray(sourceFiles) && sourceFiles.some((file) => (
    typeof file?.text === "string" && file.text.length > 0
  ) || (
    file?.text instanceof Uint8Array && file.text.length > 0
  ) || (
    typeof file?.content === "string" && file.content.length > 0
  ) || (
    file?.content instanceof Uint8Array && file.content.length > 0
  ));
}

function redactionFieldsForPrompt(prompt) {
  const sourceFilesForRedaction = auditSourceFilesForPrompt(prompt, null);
  return sourceFilesForRedaction.length > 0
    ? {
      sourceRedactionRequired: sourceFilesHaveBodies(sourceFilesForRedaction),
      sourceFilesForRedaction,
    }
    : {};
}

function redactionFieldsForSelected(selectedFiles) {
  const files = sourceFilesForRedaction(selectedFiles ?? []);
  return files.length > 0
    ? { sourceRedactionRequired: sourceFilesHaveBodies(files), sourceFilesForRedaction: files }
    : {};
}

function jobsDir(cwd) {
  return resolveJobsDir(cwd);
}

function runtimeOptionsSidecarPath(workspaceRoot, jobId) {
  return commonRuntimeOptionsSidecarPath(resolveJobsDir(workspaceRoot), jobId);
}

function prepareSidecarJobDirectory(workspaceRoot, file) {
  const jobsDirectory = resolveJobsDir(workspaceRoot);
  const dir = dirnamePath(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertRealJobDirectory(jobsDirectory, dir);
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  return dir;
}

function agySidecarPath(workspaceRoot, jobId, name) {
  if (!AGY_WRITABLE_SIDECARS.has(name)) {
    throw new Error(`unsupported AGY sidecar: ${name}`);
  }
  return joinPath(dirnamePath(runtimeOptionsSidecarPath(workspaceRoot, jobId)), name);
}

function writeRuntimeOptionsSidecar(workspaceRoot, jobId, options) {
  const file = runtimeOptionsSidecarPath(workspaceRoot, jobId);
  prepareSidecarJobDirectory(workspaceRoot, file);
  const payload = {
    timeout_ms: options.timeout_ms,
  };
  if (options.previous_source_attempt && typeof options.previous_source_attempt === "object") {
    payload.previous_source_attempt = options.previous_source_attempt;
  }
  if (Array.isArray(options.review_slot_prior_attempts)) {
    payload.review_slot_prior_attempts = options.review_slot_prior_attempts.filter(
      (attempt) => attempt && typeof attempt === "object" && !Array.isArray(attempt),
    );
  }
  if (typeof options.resend_confirmation_approved === "boolean") {
    payload.resend_confirmation_approved = options.resend_confirmation_approved;
  }
  if (typeof options.resume_without_source_resend === "boolean") {
    payload.resume_without_source_resend = options.resume_without_source_resend;
  }
  if (typeof options.review_slot_disposition === "string" && options.review_slot_disposition.length > 0) {
    payload.review_slot_disposition = options.review_slot_disposition;
  }
  if (typeof options.review_slot_waiver_artifact === "string" && options.review_slot_waiver_artifact.length > 0) {
    payload.review_slot_waiver_artifact = options.review_slot_waiver_artifact;
  }
  if (typeof options.review_slot_override_artifact === "string" && options.review_slot_override_artifact.length > 0) {
    payload.review_slot_override_artifact = options.review_slot_override_artifact;
  }
  if (typeof options.source_packet_override_approved === "boolean") {
    payload.source_packet_override_approved = options.source_packet_override_approved;
  }
  if (typeof options.source_packet_override_source === "string" && options.source_packet_override_source.length > 0) {
    payload.source_packet_override_source = options.source_packet_override_source;
  }
  writeFileAtomicDurable(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function writeSidecar(workspaceRoot, jobId, name, contents) {
  const file = agySidecarPath(workspaceRoot, jobId, name);
  prepareSidecarJobDirectory(workspaceRoot, file);
  writeFileAtomicDurable(file, contents ?? "");
}

function writeExecutionSidecars(workspaceRoot, jobId, execution) {
  if (!execution) return;
  for (const [name, contents] of [["stdout.log", execution.stdout], ["stderr.log", execution.stderr]]) {
    try { writeSidecar(workspaceRoot, jobId, name, contents); }
    catch (e) {
      process.stderr.write(`agy-companion: warning: sidecar ${name} write failed: ${e?.message ?? String(e)}\n`);
    }
  }
}

function gitStatus(args, cwd, workspaceRoot = null) {
  return execFileSync(resolveGitBinary({ cwd, workspaceRoot }), ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(cleanGitEnv()),
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

function reviewPromptRepositoryIdentity(cwd, workspaceRoot) {
  const identity = repositoryIdentity(cwd, workspaceRoot);
  if (identity && identity !== workspaceRoot) return identity;
  return `local-workspace:${basenamePath(workspaceRoot ?? cwd ?? "workspace") || "workspace"}`;
}

function gitIdentityForInvocation(invocation) {
  return {
    remote: reviewPromptRepositoryIdentity(invocation.cwd, invocation.workspace_root),
    branch: gitText(["branch", "--show-current"], invocation.cwd, invocation.workspace_root) ?? "HEAD",
    baseRef: invocation.scope_base ?? null,
    baseCommit: gitCommitForPrompt(invocation.cwd, invocation.scope_base, invocation.workspace_root),
    headRef: gitText(["branch", "--show-current"], invocation.cwd, invocation.workspace_root) ?? "HEAD",
    headCommit: gitCommitForPrompt(invocation.cwd, "HEAD", invocation.workspace_root),
  };
}

// gitIdentityForInvocation() that tolerates a wedged git binary. Used only by the
// run() escape-finalizer, where a mid-run git-binary policy change is the reason
// we are finalizing: re-resolving identity would throw the same policy error.
// Returns an honest "unavailable" identity rather than fabricating commit metadata.
// Non-policy errors still propagate (they are real bugs, not the degraded path).
function tolerantGitIdentity(invocation) {
  try {
    return gitIdentityForInvocation(invocation);
  } catch (error) {
    if (!isGitBinaryPolicyError(error)) throw error;
    return {
      remote: null,
      branch: "HEAD",
      baseRef: invocation.scope_base ?? null,
      baseCommit: null,
      headRef: "HEAD",
      headCommit: null,
    };
  }
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

function modeSendsSelectedSource(mode) {
  return mode === "review" || mode === "adversarial-review" || mode === "custom-review";
}

function subscriptionRouteFields({ sourceBearing = false } = {}) {
  const route = selectProviderRoute({
    requestedRoute: "subscription",
    providerCapabilities: ROUTE_CAPABILITIES,
    sourceBearing,
  });
  return Object.freeze({
    selected_route: route.selected_route,
    route_step: route.route_step,
    route_steps: route.route_steps,
    fallback_reason: route.fallback_reason,
    selected_auth_path: route.auth_path,
    billing_path: route.billing_path,
    source_send_approval_required: route.source_send_approval_required,
    source_send_approval_state: route.source_send_approval_state,
  });
}

function reviewSlotInvocationFields(options = {}) {
  return Object.freeze({
    review_slot_disposition: typeof options["review-slot-disposition"] === "string"
      ? options["review-slot-disposition"]
      : null,
    review_slot_waiver_artifact: typeof options["review-slot-waiver-artifact"] === "string"
      ? options["review-slot-waiver-artifact"]
      : null,
    review_slot_override_artifact: typeof options["review-slot-override-artifact"] === "string"
      ? options["review-slot-override-artifact"]
      : null,
  });
}

function reviewSlotRouteFields(invocation = {}) {
  return {
    reviewSlot: {
      priorAttempts: Array.isArray(invocation.review_slot_prior_attempts)
        ? invocation.review_slot_prior_attempts
        : [],
      disposition: invocation.review_slot_disposition ?? "none",
      waiverArtifact: invocation.review_slot_waiver_artifact ?? null,
      overrideArtifact: invocation.review_slot_override_artifact ?? null,
    },
  };
}

function sourcePacketOverrideInvocationFields(options = {}) {
  const approved = options["allow-large-source-packet"] === true;
  return Object.freeze({
    source_packet_override_approved: approved,
    source_packet_override_source: approved ? LARGE_SOURCE_PACKET_FLAG : null,
  });
}

function sourcePacketOverrideRouteFields(invocation = {}) {
  return {
    sourcePacketOverrideApproved: invocation.source_packet_override_approved === true,
    sourcePacketOverrideSource: invocation.source_packet_override_source ?? null,
  };
}

function reviewSlotFromRecord(record) {
  const slot = record?.review_metadata?.audit_manifest?.review_slot
    ?? record?.external_review?.review_slot
    ?? null;
  return slot && typeof slot === "object" && !Array.isArray(slot) ? slot : null;
}

function priorSlotCountsTowardRetry(slot) {
  if (!slot?.retry_fingerprint) return false;
  if (slot.source_state === "not_sent") return false;
  if (slot.verdict === "approved") return false;
  const reason = String(slot.not_counted_reason ?? "unknown");
  if (reason === "stale_head" || reason === "source_not_sent") return false;
  return true;
}

function collectPriorReviewSlotAttempts(workspaceRoot, currentJobId = null) {
  let entries;
  try {
    entries = readdirSync(resolveJobsDir(workspaceRoot), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const attempts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const jobId = entry.name.slice(0, -".json".length);
    if (currentJobId !== null && jobId === currentJobId) continue;
    try {
      const record = JSON.parse(readFileSync(joinPath(resolveJobsDir(workspaceRoot), entry.name), "utf8"));
      if (record?.job_id !== jobId) continue;
      const slot = reviewSlotFromRecord(record);
      if (priorSlotCountsTowardRetry(slot)) {
        const previousAttempt = sourcePacketPreviousAttemptFromJobRecord(record);
        attempts.push(previousAttempt
          ? { ...previousAttempt, review_slot: slot }
          : { review_slot: slot });
      }
    } catch {
      // Malformed legacy records are not trusted as retry-policy evidence.
    }
  }
  return attempts;
}

function buildInvocation({
  jobId,
  mode,
  cwd,
  workspaceRoot,
  binary,
  model,
  scope,
  scopeBase,
  scopePaths,
  userPrompt,
  startedAt,
  previousSourceAttempt = null,
  reviewSlotPriorAttempts = [],
  resendConfirmationApproved = false,
  timeoutMs,
  reviewSlotFields = {},
  sourcePacketOverrideFields = {},
}) {
  const routeFields = subscriptionRouteFields({ sourceBearing: modeSendsSelectedSource(mode) });
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
    ...routeFields,
    previous_source_attempt: previousSourceAttempt,
    review_slot_prior_attempts: reviewSlotPriorAttempts,
    resend_confirmation_approved: resendConfirmationApproved,
    resume_without_source_resend: false,
    timeout_ms: timeoutMs,
    ...reviewSlotFields,
    ...sourcePacketOverrideFields,
    started_at: startedAt,
  };
}

function buildAuditManifest({
  promptText,
  selectedFiles,
  timeoutMs,
  invocation,
  result,
  status,
  errorCode,
  pidInfo = null,
  gitIdentity = null,
  sourcePacketPolicy = null,
}) {
  const sourceContentTransmission = sourceContentTransmissionForExecution({ status, errorCode, pidInfo });
  return buildReviewAuditManifest({
    prompt: promptText,
    sourceFiles: selectedFiles,
    // The escape-finalizer passes a precomputed (git-tolerant) identity because
    // gitIdentityForInvocation() re-invokes git, which is the very thing that is
    // wedged on that path. All other callers resolve identity inline as before.
    git: gitIdentity ?? gitIdentityForInvocation(invocation),
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
      selectedRoute: invocation.selected_route ?? null,
      routeStep: invocation.route_step ?? null,
      routeSteps: invocation.route_steps ?? null,
      fallbackReason: invocation.fallback_reason ?? null,
      authPath: invocation.selected_auth_path ?? null,
      billingPath: invocation.billing_path ?? null,
      sourceBearing: modeSendsSelectedSource(invocation.mode),
      sourceContentTransmission,
      sourceSendApprovalRequired: invocation.source_send_approval_required ?? null,
      sourceSendApprovalState: invocation.source_send_approval_state ?? null,
      providerCapabilities: ROUTE_CAPABILITIES,
      sourcePacketPolicy,
      renderedPromptBudgetChars: AGY_RENDERED_PROMPT_ARGV_MAX_BYTES,
      previousAttempt: invocation.previous_source_attempt ?? null,
      resendConfirmationApproved: invocation.resend_confirmation_approved === true,
      resumeWithoutSourceResend: invocation.resume_without_source_resend === true,
      ...reviewSlotRouteFields(invocation),
      ...sourcePacketOverrideRouteFields(invocation),
    },
    result,
    status,
    errorCode,
  });
}

function sourcePacketPolicyPreflight(invocation, prompt, containmentPath) {
  const selectedFiles = auditSourceFilesForPrompt(prompt, containmentPath);
  const preflightManifest = buildAuditManifest({
    promptText: prompt,
    selectedFiles,
    timeoutMs: invocation.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    invocation,
    result: "",
    status: "preflight_failed",
    errorCode: null,
  });
  const policy = preflightManifest?.source_packet_policy ?? null;
  if (!policy || policy.source_send_allowed !== false) return null;
  const errorCode = policy.source_packet_policy_error_code ?? "source_packet_policy_blocked";
  const execution = {
    preflight: true,
    exitCode: null,
    parsed: null,
    pidInfo: null,
    agySessionId: null,
    stdout: "",
    stderr: "",
    errorMessage: `${errorCode}: ${policy.suggested_action ?? "source packet policy blocked selected source send"}`,
    runtimeDiagnostics: sourcePacketRuntimeDiagnosticsForManifest(preflightManifest),
  };
  execution.reviewAuditManifest = buildAuditManifest({
    promptText: prompt,
    selectedFiles,
    timeoutMs: invocation.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    invocation,
    result: "",
    status: "failed",
    errorCode,
    pidInfo: null,
  });
  execution.runtimeDiagnostics = sourcePacketRuntimeDiagnosticsForManifest(
    execution.reviewAuditManifest,
    execution.runtimeDiagnostics,
  );
  return execution;
}

function renderedPromptArgvPreflight(invocation, prompt, containmentPath) {
  const renderedPromptBytes = Buffer.byteLength(prompt ?? "", "utf8");
  if (renderedPromptBytes <= AGY_RENDERED_PROMPT_ARGV_MAX_BYTES) return null;

  const selectedFiles = auditSourceFilesForPrompt(prompt, containmentPath);
  const baseManifest = buildAuditManifest({
    promptText: prompt,
    selectedFiles,
    timeoutMs: invocation.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    invocation,
    result: "",
    status: "preflight_failed",
    errorCode: null,
  });
  const basePolicy = baseManifest?.source_packet_policy ?? {};
  const policy = Object.freeze({
    ...basePolicy,
    source_send_allowed: false,
    source_packet_action: "narrow_source_packet",
    source_content_transmission: NON_TRANSMITTING_DISCLOSURE.source_content_transmission,
    source_packet_policy_error_code: "prompt_too_large",
    suggested_action:
      "Do not send selected source. Narrow or shard the AGY prompt before retrying; --allow-large-source-packet cannot bypass the platform argv transport cap.",
    rendered_prompt_bytes: renderedPromptBytes,
    rendered_prompt_argv_budget_bytes: AGY_RENDERED_PROMPT_ARGV_MAX_BYTES,
    transport: "argv_print",
  });
  const execution = {
    preflight: true,
    exitCode: null,
    parsed: {
      ok: false,
      reason: "prompt_too_large",
      error: `rendered AGY --print argv is ${renderedPromptBytes} bytes; limit is ${AGY_RENDERED_PROMPT_ARGV_MAX_BYTES} bytes`,
    },
    pidInfo: null,
    agySessionId: null,
    stdout: "",
    stderr: "",
    errorMessage:
      `prompt_too_large: rendered AGY --print argv is ${renderedPromptBytes} bytes; limit is ${AGY_RENDERED_PROMPT_ARGV_MAX_BYTES} bytes`,
    runtimeDiagnostics: {
      agy_transport_argv: {
        rendered_prompt_bytes: renderedPromptBytes,
        max_bytes: AGY_RENDERED_PROMPT_ARGV_MAX_BYTES,
      },
    },
  };
  execution.reviewAuditManifest = buildAuditManifest({
    promptText: prompt,
    selectedFiles,
    timeoutMs: invocation.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    invocation,
    result: "",
    status: "failed",
    errorCode: "prompt_too_large",
    pidInfo: null,
    sourcePacketPolicy: policy,
  });
  execution.runtimeDiagnostics = sourcePacketRuntimeDiagnosticsForManifest(
    execution.reviewAuditManifest,
    execution.runtimeDiagnostics,
  );
  return execution;
}

function sourcePacketRuntimeDiagnosticsForManifest(manifest, base = null) {
  const diagnostics = base && typeof base === "object" ? { ...base } : {};
  if (manifest?.source_packet_policy && typeof manifest.source_packet_policy === "object") {
    diagnostics.source_packet_policy = manifest.source_packet_policy;
  }
  if (manifest?.packet_recovery && typeof manifest.packet_recovery === "object") {
    diagnostics.packet_recovery = manifest.packet_recovery;
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : null;
}

function persistRecord(workspaceRoot, record, { fallbackJobFile = null } = {}) {
  const { metaError, stateError } = commitJobRecord(workspaceRoot, record.job_id, record);
  const error = metaError ?? stateError;
  if (!error) return;
  // A mid-run git-binary policy change can make state resolution fail. When the
  // caller supplied a path resolved while git was healthy, land the terminal meta
  // record there git-free; reconcileActiveJobs() heals state.json on the next
  // command. Without a fallback (or for non-policy errors), propagate the failure.
  if (!fallbackJobFile || !isGitBinaryPolicyError(error)) throw error;
  writeJobRecordToFile(fallbackJobFile, record);
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
    ...redactionFieldsForSelected(selectedFiles),
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
    pidInfo,
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
      ...NON_TRANSMITTING_DISCLOSURE,
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
      ...NON_TRANSMITTING_DISCLOSURE,
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
      "review-slot-disposition", "review-slot-waiver-artifact", "review-slot-override-artifact",
      "prompt-file",
    ],
    booleanOptions: ["foreground", "background", "resend-confirmation-approved", "allow-large-source-packet"],
  });
  const mode = options.mode;
  if (!["review", "adversarial-review", "custom-review"].includes(mode)) {
    printJson({ target: "agy", status: "failed", error_code: "bad_mode", ...errorSinkDisclosure() });
    process.exit(1);
  }
  if (options.background) {
    fail("bad_args", "AGY is foreground-only; --background is unsupported");
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
  const userPrompt = promptFromOptions(positionals, options);
  const reviewSlotPriorAttempts = collectPriorReviewSlotAttempts(workspaceRoot, jobId);
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
    previousSourceAttempt: latestSourcePacketPreviousAttempt(reviewSlotPriorAttempts),
    reviewSlotPriorAttempts,
    resendConfirmationApproved: options["resend-confirmation-approved"] === true,
    timeoutMs,
    reviewSlotFields: reviewSlotInvocationFields(options),
    sourcePacketOverrideFields: sourcePacketOverrideInvocationFields(options),
    startedAt,
  });
  const profile = profileForScope(mode, scope);
  const queuedRecord = buildJobRecord(invocation, null, []);
  writeRuntimeOptionsSidecar(workspaceRoot, jobId, {
    timeout_ms: timeoutMs,
    previous_source_attempt: invocation.previous_source_attempt,
    review_slot_prior_attempts: invocation.review_slot_prior_attempts,
    resend_confirmation_approved: invocation.resend_confirmation_approved,
    resume_without_source_resend: invocation.resume_without_source_resend,
    review_slot_disposition: invocation.review_slot_disposition,
    review_slot_waiver_artifact: invocation.review_slot_waiver_artifact,
    review_slot_override_artifact: invocation.review_slot_override_artifact,
    source_packet_override_approved: invocation.source_packet_override_approved,
    source_packet_override_source: invocation.source_packet_override_source,
  });
  persistRecord(invocation.workspace_root, queuedRecord);
  const queueDelayMs = afterQueueTestDelayMs();
  if (queueDelayMs > 0) {
    await sleep(queueDelayMs);
  }
  // Pre-resolve the durable job-record path while git is still healthy. A mid-run
  // RELAY_GIT_BINARY topology change can make resolveWorkspaceRoot() throw a git
  // policy error, after which resolveStateDir()/persistRecord() can no longer
  // locate this job's state dir. Caching the path lets the escape-finalizer land a
  // terminal record git-free instead of orphaning a stuck `queued` record.
  let resolvedJobFile = null;
  try {
    resolvedJobFile = resolveJobFile(invocation.workspace_root, jobId);
  } catch { /* entry-time git failure is surfaced by the guards below */ }
  let containment = null;
  let selectedFiles = [];
  let promptText;
  // Hoisted so the escape-finalizer (the catch below) can read whatever progress
  // the run made before a post-setup throw escaped.
  let sidecarPrompt = null;
  let mutationContext = null;
  let execution = null;
  let workloadLease = null;
  // Single guaranteed finalization for the whole containment-holding body: any
  // throw that escapes the inner handlers (e.g. a post-spawn git_binary_rejected
  // from consumeCancelMarker / buildAuditManifest / persistRecord under a mid-run
  // .git topology change) must still tear down the source-bearing worktree and
  // converge the durable record + disclosure — never leak, never orphan.
  try {
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

    if (consumeCancelMarker(workspaceRoot, jobId)) {
      const reviewAuditManifest = buildAuditManifest({
        promptText: sidecarPrompt,
        selectedFiles,
        timeoutMs,
        invocation,
        result: "",
        status: "cancelled",
        errorCode: null,
        pidInfo: null,
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

    const sourcePacketPreflight = sourcePacketPolicyPreflight(invocation, sidecarPrompt, containment.path);
    if (sourcePacketPreflight) {
      if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
      const errorRecord = buildJobRecord(invocation, {
        exitCode: sourcePacketPreflight.exitCode,
        endedAt: sourcePacketPreflight.endedAt,
        parsed: sourcePacketPreflight.parsed,
        pidInfo: null,
        agySessionId: null,
        errorMessage: sourcePacketPreflight.errorMessage,
        reviewAuditManifest: sourcePacketPreflight.reviewAuditManifest,
        runtimeDiagnostics: sourcePacketPreflight.runtimeDiagnostics,
        ...redactionFieldsForPrompt(sidecarPrompt),
      }, mutationContext.mutations);
      persistRecord(invocation.workspace_root, errorRecord);
      printLifecycleJson(errorRecord, lifecycleEvents);
      process.exit(2);
    }

    const argvPreflight = renderedPromptArgvPreflight(invocation, sidecarPrompt, containment.path);
    if (argvPreflight) {
      if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
      const errorRecord = buildJobRecord(invocation, {
        exitCode: argvPreflight.exitCode,
        endedAt: argvPreflight.endedAt,
        parsed: argvPreflight.parsed,
        pidInfo: null,
        agySessionId: null,
        errorMessage: argvPreflight.errorMessage,
        reviewAuditManifest: argvPreflight.reviewAuditManifest,
        runtimeDiagnostics: argvPreflight.runtimeDiagnostics,
        ...redactionFieldsForPrompt(sidecarPrompt),
      }, mutationContext.mutations);
      persistRecord(invocation.workspace_root, errorRecord);
      printLifecycleJson(errorRecord, lifecycleEvents);
      process.exit(2);
    }

    const sourceBearing = modeSendsSelectedSource(invocation.mode);
    let admissionContext = {};
    if (sourceBearing) {
      const route = "subscription";
      try {
        admissionContext = resolveAgyAdmissionContext(invocation.target, route, process.env);
      } catch {
        const workloadPreflight = concurrencyAdmissionBlockedExecution(invocation.target, route);
        workloadPreflight.reviewAuditManifest = buildAuditManifest({
          promptText: sidecarPrompt,
          selectedFiles,
          timeoutMs,
          invocation,
          result: "",
          status: "failed",
          errorCode: "provider_workload_blocked",
          pidInfo: null,
        });
        if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
        const errorRecord = buildJobRecord(invocation, {
          exitCode: workloadPreflight.exitCode,
          endedAt: workloadPreflight.endedAt,
          parsed: workloadPreflight.parsed,
          pidInfo: null,
          agySessionId: null,
          errorMessage: workloadPreflight.errorMessage,
          reviewAuditManifest: workloadPreflight.reviewAuditManifest,
          runtimeDiagnostics: workloadPreflight.runtimeDiagnostics,
          ...redactionFieldsForPrompt(sidecarPrompt),
        }, mutationContext.mutations);
        persistRecord(invocation.workspace_root, errorRecord);
        printLifecycleJson(errorRecord, lifecycleEvents);
        process.exit(2);
      }
    }

    const workloadAdmission = acquireProviderWorkloadLease({
      ...admissionContext,
      provider: invocation.target,
      jobId,
      cwd,
      sourceBearing,
      env: process.env,
    });
    if (workloadAdmission.ok) {
      assertSourceBearingWorkloadLease(workloadAdmission, sourceBearing);
      workloadLease = workloadAdmission.lease;
    } else {
      const workloadPreflight = providerWorkloadBlockedExecution(workloadAdmission);
      workloadPreflight.reviewAuditManifest = buildAuditManifest({
        promptText: sidecarPrompt,
        selectedFiles,
        timeoutMs,
        invocation,
        result: "",
        status: "failed",
        errorCode: "provider_workload_blocked",
        pidInfo: null,
      });
      if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
      const errorRecord = buildJobRecord(invocation, {
        exitCode: workloadPreflight.exitCode,
        endedAt: workloadPreflight.endedAt,
        parsed: workloadPreflight.parsed,
        pidInfo: null,
        agySessionId: null,
        errorMessage: workloadPreflight.errorMessage,
        reviewAuditManifest: workloadPreflight.reviewAuditManifest,
        runtimeDiagnostics: workloadPreflight.runtimeDiagnostics,
        ...redactionFieldsForPrompt(sidecarPrompt),
      }, mutationContext.mutations);
      persistRecord(invocation.workspace_root, errorRecord);
      printLifecycleJson(errorRecord, lifecycleEvents);
      process.exit(2);
    }

    const readinessFailure = agyReadinessPreflight({
      binary,
      model: options.model ?? null,
    });
    if (readinessFailure) {
      releaseProviderWorkloadLease(workloadLease);
      workloadLease = null;
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
          onSpawn: (pidInfo) => {
            // The target has spawned: the source packet is now delivered via --print argv.
            // Latch SENT for the top-level error sinks (see sourceSentToTarget).
            sourceSentToTarget = true;
            writeRunningRecord(invocation, pidInfo, mutationContext.mutations, {
              promptText: sidecarPrompt,
              selectedFiles,
              timeoutMs,
            });
          },
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
    releaseProviderWorkloadLease(workloadLease);
    workloadLease = null;
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
      && execution.exitCode === 0;
    let parsed = preliminarilyCompleted
      ? execution.parsed
      : {
        ...execution.parsed,
        ok: false,
        reason: execution.parsed.reason ?? "review_not_completed",
        error: execution.parsed.error ?? "AGY did not produce a substantive review verdict",
        result: execution.parsed.result ?? (execution.parsed.reason ? null : ""),
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
      pidInfo: execution.pidInfo ?? null,
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
          result: parsed.result ?? execution.parsed.result ?? "",
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
        result: parsed.result ?? execution.parsed.result ?? "",
      };
      recordStatus = "failed";
      recordErrorCode = parsed.reason ?? "review_not_completed";
      reviewAuditManifest = buildAuditManifest({
        promptText: sidecarPrompt,
        selectedFiles,
        timeoutMs,
        invocation,
        result: parsed.result ?? "",
        status: recordStatus,
        errorCode: recordErrorCode,
        pidInfo: execution.pidInfo ?? null,
      });
      reviewAuditManifest = withMutationReviewFailure(reviewAuditManifest, mutationContext.mutations);
    }
    const record = buildJobRecord(invocation, {
      ...execution,
      parsed,
      reviewAuditManifest,
      runtimeDiagnostics: sourcePacketRuntimeDiagnosticsForManifest(
        reviewAuditManifest,
        execution.runtimeDiagnostics ?? null,
      ),
      ...redactionFieldsForSelected(selectedFiles),
    }, mutationContext.mutations);
    persistRecord(invocation.workspace_root, record);
    writeExecutionSidecars(invocation.workspace_root, invocation.job_id, execution);
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    printLifecycleJson(record, lifecycleEvents);
    process.exit(record.status === "completed" ? 0 : 1);
  } catch (escapeError) {
    // Guaranteed teardown: a source-bearing containment worktree must never leak
    // into os.tmpdir, no matter where the body threw. cleanup() is best-effort and
    // idempotent (a path an inner handler already removed just ENOENTs here).
    releaseProviderWorkloadLease(workloadLease);
    workloadLease = null;
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    // The confirmed escape class: a mid-run RELAY_GIT_BINARY topology change makes a
    // post-setup git call (consumeCancelMarker / buildAuditManifest / persistRecord)
    // throw git_binary_rejected straight out of run(). Finalize a terminal record
    // git-free so the job converges to failed instead of orphaning as queued; the
    // pidInfo-aware classifier discloses SENT post-spawn, NOT_SENT pre-spawn.
    if (isGitBinaryPolicyError(escapeError)) {
      finalizeRunGitPolicyEscape({
        escapeError,
        invocation,
        lifecycleEvents,
        execution,
        sidecarPrompt,
        selectedFiles,
        timeoutMs,
        mutations: mutationContext?.mutations ?? [],
        resolvedJobFile,
      });
      return;
    }
    // Non-policy escapes are real bugs: let main().catch surface them, but only
    // after the worktree above has been reclaimed.
    throw escapeError;
  }
}

// Escape-path finalizer for a mid-run git-binary policy rejection thrown out of
// run()'s body. The normal terminal-record machinery re-invokes git (via
// resolveWorkspaceRoot in persistRecord and gitIdentityForInvocation in
// buildAuditManifest) — exactly what is wedged here — so this path lands the
// record at the pre-resolved job file (git-free) and supplies a git-tolerant
// identity. Disclosure is NOT hand-computed: the record carries parsed.reason
// "git_binary_rejected" plus the captured pidInfo, so the shared classifyExecution()
// applies the same structural invariant as the in-band post-run rejection —
// target spawned (pidInfo present) ⇒ SENT, pre-spawn ⇒ NOT_SENT.
function finalizeRunGitPolicyEscape({
  escapeError,
  invocation,
  lifecycleEvents,
  execution,
  sidecarPrompt,
  selectedFiles,
  timeoutMs,
  mutations,
  resolvedJobFile,
}) {
  const message = escapeError?.message ?? String(escapeError);
  const pidInfo = execution?.pidInfo ?? null;
  try {
    const reviewAuditManifest = buildAuditManifest({
      promptText: sidecarPrompt,
      selectedFiles,
      timeoutMs,
      invocation,
      result: "",
      status: "failed",
      errorCode: "git_binary_rejected",
      pidInfo,
      // The wedged binary is why we are finalizing; resolving identity inline
      // would re-throw the same policy error. buildJobRecord re-derives the
      // manifest's disclosure from the classified code, so SENT/NOT_SENT stays
      // governed by pidInfo, not by this placeholder errorCode.
      gitIdentity: tolerantGitIdentity(invocation),
    });
    // Build the terminal record the SAME way the in-band post-run git rejection does when
    // the target spawned: spread the real execution so runtime_diagnostics
    // (source_packet_policy) and raw_output byte counts are preserved, not dropped — full
    // record-level parity with the in-band path, not just status/error_code/disclosure.
    // Pre-spawn (no execution) mirrors persistAndPrintPreSpawnFailure's synthetic
    // executionForRecord (no runtime diagnostics — there was no execution). Either way the
    // shared classifyExecution governs disclosure (pidInfo present ⇒ SENT, else NOT_SENT).
    const recordExecution = execution
      ? {
        ...execution,
        parsed: {
          ...execution.parsed,
          ok: false,
          reason: "git_binary_rejected",
          error: message,
          result: execution.parsed?.result ?? "",
        },
        reviewAuditManifest,
        runtimeDiagnostics: sourcePacketRuntimeDiagnosticsForManifest(
          reviewAuditManifest,
          execution.runtimeDiagnostics ?? null,
        ),
        ...redactionFieldsForSelected(selectedFiles),
      }
      : executionForRecord({
        status: "failed",
        pidInfo: null,
        parsed: { ok: false, reason: "git_binary_rejected", error: message, result: null },
        exitCode: null,
        endedAt: new Date().toISOString(),
        reviewAuditManifest,
        selectedFiles,
      });
    const record = buildJobRecord(invocation, recordExecution, mutations);
    persistRecord(invocation.workspace_root, record, { fallbackJobFile: resolvedJobFile });
    printLifecycleJson(record, lifecycleEvents);
    process.exit(1);
  } catch {
    // Doubly degraded: even the git-free terminal write failed (e.g. the resolved
    // job dir is gone). Emit an honest minimal failure envelope so the caller never
    // hangs or sees a phantom success. fail() discloses via the sourceSentToTarget
    // latch, and the containment worktree was already reclaimed by run()'s catch.
    fail("git_binary_rejected", message, { target: "agy" });
  }
}

function fail(code, message, details = {}) {
  printJson({
    ok: false,
    error: code,
    error_code: code,
    message,
    error_message: message,
    ...details,
    // Honor whether the target already received the source (see sourceSentToTarget):
    // a post-spawn failure reaching this generic sink must not falsely report not_sent.
    // Read/query commands omit the field entirely (errorSinkDisclosure, #240). Spread LAST so the
    // latch-driven decision is authoritative — a stray source_content_transmission in details can
    // never override it (never the dangerous under-warning direction).
    ...errorSinkDisclosure(),
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
  // Read/query commands omit the error-envelope disclosure; every other command discloses (#240).
  commandOmitsErrorDisclosure = DISCLOSURE_OMITTING_COMMANDS.has(command);
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
  if (command === "continue") {
    fail("bad_args", "AGY continue/resume is unsupported; start a new foreground run instead", { target: "agy" });
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
    // See fail()/errorSinkDisclosure: read/query commands omit; the latch overrides (#240).
    ...errorSinkDisclosure(),
  });
  process.exit(1);
});
