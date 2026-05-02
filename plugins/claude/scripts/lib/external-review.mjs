export const PROVIDER_NAMES = Object.freeze({
  claude: "Claude Code",
  gemini: "Gemini CLI",
  kimi: "Kimi Code CLI",
});

export function providerDisplayName(target) {
  return PROVIDER_NAMES[target] ?? target;
}

export function externalReviewDisclosure(provider, status, errorCode) {
  if (status === "queued" || status === "running") {
    return `Selected source content may be sent to ${provider} for external review.`;
  }
  if (status === "completed") {
    return `Selected source content was sent to ${provider} for external review.`;
  }
  if (errorCode === "scope_failed") {
    return `Selected source content was not sent to ${provider}; the review scope was rejected before the target process was started.`;
  }
  if (errorCode === "spawn_failed") {
    return `Selected source content was not sent to ${provider}; the target process was not spawned.`;
  }
  if (targetProcessReceivedContent(errorCode)) {
    return `Selected source content was sent to ${provider} for external review, but the run ended before a clean result was produced.`;
  }
  if (status === "stale") {
    return `Selected source content may have been sent to ${provider}; the background worker became stale before completion.`;
  }
  return `Selected source content may have been sent to ${provider}; the run ended before a clean result was produced.`;
}

function targetProcessReceivedContent(errorCode) {
  return new Set([
    "claude_error",
    "gemini_error",
    "kimi_error",
    "parse_error",
    "finalization_failed",
    "timeout",
  ]).has(errorCode);
}

export function buildExternalReview({ invocation, sessionId = null, status, errorCode }) {
  const provider = providerDisplayName(invocation.target);
  return Object.freeze({
    marker: "EXTERNAL REVIEW",
    provider,
    run_kind: invocation.run_kind ?? "foreground",
    job_id: invocation.job_id,
    session_id: sessionId,
    parent_job_id: invocation.parent_job_id ?? null,
    mode: invocation.mode,
    scope: invocation.scope,
    scope_base: invocation.scope_base ?? null,
    scope_paths: invocation.scope_paths ?? null,
    disclosure: externalReviewDisclosure(provider, status, errorCode),
  });
}
