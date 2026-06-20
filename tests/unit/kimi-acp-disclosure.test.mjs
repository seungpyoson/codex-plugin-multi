// Source-transmission disclosure integrity for the kimi-code ACP path (#222/#223).
//
// These tests drive the FULL composed path the companion uses — real spawnKimi over
// ACP -> classifyExecution -> sourceContentTransmissionForExecution ->
// externalReviewDisclosure — not the leaf functions in isolation. That composition
// is exactly what a leaf-only disclosure test cannot see: a pre-prompt ACP failure
// (model_unavailable / auth_required / acp_protocol_error) where the adapter set
// sourceSent:false must disclose NOT_SENT and must NOT claim the source "was sent"
// or that the operator "cancelled" — the adapter's own teardown SIGTERM is not an
// operator cancel. A clean turn whose server is slow to release stdin (the
// graceful-close fallback kill fires) must still be classified completed with its
// verdict preserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawnKimi } from "../../plugins/kimi/scripts/lib/kimi.mjs";
import { __resetKimiCapabilityCache } from "../../plugins/kimi/scripts/lib/kimi-capabilities.mjs";
import { resolveProfile } from "../../plugins/kimi/scripts/lib/mode-profiles.mjs";
import { classifyExecution } from "../../plugins/kimi/scripts/lib/job-record.mjs";
import {
  sourceContentTransmissionForExecution,
  externalReviewDisclosure,
  SOURCE_CONTENT_TRANSMISSION,
} from "../../plugins/kimi/scripts/lib/external-review.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_KIMI = path.resolve(HERE, "../smoke/fake-kimi.mjs");

async function classifyRun(profileName, runtime = {}, mockEnv = {}) {
  __resetKimiCapabilityCache();
  const execution = await spawnKimi(resolveProfile(profileName), {
    binary: FAKE_KIMI,
    promptText: "Review this scope.",
    timeoutMs: 15000,
    env: { ...process.env, ...mockEnv },
    ...runtime,
  });
  const { status, error_code } = classifyExecution(execution);
  const transmission = sourceContentTransmissionForExecution({
    status,
    errorCode: error_code,
    pidInfo: execution.pidInfo,
  });
  const disclosure = externalReviewDisclosure("Kimi Code CLI", status, transmission, error_code);
  return { execution, status, error_code, transmission, disclosure };
}

function assertNotSent({ transmission, disclosure }, label) {
  assert.equal(transmission, SOURCE_CONTENT_TRANSMISSION.NOT_SENT, `${label}: expected NOT_SENT, disclosure was "${disclosure}"`);
  assert.match(disclosure, /was not sent/, `${label}: disclosure must state source was not sent`);
  assert.doesNotMatch(disclosure, /was sent|cancelled/i, `${label}: disclosure must not claim sent or cancelled`);
}

test("model_unavailable (pre-prompt) discloses NOT_SENT, never sent/cancelled", async () => {
  const r = await classifyRun("review", { model: "not-an-offered-model" }, { MOCK_ACP_NO_MODEL: "1" });
  assert.equal(r.execution.parsed.reason, "model_unavailable");
  assertNotSent(r, "model_unavailable");
});

test("auth_required (pre-prompt) discloses NOT_SENT, never sent/cancelled", async () => {
  const r = await classifyRun("ping", {}, { MOCK_ACP_AUTH_REQUIRED: "1" });
  assert.equal(r.execution.parsed.reason, "not_authed");
  assertNotSent(r, "auth_required");
});

test("acp_protocol_error (pre-prompt session failure) discloses NOT_SENT, never sent/cancelled", async () => {
  const r = await classifyRun("review", {}, { MOCK_ACP_SESSION_ERROR: "1" });
  assert.equal(r.execution.parsed.reason, "acp_protocol_error");
  assertNotSent(r, "acp_protocol_error");
});

test("a clean turn whose server is slow to release stdin is still completed with its verdict preserved", async () => {
  const r = await classifyRun("review", {}, { MOCK_ACP_HANG_ON_EOF: "1", MOCK_ACP_REPLY: "VERDICT: PASS\nclean" });
  assert.equal(r.status, "completed", `expected completed, got ${r.status} (verdict must not be discarded as a cancel)`);
  assert.equal(r.transmission, SOURCE_CONTENT_TRANSMISSION.SENT);
  assert.equal(r.execution.parsed.ok, true);
  assert.equal(r.execution.parsed.result, "VERDICT: PASS\nclean");
});
