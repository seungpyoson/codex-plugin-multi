// JobRecord schema (spec §21.3) — the ONE shape the companion durably
// persists, reads back, and returns to its callers.
//
// Historical defect: three different shapes existed.
//   1. baseRecord  — written at cmdRun entry (status: running/queued).
//   2. printJson   — foreground stdout, hand-assembled from execution vars.
//   3. finalRecord — persisted terminal meta, omitted result/denials/mutations.
//
// Consumers (cmdResult, result-handling skill) couldn't render a
// background job's result because the persisted record didn't carry it
// (finding #1/H1). The full prompt was persisted at 0644, leaking user
// context (finding #9). Skill docs described fields that never existed.
//
// This module replaces all three with ONE builder. Foreground and background
// paths converge through buildJobRecord. cmdResult reads the file verbatim.
//
// Design rules:
// - Frozen output — consumers cannot mutate in place.
// - No full `prompt` field, ever. `prompt_head` ≤200 chars is the only text.
// - Every EXPECTED_KEYS entry present on every record (nullable allowed).
// - Schema drift is a test failure (job-record.test.mjs asserts on keys AND
//   on claude-result-handling/SKILL.md mentioning each field).

import {
  SOURCE_CONTENT_TRANSMISSION,
  buildExternalReview,
  sourceContentTransmissionForExecution,
} from "./external-review.mjs";
import {
  buildExternalModelFailureDiagnostic,
  classifyCompanionExecution,
} from "./external-model-failure-core.mjs";
import { hasSubstantiveInvalidVerdictReason } from "./external-model-review-quality.mjs";
import { buildPacketRecovery } from "./provider-route-policy.mjs";
import { buildPrivacyRedactor, sanitizeProviderWorkloadDiagnostic } from "./privacy-redaction.mjs";
import { elapsedMs } from "./time.mjs";
import path from "node:path";

export const SCHEMA_VERSION = 10;

/**
 * Canonical JobRecord field list. Exported so tests can reference it and
 * the skill can be verified against it. The ORDER here matches the spec
 * §21.3 table for readability; persisted JSON does not rely on order.
 */
export const EXPECTED_KEYS = Object.freeze([
  // Identity (§21.1)
  "id",                   // legacy alias for job_id; kept until T8 can drop
  "job_id",
  "target",
  "parent_job_id",
  "claude_session_id",
  "gemini_session_id",
  "kimi_session_id",
  "resume_chain",
  "pid_info",

  // Invocation (§21.2)
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

  // Lifecycle
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

  // Result
  "result",
  "structured_output",
  "permission_denials",
  "mutations",
  "cost_usd",
  "usage",

  // Bookkeeping
  "schema_version",
]);

const EXPECTED_KEYS_SET = new Set(EXPECTED_KEYS);

function stringBytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function sourceStateNeedsPacketRecovery(sourceContentTransmission) {
  return sourceContentTransmission === SOURCE_CONTENT_TRANSMISSION.SENT
    || sourceContentTransmission === SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT
    || sourceContentTransmission === SOURCE_CONTENT_TRANSMISSION.UNKNOWN;
}

function packetRecoveryForRecordStatus(manifest, {
  status = null,
  errorCode = null,
  sourceContentTransmission = null,
  packetRecovery = null,
} = {}) {
  if (packetRecovery && typeof packetRecovery === "object") return packetRecovery;
  if (manifest?.packet_recovery && typeof manifest.packet_recovery === "object") return manifest.packet_recovery;
  if (status !== "stale" || errorCode !== "stale_active_job") return null;
  if (!sourceStateNeedsPacketRecovery(sourceContentTransmission)) return null;
  return buildPacketRecovery({
    reason: errorCode,
    sourcePacketPolicy: manifest?.source_packet_policy ?? null,
    providerCapabilities: {
      source_packet: { resume_without_resend_supported: false },
    },
    provider: manifest?.source_packet_policy?.provider ?? null,
    mode: manifest?.source_packet_policy?.mode ?? null,
    routeStep: manifest?.route_step ?? manifest?.source_packet_policy?.route_step ?? null,
    selectedSource: manifest?.selected_source ?? null,
    sourceContentTransmission,
  });
}

