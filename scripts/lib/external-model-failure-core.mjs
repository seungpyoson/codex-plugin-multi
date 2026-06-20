import { externalModelFailureClass } from "./external-model-failure-catalog.mjs";
import { reviewQualityFailureState } from "./external-model-review-quality.mjs";
import { PROVIDER_WORKLOAD_BLOCKED_CODE } from "./review-workload.mjs";

const CANCEL_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);
const FINALIZATION_FAILED_PREFIX = "finalization_failed:";
const APPROVAL_REQUIRED_PREFIX = "approval_required:";
const SOURCE_PACKET_TOO_LARGE_PREFIX = "source_packet_too_large:";
const RESEND_CONFIRMATION_REQUIRED_PREFIX = "resend_confirmation_required:";
const PROVIDER_WORKLOAD_BLOCKED_PREFIX = `${PROVIDER_WORKLOAD_BLOCKED_CODE}:`;
const GIT_BINARY_POLICY_PREFIX = "RELAY_GIT_BINARY ";
const NOT_AUTHED_PREFIX = "not_authed:";
const SANDBOX_BLOCKED_PREFIX = "sandbox_blocked:";
const REVIEW_SLOT_POLICY_ERROR_CODES = new Set([
  "review_slot_disposition_required",
  "review_slot_override_artifact_required",
  "review_slot_waiver_artifact_required",
  "retry_disposition_not_valid_for_third_attempt",
  "third_same_packet_retry_requires_disposition",
]);
const SCOPE_FAILURE_PREFIXES = [
  "unsafe_symlink:",
  "scope_population_failed:",
  "scope_base_invalid:",
  "scope_base_missing:",
  "scope_requires_git:",
  "scope_requires_head:",
  "scope_paths_required:",
  "scope_empty:",
  "invalid_profile:",
];
const SIGNAL_LIKE_EXIT_CODES = new Set([130, 137, 143]);
const SIGNAL_MASKED_PARSE_REASONS = new Set(["empty_stdout", "json_parse_error"]);

export function classifySignalLikeExit(execution) {
  if (!execution || execution.timedOut === true) return null;
  if (!SIGNAL_LIKE_EXIT_CODES.has(Number(execution.exitCode))) return null;
  if (!hasSpawnedProcessEvidence(execution)) return null;

  const parsed = execution.parsed ?? null;
  if (hasValidParsedReviewPayload(parsed)) {
    const reviewQualityState = reviewQualityFailureState(execution.reviewAuditManifest?.review_quality);
    if (reviewQualityState) return reviewQualityState;
    return { status: "completed", error_code: null, error_message: null };
  }

  if (parsed?.ok === false && isSignalMaskedParseFailure(parsed)) {
    return {
      status: "failed",
      error_code: "interrupted",
      error_message: parsed.error ?? parsed.reason ?? `exit_code:${execution.exitCode}`,
    };
  }
  if (parsed === null) {
    return {
      status: "failed",
      error_code: "interrupted",
      error_message: `exit_code:${execution.exitCode}`,
    };
  }

  return null;
}

export function classifyCompanionLifecycleState(execution) {
  if (!execution) {
    return {
      status: "queued",
      error_code: null,
      error_message: null,
    };
  }
  if (execution.status === "running") {
    return {
      status: "running",
      error_code: null,
      error_message: null,
    };
  }
  if (execution.status === "cancelled") {
    return {
      status: "cancelled",
      error_code: null,
      error_message: null,
    };
  }
  if (execution.status === "stale") {
    return {
      status: "stale",
      error_code: "stale_active_job",
      error_message: execution.errorMessage ?? "stale_active_job",
    };
  }
  return null;
}

