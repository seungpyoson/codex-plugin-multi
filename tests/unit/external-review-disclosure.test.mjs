// Exhaustive coverage of the external-review disclosure + source-transmission
// surface across every provider copy of the shared external-review.mjs. The
// disclosure maps hold one arrow function per (status × transmission × errorCode)
// branch; some are only reached by the full companion (smoke) path, so this unit
// test drives every branch directly to keep function coverage at 100% under the
// coverage gate (which skips smoke).

import { test } from "node:test";
import assert from "node:assert/strict";

const COPIES = [
  "../../plugins/api-reviewers/scripts/lib/external-review.mjs",
  "../../plugins/claude/scripts/lib/external-review.mjs",
  "../../plugins/gemini/scripts/lib/external-review.mjs",
  "../../plugins/grok/scripts/lib/external-review.mjs",
  "../../plugins/kimi/scripts/lib/external-review.mjs",
];

// Error codes that drive every NOT_SENT disclosure branch (the by-error map plus
// the inline special cases).
const NOT_SENT_CODES = [
  "approval_scope_changed", "cache_install", "cli_contract_mismatch", "preflight_stale",
  "prompt_too_large", "scope_failed", "spawn_failed", "oauth_inference_rejected",
  "source_packet_too_large", "resend_confirmation_required", "not_authed", "sandbox_blocked",
  "model_unavailable", "acp_protocol_error", "usage_limited_preflight", "some_unmapped_code",
];

for (const rel of COPIES) {
  const name = rel.split("/").slice(-3, -2)[0]; // plugin name
  test(`external-review disclosure + transmission cover every branch (${name})`, async () => {
    const m = await import(rel);
    const { externalReviewDisclosure, sourceContentTransmissionForExecution, targetProcessReceivedContent, providerDisplayName, buildExternalReview, SOURCE_CONTENT_TRANSMISSION } = m;
    const T = SOURCE_CONTENT_TRANSMISSION;
    const provider = "TestProvider";

    // buildExternalReview: the canonical external_review payload + its guards.
    const review = buildExternalReview({
      invocation: { target: "kimi", run_kind: "foreground", job_id: "j1", parent_job_id: null, mode: "custom-review", scope: "custom", scope_base: null, scope_paths: ["a.txt"] },
      sessionId: "s1",
      status: "completed",
      errorCode: null,
      sourceContentTransmission: T.SENT,
      reviewSlot: null,
    });
    assert.equal(review.marker, "EXTERNAL REVIEW");
    assert.equal(review.source_content_transmission, T.SENT);
    assert.equal(Object.isFrozen(review), true);
    assert.throws(
      () => buildExternalReview({ invocation: { target: "kimi" }, status: "completed", sourceContentTransmission: "bogus" }),
      /invalid sourceContentTransmission/,
    );

    // Every transmission × representative status combination -> a non-empty string.
    const statuses = ["completed", "running", "cancelled", "stale", "failed", "queued"];
    const transmissions = [T.SENT, T.NOT_SENT, T.MAY_BE_SENT, T.UNKNOWN];
    for (const transmission of transmissions) {
      for (const status of statuses) {
        const text = externalReviewDisclosure(provider, status, transmission);
        assert.equal(typeof text, "string");
        assert.ok(text.length > 0);
      }
    }
    // Every NOT_SENT error-code disclosure branch.
    for (const code of NOT_SENT_CODES) {
      const text = externalReviewDisclosure(provider, "failed", T.NOT_SENT, code);
      assert.ok(text.length > 0, code);
    }
    // Pre-send quota (usage_limited_preflight) must render the NOT_SENT framing
    // verbatim — never a SENT-implying string. Pins the disclosure wording behind
    // the over-disclosure fix (PR #226) so it cannot silently flip.
    const preflightText = externalReviewDisclosure(provider, "failed", T.NOT_SENT, "usage_limited_preflight");
    assert.match(preflightText, /was not sent/, "usage_limited_preflight must disclose NOT sent");
    assert.match(preflightText, /before the review prompt was written/, "usage_limited_preflight must state the failure preceded the prompt write");

    // sourceContentTransmissionForExecution across statuses, codes, and pidInfo.
    for (const status of ["queued", "running", "stale", "cancelled", "completed", "failed"]) {
      for (const pidInfo of [null, { pid: 123 }]) {
        for (const errorCode of [null, "kimi_error", "cli_contract_mismatch", "oauth_inference_rejected", "interrupted", "model_unavailable", "timeout"]) {
          const v = sourceContentTransmissionForExecution({ status, errorCode, pidInfo });
          assert.ok(Object.values(T).includes(v), `${status}/${errorCode}/${pidInfo ? "pid" : "nopid"} -> ${v}`);
        }
      }
    }

    // targetProcessReceivedContent + providerDisplayName.
    assert.equal(typeof targetProcessReceivedContent("kimi_error"), "boolean");
    assert.equal(typeof targetProcessReceivedContent("cli_contract_mismatch"), "boolean");
    assert.equal(typeof providerDisplayName("kimi"), "string");
  });
}