function auditManifestForRecordStatus(manifest, { status, errorCode, pidInfo, packetRecovery } = {}) {
  if (!manifest) return null;
  const inputPacketRecovery = packetRecovery
    && typeof packetRecovery === "object"
    ? packetRecovery
    : null;
  if (!manifest.review_quality || typeof status !== "string") {
    return inputPacketRecovery && !manifest.packet_recovery
      ? Object.freeze({ ...manifest, packet_recovery: inputPacketRecovery })
      : manifest;
  }
  const sourceContentTransmission = sourceContentTransmissionForExecution({ status, errorCode, pidInfo });
  const statusPacketRecovery = packetRecoveryForRecordStatus(manifest, {
    status,
    errorCode,
    sourceContentTransmission,
    packetRecovery: inputPacketRecovery,
  });
  const shouldBackfillPacketRecovery = statusPacketRecovery
    && typeof statusPacketRecovery === "object"
    && !manifest.packet_recovery;
  const failedReviewSlot = sourceContentTransmission === "sent"
    && !["completed", "queued", "running"].includes(status);
  const reviewSlot = manifest.review_slot && manifest.review_slot.source_state !== sourceContentTransmission
    ? Object.freeze({ ...manifest.review_slot, source_state: sourceContentTransmission })
    : manifest.review_slot;
  if (
    manifest.review_quality.failed_review_slot === failedReviewSlot
    && manifest.review_slot === reviewSlot
    && !shouldBackfillPacketRecovery
  ) {
    return manifest;
  }
  return Object.freeze({
    ...manifest,
    ...(shouldBackfillPacketRecovery ? { packet_recovery: statusPacketRecovery } : {}),
    source_content_transmission: sourceContentTransmission,
    review_quality: Object.freeze({
      ...manifest.review_quality,
      failed_review_slot: failedReviewSlot,
    }),
    review_slot: reviewSlot,
  });
}

function buildReviewMetadata(invocation, execution = null, parsed = null, endedAt = null, status = null, errorCode = null) {
  if (!invocation.review_prompt_contract_version) return null;
  return Object.freeze({
    prompt_contract_version: invocation.review_prompt_contract_version,
    prompt_provider: invocation.review_prompt_provider ?? invocation.target,
    scope: invocation.scope,
    scope_base: invocation.scope_base ?? null,
    scope_paths: invocation.scope_paths ?? null,
    raw_output: execution ? Object.freeze({
      stdout_bytes: stringBytes(execution.stdout),
      stderr_bytes: stringBytes(execution.stderr),
      parsed_ok: parsed?.ok ?? null,
      result_chars: typeof parsed?.result === "string" ? parsed.result.length : null,
      elapsed_ms: elapsedMs(invocation.started_at, endedAt),
    }) : null,
    audit_manifest: auditManifestForRecordStatus(execution?.reviewAuditManifest ?? null, {
      status,
      errorCode,
      pidInfo: execution?.pidInfo ?? null,
      packetRecovery: execution?.runtimeDiagnostics?.packet_recovery ?? null,
    }),
  });
}

export function externalReviewForInvocation(invocation, execution = null) {
  const { status, error_code } = classifyExecution(execution);
  const auditManifest = auditManifestForRecordStatus(execution?.reviewAuditManifest ?? null, {
    status,
    errorCode: error_code,
    pidInfo: execution?.pidInfo ?? null,
    packetRecovery: execution?.runtimeDiagnostics?.packet_recovery ?? null,
  });
  const sourceContentTransmission = invocation.resume_without_source_resend === true
    ? SOURCE_CONTENT_TRANSMISSION.NOT_SENT
    : sourceContentTransmissionForExecution({
      status,
      errorCode: error_code,
      pidInfo: execution?.pidInfo ?? null,
    });
  return buildExternalReview({
    invocation,
    sessionId: execution?.kimiSessionId ?? null,
    status,
    errorCode: error_code,
    sourceContentTransmission,
    reviewSlot: auditManifest?.review_slot ?? null,
  });
}

