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

test("auth_required AFTER source sent (session/prompt -32000) -> reason auth_required, sourceSent TRUE", async () => {
  // A -32000 authRequired returned by session/PROMPT (token expiry mid-session,
  // per-operation auth) lands AFTER the prompt was written, so the source WAS sent.
  // The adapter must report the truthful sourceSent:true; a hardcoded false here is
  // the dangerous under-disclosure direction. The adapter keeps the raw reason
  // (auth_required) — the bridge (acpResultToParsed) is what coerces a post-send
  // pre-target reason to a content-received code. See kimi-bridge / kimi-acp-disclosure.
  const dir = mkdtempSync(path.join(tmpdir(), "acp-postauth-leaf-"));
  const lenFile = path.join(dir, "len.txt");
  try {
    const r = await run({}, { MOCK_ACP_PROMPT_AUTH_REQUIRED: "1", MOCK_ACP_PROMPT_LEN_FILE: lenFile });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "auth_required");
    assert.equal(r.sourceSent, true, "the prompt was already written; source WAS sent");
    const received = Number(readFileSync(lenFile, "utf8"));
    assert.ok(received > 0, `ground truth: the mock received ${received} prompt bytes before the auth error`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrong CLI (non-JSON banner on stdout) -> cli_contract_mismatch, source NOT sent", async () => {
  const r = await run({}, { MOCK_ACP_INIT_GARBAGE: "1" });
  assert.equal(r.ok, false);
  assert.equal(r.sourceSent, false);
  // The banner is a non-JSON line on stdout -> peer.protocolError set -> initialize
  // rejected on child close -> deterministic cli_contract_mismatch. Pin it exactly;
  // a loose set would let a future timeout/hang regression pass unnoticed.
  assert.equal(r.reason, "cli_contract_mismatch", `got ${r.reason}`);
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

test("an EXTERNAL signal that kills the child mid-prompt is reported as the real signal, not masked", async () => {
  // The adapter masks its OWN teardown SIGTERM (adapterInitiatedKill) so the
  // companion does not misread it as an operator cancel. But a GENUINE external
  // signal that terminates the child before the catch runs must NOT be masked:
  // the catch path also calls kill(), and that no-op cleanup must not erase the
  // real signal. Drive a long prompt, then SIGTERM the child from onSpawn.
  let killed = false;
  const r = await run(
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
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false, "this must be a signal kill, not a timeout");
  assert.equal(r.signal, "SIGTERM", "a genuine external signal must propagate (not be masked to null by the catch-path kill)");
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

test("the stdout 'end' flush is independently load-bearing (server ends stdout before exit; no process-close backstop)", async () => {
  // Isolates the constructor's stdout 'end' handler from the close-handler backstop:
  // the server ends stdout (EOF) but stays alive on stdin, so the buffered
  // newline-less frame can ONLY be dispatched by the 'end' handler. Removing that
  // handler makes this turn hang until timeout instead of resolving.
  const r = await run({ timeoutMs: 8000 }, { MOCK_ACP_END_STDOUT_NO_EXIT: "1", MOCK_ACP_REPLY: "VERDICT: PASS" });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.result, "VERDICT: PASS");
});

test("non-JSON stdout AFTER the prompt is sent stays sourceSent:true (kimi_error), not a pre-target cli_contract_mismatch", async () => {
  // peer.protocolError is set by any non-JSON stdout line at any time. A leak that
  // happens AFTER the prompt was written must not be reported as source-NOT-sent.
  const r = await run({}, { MOCK_ACP_POST_PROMPT_GARBAGE_STDOUT: "1" });
  assert.equal(r.ok, false);
  assert.equal(r.sourceSent, true, "the prompt was already written; the source was sent");
  assert.equal(r.reason, "kimi_error", "a post-prompt stdout leak is a model failure, not a pre-target contract mismatch");
});

test("a server negotiating a different protocolVersion fails clean as cli_contract_mismatch, source NOT sent", async () => {
  const r = await run({}, { MOCK_ACP_PROTOCOL_VERSION: "2" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cli_contract_mismatch");
  assert.equal(r.sourceSent, false, "must abort before sending source against an unknown protocol version");
});

test("protocolVersion as the STRING \"1\" is tolerated (no false-negative); a string mismatch still fails SAFE", async () => {
  // The version check coerces with Number(), so a server that serializes the
  // version as a JSON string "1" is accepted (failing it would be a false-negative
  // readiness error). A genuine mismatch as a string ("2") must still fail safe.
  const ok = await run({}, { MOCK_ACP_PROTOCOL_VERSION_RAW: "1", MOCK_ACP_REPLY: "VERDICT: PASS" });
  assert.equal(ok.ok, true, ok.error ?? "string \"1\" must be accepted, not rejected as a contract mismatch");
  assert.equal(ok.stopReason, "end_turn");

  const bad = await run({}, { MOCK_ACP_PROTOCOL_VERSION_RAW: "2" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "cli_contract_mismatch");
  assert.equal(bad.sourceSent, false, "a string mismatch must still abort before sending source");
});
