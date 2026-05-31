#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { basename as basenamePath, dirname, join as joinPath, resolve as resolvePath } from "node:path";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync,
  writeFileSync, chmodSync, readdirSync, statSync, lstatSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { parseArgs } from "./lib/args.mjs";
import { configureState, resolveJobsDir, resolveJobFile, resolveStateDir, writeJobFile, upsertJob, listJobs, commitJobRecord } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { resolveProfile, resolveModelForProfile, resolveModelCandidatesForProfile } from "./lib/mode-profiles.mjs";
import { setupContainment } from "./lib/containment.mjs";
import { populateScope } from "./lib/scope.mjs";
import { newJobId, verifyPidInfo } from "./lib/identity.mjs";
import { buildJobRecord, classifyExecution, externalReviewForInvocation } from "./lib/job-record.mjs";
import { sourceContentTransmissionForExecution } from "./lib/external-review.mjs";
import { reconcileActiveJobs } from "./lib/reconcile.mjs";
import { cleanGitEnv } from "./lib/git-env.mjs";
import { gitEnv, isGitBinaryPolicyError, resolveGitBinary } from "./lib/git-binary.mjs";
import { spawnKimi } from "./lib/kimi.mjs";
import {
  latestSourcePacketPreviousAttempt,
  selectProviderRoute,
  sourcePacketCanResumeWithoutResendFromPreviousAttempt,
  sourcePacketCanResumeWithoutResendFromJobRecord,
  sourcePacketPreviousAttemptForContinuation,
  sourcePacketPreviousAttemptFromJobRecord,
} from "./lib/provider-route-policy.mjs";
import { writeCancelMarker, consumeCancelMarker } from "./lib/cancel-marker.mjs";
import { isCodexSandbox } from "./lib/codex-env.mjs";
import {
  PING_PROMPT,
  cancelNoPidInfoSuggestedAction,
  cancelUnverifiableSuggestedAction,
  consumeJsonSettingsSidecar,
  consumePromptSidecar,
  credentialNameDiagnostics,
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
  scopeBaseForOptions,
  startExternalReviewHeartbeat,
  summarizeScopeDirectory,
  writePromptSidecar,
} from "./lib/companion-common.mjs";
import { REVIEW_PROMPT_CONTRACT_VERSION, buildReviewAuditManifest, buildReviewPrompt, buildSelectedSourcePromptBlock, selectedSourceFilesFromPrompt } from "./lib/review-prompt.mjs";
import { diffSourceFiles } from "./lib/diff-source.mjs";
import {
  acquireProviderWorkloadLease,
  providerWorkloadBlockedExecution,
  releaseProviderWorkloadLease,
} from "./lib/review-workload.mjs";

const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_CONFIG_PATH = resolvePath(PLUGIN_ROOT, "config/models.json");
const CONTINUABLE_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);
const RUN_MODES = Object.freeze(["review", "adversarial-review", "custom-review", "rescue"]);
const PREFLIGHT_MODES = Object.freeze(["review", "adversarial-review", "custom-review"]);
const DEFAULT_KIMI_REVIEW_TIMEOUT_MS = 900000;
const DEFAULT_KIMI_PING_TIMEOUT_MS = 900000;
const KIMI_READINESS_PREFLIGHT_TIMEOUT_MS = 900000;
const REVIEW_PROMPT_SOURCE_DELIMITER_PREFIX = "KIMI FILE";
const KIMI_SOURCE_PACKET_MAX_BYTES = 32 * 1024;

const ROUTE_CAPABILITIES = Object.freeze({
  subscription: Object.freeze({
    kind: "oauth",
    auth_path: "subscription_oauth",
    source_packet: Object.freeze({
      max_bytes: KIMI_SOURCE_PACKET_MAX_BYTES,
      resume_without_resend_supported: false,
    }),
  }),
});

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

function findResultJobWorkspaceMatches(workspaceRoot, jobId) {
  let stateRoot;
  try {
    stateRoot = dirname(resolveStateDir(workspaceRoot));
  } catch {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(stateRoot);
  } catch {
    return [];
  }
  const matches = [];
  for (const entry of entries) {
    const candidate = joinPath(stateRoot, entry, "jobs", `${jobId}.json`);
    if (!existsSync(candidate)) continue;
    try {
      const record = JSON.parse(readFileSync(candidate, "utf8"));
      matches.push(record.workspace_root ?? record.cwd ?? null);
    } catch {
      continue;
    }
  }
  return matches;
}

function jobNotFoundDetails(jobId, cwd, workspaceRoot, commandName) {
  const matchedWorkspaceRoots = findResultJobWorkspaceMatches(workspaceRoot, jobId);
  const matchedWorkspaceRoot = matchedWorkspaceRoots[0] ?? null;
  const matchedWorkspace = matchedWorkspaceRoot !== null;
  const command = commandName === "continue" ? "continue --job" : "result with --job";
  if (matchedWorkspaceRoots.length > 1) {
    return {
      job_id: jobId,
      cwd,
      workspace_root: workspaceRoot,
      error_code: "state_collision",
      matched_workspace_count: matchedWorkspaceRoots.length,
      suggested_action: `State collision: job ${jobId} exists under multiple workspace state roots. Do not trust an arbitrary match; inspect plugin state, remove or repair duplicate state entries, then run ${command} ${jobId} --cwd <workspace used when the job was launched>.`,
    };
  }
  const suggested_action = matchedWorkspaceRoot
    ? `Job exists under a different workspace. Run ${command} ${jobId} --cwd <workspace used when the job was launched>.`
    : `Run ${command} ${jobId} --cwd <workspace used when the job was launched>.`;
  return {
    job_id: jobId,
    cwd,
    workspace_root: workspaceRoot,
    suggested_action,
    ...(matchedWorkspace ? { matched_workspace: true } : {}),
  };
}