/**
 * Infer lifecycle status + error classification from the execution tuple.
 *
 * Status derivation (spec §21.3):
 *   queued      — no execution yet (background launch, pre-worker).
 *   completed   — exitCode === 0 AND parsed.ok === true.
 *   cancelled   — target CLI exited via SIGTERM/SIGKILL from an operator
 *                 cancel (#16 follow-up 2). timedOut runs are NOT cancelled.
 *   failed      — anything else.
 *
 * error_code classification:
 *   null            — completed or cancelled.
 *   git_binary_rejected — RELAY_GIT_BINARY policy rejected an override.
 *   scope_failed    — execution.errorMessage describes scope preparation refusal.
 *   spawn_failed    — execution.errorMessage set (spawn threw before Kimi ran).
 *   not_authed      — same-process auth/readiness preflight found no usable
 *                     Kimi login before selected source was sent.
 *   sandbox_blocked — same-process readiness preflight found Codex sandbox
 *                     denying access to Kimi state before selected source was sent.
 *   finalization_failed — errorMessage starts "finalization_failed:" — the
 *                         companion's executeRun fallback path (#16 follow-up 1).
 *                         Distinguished from spawn_failed so monitoring/automation
 *                         routing on error_code doesn't conflate disk/lock failures
 *                         with missing-binary errors. PR #21 review HIGH 1.
 *   step_limit_exceeded — Kimi emitted its non-JSON max-step exhaustion sentinel.
 *   usage_limited  — Kimi emitted a non-JSON quota/usage-limit failure.
 *   parse_error     — parsed.ok === false with reason starting "json_parse"/"empty_stdout".
 *   timeout         — execution.timedOut === true (companion's wall-clock kill).
 *   kimi_error    — exitCode !== 0 with parseable JSON from Kimi.
 *                     Also covers exitCode === 0 but parsed.ok === false with
 *                     is_error semantics.
 *   kimi_error      — catch-all target failure; should be rare when no
 *                     parsed diagnostic is available.
 */
export function classifyExecution(execution) {
  return classifyCompanionExecution(execution, { catchallCode: "kimi_error" });
}

function reviewQualityReasons(errorMessage) {
  const prefix = "review_quality_failed:";
  const text = String(errorMessage ?? "");
  if (!text.startsWith(prefix)) return [];
  return text.slice(prefix.length).split(",").map((reason) => reason.trim()).filter(Boolean);
}

