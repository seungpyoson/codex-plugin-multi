// Bridge-level (acpResultToParsed) tests for the source-disclosure CLASS guard
// (#223 de-risking). The adapter reports raw facts (reason + truthful sourceSent);
// the bridge translates the reason into relay's failure vocabulary AND enforces the
// disclosure invariant: once the prompt was written (sourceSent === true), the
// failure code must classify as content-received, never pre-target/source-NOT-sent.
// These pin the guard for the whole class of pre-target reasons, not just the
// auth_required instance that surfaced it, so a future pre-target reason emitted
// post-send is covered by construction.
import { test } from "node:test";
import assert from "node:assert/strict";

import { acpResultToParsed } from "../../plugins/kimi/scripts/lib/kimi.mjs";
import { PRE_TARGET_NOT_SENT_ERROR_CODES } from "../../plugins/kimi/scripts/lib/external-review.mjs";

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

test("content-received reasons are never altered by the guard, regardless of sourceSent", () => {
  // kimi_error and timeout already classify as content-received; the guard must be a
  // no-op for them. timeout in particular must STAY timeout post-send (the deferred
  // #228 SAFE-direction behavior — a handshake timeout discloses SENT by design).
  for (const sourceSent of [true, false]) {
    assert.equal(acpResultToParsed(baseFail({ reason: "kimi_error", sourceSent })).reason, "kimi_error");
    assert.equal(acpResultToParsed(baseFail({ reason: "timeout", sourceSent })).reason, "timeout");
  }
});

test("the guard set is exactly the canonical PRE_TARGET_NOT_SENT_ERROR_CODES (single source of truth)", () => {
  // Every canonical pre-target code, when emitted post-send, coerces to kimi_error.
  // This binds the bridge to external-review.mjs's set so the two can never drift.
  for (const code of PRE_TARGET_NOT_SENT_ERROR_CODES) {
    const parsed = acpResultToParsed(baseFail({ reason: code, sourceSent: true }));
    assert.equal(parsed.reason, "kimi_error", `post-send ${code} must coerce to kimi_error`);
  }
});

test("a clean (ok) result is untouched", () => {
  const parsed = acpResultToParsed({ ok: true, sessionId: "s", result: "VERDICT: PASS", rawTranscript: "VERDICT: PASS" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "VERDICT: PASS");
});
