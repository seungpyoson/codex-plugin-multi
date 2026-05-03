export const PROVIDER_NAMES = Object.freeze({
  claude: "Claude Code",
  gemini: "Gemini CLI",
  kimi: "Kimi Code CLI",
});

export function providerDisplayName(target) {
  return PROVIDER_NAMES[target] ?? target;
}

export const SOURCE_CONTENT_TRANSMISSION = Object.freeze({
  NOT_SENT: "not_sent",
  MAY_BE_SENT: "may_be_sent",
  SENT: "sent",
  UNKNOWN: "unknown",
});

const SOURCE_CONTENT_TRANSMISSION_VALUES = new Set(Object.values(SOURCE_CONTENT_TRANSMISSION));

export const EXTERNAL_REVIEW_KEYS = Object.freeze([
  "marker",
  "provider",
  "run_kind",
  "job_id",
  "session_id",
  "parent_job_id",
  "mode",
  "scope",
  "scope_base",
  "scope_paths",
  "source_content_transmission",
  "disclosure",
]);

const CONTENT_RECEIVED_ERROR_CODES = Object.freeze(new Set([
  "claude_error",
  "gemini_error",
  "kimi_error",
  "parse_error",
  "step_limit_exceeded",
  "finalization_failed",
  "timeout",
]));

const SENT_DISCLOSURE_BY_STATUS = Object.freeze({
  completed: (provider) => `Selected source content was sent to ${provider} for external review.`,
  running: (provider) => `Selected source content was sent to ${provider} for external review; the run is in progress.`,
  cancelled: (provider) => `Selected source content was sent to ${provider} for external review; the operator cancelled the run before it completed.`,
  stale: (provider) => `Selected source content was sent to ${provider} for external review; the run became stale before completion.`,
});

const NOT_SENT_DISCLOSURE_BY_STATUS = Object.freeze({
  cancelled: (provider) => `Selected source content was not sent to ${provider}; the operator cancelled the run before the target process was started.`,
});

const NOT_SENT_DISCLOSURE_BY_ERROR = Object.freeze({
  scope_failed: (provider) => `Selected source content was not sent to ${provider}; the review scope was rejected before the target process was started.`,
  spawn_failed: (provider) => `Selected source content was not sent to ${provider}; the target process was not spawned.`,
});

const UNKNOWN_DISCLOSURE_BY_STATUS = Object.freeze({
  stale: (provider) => `Selected source content may have been sent to ${provider}; the run became stale before completion.`,
});

export function externalReviewDisclosure(provider, status, sourceContentTransmission, errorCode = null) {
  switch (sourceContentTransmission) {
    case SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT:
      return `Selected source content may be sent to ${provider} for external review.`;
    case SOURCE_CONTENT_TRANSMISSION.SENT:
      return (SENT_DISCLOSURE_BY_STATUS[status] ?? sentWithoutCleanResult)(provider);
    case SOURCE_CONTENT_TRANSMISSION.NOT_SENT:
      return (NOT_SENT_DISCLOSURE_BY_STATUS[status]
        ?? NOT_SENT_DISCLOSURE_BY_ERROR[errorCode]
        ?? notSentTargetNotStarted)(provider);
    default:
      return (UNKNOWN_DISCLOSURE_BY_STATUS[status] ?? unknownWithoutCleanResult)(provider);
  }
}

function sentWithoutCleanResult(provider) {
  return `Selected source content was sent to ${provider} for external review, but the run ended before a clean result was produced.`;
}

function notSentTargetNotStarted(provider) {
  return `Selected source content was not sent to ${provider}; the target process was not started.`;
}

function unknownWithoutCleanResult(provider) {
  return `Selected source content may have been sent to ${provider}; the run ended before a clean result was produced.`;
}

export function sourceContentTransmissionForExecution({ status, errorCode, pidInfo }) {
  if (status === "queued") {
    return SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT;
  }
  if (status === "running") {
    return pidInfo ? SOURCE_CONTENT_TRANSMISSION.SENT : SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT;
  }
  if (status === "stale") {
    if (pidInfo) return SOURCE_CONTENT_TRANSMISSION.SENT;
    // A stale queued record without pid_info usually means the worker never
    // reached target spawn, but the running-record handoff after spawn is
    // best-effort. If that write failed, queued is the last durable status
    // even though selected content may have reached the target. Keep stale
    // no-pid cases conservative instead of claiming not_sent.
    return SOURCE_CONTENT_TRANSMISSION.UNKNOWN;
  }
  if (errorCode === "scope_failed" || errorCode === "spawn_failed") {
    return SOURCE_CONTENT_TRANSMISSION.NOT_SENT;
  }
  if (status === "cancelled") {
    return pidInfo ? SOURCE_CONTENT_TRANSMISSION.SENT : SOURCE_CONTENT_TRANSMISSION.NOT_SENT;
  }
  if (status === "completed" || targetProcessReceivedContent(errorCode)) {
    return SOURCE_CONTENT_TRANSMISSION.SENT;
  }
  return SOURCE_CONTENT_TRANSMISSION.UNKNOWN;
}

export function targetProcessReceivedContent(errorCode) {
  return CONTENT_RECEIVED_ERROR_CODES.has(errorCode);
}

export function buildExternalReview({ invocation, sessionId = null, status, errorCode = null, sourceContentTransmission }) {
  if (!SOURCE_CONTENT_TRANSMISSION_VALUES.has(sourceContentTransmission)) {
    throw new Error(`invalid sourceContentTransmission: ${String(sourceContentTransmission)}`);
  }
  const provider = providerDisplayName(invocation.target);
  const review = {
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
    source_content_transmission: sourceContentTransmission,
    disclosure: externalReviewDisclosure(provider, status, sourceContentTransmission, errorCode),
  };
  const keys = Object.keys(review);
  if (keys.length !== EXTERNAL_REVIEW_KEYS.length
      || keys.some((key, index) => key !== EXTERNAL_REVIEW_KEYS[index])) {
    throw new Error(`external_review keys drifted: ${keys.join(",")}`);
  }
  return Object.freeze(review);
}