function buildErrorDiagnostic(invocation, status, error_code, error_message) {
  const empty = {
    error_summary: null,
    error_cause: null,
    suggested_action: null,
    disclosure_note: null,
  };
  const target = targetDisplayName(invocation.target);
  if (status === "failed" && error_code === "usage_limited") {
    return {
      error_summary: `${target.displayName} Code CLI reported a subscription usage limit before returning a review result.`,
      error_cause:
        `${target.displayName} emitted a plain-text quota or billing-cycle failure instead of ` +
        "the requested stream-json payload. The companion recognized it as an account usage limit, not a JSON parse failure.",
      suggested_action:
        `Wait for ${target.displayName} quota to recover, reduce reviewer concurrency, or run ` +
        `\`${target.binaryName}\` interactively to inspect account usage. Track tier or credit changes separately from this review run.`,
      disclosure_note: null,
    };
  }
  if (status === "failed" && error_code === "not_authed") {
    return {
      error_summary: `${target.displayName} Code CLI is not logged in for this Codex session.`,
      error_cause:
        `The companion checked ${target.displayName} readiness in the same process before launching the review target, and the CLI did not report a usable login.`,
      suggested_action:
        `Run \`${target.binaryName} login\` in a normal terminal, rerun /kimi-setup, then retry the review.`,
      disclosure_note: null,
    };
  }
  if (status === "failed" && error_code === "sandbox_blocked") {
    return {
      error_summary: `${target.displayName} Code CLI is blocked by Codex sandbox access to Kimi state.`,
      error_cause:
        "The companion ran a same-process readiness preflight before sending selected source, and Kimi could not read or write its ~/.kimi-code state/log files from this Codex sandbox.",
      suggested_action:
        "Add ~/.kimi-code/logs to [sandbox_workspace_write].writable_roots in ~/.codex/config.toml, leave KIMI_CODE_HOME at its default, start a fresh Codex session, and rerun /kimi-setup. If the next denial is another ~/.kimi-code auth/config path, use ~/.kimi-code as the writable root.",
      disclosure_note: null,
    };
  }
  if (status === "failed" && error_code === "review_not_completed") {
    const reasons = reviewQualityReasons(error_message);
    if (invocation.target === "kimi" && hasSubstantiveInvalidVerdictReason(reasons)) {
      return {
        error_summary: "Kimi Code CLI returned review prose but omitted the required verdict marker.",
        error_cause:
          "Kimi returned substantive review prose after source was sent, but the review-quality audit requires an explicit verdict marker before the slot can count as completed.",
        suggested_action:
          "Treat this Kimi slot as failed. Do not automatically resend selected source. " +
          "Retry by narrowing the scope, sharding the source packet, relaying the prompt to another ready reviewer, " +
          "or running interactive Kimi and ensuring the first line is `Verdict: APPROVE`, `Verdict: REQUEST_CHANGES`, or `Verdict: NOT_REVIEWED`. " +
          "For direct API retries, require a fresh matching approval token whenever provider, mode, source packet, " +
          "prompt hash, scope resolution, request settings, auth path, or billing path changes.",
        disclosure_note: null,
      };
    }
    return {
      error_summary: `${target.displayName} Code CLI review did not complete as a usable external review.`,
      error_cause:
        "The target process returned successfully, but the review-quality audit marked the slot as failed. " +
        "Common causes are NOT REVIEWED output, permission/read denial, or shallow output.",
      suggested_action:
        "Treat this slot as failed, inspect runtime diagnostics and the raw result, then retry with a source packet the reviewer can inspect.",
      disclosure_note: null,
    };
  }
  if (status !== "failed" || error_code !== "scope_failed" || !error_message) {
    const sharedDiagnostic = status === "failed"
      ? buildExternalModelFailureDiagnostic(error_code, `${target.displayName} Code CLI`)
      : null;
    if (sharedDiagnostic) return sharedDiagnostic;
    return empty;
  }

  const message = String(error_message);
  const disclosure =
    `Scope preparation failed before ${target.displayName} launch. The target CLI was not spawned, ` +
    "so rejected scope content was not sent to the target CLI or external provider. " +
    "Branch-diff reduces scope, but any successful external review still sends selected source content to the target provider.";

  if (message.startsWith("unsafe_symlink:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "A symlink in the selected review scope resolves outside the source root, " +
        "so the companion refused to copy it into disposable containment.",
      suggested_action:
        "For committed branch changes, retry with adversarial-review/branch-diff and an explicit --scope-base <ref>. " +
        "For live working-tree review, remove or relocate the symlink, or use custom scope paths that exclude it.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_population_failed:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "The companion could not safely prepare the selected review scope. " +
        "For working-tree scope this often means gitignored files could not be evaluated or filesystem copying failed.",
      suggested_action:
        "Fix the working-tree/index issue and retry. For committed branch changes, retry with adversarial-review/branch-diff and an explicit --scope-base <ref>.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_base_invalid:") || message.startsWith("scope_base_missing:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "A missing, unsafe, or unresolvable git base ref prevented scope preparation. " +
        "Branch-diff scopes require a valid, fetchable base ref.",
      suggested_action:
        "To fix this, choose a valid base ref (a branch name, tag, remote ref, or commit SHA) and " +
        "pass it via `--scope-base <ref>`. Alternatively, use working-tree scope which " +
        "does not require a base ref. Option-shaped values beginning with '-' are rejected before git branch-diff runs.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_requires_git:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "The selected scope requires a git repository, but the workspace root is not " +
        "inside a git worktree.",
      suggested_action:
        "To resolve this: run from a git worktree or use a scope that supports " +
        "non-git directories (such as passing explicit --scope-paths).",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_requires_head:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "The selected scope requires at least one commit (HEAD), but the repository " +
        "has no commits yet.",
      suggested_action:
        "To fix this, create an initial commit before running git-object scopes such " +
        "as branch-diff. Use `git commit` to create the first commit.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_paths_required:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "The custom scope requires explicit paths; no scope paths were provided.",
      suggested_action:
        "To fix this: pass explicit --scope-paths <path> [<path> ...] before `--`. " +
        "For automatic scope detection, use working-tree or branch-diff scope instead.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_empty:")) {
    return {
      error_summary: "Review scope was empty before target launch.",
      error_cause:
        "The selected scope was empty and resolved to no reviewable files. Launching the target " +
        "would produce a misleading completed review with no useful source context.",
      suggested_action:
        "Branch-diff reviews committed HEAD-vs-base changes only; it does not include dirty working-tree edits. " +
        "For branch diffs, choose a different --scope-base <ref> if this branch should have committed changes, " +
        "or retry with --scope-base HEAD~1 to review the last commit. For uncommitted, already-merged, or no-diff branches, " +
        "retry with `--mode=custom-review` and explicit `--scope-paths <glob,...>` so source selection stays explicit.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("invalid_profile:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "This is an internal plugin or profile bug, not a user input error. " +
        "The review profile or plugin configuration is internally inconsistent.",
      suggested_action:
        "Please report this as a bug and include the raw error_message value " +
        "to help diagnose the misconfigured profile field.",
      disclosure_note: disclosure,
    };
  }

  return {
    error_summary: "Review scope was rejected before target launch.",
    error_cause: "The selected review scope could not be prepared safely.",
    suggested_action:
      "Check the raw error_message, fix the scope input, and retry. For committed branch changes, prefer branch-diff with an explicit --scope-base <ref>.",
    disclosure_note: disclosure,
  };
}

