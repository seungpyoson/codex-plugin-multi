// Bridge-level (acpResultToParsed) tests for the source-disclosure CLASS guard
// (#223 de-risking). The adapter reports raw facts (reason + truthful sourceSent);
// the bridge translates the reason into relay's failure vocabulary AND enforces the
// disclosure invariant SYMMETRICALLY at one chokepoint, keyed on sourceSent:
//   - post-send (sourceSent:true): the code must classify content-received, never
//     pre-target/NOT_SENT (else transmitted source is under-disclosed) — pre-target
//     codes coerce to kimi_error;
//   - pre-send (sourceSent:false): the code must classify pre-target/NOT_SENT, never
//     content-received/SENT (else not-sent source is over-disclosed) — content-received
//     codes coerce to acp_protocol_error, EXCEPT the deferred #228 timeout.
// These pin BOTH directions for the whole class, not just the instances that surfaced
// them, so a future un-gated reason or text-scan is covered by construction.
import { test } from "node:test";
import assert from "node:assert/strict";

import { acpResultToParsed } from "../../plugins/kimi/scripts/lib/kimi.mjs";
import { PRE_TARGET_NOT_SENT_ERROR_CODES, targetProcessReceivedContent } from "../../plugins/kimi/scripts/lib/external-review.mjs";

const baseFail = (over) => ({
  ok: false,
  reason: null,
  error: "boom",
  sessionId: "session_mock",
  stderr: "",
  rawTranscript: "",
  sourceSent: false,
  ...over,
});

test("post-send (sourceSent:true) pre-target reasons are coerced to content-received kimi_error", () => {
  // auth_required maps to not_authed; model_unavailable / acp_protocol_error pass
  // through ACP_REASON_TO_CODE unchanged — all three are PRE_TARGET_NOT_SENT codes.
  for (const reason of ["auth_required", "model_unavailable", "acp_protocol_error"]) {
    const parsed = acpResultToParsed(baseFail({ reason, sourceSent: true }));
    assert.equal(parsed.reason, "kimi_error", `post-send ${reason} must coerce to kimi_error (content-received -> SENT)`);
    assert.equal(parsed.error, "boom", "the raw failure detail must be preserved for diagnosis");
  }
});

test("pre-send (sourceSent:false) pre-target reasons pass through unchanged (still NOT_SENT)", () => {
  assert.equal(acpResultToParsed(baseFail({ reason: "auth_required", sourceSent: false })).reason, "not_authed");
  assert.equal(acpResultToParsed(baseFail({ reason: "model_unavailable", sourceSent: false })).reason, "model_unavailable");
  assert.equal(acpResultToParsed(baseFail({ reason: "acp_protocol_error", sourceSent: false })).reason, "acp_protocol_error");
  assert.equal(acpResultToParsed(baseFail({ reason: "cli_contract_mismatch", sourceSent: false })).reason, "cli_contract_mismatch");
});

test("post-send content-received reasons pass through (the under-disclosure guard is a no-op for them)", () => {
  // kimi_error and timeout already classify as content-received; once the prompt was
  // written (SENT) the guard must leave them untouched.
  assert.equal(acpResultToParsed(baseFail({ reason: "kimi_error", sourceSent: true })).reason, "kimi_error");
  assert.equal(acpResultToParsed(baseFail({ reason: "timeout", sourceSent: true })).reason, "timeout");
});

test("over-disclosure guard (symmetric): a content-received reason emitted PRE-send coerces to a NOT_SENT code, except the deferred #228 timeout", () => {
  // Mirror of the post-send under-disclosure guard. Pre-send (sourceSent:false) the
  // prompt was never written, so the source did NOT leave the machine: ANY reason that
  // would classify content-received (-> SENT) is the over-disclosure direction and is
  // coerced to the generic pre-target acp_protocol_error (-> NOT_SENT). This makes a
  // future un-gated text-scan structurally unable to reopen the over-disclosure class
  // that the quota bug was an instance of. (kimi_error pre-send is not a real adapter
  // output — runAcpPrompt emits acp_protocol_error pre-send — but the backstop must
  // hold for it and every other content-received code by construction.)
  for (const cr of ["kimi_error", "review_not_completed", "parse_error", "provider_error", "step_limit_exceeded", "usage_limited", "finalization_failed"]) {
    const parsed = acpResultToParsed(baseFail({ reason: cr, sourceSent: false }));
    assert.equal(parsed.reason, "acp_protocol_error", `pre-send ${cr} must coerce to the NOT_SENT acp_protocol_error`);
    assert.equal(PRE_TARGET_NOT_SENT_ERROR_CODES.has(parsed.reason), true, `pre-send ${cr} must bucket as pre-target (NOT_SENT)`);
    assert.equal(targetProcessReceivedContent(parsed.reason), false, `pre-send ${cr} must NOT bucket as content-received`);
  }
  // #228 EXCEPTION: a pre-prompt handshake timeout is the one content-received code
  // deliberately left disclosing SENT (cross-provider, deferred). It must NOT coerce.
  assert.equal(acpResultToParsed(baseFail({ reason: "timeout", sourceSent: false })).reason, "timeout");
});

test("the guard set is exactly the canonical PRE_TARGET_NOT_SENT_ERROR_CODES (single source of truth)", () => {
  // Every canonical pre-target code, when emitted post-send, coerces to kimi_error.
  // This binds the bridge to external-review.mjs's set so the two can never drift.
  for (const code of PRE_TARGET_NOT_SENT_ERROR_CODES) {
    const parsed = acpResultToParsed(baseFail({ reason: code, sourceSent: true }));
    assert.equal(parsed.reason, "kimi_error", `post-send ${code} must coerce to kimi_error`);
  }
});

test("a quota/usage-limit error is gated on sourceSent (the text-scanned content-received code)", () => {
  // usage_limited is the ONE content-received code derived from scanning the error
  // text, not the lifecycle — so it must obey the same disclosure invariant as the
  // lifecycle codes. Post-send: the quota was hit BY the review request, so it keeps
  // the content-received usage_limited code (-> SENT). Pre-send: a quota error before
  // the prompt write means the source never left the machine, so it maps to the
  // pre-target usage_limited_preflight code (-> NOT_SENT) instead of over-disclosing.
  const quota = "insufficient_quota: usage limit reached for this billing cycle";

  const post = acpResultToParsed(baseFail({ reason: "kimi_error", error: quota, sourceSent: true }));
  assert.equal(post.reason, "usage_limited", "post-send quota keeps the content-received usage_limited code");
  assert.equal(targetProcessReceivedContent(post.reason), true, "post-send quota must bucket as content-received (SENT)");

  const pre = acpResultToParsed(baseFail({ reason: "acp_protocol_error", error: quota, sourceSent: false }));
  assert.equal(pre.reason, "usage_limited_preflight", "pre-send quota maps to the pre-target code, NOT usage_limited");
  assert.equal(PRE_TARGET_NOT_SENT_ERROR_CODES.has(pre.reason), true, "pre-send quota must bucket as pre-target (NOT_SENT)");
  assert.equal(targetProcessReceivedContent(pre.reason), false, "pre-send quota must NOT bucket as content-received");

  // The quota detail surfaces as the sanitized safe message in both directions (no
  // raw billing text leaks); the direction is what differs.
  assert.match(pre.error, /quota|usage|billing|credit/i, "the quota message must be preserved for the operator");
});

test("a clean (ok) result is untouched", () => {
  const parsed = acpResultToParsed({ ok: true, sessionId: "s", result: "VERDICT: PASS", rawTranscript: "VERDICT: PASS" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "VERDICT: PASS");
});
