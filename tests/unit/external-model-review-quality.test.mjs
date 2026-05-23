import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasSubstantiveInvalidVerdictReason,
  reviewQualityFailureState,
} from "../../scripts/lib/external-model-review-quality.mjs";

test("reviewQualityFailureState only fails exact boolean failed_review_slot", () => {
  assert.equal(reviewQualityFailureState(null), null);
  assert.equal(reviewQualityFailureState({ failed_review_slot: false }), null);
  assert.equal(reviewQualityFailureState({ failed_review_slot: "true" }), null);
});

test("reviewQualityFailureState preserves companion review-quality reason formatting", () => {
  assert.deepEqual(
    reviewQualityFailureState({
      failed_review_slot: true,
      semantic_failure_reasons: ["shallow_output", "missing_verdict"],
    }),
    {
      status: "failed",
      error_code: "review_not_completed",
      error_message: "review_quality_failed:shallow_output,missing_verdict",
    },
  );

  assert.deepEqual(
    reviewQualityFailureState({ failed_review_slot: true }),
    {
      status: "failed",
      error_code: "review_not_completed",
      error_message: "review_quality_failed:review_quality_failed",
    },
  );
});

test("reviewQualityFailureState supports Grok and API legacy fallback messages", () => {
  assert.equal(
    reviewQualityFailureState(
      { failed_review_slot: true, semantic_failure_reasons: [] },
      { emptyReasonsMessage: "review_quality_failed:unknown" },
    ).error_message,
    "review_quality_failed:unknown",
  );

  assert.equal(
    reviewQualityFailureState(
      { failed_review_slot: true },
      { missingReasonsMessage: "review_quality_failed" },
    ).error_message,
    "review_quality_failed",
  );
});

test("hasSubstantiveInvalidVerdictReason covers invalid verdict reasons but not shallow output", () => {
  assert.equal(hasSubstantiveInvalidVerdictReason(["missing_verdict"]), true);
  assert.equal(hasSubstantiveInvalidVerdictReason(["bad_verdict"]), true);
  assert.equal(hasSubstantiveInvalidVerdictReason(["invalid_verdict"]), true);
  assert.equal(hasSubstantiveInvalidVerdictReason(["bad_verdict", "shallow_output"]), false);
  assert.equal(hasSubstantiveInvalidVerdictReason(["permission_blocked"]), false);
  assert.equal(hasSubstantiveInvalidVerdictReason(null), false);
});