export function classifyCompanionErrorMessage(message, options = {}) {
  if (!message) return null;
  const providerState = options.classifyProviderErrorMessage?.(message) ?? null;
  if (providerState) return providerState;

  const text = String(message);
  if (text.startsWith(NOT_AUTHED_PREFIX)) {
    return {
      status: "failed",
      error_code: "not_authed",
      error_message: text.slice(NOT_AUTHED_PREFIX.length).trim(),
    };
  }
  if (text.startsWith(SANDBOX_BLOCKED_PREFIX)) {
    return {
      status: "failed",
      error_code: "sandbox_blocked",
      error_message: text.slice(SANDBOX_BLOCKED_PREFIX.length).trim(),
    };
  }
  if (text.startsWith(APPROVAL_REQUIRED_PREFIX)) {
    return {
      status: "failed",
      error_code: "approval_required",
      error_message: text.slice(APPROVAL_REQUIRED_PREFIX.length).trim(),
    };
  }
  if (text.startsWith(SOURCE_PACKET_TOO_LARGE_PREFIX)) {
    return {
      status: "failed",
      error_code: "source_packet_too_large",
      error_message: text.slice(SOURCE_PACKET_TOO_LARGE_PREFIX.length).trim(),
    };
  }
  if (text.startsWith(RESEND_CONFIRMATION_REQUIRED_PREFIX)) {
    return {
      status: "failed",
      error_code: "resend_confirmation_required",
      error_message: text.slice(RESEND_CONFIRMATION_REQUIRED_PREFIX.length).trim(),
    };
  }
  if (text.startsWith(PROVIDER_WORKLOAD_BLOCKED_PREFIX)) {
    return {
      status: "failed",
      error_code: PROVIDER_WORKLOAD_BLOCKED_CODE,
      error_message: text.slice(PROVIDER_WORKLOAD_BLOCKED_PREFIX.length).trim(),
    };
  }
  for (const errorCode of REVIEW_SLOT_POLICY_ERROR_CODES) {
    const prefix = `${errorCode}:`;
    if (text.startsWith(prefix)) {
      return {
        status: "failed",
        error_code: errorCode,
        error_message: text.slice(prefix.length).trim(),
      };
    }
  }
  if (text.startsWith(GIT_BINARY_POLICY_PREFIX)) {
    return {
      status: "failed",
      error_code: "git_binary_rejected",
      error_message: message,
    };
  }
  if (isScopeFailure(message)) {
    return {
      status: "failed",
      error_code: "scope_failed",
      error_message: message,
    };
  }
  const isFinalization = text.startsWith(FINALIZATION_FAILED_PREFIX);
  const genericErrorCode = options.genericErrorCode ?? "spawn_failed";
  return {
    status: "failed",
    error_code: isFinalization ? "finalization_failed" : genericErrorCode,
    error_message: message,
  };
}

export function classifyCommonParsedFailure(parsed) {
  const reason = parsed?.reason ?? null;
  if (reason === "step_limit_exceeded") {
    return {
      status: "failed",
      error_code: "step_limit_exceeded",
      error_message: parsed.error ?? reason,
    };
  }
  if (reason === "prompt_too_large") {
    return {
      status: "failed",
      error_code: "prompt_too_large",
      error_message: parsed.error ?? reason,
    };
  }
  if (reason === "cli_contract_mismatch") {
    return {
      status: "failed",
      error_code: "cli_contract_mismatch",
      error_message: parsed.error ?? reason,
    };
  }
  // Pre-target readiness failures whose reason is itself a member of
  // PRE_TARGET_NOT_SENT_ERROR_CODES — the source never reached the model. Surface
  // the reason verbatim as the error_code so source-content-transmission resolves
  // NOT_SENT, instead of falling through to the catch-all provider error code
  // (which is classified content-received and would falsely disclose "source sent").
  if (reason === "not_authed" || reason === "model_unavailable" || reason === "acp_protocol_error") {
    return {
      status: "failed",
      error_code: reason,
      error_message: parsed.error ?? reason,
    };
  }
  if (reason === "usage_limited") {
    return {
      status: "failed",
      error_code: "usage_limited",
      error_message: parsed.error ?? reason,
    };
  }
  if (reason === PROVIDER_WORKLOAD_BLOCKED_CODE) {
    return {
      status: "failed",
      error_code: PROVIDER_WORKLOAD_BLOCKED_CODE,
      error_message: parsed.error ?? reason,
    };
  }
  if (reason === "json_parse_error" || reason === "empty_stdout") {
    return {
      status: "failed",
      error_code: "parse_error",
      error_message: parsed.error ?? reason,
    };
  }
  return null;
}

