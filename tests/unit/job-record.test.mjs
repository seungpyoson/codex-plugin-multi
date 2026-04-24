// T7.4 — JobRecord schema tests (spec §21.3).
//
// These assertions enforce ONE canonical record shape, persisted and
// returned identically from foreground/background/cmdResult. Every extra
// field or missing field is a test failure — drift is how we got three
// different shapes in the first place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import {
  buildJobRecord,
  EXPECTED_KEYS,
  SCHEMA_VERSION,
} from "../../plugins/claude/scripts/lib/job-record.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = resolvePath(HERE, "..", "..",
  "plugins/claude/skills/claude-result-handling/SKILL.md");

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const CLAUDE_UUID = "11111111-2222-4333-8444-555555555555";

// Helper — minimal valid invocation captured at cmdRun entry.
function makeInvocation(overrides = {}) {
  return {
    job_id: UUID,
    target: "claude",
    parent_job_id: null,
    resume_chain: [],
    mode_profile_name: "review",
    mode: "review",
    model: "claude-haiku-4-5-20251001",
    cwd: "/tmp/src",
    workspace_root: "/tmp/src",
    containment: "worktree",
    scope: "working-tree",
    dispose_effective: true,
    scope_base: null,
    scope_paths: null,
    prompt_head: "review: x=1",
    schema_spec: null,
    binary: "claude",
    started_at: "2026-04-24T12:00:00.000Z",
    ...overrides,
  };
}

function makePidInfo() {
  return { pid: 12345, starttime: "Thu Apr 24 12:00:00 2026", argv0: "claude" };
}

test("EXPECTED_KEYS is the spec §21.3 canonical list", () => {
  const required = [
    "id", "job_id", "target", "parent_job_id", "claude_session_id",
    "resume_chain", "pid_info",
    "mode", "mode_profile_name", "model", "cwd", "workspace_root",
    "containment", "scope", "dispose_effective", "scope_base", "scope_paths",
    "prompt_head", "schema_spec", "binary",
    "status", "started_at", "ended_at", "exit_code", "error_code", "error_message",
    "result", "structured_output", "permission_denials", "mutations",
    "cost_usd", "usage",
    "schema_version",
  ];
  assert.deepEqual([...EXPECTED_KEYS].sort(), required.sort());
});

test("buildJobRecord: foreground success path has EXACTLY the expected keys", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: 0,
    parsed: { ok: true, sessionId: CLAUDE_UUID, result: "done", structured: null, denials: [],
      costUsd: 0.001, usage: { input_tokens: 10 } },
    pidInfo: makePidInfo(),
    claudeSessionId: CLAUDE_UUID,
    stdout: "", stderr: "",
  }, []);

  assert.deepEqual(Object.keys(rec).sort(), [...EXPECTED_KEYS].sort(),
    "JobRecord keys must match EXPECTED_KEYS exactly — no drift");

  assert.equal(rec.status, "completed");
  assert.equal(rec.result, "done");
  assert.equal(rec.structured_output, null);
  assert.deepEqual(rec.permission_denials, []);
  assert.deepEqual(rec.mutations, []);
  assert.equal(rec.prompt_head, "review: x=1");
  assert.equal("prompt" in rec, false,
    "§21.3.1 forbids a full `prompt` field on persisted records");
  assert.equal(rec.claude_session_id, CLAUDE_UUID,
    "claude_session_id must come from execution, never minted here");
  assert.equal(rec.cost_usd, 0.001);
  assert.equal(rec.exit_code, 0);
  assert.equal(rec.error_code, null);
  assert.equal(rec.error_message, null);
  assert.equal(rec.schema_version, SCHEMA_VERSION);
  assert.equal(rec.id, rec.job_id, "id is legacy alias for job_id");
});

test("buildJobRecord: queued/pre-run state (no execution)", () => {
  const rec = buildJobRecord(makeInvocation(), null, []);
  assert.deepEqual(Object.keys(rec).sort(), [...EXPECTED_KEYS].sort());
  assert.equal(rec.status, "queued");
  assert.equal(rec.result, null);
  assert.equal(rec.structured_output, null);
  assert.deepEqual(rec.permission_denials, []);
  assert.deepEqual(rec.mutations, []);
  assert.equal(rec.ended_at, null);
  assert.equal(rec.exit_code, null);
  assert.equal(rec.cost_usd, null);
  assert.equal(rec.usage, null);
  assert.equal(rec.pid_info, null);
  assert.equal(rec.claude_session_id, null);
  assert.equal(rec.error_code, null);
  assert.equal(rec.error_message, null);
});

test("buildJobRecord: failure path — claude exited non-zero", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: 1,
    parsed: { ok: false, reason: "is_error", result: "partial output",
      structured: null, denials: [], costUsd: null, usage: null },
    pidInfo: makePidInfo(),
    claudeSessionId: null,
    stdout: "", stderr: "",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "claude_error");
  assert.equal(rec.exit_code, 1);
  // Readable stdout can still ride along on a failure.
  assert.equal(rec.result, "partial output");
});