function targetDisplayName(target) {
  if (target === "claude") return { displayName: "Claude", binaryName: "claude" };
  return { displayName: "Kimi", binaryName: "kimi" };
}

/**
 * Assert the invocation object carries the fields buildJobRecord needs.
 * Catches legacy call sites that still pass a full `prompt` (§21.3.1
 * defense in depth — persisting a prompt must be impossible, not merely
 * "the builder happens not to read it").
 */
function assertInvocation(invocation) {
  if (!invocation || typeof invocation !== "object") {
    throw new Error("buildJobRecord: invocation object required");
  }
  if ("prompt" in invocation) {
    throw new Error(
      "buildJobRecord: invocation must not carry a full `prompt` field; " +
      "spec §21.3.1 forbids persisting prompt text. Pass only prompt_head."
    );
  }
  for (const f of [
    "job_id", "target", "mode", "mode_profile_name", "model",
    "cwd", "workspace_root", "containment", "scope",
    "prompt_head", "binary", "started_at", "run_kind",
  ]) {
    if (!(f in invocation)) {
      throw new Error(`buildJobRecord: invocation missing required field "${f}"`);
    }
  }
}

function targetFromDenial(denial) {
  if (typeof denial === "string") return denial;
  if (!denial || typeof denial !== "object") return null;
  const toolInput = denial.tool_input && typeof denial.tool_input === "object"
    ? denial.tool_input
    : null;
  return denial.target
    ?? denial.path
    ?? denial.file_path
    ?? denial.file
    ?? toolInput?.target
    ?? toolInput?.path
    ?? toolInput?.file_path
    ?? toolInput?.file
    ?? null;
}