export function classifyCompanionExecution(execution, options = {}) {
  const catchallCode = options.catchallCode ?? "provider_error";
  const lifecycleState = classifyCompanionLifecycleState(execution);
  if (lifecycleState) return lifecycleState;

  const errorMessageState = classifyCompanionErrorMessage(execution.errorMessage, {
    ...options,
    genericErrorCode: hasSpawnedProcessEvidence(execution) ? catchallCode : "spawn_failed",
  });
  if (errorMessageState) return errorMessageState;

  if (execution.timedOut === true) {
    return {
      status: "failed",
      error_code: "timeout",
      error_message: "target CLI exceeded the configured timeoutMs",
    };
  }
  if (CANCEL_SIGNALS.has(execution.signal ?? "")) {
    return {
      status: "cancelled",
      error_code: null,
      error_message: null,
    };
  }
  const signalLikeState = classifySignalLikeExit(execution);
  if (signalLikeState) return signalLikeState;

  const parsed = execution.parsed ?? null;
  if (execution.exitCode === 0 && parsed && parsed.ok === true) {
    const reviewQualityState = reviewQualityFailureState(execution.reviewAuditManifest?.review_quality);
    if (reviewQualityState) return reviewQualityState;
    return { status: "completed", error_code: null, error_message: null };
  }
  if (parsed && parsed.ok === false) {
    const commonState = classifyCommonParsedFailure(parsed);
    if (commonState) return commonState;
    const providerState = options.classifyProviderParsedFailure?.({ execution, invocation: options.invocation ?? null, parsed }) ?? null;
    if (providerState) return providerState;
    return {
      status: "failed",
      error_code: catchallCode,
      error_message: parsed.error ?? null,
    };
  }
  return {
    status: "failed",
    error_code: catchallCode,
    error_message: null,
  };
}

export function buildExternalModelFailureDiagnostic(errorCode, targetName) {
  const failureClass = externalModelFailureClass(errorCode);
  if (!failureClass) return null;
  return {
    error_summary: failureClass.error_summary.replace("The external model", targetName),
    error_cause: failureClass.error_cause,
    suggested_action: suggestedActionForFailure(failureClass, targetName),
    disclosure_note: null,
  };
}

function suggestedActionForFailure(failureClass, targetName) {
  if (
    failureClass.error_code === "oauth_inference_rejected" &&
    /\bClaude Code\b/i.test(String(targetName ?? ""))
  ) {
    return "Treat this review slot as failed before usable review output. Run `claude auth login` in a normal terminal, rerun setup, then verify OAuth-only `claude -p` inference works before retrying.";
  }
  return failureClass.suggested_action;
}

function hasSpawnedProcessEvidence(execution) {
  return Boolean(execution.pidInfo) || execution.started === true || execution.phase === "post_spawn";
}

function hasValidParsedReviewPayload(parsed) {
  if (!parsed || parsed.ok !== true) return false;
  if (typeof parsed.result === "string") return true;
  return parsed.structured != null;
}

function isSignalMaskedParseFailure(parsed) {
  const reason = parsed.reason ?? "";
  if (SIGNAL_MASKED_PARSE_REASONS.has(reason)) return true;
  return reason === "" && parsed.result == null && parsed.structured == null;
}

function isScopeFailure(message) {
  return SCOPE_FAILURE_PREFIXES.some((prefix) => String(message ?? "").startsWith(prefix));
}