test("buildJobRecord: spawn_failed path (execution threw before claude)", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: null,
    parsed: null,
    pidInfo: null,
    claudeSessionId: null,
    errorMessage: "spawn claude ENOENT",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "spawn_failed");
  assert.equal(rec.error_message, "spawn claude ENOENT");
  assert.equal(rec.result, null);
});

test("buildJobRecord: parse_error path (claude returned unparsable stdout)", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: 0,
    parsed: { ok: false, reason: "json_parse_error", result: null,
      structured: null, denials: [] },
    pidInfo: makePidInfo(),
    claudeSessionId: null,
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "parse_error");
});

test("buildJobRecord: mutations pass through verbatim", () => {
  const mutations = ["M foo.md", "?? bar.js"];
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: 0,
    parsed: { ok: true, sessionId: CLAUDE_UUID, result: "done", structured: null, denials: [],
      costUsd: null, usage: null },
    pidInfo: makePidInfo(),
    claudeSessionId: CLAUDE_UUID,
  }, mutations);
  assert.deepEqual(rec.mutations, mutations);
  assert.equal("warning" in rec, false,
    "No top-level warning field — consumers derive from mutations.length");
});

test("buildJobRecord: structured_output populated when schema run succeeded", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: 0,
    parsed: {
      ok: true, sessionId: CLAUDE_UUID, result: "",
      structured: { verdict: "approve", summary: "ok", findings: [] },
      denials: [],
      costUsd: 0.002, usage: { input_tokens: 20 },
    },
    pidInfo: makePidInfo(),
    claudeSessionId: CLAUDE_UUID,
  }, []);
  assert.deepEqual(rec.structured_output, {
    verdict: "approve", summary: "ok", findings: [],
  });
  assert.equal(rec.result, "");
});

test("buildJobRecord: record is frozen", () => {
  const rec = buildJobRecord(makeInvocation(), null, []);
  assert.equal(Object.isFrozen(rec), true,
    "JobRecord must be frozen so callers can't silently mutate fields");
});

test("buildJobRecord: rejects invocation with a `prompt` field (defense in depth)", () => {
  assert.throws(
    () => buildJobRecord(
      makeInvocation({ prompt: "this should never be persisted" }),
      null,
      [],
    ),
    /prompt/i,
    "Passing a full `prompt` in invocation MUST throw — §21.3.1",
  );
});

// T7.7 C1 / B1 — §21.1 invariant: claude_session_id must be echoed by Claude
// or be null. NEVER fall back to resumeId or jobId. These three tests enforce
// the class-of-problem: no silent identity substitution across types.
test("T7.7 B1: buildJobRecord rejects claudeSessionId when parsed.sessionId was not echoed", () => {
  // Parse failed (empty stdout) → parsed.sessionId is null. Passing a non-null
  // claudeSessionId here is the legacy ?? resumeId ?? jobId fallback that
  // §21.1 forbids. Must throw.
  assert.throws(
    () => buildJobRecord(makeInvocation(), {
      exitCode: 0,
      parsed: { ok: false, reason: "empty_stdout", sessionId: null,
        result: null, structured: null, denials: [] },
      pidInfo: makePidInfo(),
      // Legacy fallback would have plugged in resumeId or jobId here.
      claudeSessionId: "99999999-8888-4777-8666-555555555555",
    }, []),
    /§21\.1|identity|fallback|parsed\.sessionId/i,
    "§21.1: claudeSessionId MUST equal parsed.sessionId (or both null) — no cross-type fallback",
  );
});

test("T7.7 B1: buildJobRecord accepts claudeSessionId that matches parsed.sessionId", () => {
  // Positive baseline — parsed.sessionId echoed by Claude, companion carries
  // the same value through. This is the canonical happy path.
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: 0,
    parsed: { ok: true, sessionId: CLAUDE_UUID, result: "done",
      structured: null, denials: [], costUsd: null, usage: null },
    pidInfo: makePidInfo(),
    claudeSessionId: CLAUDE_UUID,
  }, []);
  assert.equal(rec.claude_session_id, CLAUDE_UUID);
});

test("T7.7 B1: buildJobRecord accepts null claudeSessionId when parsed.sessionId is null (parse-failure case)", () => {
  // Valid state: Claude's stdout unparseable → parsed.sessionId=null →
  // companion persists claude_session_id=null. Record still builds.
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: 2,
    parsed: { ok: false, reason: "json_parse_error", sessionId: null,
      result: null, structured: null, denials: [] },
    pidInfo: makePidInfo(),
    claudeSessionId: null,
  }, []);
  assert.equal(rec.claude_session_id, null);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "parse_error");
});

test("schema parity — every EXPECTED_KEYS field is documented in claude-result-handling/SKILL.md", () => {
  const skillText = readFileSync(SKILL_MD, "utf8");
  const missing = [];
  for (const key of EXPECTED_KEYS) {
    // Look for the bare key name somewhere in the doc; a loose but effective
    // drift check. If the field was renamed or removed from docs, this fails.
    const pattern = new RegExp(`\\b${key.replace(/_/g, "_")}\\b`);
    if (!pattern.test(skillText)) missing.push(key);
  }
  assert.deepEqual(missing, [],
    `claude-result-handling/SKILL.md must mention every JobRecord field. Missing: ${missing.join(", ")}`);
});
