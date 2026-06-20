// Integration tests for the kimi-code ACP spawn surface (#222/#223): spawnKimi
// drives `kimi acp` over stdio (NOT `-p <argv>`), so the prompt — with embedded
// source of any size — is immune to the Linux MAX_ARG_STRLEN cap that crashed large
// reviews with E2BIG. Driven against tests/smoke/fake-kimi.mjs, a fake `kimi` binary
// that serves --help / --version / acp.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { spawnKimi } from "../../plugins/kimi/scripts/lib/kimi.mjs";
import { __resetKimiCapabilityCache, KimiContractMismatchError } from "../../plugins/kimi/scripts/lib/kimi-capabilities.mjs";
import { resolveProfile } from "../../plugins/kimi/scripts/lib/mode-profiles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_KIMI = path.resolve(HERE, "../smoke/fake-kimi.mjs");

function spawn(profileName, runtime = {}, mockEnv = {}) {
  // The fake binary's --help varies by env on one stat identity, so clear the
  // stat-identity cache to force a fresh capability probe each test.
  __resetKimiCapabilityCache();
  return spawnKimi(resolveProfile(profileName), {
    binary: FAKE_KIMI,
    promptText: "Review this scope.",
    timeoutMs: 15000,
    env: { ...process.env, ...mockEnv },
    ...runtime,
  });
}

test("spawnKimi(review) drives kimi acp and maps the verdict onto the parsed contract", async () => {
  const r = await spawn("review", {}, { MOCK_ACP_REPLY: "VERDICT: PASS\nclean" });
  assert.equal(r.parsed.ok, true, r.parsed.error ?? "");
  assert.equal(r.parsed.result, "VERDICT: PASS\nclean");
  assert.equal(r.kimiSessionId, "session_mock");
  assert.ok(r.pidInfo, "pidInfo captured for the acp process");
  assert.equal(r.timedOut, false);
});

test("spawnKimi sends a large embedded-source prompt over ACP with NO argv limit (E2BIG fix)", async () => {
  // 600 KiB — over the 512 KiB source budget and ~5x Linux MAX_ARG_STRLEN; the old
  // -p path E2BIG'd here. The fake server asserts it received the full prompt.
  const big = `KIMI FILE 1: packet-0.txt\n${"k".repeat(600 * 1024)}`;
  const r = await spawn("custom-review", { promptText: big }, {
    MOCK_ACP_ASSERT_PROMPT_INCLUDES: "KIMI FILE 1: packet-0.txt",
    MOCK_ACP_REPLY: "VERDICT: PASS",
  });
  assert.equal(r.parsed.ok, true, r.parsed.error ?? "");
  assert.equal(r.parsed.result, "VERDICT: PASS");
});

test("spawnKimi throws cli_contract_mismatch when the CLI does not advertise the acp command", async () => {
  await assert.rejects(
    () => spawn("review", {}, { FAKE_KIMI_LEGACY: "1" }),
    (e) => e instanceof KimiContractMismatchError && e.code === "cli_contract_mismatch" && e.missing.includes("acp"),
  );
});

test("spawnKimi(rescue) keeps the full multi-message transcript (finalMessageOnly=false)", async () => {
  const r = await spawn("rescue", {}, { MOCK_ACP_REPLY: "ABCDEF", MOCK_ACP_CHUNKS: "3" });
  assert.equal(r.parsed.ok, true, r.parsed.error ?? "");
  assert.equal(r.parsed.result, "AB\nCD\nEF");
});

test("spawnKimi maps an ACP auth failure to not_authed (source NOT sent vocabulary)", async () => {
  const r = await spawn("ping", {}, { MOCK_ACP_AUTH_REQUIRED: "1" });
  assert.equal(r.parsed.ok, false);
  assert.equal(r.parsed.reason, "not_authed");
});

test("spawnKimi fails clean as model_unavailable when the requested model is not offered (no silent substitution)", async () => {
  const r = await spawn("review", { model: "not-an-offered-model" }, { MOCK_ACP_NO_MODEL: "1" });
  assert.equal(r.parsed.ok, false);
  assert.equal(r.parsed.reason, "model_unavailable");
});

test("spawnKimi requires a non-empty prompt", async () => {
  await assert.rejects(() => spawnKimi(resolveProfile("review"), { binary: FAKE_KIMI, promptText: "" }), /promptText is required/);
});

test("rescue APPROVES a tool-permission request (allow); review DENIES it (reject) — the safety boundary", async () => {
  // The rescue-vs-review permission decision is a safety boundary: rescue edits the
  // tree (auto-approve), review must never approve a tool call. Assert the exact
  // option the client selects for each profile so a flip of the allow/reject branch
  // in acp-client.mjs (or the profile->approveToolCalls mapping) fails the suite.
  const dir = mkdtempSync(path.join(os.tmpdir(), "kimi-perm-"));

  const rescueFile = path.join(dir, "rescue-outcome.json");
  await spawn("rescue", {}, {
    MOCK_ACP_REQUEST_PERMISSION: "1",
    MOCK_ACP_PERMISSION_OUTCOME_FILE: rescueFile,
    MOCK_ACP_REPLY: "applied the fix",
  });
  const rescueOutcome = JSON.parse(readFileSync(rescueFile, "utf8"));
  assert.equal(rescueOutcome?.outcome, "selected");
  assert.equal(rescueOutcome?.optionId, "allow", "rescue must approve the tool call");

  const reviewFile = path.join(dir, "review-outcome.json");
  await spawn("review", {}, {
    MOCK_ACP_REQUEST_PERMISSION: "1",
    MOCK_ACP_PERMISSION_OUTCOME_FILE: reviewFile,
    MOCK_ACP_REPLY: "VERDICT: PASS",
  });
  const reviewOutcome = JSON.parse(readFileSync(reviewFile, "utf8"));
  assert.equal(reviewOutcome?.outcome, "selected");
  assert.equal(reviewOutcome?.optionId, "reject", "review must deny the tool call, never approve");
});

test("spawnKimi re-throws a spawn failure (binary not found) with the original code", async () => {
  __resetKimiCapabilityCache();
  await assert.rejects(
    () => spawnKimi(resolveProfile("review"), { binary: "/nonexistent/kimi-xyz", promptText: "Review this scope.", timeoutMs: 5000 }),
    (e) => e.code === "ENOENT" || /spawn|ENOENT/.test(e.message),
  );
});