function toolFromDenial(denial) {
  if (!denial || typeof denial !== "object") return null;
  return denial.tool ?? denial.name ?? null;
}

function pathInside(base, target) {
  if (!base || !target || !path.isAbsolute(target)) {
    return { inside: null, relative: null };
  }
  const relative = path.relative(base, target);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return {
    inside,
    relative: inside ? (relative || ".") : null,
  };
}

function normalizeProviderAccountIdentity(input) {
  const identity = input?.provider_account_identity;
  if (!identity || typeof identity !== "object") return null;
  const provider = typeof identity.provider === "string" && /^[a-z0-9._-]+$/.test(identity.provider)
    ? identity.provider
    : null;
  const identitySource = typeof identity.identity_source === "string" && /^[a-z0-9._-]+$/.test(identity.identity_source)
    ? identity.identity_source
    : null;
  const identityFields = Array.isArray(identity.identity_fields)
    ? identity.identity_fields.filter((field) => typeof field === "string" && /^[a-z0-9._-]+$/.test(field))
    : [];
  const fingerprintValue = typeof identity.account_fingerprint?.value === "string" &&
    /^[a-f0-9]{64}$/i.test(identity.account_fingerprint.value)
    ? identity.account_fingerprint.value.toLowerCase()
    : null;
  if (!provider || !identitySource || !fingerprintValue) return null;
  return {
    provider,
    identity_source: identitySource,
    identity_fields: identityFields,
    account_fingerprint: {
      algorithm: "sha256",
      value: fingerprintValue,
    },
  };
}

function normalizeProviderWorkloadDiagnostic(input, redactText = (value) => value) {
  // §8/§9: a blocked provider-workload diagnostic is a disclosure surface — it carries
  // counts only ({active_count, limit}). The blocking job's holder identity
  // (job_id/provider/pid/host/cwd/lock_file) must never be persisted or returned: it is a
  // cross-job info-disclosure vector for source-bearing reviews, and belongs in debug logs only.
  return sanitizeProviderWorkloadDiagnostic(input, redactText);
}

function normalizeRuntimeDiagnostics(input, denials, redactText = (value) => value) {
  if (!input || typeof input !== "object") return null;
  const redactNullableText = (value) => value == null ? null : redactText(value);

  const addDir = typeof input.add_dir === "string" ? input.add_dir : null;
  const childCwd = typeof input.child_cwd === "string" ? input.child_cwd : null;
  const cleanupWarning = input.cleanup_warning === "runtime_options_persisted"
    ? input.cleanup_warning
    : null;
  const cleanupWarningPath = typeof input.cleanup_warning_path === "string"
    ? input.cleanup_warning_path
    : null;
  const scopePathMappings = Array.isArray(input.scope_path_mappings)
    ? input.scope_path_mappings.map((mapping) => ({
      original: typeof mapping?.original === "string" ? mapping.original : null,
      contained: typeof mapping?.contained === "string" ? mapping.contained : null,
      relative: typeof mapping?.relative === "string" ? mapping.relative : null,
      inside_add_dir: mapping?.inside_add_dir === true,
    }))
    : [];
  const permissionDenials = Array.isArray(denials)
    ? denials.map((denial) => {
      const target = targetFromDenial(denial);
      const { inside, relative } = pathInside(addDir, target);
      return {
        tool: redactNullableText(toolFromDenial(denial)),
        target: redactNullableText(target),
        inside_add_dir: inside,
        relative_to_add_dir: relative,
      };
    })
    : [];

  const out = {
    add_dir: addDir,
    child_cwd: childCwd,
    scope_path_mappings: scopePathMappings,
    permission_denials: permissionDenials,
  };
  if (cleanupWarning) {
    out.cleanup_warning = cleanupWarning;
    out.cleanup_warning_path = cleanupWarningPath;
  }
  if (input.source_packet_policy && typeof input.source_packet_policy === "object") {
    out.source_packet_policy = input.source_packet_policy;
  }
  if (input.packet_recovery && typeof input.packet_recovery === "object") {
    out.packet_recovery = input.packet_recovery;
  }
  const providerAccountIdentity = normalizeProviderAccountIdentity(input);
  if (providerAccountIdentity) out.provider_account_identity = providerAccountIdentity;
  const providerWorkload = normalizeProviderWorkloadDiagnostic(input.provider_workload, redactText);
  if (providerWorkload) out.provider_workload = providerWorkload;
  return out;
}