function resultNotFoundDetails(jobId, cwd, workspaceRoot) {
  return jobNotFoundDetails(jobId, cwd, workspaceRoot, "result");
}

function continueNotFoundDetails(jobId, cwd, workspaceRoot) {
  return jobNotFoundDetails(jobId, cwd, workspaceRoot, "continue");
}

function targetPromptFor(profile, userPrompt, invocation = {}, sourceFiles = []) {
  if (profile.permission_mode !== "plan") return userPrompt;
  const selectedSource = buildSelectedSourcePromptBlock(sourceFiles, {
    delimiterPrefix: REVIEW_PROMPT_SOURCE_DELIMITER_PREFIX,
  });
  const modeLine = profile.name === "adversarial-review"
    ? "You are performing an adversarial code review. Prioritize correctness bugs, security risks, regressions, and missing tests."
    : "You are performing a code review. Prioritize bugs, behavioral regressions, and missing tests.";
  return buildReviewPrompt({
    provider: "Kimi",
    mode: profile.name,
    repository: reviewPromptRepositoryIdentity(invocation.cwd, invocation.workspace_root),
    baseRef: invocation.scope_base ?? null,
    baseCommit: gitCommitForPrompt(invocation.cwd, invocation.scope_base, invocation.workspace_root),
    headRef: "HEAD",
    headCommit: gitCommitForPrompt(invocation.cwd, "HEAD", invocation.workspace_root),
    scope: invocation.scope ?? profile.scope,
    scopePaths: invocation.scope_paths ?? null,
    userPrompt,
    // Kimi Code 1.43 stalls on the standard generated contract shape even with
    // a 32-byte selected source packet; compact keeps the shared semantics.
    contractStyle: "compact",
    extraInstructions: [
      modeLine,
      "Your final answer must be self-contained and must not refer to prior, previous, above, or already-provided answers.",
      ...(selectedSource ? [selectedSource] : []),
    ],
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

function promptMetadata(invocation) {
  return {
    repository: reviewPromptRepositoryIdentity(invocation.cwd, invocation.workspace_root),
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

function auditSourceFilesForPrompt(prompt, containmentPath) {
  return selectedSourceFilesFromPrompt(prompt, {
    delimiterPrefix: REVIEW_PROMPT_SOURCE_DELIMITER_PREFIX,
  }) ?? auditSourceFiles(containmentPath);
}

function selectedSourceFilesForRedaction(prompt) {
  return selectedSourceFilesFromPrompt(prompt, {
    delimiterPrefix: REVIEW_PROMPT_SOURCE_DELIMITER_PREFIX,
  }) ?? [];
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
  const sourceFilesForRedaction = selectedSourceFilesForRedaction(prompt);
  return sourceFilesForRedaction.length > 0
    ? {
      sourceRedactionRequired: sourceFilesHaveBodies(sourceFilesForRedaction),
      sourceFilesForRedaction,
    }
    : {};
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

function executionForAuditClassification(execution) {
  if (!execution || !("reviewAuditManifest" in execution)) return execution;
  const { reviewAuditManifest: _ignored, ...rest } = execution;
  return rest;
}

function reviewAuditManifest(invocation, prompt, containmentPath, execution) {
  if (!invocation.review_prompt_contract_version || invocation.mode_profile_name === "rescue") return null;
  const meta = promptMetadata(invocation);
  const auditExecution = executionForAuditClassification(execution);
  const { status: executionStatus, error_code: errorCode } = classifyExecution(auditExecution);
  const sourceContentTransmission = sourceContentTransmissionForExecution({
    status: execution?.preflight === true ? "preflight_failed" : executionStatus,
    errorCode,
    pidInfo: auditExecution?.pidInfo ?? null,
  });
  return buildReviewAuditManifest({
    prompt,
    sourceFiles: invocation.resume_without_source_resend === true
      ? []
      : auditSourceFilesForPrompt(prompt, containmentPath),
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
    providerIds: { sessionId: auditExecution?.kimiSessionId ?? null },
    scope: {
      name: invocation.scope,
      base: invocation.scope_base ?? null,
      paths: invocation.scope_paths ?? null,
      reason: scopeResolutionReason(invocation),
    },
    route: {
      mode: invocation.mode,
      providerId: "kimi",
      selectedRoute: invocation.selected_route ?? null,
      routeStep: invocation.route_step ?? null,
      routeSteps: invocation.route_steps ?? null,
      fallbackReason: invocation.fallback_reason ?? null,
      approvalScope: null,
      authPath: invocation.selected_auth_path ?? null,
      billingPath: invocation.billing_path ?? null,
      sourceBearing: modeSendsSelectedSource(invocation.mode),
      sourceContentTransmission,
      sourceSendApprovalRequired: invocation.source_send_approval_required ?? null,
      sourceSendApprovalState: invocation.source_send_approval_state ?? null,
      providerCapabilities: ROUTE_CAPABILITIES,
      previousAttempt: invocation.previous_source_attempt ?? null,
      resendConfirmationApproved: invocation.resend_confirmation_approved === true,
      resumeWithoutSourceResend: invocation.resume_without_source_resend === true,
      ...reviewSlotRouteFields(invocation),
      sourcePacketOverrideApproved: invocation.source_packet_override_approved === true,
      sourcePacketOverrideSource: invocation.source_packet_override_source ?? null,
    },
    result: execution?.parsed?.result ?? "",
    status: execution?.preflight === true ? "preflight_failed" : executionStatus,
    errorCode,
  });
}

function sourcePacketPolicyPreflight(invocation, prompt, containmentPath) {
  const preflightExecution = {
    preflight: true,
    exitCode: null,
    parsed: null,
    pidInfo: null,
    kimiSessionId: null,
    stdout: "",
    stderr: "",
    errorMessage: "source_packet_too_large: source packet policy preflight pending",
  };
  const manifest = reviewAuditManifest(invocation, prompt, containmentPath, preflightExecution);
  const policy = manifest?.source_packet_policy ?? null;
  if (!policy || policy.source_send_allowed !== false) return null;
  const errorCode = policy.source_packet_policy_error_code ?? "source_packet_policy_blocked";
  const execution = {
    ...preflightExecution,
    errorMessage: `${errorCode}: ${policy.suggested_action ?? "source packet policy blocked selected source send"}`,
    runtimeDiagnostics: {
      source_packet_policy: policy,
      packet_recovery: manifest.packet_recovery ?? null,
    },
  };
  execution.reviewAuditManifest = reviewAuditManifest(invocation, prompt, containmentPath, execution);
  return execution;
}

function subscriptionRouteFacts({ sourceBearing = false } = {}) {
  const route = selectProviderRoute({
    requestedRoute: "subscription",
    providerCapabilities: ROUTE_CAPABILITIES,
    sourceBearing,
  });
  return {
    selected_route: route.selected_route,
    route_step: route.route_step,
    route_steps: route.route_steps,
    fallback_reason: route.fallback_reason,
    selected_auth_path: route.auth_path,
    billing_path: route.billing_path,
    source_send_approval_required: route.source_send_approval_required,
    source_send_approval_state: route.source_send_approval_state,
  };
}

const LARGE_SOURCE_PACKET_FLAG = "--allow-large-source-packet";

function sourcePacketOverrideInvocationFields(options = {}) {
  const approved = options["allow-large-source-packet"] === true;
  return Object.freeze({
    source_packet_override_approved: approved,
    source_packet_override_source: approved ? LARGE_SOURCE_PACKET_FLAG : null,
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
  return mode === "review" || mode === "adversarial-review" || mode === "custom-review" || mode === "rescue";
}

function scopedTargetPromptForOrExit(invocation, profile, userPrompt, lifecycleEvents) {
  if (!invocation.review_prompt_contract_version || invocation.mode_profile_name === "rescue") {
    return targetPromptFor(profile, userPrompt, invocation);
  }
  if (invocation.resume_without_source_resend === true) {
    return targetPromptFor(profile, userPrompt, invocation);
  }
  const { job_id: jobId, cwd, workspace_root: workspaceRoot } = invocation;
  let containment = null;
  let containmentCleaned = false;
  const cleanupContainment = () => {
    if (!containment || containmentCleaned) return;
    try {
      containment.cleanup();
      containmentCleaned = true;
    } catch { /* best-effort */ }
  };
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
      workspaceRoot,
    }, containment);
    return targetPromptFor(profile, userPrompt, invocation, (() => { const d = diffSourceFiles(cwd, invocation.scope_base, { scopePaths: invocation.scope_paths, workspaceRoot }); return d.length > 0 ? d : auditSourceFiles(containment.path); })());
  } catch (e) {
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, kimiSessionId: null,
      errorMessage: e.message,
    }, []);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    printLifecycleJson(errorRecord, lifecycleEvents);
    cleanupContainment();
    process.exit(2);
  } finally {
    cleanupContainment();
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

function makeKimiPingCwd() {
  const dir = mkdtempSync(joinPath(tmpdir(), "kimi-ping-neutral-"));
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

function createKimiReadOnlyLaunchFiles(profile) {
  if (!Array.isArray(profile.allowed_tools)) return null;
  const dir = mkdtempSync(joinPath(tmpdir(), "kimi-policy-"));
  const skillsDir = joinPath(dir, "skills");
  const mcpConfigFile = joinPath(dir, "empty-mcp.json");
  const agentFilePath = joinPath(dir, "agent.yaml");
  const systemPromptPath = joinPath(dir, "system.md");
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  writeFileSync(mcpConfigFile, "{}\n", "utf8");
  writeFileSync(systemPromptPath, [
    "You are a read-only external reviewer.",
    "Use only the prompt text supplied by the caller.",
    "Do not use tools, inspect the workspace, edit files, or fetch external content.",
    "Return the requested review verdict and findings directly.",
    "",
  ].join("\n"), "utf8");
  writeFileSync(agentFilePath, [
    "version: 1",
    "agent:",
    "  name: codex-readonly-reviewer",
    "  system_prompt_path: ./system.md",
    ...(profile.allowed_tools.length === 0
      ? ["  tools: []"]
      : ["  tools:", ...profile.allowed_tools.map((tool) => `    - ${JSON.stringify(tool)}`)]),
    "  subagents: {}",
    "",
  ].join("\n"), "utf8");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  try { process.once("exit", cleanup); } catch { /* best-effort */ }
  return Object.freeze({ dir, agentFilePath, mcpConfigFile, skillsDir, cleanup });
}

function readOnlyLaunchInputs(launchFiles) {
  if (!launchFiles) return {};
  return {
    agentFilePath: launchFiles.agentFilePath,
    mcpConfigFile: launchFiles.mcpConfigFile,
    skillsDir: launchFiles.skillsDir,
  };
}

async function kimiReadinessPreflight(invocation, profile) {
  const readinessProfile = resolveProfile("ping");
  const candidates = modelCandidatesForInvocation(profile, invocation);
  let execution = null;
  const pingCwd = makeKimiPingCwd();
  const launchFiles = createKimiReadOnlyLaunchFiles(readinessProfile);
  try {
    for (let i = 0; i < candidates.length; i++) {
      execution = await spawnKimi(readinessProfile, {
        model: candidates[i],
        promptText: PING_PROMPT,
        cwd: pingCwd,
        binary: invocation.binary,
        env: { ...process.env, KIMI_COMPANION_PREFLIGHT: "1" },
        timeoutMs: KIMI_READINESS_PREFLIGHT_TIMEOUT_MS,
        maxStepsPerTurn: invocation.max_steps_per_turn,
        ...readOnlyLaunchInputs(launchFiles),
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
      kimiSessionId: null,
      stdout: "",
      stderr: "",
      errorMessage: isKimiCodexSandboxBlocked(detail) ? `sandbox_blocked: ${detail}` : detail,
    };
  } finally {
    if (launchFiles) launchFiles.cleanup();
  }

  const failureText = pingFailureText(execution);
  const detail = pingFailureDetail(execution);
  let errorMessage = detail || "Kimi Code CLI readiness check failed before review launch.";
  if (isKimiCodexSandboxBlocked(failureText)) {
    errorMessage = `sandbox_blocked: ${detail}`;
  } else if (PING_AUTH_RE.test(detail)) {
    errorMessage = `not_authed: ${detail}`;
  }
  return {
    ...execution,
    pidInfo: null,
    kimiSessionId: null,
    preflight: true,
    errorMessage,
  };
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
  const consumed = consumeJsonSettingsSidecar(file);
  const parsed = consumed.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const timeoutMs = parsed.timeout_ms;
  const maxSteps = parsed.max_steps_per_turn;
  const options = {};
  if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) options.timeout_ms = timeoutMs;
  if (Number.isSafeInteger(maxSteps) && maxSteps > 0) options.max_steps_per_turn = maxSteps;
  if (parsed.previous_source_attempt && typeof parsed.previous_source_attempt === "object" && !Array.isArray(parsed.previous_source_attempt)) {
    options.previous_source_attempt = parsed.previous_source_attempt;
  }
  if (Array.isArray(parsed.review_slot_prior_attempts)) {
    options.review_slot_prior_attempts = parsed.review_slot_prior_attempts.filter(
      (attempt) => attempt && typeof attempt === "object" && !Array.isArray(attempt),
    );
  }
  if (typeof parsed.resend_confirmation_approved === "boolean") {
    options.resend_confirmation_approved = parsed.resend_confirmation_approved;
  }
  if (typeof parsed.resume_without_source_resend === "boolean") {
    options.resume_without_source_resend = parsed.resume_without_source_resend;
  }
  if (typeof parsed.review_slot_disposition === "string" && parsed.review_slot_disposition.length > 0) {
    options.review_slot_disposition = parsed.review_slot_disposition;
  }
  if (typeof parsed.review_slot_waiver_artifact === "string" && parsed.review_slot_waiver_artifact.length > 0) {
    options.review_slot_waiver_artifact = parsed.review_slot_waiver_artifact;
  }
  if (typeof parsed.review_slot_override_artifact === "string" && parsed.review_slot_override_artifact.length > 0) {
    options.review_slot_override_artifact = parsed.review_slot_override_artifact;
  }
  if (typeof parsed.source_packet_override_approved === "boolean") {
    options.source_packet_override_approved = parsed.source_packet_override_approved;
  }
  if (typeof parsed.source_packet_override_source === "string" && parsed.source_packet_override_source.length > 0) {
    options.source_packet_override_source = parsed.source_packet_override_source;
  }
  if (consumed.cleanup_warning) {
    options.cleanup_warning = consumed.cleanup_warning;
    options.cleanup_warning_path = consumed.cleanup_warning_path;
  }
  return options;
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
    ...subscriptionRouteFacts({ sourceBearing: modeSendsSelectedSource(record.mode) }),
    previous_source_attempt: runtimeOptions.previous_source_attempt ?? null,
    review_slot_prior_attempts: runtimeOptions.review_slot_prior_attempts ?? [],
    resend_confirmation_approved: runtimeOptions.resend_confirmation_approved === true,
    resume_without_source_resend: runtimeOptions.resume_without_source_resend === true,
    review_slot_disposition: runtimeOptions.review_slot_disposition ?? null,
    review_slot_waiver_artifact: runtimeOptions.review_slot_waiver_artifact ?? null,
    review_slot_override_artifact: runtimeOptions.review_slot_override_artifact ?? null,
    source_packet_override_approved: runtimeOptions.source_packet_override_approved === true,
    source_packet_override_source: runtimeOptions.source_packet_override_source ?? null,
    runtime_options_cleanup_warning: runtimeOptions.cleanup_warning ?? null,
    runtime_options_cleanup_path: runtimeOptions.cleanup_warning_path ?? null,
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

function rejectUnsupportedAuthMode(options = {}) {
  if (options["auth-mode"] !== undefined) {
    fail("bad_args", "Kimi supports subscription auth only; --auth-mode is not supported.");
  }
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
    valueOptions: ["mode", "cwd", "scope-base", "scope-paths", "binary", "auth-mode"],
    booleanOptions: [],
  });
  rejectUnsupportedAuthMode(options);
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

  const profile = effectiveProfileForOptions(resolveProfile(mode), options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const scopePaths = parseScopePathsOption(options["scope-paths"]);
  const scopeBase = scopeBaseForOptions(options);
  let containment = null;
  let exitCode = 0;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase,
      scopePaths,
      workspaceRoot,
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
      scope_base: scopeBase,
      scope_paths: scopePaths,
      ...summary,
      ...preflightSafetyFields(),
      disclosure_note: preflightDisclosure("Kimi"),
    });
  } catch (e) {
    exitCode = 2;
    const error = isGitBinaryPolicyError(e) ? "git_binary_rejected" : "scope_failed";
    printJson({
      ok: false,
      event: "preflight",
      target: "kimi",
      mode,
      cwd,
      workspace_root: workspaceRoot,
      containment: profile.containment,
      scope: profile.scope,
      scope_base: scopeBase,
      scope_paths: scopePaths,
      error,
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
    valueOptions: [
      "mode", "model", "cwd", "binary", "scope-base", "scope-paths",
      "override-dispose", "timeout-ms", "max-steps-per-turn", "lifecycle-events", "auth-mode",
      "review-slot-disposition", "review-slot-waiver-artifact", "review-slot-override-artifact",
      "prompt-file",
    ],
    booleanOptions: ["background", "foreground", "allow-large-source-packet"],
  });
  rejectUnsupportedAuthMode(options);
  const mode = options.mode;
  if (!mode || !RUN_MODES.includes(mode)) {
    fail("bad_args", `--mode must be one of ${RUN_MODES.join("|")}; got ${JSON.stringify(mode)}`);
  }
  if (options.background && options.foreground) {
    fail("bad_args", "--background and --foreground are mutually exclusive");
  }
  const profile = effectiveProfileForOptions(resolveProfile(mode), options);
  const scopeBase = scopeBaseForOptions(options);
  const model = options.model ?? resolveModelForProfile(profile, loadModels()) ?? null;
  if (!model) fail("no_model", "no model resolved; pass --model or populate config/models.json");

  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const prompt = promptFromOptions(positionals, options);

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
  const reviewSlotPriorAttempts = collectPriorReviewSlotAttempts(workspaceRoot, jobId);
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
    scope_base: scopeBase,
    scope_paths: scopePaths,
    prompt_head: prompt.slice(0, 200),
    review_prompt_contract_version: profile.name === "rescue" ? null : REVIEW_PROMPT_CONTRACT_VERSION,
    review_prompt_provider: profile.name === "rescue" ? null : "Kimi",
    schema_spec: null,
    binary: options.binary ?? process.env.KIMI_BINARY ?? "kimi",
    run_kind: options.background ? "background" : "foreground",
    timeout_ms: timeoutMs,
    max_steps_per_turn: maxStepsPerTurn,
    ...subscriptionRouteFacts({ sourceBearing: modeSendsSelectedSource(mode) }),
    previous_source_attempt: latestSourcePacketPreviousAttempt(reviewSlotPriorAttempts),
    review_slot_prior_attempts: reviewSlotPriorAttempts,
    ...reviewSlotInvocationFields(options),
    ...sourcePacketOverrideInvocationFields(options),
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeRuntimeOptionsSidecar(workspaceRoot, jobId, {
    timeout_ms: timeoutMs,
    max_steps_per_turn: maxStepsPerTurn,
    previous_source_attempt: invocation.previous_source_attempt,
    review_slot_prior_attempts: invocation.review_slot_prior_attempts,
    review_slot_disposition: invocation.review_slot_disposition,
    review_slot_waiver_artifact: invocation.review_slot_waiver_artifact,
    review_slot_override_artifact: invocation.review_slot_override_artifact,
    source_packet_override_approved: invocation.source_packet_override_approved,
    source_packet_override_source: invocation.source_packet_override_source,
  });
  writeJobFile(workspaceRoot, jobId, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  const targetPrompt = scopedTargetPromptForOrExit(invocation, profile, prompt, lifecycleEvents);

  if (options.background) {
    const sourcePacketPreflight = sourcePacketPolicyPreflight(invocation, targetPrompt, null);
    if (sourcePacketPreflight) {
      const errorRecord = buildJobRecord(invocation, {
        exitCode: sourcePacketPreflight.exitCode,
        endedAt: sourcePacketPreflight.endedAt,
        parsed: sourcePacketPreflight.parsed,
        pidInfo: null,
        kimiSessionId: null,
        errorMessage: sourcePacketPreflight.errorMessage,
        reviewAuditManifest: sourcePacketPreflight.reviewAuditManifest,
        runtimeDiagnostics: sourcePacketPreflight.runtimeDiagnostics,
        ...redactionFieldsForPrompt(targetPrompt),
      }, []);
      writeJobFile(workspaceRoot, jobId, errorRecord);
      upsertJob(workspaceRoot, errorRecord);
      printLifecycleJson(errorRecord, lifecycleEvents);
      process.exit(2);
    }
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
  const profile = effectiveProfileForOptions(resolveProfile(invocation.mode_profile_name), {
    "scope-base": invocation.scope_base,
  });
  let containment = null;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
      workspaceRoot,
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
      gitStatusBefore = gitStatus(["status", "-s", "--untracked-files=all"], cwd, workspaceRoot);
      writeSidecar(workspaceRoot, jobId, "git-status-before.txt", gitStatusBefore);
    } catch (e) {
      if (isGitBinaryPolicyError(e)) throw e;
      mutations.push(mutationDetectionFailure(e));
    }
  }

  const resumeId = invocation.resume_chain && invocation.resume_chain.length > 0
    ? invocation.resume_chain[invocation.resume_chain.length - 1]
    : null;
  const launchFiles = createKimiReadOnlyLaunchFiles(profile);

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
    if (launchFiles) launchFiles.cleanup();
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

  const sourcePacketPreflight = sourcePacketPolicyPreflight(invocation, prompt, containment.path);
  if (sourcePacketPreflight) {
    if (neutralCwd) {
      try { rmSync(neutralCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (launchFiles) launchFiles.cleanup();
    if (disposeEffective) {
      try { containment.cleanup(); } catch { /* best-effort */ }
    }
    const errorRecord = buildJobRecord(invocation, {
      exitCode: sourcePacketPreflight.exitCode,
      endedAt: sourcePacketPreflight.endedAt,
      parsed: sourcePacketPreflight.parsed,
      pidInfo: null,
      kimiSessionId: null,
      errorMessage: sourcePacketPreflight.errorMessage,
      reviewAuditManifest: sourcePacketPreflight.reviewAuditManifest,
      runtimeDiagnostics: sourcePacketPreflight.runtimeDiagnostics,
      ...redactionFieldsForPrompt(prompt),
    }, mutations);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (foreground) printLifecycleJson(errorRecord, lifecycleEvents);
    process.exit(2);
  }

  const workloadAdmission = acquireProviderWorkloadLease({
    provider: invocation.target,
    jobId,
    cwd,
    sourceBearing: modeSendsSelectedSource(invocation.mode),
  });
  let workloadLease = null;
  if (workloadAdmission.ok) {
    workloadLease = workloadAdmission.lease;
  } else {
    const workloadPreflight = providerWorkloadBlockedExecution(workloadAdmission);
    workloadPreflight.reviewAuditManifest = reviewAuditManifest(invocation, prompt, containment.path, workloadPreflight);
    if (neutralCwd) {
      try { rmSync(neutralCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (launchFiles) launchFiles.cleanup();
    if (disposeEffective) {
      try { containment.cleanup(); } catch { /* best-effort */ }
    }
    const errorRecord = buildJobRecord(invocation, {
      exitCode: workloadPreflight.exitCode,
      endedAt: workloadPreflight.endedAt,
      parsed: workloadPreflight.parsed,
      pidInfo: null,
      kimiSessionId: null,
      errorMessage: workloadPreflight.errorMessage,
      reviewAuditManifest: workloadPreflight.reviewAuditManifest,
      runtimeDiagnostics: workloadPreflight.runtimeDiagnostics,
      ...redactionFieldsForPrompt(prompt),
    }, mutations);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (foreground) printLifecycleJson(errorRecord, lifecycleEvents);
    process.exit(2);
  }

  const preflightExecution = await kimiReadinessPreflight(invocation, profile);
  if (preflightExecution) {
    preflightExecution.reviewAuditManifest = reviewAuditManifest(invocation, prompt, containment.path, preflightExecution);
    const errorRecord = buildJobRecord(invocation, {
      exitCode: preflightExecution.exitCode,
      endedAt: preflightExecution.endedAt,
      parsed: preflightExecution.parsed,
      pidInfo: null,
      kimiSessionId: null,
      errorMessage: preflightExecution.errorMessage,
      signal: preflightExecution.signal ?? null,
      timedOut: preflightExecution.timedOut === true,
      reviewAuditManifest: preflightExecution.reviewAuditManifest,
      ...redactionFieldsForPrompt(prompt),
    }, mutations);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    for (const [name, contents] of [
      ["stdout.log", preflightExecution.stdout],
      ["stderr.log", preflightExecution.stderr],
    ]) {
      try { writeSidecar(workspaceRoot, jobId, name, contents); }
      catch (e) {
        process.stderr.write(`kimi-companion: warning: sidecar ${name} write failed: ${e.message}\n`);
      }
    }
    releaseProviderWorkloadLease(workloadLease);
    workloadLease = null;
    if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
    if (launchFiles) launchFiles.cleanup();
    if (disposeEffective) containment.cleanup();
    if (foreground) printLifecycleJson(errorRecord, lifecycleEvents);
    process.exit(2);
  }

  if (foreground && lifecycleEvents) {
    printLifecycleJson(
      externalReviewLaunchedEvent(invocation, externalReviewForInvocation(invocation)),
      lifecycleEvents,
    );
  }

  let execution;
  let executedInvocation = invocation;
  const stopHeartbeat = foreground ? startExternalReviewHeartbeat(invocation, lifecycleEvents) : () => {};
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
        ...readOnlyLaunchInputs(launchFiles),
        onSpawn: (pidInfo) => {
          const runningExecution = {
            status: "running",
            exitCode: null,
            parsed: null,
            pidInfo,
            kimiSessionId: null,
          };
          runningExecution.reviewAuditManifest = reviewAuditManifest(
            attemptInvocation,
            prompt,
            containment.path,
            runningExecution,
          );
          const runningRecord = buildJobRecord(attemptInvocation, runningExecution, mutations);
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
    releaseProviderWorkloadLease(workloadLease);
    workloadLease = null;
    const errorRecord = buildJobRecord(executedInvocation, {
      exitCode: null, parsed: null, pidInfo: null, kimiSessionId: null,
      errorMessage: e.message,
      ...redactionFieldsForPrompt(prompt),
    }, mutations);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
    if (launchFiles) launchFiles.cleanup();
    if (disposeEffective) containment.cleanup();
    stopHeartbeat();
    if (foreground) printLifecycleJson(errorRecord, lifecycleEvents);
    process.exit(2);
  } finally {
    stopHeartbeat();
    releaseProviderWorkloadLease(workloadLease);
    workloadLease = null;
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
      gitStatusAfter = gitStatus(["status", "-s", "--untracked-files=all"], cwd, workspaceRoot);
      try { writeSidecar(workspaceRoot, jobId, "git-status-after.txt", gitStatusAfter); }
      catch (e) { process.stderr.write(`kimi-companion: warning: sidecar git-status-after.txt write failed: ${e.message}\n`); }
    } catch (e) {
      if (isGitBinaryPolicyError(e)) throw e;
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
  execution.reviewAuditManifest = withMutationReviewFailure(
    reviewAuditManifest(executedInvocation, prompt, containment.path, execution),
    mutations,
  );

  // signal + timedOut feed classifyExecution: a SIGTERM/SIGKILL exit without
  // timedOut is an operator cancel → status="cancelled" (#16 follow-up 2);
  // timedOut wins so wall-clock kills classify as timeout failures.
  const finalRecord = buildJobRecord(executedInvocation, {
    exitCode: execution.exitCode,
    endedAt: execution.endedAt,
    parsed: execution.parsed,
    pidInfo: execution.pidInfo,
    kimiSessionId: execution.kimiSessionId,
    ...(cancelMarker ? { status: "cancelled" } : {}),
    signal: execution.signal ?? null,
    timedOut: execution.timedOut === true,
    reviewAuditManifest: execution.reviewAuditManifest,
    errorMessage: execution.errorMessage,
    runtimeDiagnostics: execution.runtimeDiagnostics ?? null,
    ...redactionFieldsForPrompt(prompt),
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
        endedAt: execution.endedAt,
        parsed: execution.parsed,
        pidInfo: execution.pidInfo,
        kimiSessionId: execution.kimiSessionId ?? null,
        errorMessage: `finalization_failed: ${detail}`,
        ...redactionFieldsForPrompt(prompt),
      }, mutations);
    } catch { /* defense in depth */ }
    if (fallbackRecord) {
      if (metaError) {
        // commitJobRecord aborted in writeJobFile → state was NOT mutated
        // either. Overwrite both sides with the fallback failed-record.
        try { writeJobFile(workspaceRoot, jobId, fallbackRecord); } catch { /* exhausted */ }
        try { upsertJob(workspaceRoot, fallbackRecord); } catch { /* exhausted */ }
      } else if (stateError) {
        // If lock acquisition timed out before meta write, the last durable
        // meta can still be running. Preserve terminal failure evidence
        // without clobbering an already-written terminal meta.
        maybeWriteFinalizationFallbackMeta(workspaceRoot, jobId, fallbackRecord);
        try { upsertJob(workspaceRoot, finalRecord); }
        catch {
          try { upsertJob(workspaceRoot, fallbackRecord); } catch { /* exhausted */ }
        }
      }
    }
    if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
    if (launchFiles) launchFiles.cleanup();
    if (containment.disposed && disposeEffective) {
      try { containment.cleanup(); } catch { /* best-effort */ }
    }
    fail("finalization_failed", detail, {
      error_code: (metaError ?? stateError)?.code ?? null,
    });
  }

  if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
  if (launchFiles) launchFiles.cleanup();
  if (containment.disposed && disposeEffective) containment.cleanup();
  if (foreground) printLifecycleJson(finalRecord, lifecycleEvents);
  process.exit(finalRecord.status === "completed" || finalRecord.status === "cancelled" ? 0 : 2);
}

function maybeWriteFinalizationFallbackMeta(workspaceRoot, jobId, fallbackRecord) {
  let current = null;
  try {
    current = JSON.parse(readFileSync(resolveJobFile(workspaceRoot, jobId), "utf8"));
  } catch {
    current = null;
  }
  if (current && current.status !== "queued" && current.status !== "running") return;
  try { writeJobFile(workspaceRoot, jobId, fallbackRecord); } catch { /* exhausted */ }
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
    valueOptions: [
      "job", "cwd", "model", "binary", "timeout-ms", "max-steps-per-turn", "lifecycle-events", "auth-mode",
      "review-slot-disposition", "review-slot-waiver-artifact", "review-slot-override-artifact",
      "prompt-file",
    ],
    booleanOptions: ["background", "foreground", "resend-confirmation-approved", "allow-large-source-packet"],
  });
  rejectUnsupportedAuthMode(options);
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
  const jobFile = resolveJobFile(workspaceRoot, options.job);
  if (!existsSync(jobFile)) {
    fail("not_found", `no meta.json for job ${options.job}`, continueNotFoundDetails(options.job, cwd, workspaceRoot));
  }
  try {
    prior = JSON.parse(readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }

  if (!CONTINUABLE_STATUSES.has(prior.status)) {
    fail("bad_state", `cannot continue job in status ${JSON.stringify(prior.status)}; wait for terminal status or cancel first`);
  }

  const prompt = promptFromOptions(positionals, options);

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
  const priorProfile = effectiveProfileForOptions(resolveProfile(priorModeName), {
    "scope-base": prior.scope_base,
  });
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
  const previousSourceAttempt = sourcePacketPreviousAttemptForContinuation(prior, priorRuntimeOptions);
  const resumeWithoutSourceResend =
    (
      sourcePacketCanResumeWithoutResendFromJobRecord(prior) ||
      sourcePacketCanResumeWithoutResendFromPreviousAttempt(previousSourceAttempt)
    ) && Boolean(priorKimiSessionId);
  const reviewSlotPriorAttempts = collectPriorReviewSlotAttempts(workspaceRoot, newJobId_);
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
    ...subscriptionRouteFacts({ sourceBearing: modeSendsSelectedSource(priorModeName) }),
    previous_source_attempt: previousSourceAttempt,
    review_slot_prior_attempts: reviewSlotPriorAttempts,
    resend_confirmation_approved: options["resend-confirmation-approved"] === true,
    resume_without_source_resend: resumeWithoutSourceResend,
    ...reviewSlotInvocationFields(options),
    ...sourcePacketOverrideInvocationFields(options),
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeRuntimeOptionsSidecar(workspaceRoot, newJobId_, {
    timeout_ms: timeoutMs,
    max_steps_per_turn: maxStepsPerTurn,
    previous_source_attempt: previousSourceAttempt,
    review_slot_prior_attempts: invocation.review_slot_prior_attempts,
    resend_confirmation_approved: options["resend-confirmation-approved"] === true,
    resume_without_source_resend: resumeWithoutSourceResend,
    review_slot_disposition: invocation.review_slot_disposition,
    review_slot_waiver_artifact: invocation.review_slot_waiver_artifact,
    review_slot_override_artifact: invocation.review_slot_override_artifact,
    source_packet_override_approved: invocation.source_packet_override_approved,
    source_packet_override_source: invocation.source_packet_override_source,
  });
  writeJobFile(workspaceRoot, newJobId_, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);
  const targetPrompt = scopedTargetPromptForOrExit(invocation, priorProfile, prompt, lifecycleEvents);

  if (options.background) {
    const sourcePacketPreflight = sourcePacketPolicyPreflight(invocation, targetPrompt, null);
    if (sourcePacketPreflight) {
      const errorRecord = buildJobRecord(invocation, {
        exitCode: sourcePacketPreflight.exitCode,
        endedAt: sourcePacketPreflight.endedAt,
        parsed: sourcePacketPreflight.parsed,
        pidInfo: null,
        kimiSessionId: null,
        errorMessage: sourcePacketPreflight.errorMessage,
        reviewAuditManifest: sourcePacketPreflight.reviewAuditManifest,
        runtimeDiagnostics: sourcePacketPreflight.runtimeDiagnostics,
        ...redactionFieldsForPrompt(targetPrompt),
      }, []);
      writeJobFile(workspaceRoot, newJobId_, errorRecord);
      upsertJob(workspaceRoot, errorRecord);
      printLifecycleJson(errorRecord, lifecycleEvents);
      process.exit(2);
    }
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
  const { options } = parseArgs(rest, { valueOptions: ["job", "job-id", "cwd"], booleanOptions: [] });
  const jobId = options.job ?? options["job-id"];
  if (!jobId) fail("bad_args", "--job <id> is required");
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot);
  let jobFile;
  try { jobFile = resolveJobFile(workspaceRoot, jobId); }
  catch (e) { fail("bad_args", e.message); }
  if (!existsSync(jobFile)) {
    fail("not_found", `no meta.json for job ${jobId}`, resultNotFoundDetails(jobId, cwd, workspaceRoot));
  }
  // PR #21 review MED 1: wrap the read so a directory-at-meta-path
  // (KIMI_MOCK_META_CONFLICT, or a half-finalized job) produces a
  // friendly error instead of an unhandled EISDIR stacktrace.
  let meta;
  try {
    meta = JSON.parse(readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("read_failed",
      `cannot read meta.json for job ${jobId}: ${e.message}`,
      { error_code: e.code ?? null });
  }
  printJson(meta);
}

const PING_AUTH_RE = /\b(auth(?:enticat\w*)?|login|credential\w*|oauth2?|unauthenticated|signin|sign-in)\b/i;
const PING_PROVIDER_API_KEY_ENV = ["KIMI_CODE_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"];

function ignoredApiKeyAuthFields() {
  return credentialNameDiagnostics(PING_PROVIDER_API_KEY_ENV);
}

function pingRouteAuthFields() {
  const route = selectProviderRoute({
    requestedRoute: "subscription",
    providerCapabilities: ROUTE_CAPABILITIES,
    sourceBearing: false,
  });
  return {
    auth_mode: "subscription",
    selected_auth_path: route.auth_path,
    auth_path: route.auth_path,
    billing_path: route.billing_path,
    selected_route: route.selected_route,
    fallback_reason: route.fallback_reason,
    source_send_approval_required: route.source_send_approval_required,
    source_send_approval_state: route.source_send_approval_state,
    ...ignoredApiKeyAuthFields(),
  };
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

async function cmdPing(rest, { readinessProfileName = "ping" } = {}) {
  const { options } = parseArgs(rest, { valueOptions: ["model", "binary", "timeout-ms", "auth-mode"], booleanOptions: [] });
  rejectUnsupportedAuthMode(options);
  const profile = resolveProfile(readinessProfileName);
  const modelsConfig = loadModels();
  const model = options.model ?? resolveModelForProfile(profile, modelsConfig);
  const modelCandidates = options.model
    ? [options.model]
    : resolveModelCandidatesForProfile(profile, modelsConfig);
  const candidates = modelCandidates.length > 0 ? modelCandidates : [model];
  const timeoutMs = parsePositiveTimeoutMs(options["timeout-ms"], DEFAULT_KIMI_PING_TIMEOUT_MS);
  const pingCwd = makeKimiPingCwd();
  const launchFiles = createKimiReadOnlyLaunchFiles(profile);
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
        cwd: pingCwd,
        binary: options.binary ?? process.env.KIMI_BINARY ?? "kimi",
        timeoutMs,
        ...readOnlyLaunchInputs(launchFiles),
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
    if (execution.parsed.ok) {
      const payload = { status: "ok", ...pingOkFields(modelFallback), ...pingRouteAuthFields(), model: selectedModel ?? null,
        session_id: execution.kimiSessionId, usage: execution.parsed.usage };
      printJson(payload);
      process.exit(0);
    }
    const failureText = pingFailureText(execution);
    const detail = pingFailureDetail(execution);
    if (execution?.timedOut === true) {
      printJson({ status: "transient_timeout", ...pingTimeoutFields(timeoutMs), ...pingRouteAuthFields(), detail });
      process.exit(2);
    }
    if (isKimiCodexSandboxBlocked(failureText)) {
      printJson({ status: "sandbox_blocked", ...pingSandboxBlockedFields(), ...pingRouteAuthFields(), exit_code: execution.exitCode, detail });
      process.exit(2);
    }
    if (/rate limit|429|overloaded/i.test(detail)) {
      printJson({ status: "rate_limited", ...pingRateLimitedFields(), ...pingRouteAuthFields(), detail });
      process.exit(2);
    }
    if (PING_AUTH_RE.test(detail)) {
      printJson({ status: "not_authed", ...pingNotAuthedFields(), detail,
        ...pingRouteAuthFields(),
        hint: "Run `kimi` interactively to complete OAuth. API-key env vars are ignored by plugin policy." });
      process.exit(2);
    }
    printJson({ status: "error", ...pingErrorFields(), ...pingRouteAuthFields(), exit_code: execution.exitCode, detail });
    process.exit(2);
  } catch (e) {
    if (e.code === "ENOENT") {
      printJson({ status: "not_found", ...pingNotFoundFields(),
        ...pingRouteAuthFields(),
        detail: "kimi binary not found on PATH (or KIMI_BINARY override)",
        install_url: "https://moonshotai.github.io/kimi-cli/" });
      process.exit(2);
    }
    const detail = e.message;
    if (isKimiCodexSandboxBlocked(detail)) {
      printJson({ status: "sandbox_blocked", ...pingSandboxBlockedFields(), ...pingRouteAuthFields(), detail });
      process.exit(2);
    }
    printJson({ status: "error", ...pingErrorFields(), ...pingRouteAuthFields(), detail });
    process.exit(2);
  } finally {
    if (launchFiles) launchFiles.cleanup();
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
        `kimi-companion: unverifiable — could not verify pid ${pidInfo.pid} ` +
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
    case "doctor": return cmdPing(rest, { readinessProfileName: "review" });
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
  if (isGitBinaryPolicyError(e)) {
    fail("git_binary_rejected", e.message);
  }
  process.stderr.write(`kimi-companion: unhandled: ${e.stack ?? e.message ?? e}\n`);
  process.exit(1);
});
