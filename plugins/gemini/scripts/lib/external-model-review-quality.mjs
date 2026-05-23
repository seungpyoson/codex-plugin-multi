export function reviewQualityFailureState(reviewQuality, options = {}) {
  if (reviewQuality?.failed_review_slot !== true) return null;

  const {
    missingReasonsMessage = "review_quality_failed:review_quality_failed",
    emptyReasonsMessage = "review_quality_failed:",
  } = options;
  const reasons = reviewQuality.semantic_failure_reasons;
  let errorMessage;
  if (Array.isArray(reasons) && reasons.length > 0) {
    errorMessage = `review_quality_failed:${reasons.join(",")}`;
  } else if (Array.isArray(reasons)) {
    errorMessage = emptyReasonsMessage;
  } else {
    errorMessage = missingReasonsMessage;
  }

  return {
    status: "failed",
    error_code: "review_not_completed",
    error_message: errorMessage,
  };
}

const SUBSTANTIVE_INVALID_VERDICT_REASONS = new Set([
  "missing_verdict",
  "bad_verdict",
  "invalid_verdict",
]);

export function hasSubstantiveInvalidVerdictReason(reasons) {
  if (!Array.isArray(reasons) || reasons.includes("shallow_output")) return false;
  return reasons.some((reason) => SUBSTANTIVE_INVALID_VERDICT_REASONS.has(String(reason)));
}
