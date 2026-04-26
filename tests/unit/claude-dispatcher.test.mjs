import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildClaudeArgs,
  parseClaudeResult,
  spawnClaude,
  _internal,
} from "../../plugins/claude/scripts/lib/claude.mjs";
import { resolveProfile } from "../../plugins/claude/scripts/lib/mode-profiles.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOCK = path.join(REPO_ROOT, "tests/smoke/claude-mock.mjs");

const UUID = "550e8400-e29b-41d4-a716-446655440000";

test("buildClaudeArgs: review mode passes --disallowedTools + plan + setting-sources", () => {
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "hi",
    sessionId: UUID,
  });
  assert.ok(args.includes("--permission-mode"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(args.includes("--disallowedTools"));
  const disallowed = args[args.indexOf("--disallowedTools") + 1];
  for (const t of ["Write", "Edit", "Bash", "mcp__*", "Agent"]) {
    assert.ok(disallowed.includes(t), `expected "${t}" in disallowed list; got "${disallowed}"`);
  }
  assert.ok(args.includes("--setting-sources"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
});

test("buildClaudeArgs: rescue mode uses acceptEdits, no disallowedTools", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-opus-4-7",
    promptText: "fix it",
    sessionId: UUID,
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(!args.includes("--disallowedTools"));
});

test("buildClaudeArgs: adversarial-review mirrors review", () => {
  const args = buildClaudeArgs(resolveProfile("adversarial-review"), {
    model: "claude-sonnet-4-6",
    promptText: "challenge",
    sessionId: UUID,
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(args.includes("--disallowedTools"));
});

test("buildClaudeArgs: --json-schema passed for review when supplied", () => {
  const schema = '{"type":"object"}';
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001", promptText: "x",
    sessionId: UUID, jsonSchema: schema,
  });
  assert.ok(args.includes("--json-schema"));
  assert.equal(args[args.indexOf("--json-schema") + 1], schema);
});

test("buildClaudeArgs: --add-dir scoped to provided path", () => {
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001", promptText: "x",
    sessionId: UUID, addDirPath: "/tmp/some/dir",
  });
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/some/dir");
});

test("buildClaudeArgs: rescue profile omits --setting-sources (strip_context=false lives in the profile)", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-opus-4-7", promptText: "hi",
    sessionId: UUID,
  });
  assert.ok(!args.includes("--setting-sources"));
});

test("buildClaudeArgs: rejects non-UUIDv4 session IDs", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("review"), {
      model: "claude-haiku-4-5-20251001",
      promptText: "x", sessionId: "not-a-uuid",
    }),
    /UUID v4/
  );
});

test("buildClaudeArgs: resumeId emits --resume and omits --session-id", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "continue work", sessionId: UUID,
    resumeId: "11111111-2222-4333-8444-555555555555",
  });
  assert.ok(args.includes("--resume"));
  assert.ok(!args.includes("--session-id"));
  const idx = args.indexOf("--resume");
  assert.equal(args[idx + 1], "11111111-2222-4333-8444-555555555555");
});

test("buildClaudeArgs: rejects non-UUIDv4 resumeId", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("rescue"), {
      model: "claude-haiku-4-5-20251001",
      promptText: "x", sessionId: UUID, resumeId: "not-a-uuid",
    }),
    /resumeId must be UUID v4/
  );
});

test("resolveProfile: rejects unknown mode", () => {
  assert.throws(
    () => resolveProfile("chaos"),
    /unknown mode|unknown profile/i,
  );
});

test("buildClaudeArgs: rejects empty prompt", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("review"), {
      model: "claude-haiku-4-5-20251001",
      promptText: "", sessionId: UUID,
    }),
    /promptText is required/
  );
});

test("buildClaudeArgs: requires model (no alias fallback)", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("review"), {
      model: "", promptText: "x", sessionId: UUID,
    }),
    /model is required/
  );
});

