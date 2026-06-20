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
  // The CLI DID start and open a session here; the disclosure must not claim the
  // target was never started (GLM LOW2 precision).
  assert.match(r.disclosure, /CLI started and opened a session/, "model_unavailable disclosure must reflect that the CLI started");
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
  // The CLI DID start; the disclosure must not claim the target was never started
  // (GLM LOW2 precision).
  assert.match(r.disclosure, /CLI started but its protocol handshake failed/, "acp_protocol_error disclosure must reflect that the CLI started");
});

test("cli_contract_mismatch (protocolVersion mismatch, pre-prompt) discloses NOT_SENT, never sent/cancelled", async () => {
  // End-to-end pin for the protocolVersion negotiation guard: a server speaking a
  // different ACP version must fail clean BEFORE any source is sent. Covers the
  // composed path, not just the acp-client leaf (acp-client.test.mjs:182).
  const r = await classifyRun("review", {}, { MOCK_ACP_PROTOCOL_VERSION: "2" });
  assert.equal(r.execution.parsed.reason, "cli_contract_mismatch");
  assert.equal(r.error_code, "cli_contract_mismatch");
  assertNotSent(r, "cli_contract_mismatch");
});

test("an EXTERNAL operator SIGTERM during the prompt classifies as cancelled, NOT a model failure", async () => {
  // Regression for the adapterInitiatedKill over-masking: the adapter's own
  // teardown SIGTERM must be suppressed, but a GENUINE external signal that kills
  // the child while session/prompt is in flight must propagate so the companion
  // classifies the run as CANCELLED (an operator action), not kimi_error (a model
  // failure). Misreporting an operator cancel as a model failure would falsely
  // count against Kimi's reliability. Source WAS sent here, so disclosure is SENT.
  let killed = false;
  const r = await classifyRun(
    "review",
    {
      timeoutMs: 15000, // long — the adapter timeout must NOT fire; this is a pure external signal
      onSpawn: (pidInfo) => {
        if (pidInfo?.pid && !killed) {
          killed = true;
          setTimeout(() => { try { process.kill(pidInfo.pid, "SIGTERM"); } catch { /* gone */ } }, 250);
        }
      },
    },
    { MOCK_ACP_PROMPT_DELAY_MS: "5000" },
  );
  assert.equal(r.execution.signal, "SIGTERM", "the real external signal must reach the execution record (not be masked to null)");
  assert.equal(r.status, "cancelled", `expected cancelled, got ${r.status}/${r.error_code} (an operator cancel must not read as a model failure)`);
  assert.equal(r.error_code, null);
  assert.equal(r.transmission, SOURCE_CONTENT_TRANSMISSION.SENT, "the prompt was written before the cancel, so source WAS sent");
  assert.match(r.disclosure, /was sent/, "disclosure must state the source was sent");
  assert.match(r.disclosure, /cancelled/i, "disclosure must attribute this to an operator cancel");
});

test("an EXTERNAL SIGTERM during the HANDSHAKE (pre-prompt) discloses NOT_SENT, never sent", async () => {
  // The companion's CANCEL_SIGNALS short-circuit maps any signal to cancelled, and
  // cancelled+pidInfo discloses SENT — so naively un-masking EVERY external signal
  // would re-introduce the original blocker for the pre-prompt window (source never
  // sent, yet disclosed as sent). A signal is only a cancel-of-an-in-flight-review
  // once the source has been sent; before that it must disclose NOT_SENT.
  let killed = false;
  const r = await classifyRun(
    "review",
    {
      timeoutMs: 15000, // long — the adapter timeout must NOT fire; this is a pure external signal
      onSpawn: (pidInfo) => {
        if (pidInfo?.pid && !killed) {
          killed = true;
          try { process.kill(pidInfo.pid, "SIGTERM"); } catch { /* gone */ }
        }
      },
    },
    { MOCK_ACP_HANDSHAKE_DELAY_MS: "4000" }, // stall the handshake so the kill lands pre-prompt
  );
  assert.equal(r.execution.parsed.reason, "acp_protocol_error", "must be a pre-prompt failure (source not sent)");
  assertNotSent(r, "pre-prompt external SIGTERM");
});

test("post-prompt non-JSON stdout (source already sent) discloses SENT, never NOT_SENT", async () => {
  // BLOCKER class (the DANGEROUS direction): once the prompt is written, a stray
  // non-JSON line on stdout sets peer.protocolError — but the source WAS delivered
  // to the CLI. The adapter must NOT let a post-prompt protocolError hardcode
  // sourceSent:false (which would disclose "not sent ... target not started").
  const r = await classifyRun("review", {}, { MOCK_ACP_POST_PROMPT_GARBAGE_STDOUT: "1" });
  assert.equal(r.error_code, "kimi_error", "a post-prompt failure is a model failure, not a pre-target cli_contract_mismatch");
  assert.equal(r.transmission, SOURCE_CONTENT_TRANSMISSION.SENT, `source WAS delivered; expected SENT, disclosure was "${r.disclosure}"`);
  assert.match(r.disclosure, /was sent/, "disclosure must state the source was sent");
  assert.doesNotMatch(r.disclosure, /was not sent|not started/i, "must not claim the source was not sent or the target not started");
});

test("a clean turn whose server is slow to release stdin is still completed with its verdict preserved", async () => {
  const r = await classifyRun("review", {}, { MOCK_ACP_HANG_ON_EOF: "1", MOCK_ACP_REPLY: "VERDICT: PASS\nclean" });
  assert.equal(r.status, "completed", `expected completed, got ${r.status} (verdict must not be discarded as a cancel)`);
  assert.equal(r.transmission, SOURCE_CONTENT_TRANSMISSION.SENT);
  assert.equal(r.execution.parsed.ok, true);
  assert.equal(r.execution.parsed.result, "VERDICT: PASS\nclean");
});
