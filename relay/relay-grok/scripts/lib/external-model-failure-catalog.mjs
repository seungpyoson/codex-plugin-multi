export const EXTERNAL_MODEL_FAILURE_CLASSES = Object.freeze([
  Object.freeze({
    error_code: "interrupted",
    category: "process_exit",
    error_cause: "signal_like_exit",
    error_summary: "The external model process exited with a signal-like status before returning a clean review result.",
    suggested_action:
      "Treat this review slot as failed. Inspect runtime diagnostics, then retry with the same source packet after confirming the external model CLI is responsive.",
  }),
  Object.freeze({
    error_code: "step_limit_exceeded",
    category: "runtime_budget",
    error_cause: "step_limit_exhausted",
    error_summary: "The external model exhausted its configured step limit before returning a review result.",
    suggested_action:
      "Treat this review slot as failed. Do not automatically resend selected source. " +
      "Retry with a higher step budget, or rerun with a narrower scope/source packet. " +
      "For direct API retries, require a fresh matching approval token whenever provider, mode, source packet, " +
      "prompt hash, scope resolution, request settings, auth path, billing path, selected route, or fallback reason changes.",
  }),
  Object.freeze({
    error_code: "timeout",
    category: "runtime_budget",
    error_cause: "wall_clock_timeout",
    error_summary: "The external model timed out before returning a review result.",
    suggested_action:
      "Treat this review slot as failed. Do not automatically resend selected source. " +
      "Retry after checking provider service health, reducing reviewer concurrency, increasing the timeout, " +
      "or narrowing the scope/source packet. For direct API retries, require a fresh matching approval token whenever " +
      "provider, mode, source packet, prompt hash, scope resolution, request settings, auth path, billing path, " +
      "selected route, or fallback reason changes.",
  }),
  Object.freeze({
    error_code: "source_packet_too_large",
    category: "source_packet_policy",
    error_cause: "pre_send_source_packet_budget",
    error_summary: "The external model review was blocked before launch because the selected source packet exceeded the shared source packet budget.",
    suggested_action:
      "Treat this review slot as not launched. Narrow or shard the source packet, or record an explicit capability fact that raises the source packet budget before retrying.",
  }),
  Object.freeze({
    error_code: "prompt_too_large",
    category: "source_packet_policy",
    error_cause: "pre_send_prompt_arg_budget",
    error_summary: "The external model review was blocked before launch because the rendered prompt exceeded the CLI argument-size limit.",
    suggested_action:
      "Treat this review slot as not launched. Narrow or shard the source packet so the rendered prompt fits within the CLI argument-size limit, then retry. The selected source was not sent.",
  }),
  Object.freeze({
    error_code: "cli_contract_mismatch",
    category: "cli_contract",
    error_cause: "cli_command_surface_mismatch",
    error_summary: "The external model review was blocked before launch because the installed CLI does not support the command-surface flags the adapter emits.",
    suggested_action:
      "Treat this review slot as not launched. The selected source was not sent. Install or update the provider CLI to the supported command surface, then retry the same review scope.",
  }),
  Object.freeze({
    error_code: "model_unavailable",
    category: "provider_availability",
    error_cause: "requested_model_not_offered",
    error_summary: "The external model review was blocked before launch because the provider did not offer the requested model.",
    suggested_action:
      "Treat this review slot as not launched. The selected source was not sent. No silent model substitution is performed: configure a model the provider currently offers, then retry the same review scope.",
  }),
  Object.freeze({
    error_code: "acp_protocol_error",
    category: "transport",
    error_cause: "acp_handshake_failed_before_prompt",
    error_summary: "The external model review was blocked before launch because the ACP stdio handshake failed before the prompt was sent.",
    suggested_action:
      "Treat this review slot as not launched. The selected source was not sent. Inspect the provider CLI stderr/diagnostics, confirm the installed CLI speaks the expected ACP protocol version, then retry the same review scope.",
  }),
  Object.freeze({
    error_code: "resend_confirmation_required",
    category: "source_packet_policy",
    error_cause: "pre_send_resend_gate",
    error_summary: "The external model review was blocked before launch because it would resend a previously sent source packet after a failed reviewer slot.",
    suggested_action:
      "Treat the previous reviewer slot as failed. Do not automatically resend selected source without explicit resend confirmation or a narrowed source packet.",
  }),
  Object.freeze({
    error_code: "git_binary_rejected",
    category: "scope_preflight",
    error_cause: "untrusted_git_binary",
    error_summary: "The external model review was blocked by an unsafe git binary override before launch.",
    suggested_action:
      "Unset RELAY_GIT_BINARY or point it to a trusted git executable, then retry the same review scope.",
  }),
  Object.freeze({
    error_code: "finalization_failed",
    category: "job_record",
    error_cause: "job_finalization_failed",
    error_summary: "The external model review finished, but the companion failed while finalizing the job record.",
    suggested_action:
      "Treat this slot as failed. Inspect the job directory and filesystem permissions, then retry after fixing the finalization error.",
  }),
  Object.freeze({
    error_code: "spawn_failed",
    category: "target_launch",
    error_cause: "target_process_not_spawned",
    error_summary: "The external model CLI was not spawned.",
    suggested_action:
      "Treat this slot as failed. Check that the provider CLI is installed, on PATH, and executable, then rerun setup before retrying.",
  }),
  Object.freeze({
    error_code: "parse_error",
    category: "target_output",
    error_cause: "unparseable_or_empty_output",
    error_summary: "The external model returned empty or unparseable output instead of a clean review payload.",
    suggested_action:
      "Treat this slot as failed. Inspect the raw result and runtime diagnostics, then retry with a narrower source packet or run the provider CLI interactively.",
  }),
  Object.freeze({
    error_code: "scope_failed",
    category: "scope_preflight",
    error_cause: "scope_resolution_failed",
    error_summary: "The external model review scope was rejected before provider launch.",
    suggested_action:
      "Treat this review slot as not launched. Fix the scope, base ref, explicit paths, symlink, or prompt-size issue, then retry.",
  }),
  Object.freeze({
    error_code: "oauth_inference_rejected",
    category: "auth",
    error_cause: "oauth_inference_rejected",
    error_summary: "The external model OAuth/subscription inference path was rejected before returning a review result.",
    suggested_action:
      "Treat this review slot as failed before usable review output. Refresh the provider subscription/OAuth login in a normal terminal, rerun setup, then retry.",
  }),
  Object.freeze({
    error_code: "usage_limited",
    category: "cost_quota",
    error_cause: "usage_or_quota_limited",
    error_summary: "The external model provider reported a quota, usage-tier, billing, or credit limit.",
    suggested_action:
      "Treat this review slot as failed. Do not automatically resend selected source. Wait for usage to recover, reduce concurrency, or inspect the provider account manually. Any billing or tier change requires explicit user approval.",
  }),
  Object.freeze({
    error_code: "usage_limited_preflight",
    category: "cost_quota",
    error_cause: "pre_send_usage_or_quota_limited",
    error_summary: "The external model review was blocked before launch because the provider reported a quota, usage-tier, billing, or credit limit before the review prompt was sent.",
    suggested_action:
      "Treat this review slot as not launched. The selected source was not sent. Wait for usage to recover, reduce concurrency, or inspect the provider account manually. Any billing or tier change requires explicit user approval.",
  }),
  Object.freeze({
    error_code: "provider_workload_blocked",
    category: "workload_admission",
    error_cause: "same_provider_source_bearing_job_active",
    error_summary: "The external model review was blocked before launch because another source-bearing job for the same provider is already active.",
    suggested_action:
      "Treat this review slot as not launched. Wait for the active same-provider source-bearing job to finish, then retry the same source packet.",
  }),
  Object.freeze({
    error_code: "provider_unavailable",
    category: "provider_availability",
    error_cause: "provider_unavailable",
    error_summary: "The external model provider or API endpoint was unavailable.",
    suggested_action:
      "Treat this review slot as failed. Check network and provider status, then retry later or switch to another explicitly selected reviewer.",
  }),
  Object.freeze({
    error_code: "tunnel_unavailable",
    category: "transport",
    error_cause: "tunnel_unavailable",
    error_summary: "The external model tunnel transport was unavailable before a usable review could run.",
    suggested_action:
      "Treat this review slot as failed. Inspect tunnel diagnostics, repair or restart the local tunnel/session transport, then retry.",
  }),
  Object.freeze({
    error_code: "session_expired",
    category: "auth",
    error_cause: "session_expired",
    error_summary: "The external model session expired before a usable review could run.",
    suggested_action:
      "Treat this review slot as failed. Refresh the provider session in the owning browser or CLI profile, rerun setup, then retry.",
  }),
  Object.freeze({
    error_code: "privacy_persistence",
    category: "privacy_cleanup",
    error_cause: "source_or_prompt_artifact_persisted",
    error_summary: "The external model review could not prove prompt/source artifact cleanup.",
    suggested_action:
      "Treat this review slot as failed closed. Inspect runtime diagnostics, remove any reported prompt/source artifacts if present, and retry only after cleanup is proven.",
  }),
  Object.freeze({
    error_code: "review_not_completed",
    category: "review_quality",
    error_cause: "review_quality_failed",
    error_summary: "The external model did not complete as a usable review slot.",
    suggested_action:
      "Treat this review slot as failed. Inspect review-quality reasons and raw result, then retry with a source packet the reviewer can inspect and answer with the required verdict.",
  }),
  Object.freeze({
    error_code: "provider_error",
    category: "target_runtime",
    error_cause: "provider_runtime_failure",
    error_summary: "The external model provider failed before returning a clean review result.",
    suggested_action:
      "Treat this slot as failed. Inspect the provider-specific error message and runtime diagnostics, then retry after the provider is healthy.",
  }),
  Object.freeze({
    error_code: "claude_error",
    category: "target_runtime",
    error_cause: "provider_runtime_failure",
    error_summary: "The external model provider failed before returning a clean review result.",
    suggested_action:
      "Treat this Claude slot as failed. Inspect the raw result and runtime diagnostics, then retry after Claude Code is responsive.",
  }),
  Object.freeze({
    error_code: "gemini_error",
    category: "target_runtime",
    error_cause: "provider_runtime_failure",
    error_summary: "The external model provider failed before returning a clean review result.",
    suggested_action:
      "Treat this Gemini slot as failed. Inspect the raw result and runtime diagnostics, then retry after Gemini CLI is responsive.",
  }),
  Object.freeze({
    error_code: "kimi_error",
    category: "target_runtime",
    error_cause: "provider_runtime_failure",
    error_summary: "The external model provider failed before returning a clean review result.",
    suggested_action:
      "Treat this Kimi slot as failed. Inspect the raw result and runtime diagnostics, then retry after Kimi Code CLI is responsive.",
  }),
]);

const FAILURE_CLASS_BY_CODE = new Map(
  EXTERNAL_MODEL_FAILURE_CLASSES.map((entry) => [entry.error_code, entry]),
);

export function externalModelFailureClass(errorCode) {
  return FAILURE_CLASS_BY_CODE.get(errorCode) ?? null;
}