function sourceFileText(file) {
  const value = typeof file?.text === "string" || file?.text instanceof Uint8Array
    ? file.text
    : file?.content;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}

function hasSourceFileBodies(sourceFiles) {
  return Array.isArray(sourceFiles) && sourceFiles.length > 0 && sourceFiles.every((file) => {
    const text = sourceFileText(file);
    return typeof text === "string";
  });
}

function assertRequiredSourceRedaction(execution) {
  const redactionRequested = execution?.sourceRedactionRequired === true
    || Object.hasOwn(execution ?? {}, "sourceFilesForRedaction");
  if (redactionRequested && !hasSourceFileBodies(execution.sourceFilesForRedaction)) {
    throw new Error("source redaction unavailable: selected source bodies missing for required scan");
  }
}

function redactStructuredOutput(value, redactText) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactStructuredOutput(item, redactText));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redactText(key), redactStructuredOutput(item, redactText)]),
    );
  }
  return value ?? null;
}

/**
 * Build the single canonical JobRecord.
 *
 * Arguments:
 *   invocation — captured at cmdRun/cmdContinue entry BEFORE the run. Carries
 *                identity + invocation + prompt_head fields. Shape:
 *                  { job_id, target, parent_job_id?, resume_chain?,
 *                    mode_profile_name, mode, model, cwd, workspace_root,
 *                    containment, scope, dispose_effective?,
 *                    scope_base?, scope_paths?, prompt_head, schema_spec?,
 *                    binary, started_at }
 *
 *   execution  — null when writing the pre-run/queued record. Otherwise:
 *                  { exitCode, endedAt?, parsed: {ok, result?, structured?, denials?,
 *                                        costUsd?, usage?, reason?, error?},
 *                    claudeSessionId?, geminiSessionId?, kimiSessionId?, pidInfo,
 *                    errorMessage?, stdout?, stderr? }
 *
 *   mutations  — array of git-status line strings or
 *                mutation_detection_failed entries from T7.2's mutation
 *                detection. Empty array when not applicable.
 *
 * Returns a frozen object whose keys === EXPECTED_KEYS exactly.
 */
