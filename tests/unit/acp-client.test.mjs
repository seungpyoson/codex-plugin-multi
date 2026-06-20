// Unit tests for the ACP stdio client (#222/#223). Drives the real client against
// tests/smoke/kimi-acp-mock.mjs over actual child-process stdio, so NDJSON framing,
// request/response correlation, notifications, and reverse-requests are all exercised
// for real (not faked in-process).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { runAcpPrompt } from "../../plugins/kimi/scripts/lib/acp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, "../smoke/kimi-acp-mock.mjs");
const NODE = process.execPath;

function run(opts = {}, mockEnv = {}) {
  return runAcpPrompt({
    command: NODE,
    args: [MOCK],
    cwd: process.cwd(),
    env: { ...process.env, ...mockEnv },
    promptText: "Review this scope.",
    timeoutMs: 15000,
    ...opts,
  });
}

test("happy path: initialize -> session/new -> prompt -> end_turn assembles the verdict", async () => {
  const r = await run({}, { MOCK_ACP_REPLY: "VERDICT: PASS\nclean" });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.reason, null);
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.result, "VERDICT: PASS\nclean");
  assert.equal(r.sessionId, "session_mock");
  assert.equal(r.sourceSent, true);
  assert.ok(r.pidInfo, "pidInfo captured for the acp process");
});

test("large prompt (1 MiB) is delivered over stdin with NO argv limit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-bigprompt-"));
  const lenFile = path.join(dir, "len.txt");
  try {
    // 1 MiB — ~8x Linux MAX_ARG_STRLEN (128 KiB); would E2BIG on the old -p path.
    const big = "S".repeat(1024 * 1024) + " :: KIMI FILE 1: packet-0.txt";
    const r = await run(
      { promptText: big },
      { MOCK_ACP_PROMPT_LEN_FILE: lenFile, MOCK_ACP_ASSERT_PROMPT_INCLUDES: "KIMI FILE 1: packet-0.txt", MOCK_ACP_REPLY: "VERDICT: PASS" },
    );
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.sourceSent, true);
    const received = Number(readFileSync(lenFile, "utf8"));
    assert.equal(received, Buffer.byteLength(big, "utf8"), "mock received the full multi-hundred-KiB prompt over stdin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model selection: requested model is set when offered", async () => {
  const r = await run({ model: "kimi-for-coding" });
  assert.equal(r.ok, true, r.error ?? "");
});

test("model_unavailable: requested model not offered -> fail clean, source NOT sent (no silent substitution)", async () => {
  const r = await run({ model: "some-other-model" }, { MOCK_ACP_NO_MODEL: "1" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "model_unavailable");
  assert.equal(r.sourceSent, false);
});

test("auth_required: session/new -32000 -> reason auth_required, source NOT sent", async () => {
  const r = await run({}, { MOCK_ACP_AUTH_REQUIRED: "1" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "auth_required");
  assert.equal(r.sourceSent, false);
});

test("wrong CLI (non-JSON banner on stdout) -> cli_contract_mismatch, source NOT sent", async () => {
  const r = await run({}, { MOCK_ACP_INIT_GARBAGE: "1" });
  assert.equal(r.ok, false);
  assert.equal(r.sourceSent, false);
  // The banner makes initialize unparseable; the turn fails before source is sent.
  assert.ok(["cli_contract_mismatch", "acp_protocol_error", "timeout"].includes(r.reason), `got ${r.reason}`);
});

test("prompt-level failure (assert miss) AFTER source sent -> kimi_error, source sent", async () => {
  const r = await run({}, { MOCK_ACP_ASSERT_PROMPT_INCLUDES: "TOKEN-NOT-IN-PROMPT" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "kimi_error");
  assert.equal(r.sourceSent, true);
});

test("finalMessageOnly: review keeps the final message; rescue keeps the full transcript", async () => {
  const review = await run({ finalMessageOnly: true }, { MOCK_ACP_REPLY: "ABCDEF", MOCK_ACP_CHUNKS: "3" });
  // 3 messages "AB","CD","EF" -> review keeps only the last.
  assert.equal(review.ok, true, review.error ?? "");
  assert.equal(review.result, "EF");
  const rescue = await run({ finalMessageOnly: false }, { MOCK_ACP_REPLY: "ABCDEF", MOCK_ACP_CHUNKS: "3" });
  assert.equal(rescue.result, "AB\nCD\nEF");
});

test("refusal stopReason -> kimi_refused (source was sent)", async () => {
  const r = await run({}, { MOCK_ACP_STOP_REASON: "refusal", MOCK_ACP_REPLY: "" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "kimi_refused");
  assert.equal(r.sourceSent, true);
});

test("tool-permission round-trip: review denies, turn still completes", async () => {
  const r = await run({ approveToolCalls: false }, { MOCK_ACP_REQUEST_PERMISSION: "1", MOCK_ACP_REPLY: "VERDICT: PASS" });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.result, "VERDICT: PASS");
});

test("timeout: a stalled prompt turn fails clean as timeout", async () => {
  const r = await run({ timeoutMs: 300 }, { MOCK_ACP_PROMPT_DELAY_MS: "5000" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout");
  assert.equal(r.timedOut, true);
});

test("resume: session/load echoes the resumed sessionId", async () => {
  const r = await run({ resumeId: "session_prior-123" });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.sessionId, "session_prior-123");
});

test("spawn failure (binary not found) -> spawn_failed, source NOT sent, spawnFailed marked", async () => {
  const r = await runAcpPrompt({
    command: "/nonexistent/kimi-binary-xyz",
    args: ["acp"],
    promptText: "Review this scope.",
    timeoutMs: 5000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "spawn_failed");
  assert.equal(r.sourceSent, false);
  assert.equal(r.spawnFailed, true);
});

test("end_turn with no assistant text -> empty_stdout (source sent)", async () => {
  const r = await run({}, { MOCK_ACP_REPLY: "" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_stdout");
  assert.equal(r.sourceSent, true);
});

test("model pass-through: an advertised selector accepts a model not in its list (no substitution)", async () => {
  // The mock advertises a model selector with one value; requesting a different
  // model passes through (set), not model_unavailable.
  const r = await run({ model: "kimi-code/some-other" });
  assert.equal(r.ok, true, r.error ?? "");
});

test("max_tokens stopReason -> review_incomplete (source sent)", async () => {
  const r = await run({}, { MOCK_ACP_STOP_REASON: "max_tokens", MOCK_ACP_REPLY: "partial" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "review_incomplete");
  assert.equal(r.sourceSent, true);
});

test("a terminal frame WITHOUT a trailing newline at EOF is still flushed and dispatched", async () => {
  const r = await run({}, { MOCK_ACP_NO_TRAILING_NEWLINE: "1", MOCK_ACP_REPLY: "VERDICT: PASS\nclean" });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.result, "VERDICT: PASS\nclean", "the verdict from a newline-less final frame must not be dropped");
});

test("a server negotiating a different protocolVersion fails clean as cli_contract_mismatch, source NOT sent", async () => {
  const r = await run({}, { MOCK_ACP_PROTOCOL_VERSION: "2" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cli_contract_mismatch");
  assert.equal(r.sourceSent, false, "must abort before sending source against an unknown protocol version");
});