test("buildClaudeArgs: rejects invalid profile shapes and ignores disabled optional inputs", () => {
  assert.throws(() => buildClaudeArgs(null, {}), /mode profile object/);
  assert.throws(
    () => buildClaudeArgs({ name: "bad" }, { promptText: "x", model: "m", sessionId: UUID }),
    /missing required field/,
  );

  const pingArgs = buildClaudeArgs(resolveProfile("ping"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "ping",
    sessionId: UUID,
    addDirPath: "/tmp/ignored",
    jsonSchema: '{"type":"object"}',
  });
  assert.ok(!pingArgs.includes("--add-dir"));
  assert.ok(!pingArgs.includes("--json-schema"));
});

test("parseClaudeResult: empty stdout returns error", () => {
  const r = parseClaudeResult("");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_stdout");
});

test("parseClaudeResult: malformed JSON returns error", () => {
  const r = parseClaudeResult("not json");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "json_parse_error");
});

test("parseClaudeResult: prefers structured_output when present", () => {
  const payload = JSON.stringify({
    type: "result", is_error: false,
    result: "",
    structured_output: { verdict: "approve", summary: "ok", findings: [] },
    session_id: UUID,
    permission_denials: [],
  });
  const r = parseClaudeResult(payload);
  assert.equal(r.ok, true);
  assert.deepEqual(r.structured, { verdict: "approve", summary: "ok", findings: [] });
});

test("parseClaudeResult: surfaces permission_denials", () => {
  const payload = JSON.stringify({
    type: "result", is_error: false,
    result: "refused",
    session_id: UUID,
    permission_denials: [{ tool: "Bash", reason: "blocked" }],
  });
  const r = parseClaudeResult(payload);
  assert.equal(r.denials.length, 1);
  assert.equal(r.denials[0].tool, "Bash");
});

test("parseClaudeResult: covers non-string result, newline JSON, and optional metadata defaults", () => {
  const r = parseClaudeResult([
    "debug line",
    JSON.stringify({
      type: "result",
      is_error: true,
      result: { not: "text" },
      session_id: null,
      permission_denials: "not-array",
      apiKeySource: "oauth",
      usage: { input_tokens: 1 },
      total_cost_usd: 0.25,
    }),
  ].join("\n"));

  assert.equal(r.ok, false);
  assert.equal(r.result, null);
  assert.deepEqual(r.denials, []);
  assert.equal(r.apiKeySource, "oauth");
  assert.deepEqual(r.usage, { input_tokens: 1 });
  assert.equal(r.costUsd, 0.25);
});

test("spawnClaude: returns claudeSessionId from stdout and pidInfo tuple", async () => {
  const result = await spawnClaude(resolveProfile("rescue"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "hello",
    sessionId: UUID,
    binary: MOCK,
  });
  assert.equal(result.exitCode, 0, `mock exited ${result.exitCode}: ${result.stderr}`);
  // Claude echoes back --session-id as session_id; mock does the same.
  assert.equal(result.claudeSessionId, UUID,
    "claudeSessionId must come from parsed.session_id, not what we sent");
  // sessionIdSent preserves what we passed (legacy name was `sessionId`).
  assert.equal(result.sessionIdSent, UUID);
  // pidInfo tuple captured at spawn.
  assert.ok(result.pidInfo, "pidInfo must be present");
  assert.equal(typeof result.pidInfo.pid, "number");
  // pidInfo.starttime / argv0 may be null if the child exited too fast to
  // capture (normal for this tiny mock) — we accept a `capture_error` record
  // but the pid itself is always present.
  assert.ok(
    "starttime" in result.pidInfo && "argv0" in result.pidInfo,
    "pidInfo always has starttime/argv0 keys (may be null)"
  );
});

test("_internal.isUuidV4: accepts/rejects expected cases", () => {
  assert.equal(_internal.isUuidV4(UUID), true);
  assert.equal(_internal.isUuidV4("not-a-uuid"), false);
  // v1 UUID (time-based) should be rejected — Claude requires v4.
  assert.equal(_internal.isUuidV4("550e8400-e29b-11d4-a716-446655440000"), false);
});