export function buildJobRecord(invocation, execution, mutations) {
  assertInvocation(invocation);
  if (!Array.isArray(mutations)) {
    throw new Error("buildJobRecord: mutations must be an array (empty ok)");
  }
  const { status, error_code, error_message } = classifyExecution(execution);
  const parsed = execution?.parsed ?? null;
  assertRequiredSourceRedaction(execution);
  const redactSensitiveText = buildPrivacyRedactor({
    sourceFiles: execution?.sourceFilesForRedaction ?? [],
  }).text;
  const redactedErrorMessage = error_message == null ? null : redactSensitiveText(error_message);
  const diagnostic = buildErrorDiagnostic(invocation, status, error_code, redactedErrorMessage);
  const endedAt = execution && status !== "running"
    ? (execution.endedAt ?? new Date().toISOString())
    : null;
  const permissionDenials = Array.isArray(parsed?.denials) ? parsed.denials : [];
  const redactedPermissionDenials = redactStructuredOutput(permissionDenials, redactSensitiveText);
  const cleanupDiagnostics = invocation.runtime_options_cleanup_warning
    ? {
      cleanup_warning: invocation.runtime_options_cleanup_warning,
      cleanup_warning_path: invocation.runtime_options_cleanup_path ?? null,
    }
    : null;
  const reviewMetadata = buildReviewMetadata(invocation, execution, parsed, endedAt, status, error_code);
  const manifestPacketRecovery = reviewMetadata?.audit_manifest?.packet_recovery ?? null;
  const runtimeDiagnosticsBase = execution?.runtimeDiagnostics ?? null;
  const runtimeDiagnosticsWithManifestRecovery = manifestPacketRecovery
    && typeof manifestPacketRecovery === "object"
    && !(runtimeDiagnosticsBase?.packet_recovery && typeof runtimeDiagnosticsBase.packet_recovery === "object")
    ? { ...(runtimeDiagnosticsBase ?? {}), packet_recovery: manifestPacketRecovery }
    : runtimeDiagnosticsBase;
  const runtimeDiagnosticsInput = cleanupDiagnostics
    ? { ...(runtimeDiagnosticsWithManifestRecovery ?? {}), ...cleanupDiagnostics }
    : runtimeDiagnosticsWithManifestRecovery;
  const runtimeDiagnostics = normalizeRuntimeDiagnostics(runtimeDiagnosticsInput, permissionDenials, redactSensitiveText);
  const record = {
    // Identity
    id: invocation.job_id,
    job_id: invocation.job_id,
    target: invocation.target,
    parent_job_id: invocation.parent_job_id ?? null,
    claude_session_id: execution?.claudeSessionId ?? null,
    gemini_session_id: execution?.geminiSessionId ?? null,
    kimi_session_id: execution?.kimiSessionId ?? null,
    resume_chain: Array.isArray(invocation.resume_chain)
      ? [...invocation.resume_chain]
      : [],
    pid_info: execution?.pidInfo ?? null,

    // Invocation
    mode: invocation.mode,
    mode_profile_name: invocation.mode_profile_name,
    model: invocation.model,
    cwd: invocation.cwd,
    workspace_root: invocation.workspace_root,
    containment: invocation.containment,
    scope: invocation.scope,
    dispose_effective: invocation.dispose_effective ?? false,
    scope_base: invocation.scope_base ?? null,
    scope_paths: invocation.scope_paths ?? null,
    prompt_head: invocation.prompt_head == null
      ? null
      : redactSensitiveText(invocation.prompt_head).slice(0, 200),
    review_metadata: reviewMetadata,
    schema_spec: invocation.schema_spec ?? null,
    binary: invocation.binary,

    // Lifecycle
    status,
    started_at: invocation.started_at,
    ended_at: endedAt,
    exit_code: execution?.exitCode ?? null,
    error_code,
    error_message: redactedErrorMessage,
    error_summary: diagnostic.error_summary,
    error_cause: diagnostic.error_cause,
    suggested_action: diagnostic.suggested_action,
    external_review: externalReviewForInvocation(invocation, execution),
    disclosure_note: diagnostic.disclosure_note,
    runtime_diagnostics: runtimeDiagnostics,

    // Result
    result: parsed?.result == null ? null : redactSensitiveText(parsed.result),
    structured_output: parsed?.structured == null ? null : redactStructuredOutput(parsed.structured, redactSensitiveText),
    permission_denials: redactedPermissionDenials,
    mutations: [...mutations],
    cost_usd: parsed?.costUsd ?? null,
    usage: parsed?.usage ?? null,

    // Bookkeeping
    schema_version: SCHEMA_VERSION,
  };

  // Defensive: verify EXACT key set before returning. If future callers add a
  // stray field, this catches it early rather than silently drifting.
  const keys = Object.keys(record);
  if (keys.length !== EXPECTED_KEYS.length) {
    const extras = keys.filter((k) => !EXPECTED_KEYS_SET.has(k));
    const missing = EXPECTED_KEYS.filter((k) => !keys.includes(k));
    throw new Error(
      `buildJobRecord: key set drift. extras=${JSON.stringify(extras)} ` +
      `missing=${JSON.stringify(missing)}`
    );
  }
  return Object.freeze(record);
}
