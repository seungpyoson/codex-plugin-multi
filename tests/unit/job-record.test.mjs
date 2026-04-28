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
import {
  buildJobRecord as buildGeminiJobRecord,
  SCHEMA_VERSION as GEMINI_SCHEMA_VERSION,
} from "../../plugins/gemini/scripts/lib/job-record.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = resolvePath(HERE, "..", "..",
  "plugins/claude/skills/claude-result-handling/SKILL.md");

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const CLAUDE_UUID = "11111111-2222-4333-8444-555555555555";
const GEMINI_UUID = "22222222-3333-4444-9555-666666666666";

test("JobRecord schema_version is bumped for gemini_session_id parity", () => {
  assert.equal(SCHEMA_VERSION, 6);
  assert.equal(GEMINI_SCHEMA_VERSION, 6);
});

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
    "id", "job_id", "target", "parent_job_id", "claude_session_id", "gemini_session_id",
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
    parsed: { ok: true, result: "done", structured: null, denials: [],
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
  assert.equal(rec.gemini_session_id, null);
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
  assert.equal(rec.gemini_session_id, null);
  assert.equal(rec.error_code, null);
  assert.equal(rec.error_message, null);
});

test("buildJobRecord: status=cancelled short-circuit forces lifecycle override (issue #22 sub-task 2)", () => {
  // The companion's cancel-marker path passes status="cancelled" so a
  // target CLI that traps SIGTERM and exits 0 with valid JSON output is
  // still classified as cancelled — without this short-circuit,
  // classifyExecution would see a successful exit and emit "completed",
  // silently losing the operator's cancel intent.
  const rec = buildJobRecord(makeInvocation(), {
    status: "cancelled",
    exitCode: 0,
    parsed: { ok: true, result: "partial output before SIGTERM trap exit",
      structured: null, denials: [], costUsd: 0.001 },
    pidInfo: makePidInfo(),
    claudeSessionId: CLAUDE_UUID,
  }, []);
  assert.equal(rec.status, "cancelled");
  assert.equal(rec.error_code, null);
  assert.equal(rec.error_message, null);
  assert.equal(rec.exit_code, 0,
    "exit_code is preserved as captured even when status is forced to cancelled");
  // result is also preserved — the partial output the target managed to
  // emit before its SIGTERM-handler exited is still the truth on disk.
  assert.equal(rec.result, "partial output before SIGTERM trap exit");
});

test("gemini buildJobRecord: status=cancelled mirror", () => {
  const rec = buildGeminiJobRecord(
    makeInvocation({ target: "gemini", binary: "gemini" }),
    {
      status: "cancelled",
      exitCode: 0,
      parsed: { ok: true, result: "x", structured: null, denials: [] },
      pidInfo: makePidInfo(),
      geminiSessionId: GEMINI_UUID,
    }, []);
  assert.equal(rec.status, "cancelled");
  assert.equal(rec.error_code, null);
});

test("buildJobRecord: running state preserves pid_info and has no end time", () => {
  const pidInfo = { pid: 12345, starttime: "Thu Apr 24 12:00:00 2026", argv0: "claude" };
  const rec = buildJobRecord(makeInvocation(), {
    status: "running",
    exitCode: null,
    parsed: null,
    pidInfo,
    claudeSessionId: null,
  }, []);
  assert.deepEqual(Object.keys(rec).sort(), [...EXPECTED_KEYS].sort());
  assert.equal(rec.status, "running");
  assert.deepEqual(rec.pid_info, pidInfo);
  assert.equal(rec.ended_at, null);
  assert.equal(rec.exit_code, null);
  assert.equal(rec.result, null);
  assert.equal(rec.error_code, null);
  assert.equal(rec.error_message, null);
});

test("buildJobRecord: gemini success path stores gemini_session_id, not claude_session_id", () => {
  const rec = buildJobRecord(makeInvocation({
    target: "gemini",
    model: "gemini-3-flash-preview",
    binary: "gemini",
  }), {
    exitCode: 0,
    parsed: { ok: true, result: "done", structured: null, denials: [],
      costUsd: null, usage: { totalTokenCount: 10 } },
    pidInfo: { pid: 12345, starttime: "Thu Apr 24 12:00:00 2026", argv0: "gemini" },
    geminiSessionId: GEMINI_UUID,
    stdout: "", stderr: "",
  }, []);

  assert.deepEqual(Object.keys(rec).sort(), [...EXPECTED_KEYS].sort());
  assert.equal(rec.target, "gemini");
  assert.equal(rec.claude_session_id, null);
  assert.equal(rec.gemini_session_id, GEMINI_UUID,
    "gemini_session_id must come from Gemini JSON stdout, never from companion UUIDs");
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

test("gemini buildJobRecord: failure path uses gemini_error, not claude_error", () => {
  const rec = buildGeminiJobRecord(makeInvocation({
    target: "gemini",
    model: "gemini-3-flash-preview",
    binary: "gemini",
  }), {
    exitCode: 1,
    parsed: { ok: false, reason: "is_error", result: "partial output",
      structured: null, denials: [], costUsd: null, usage: null },
    pidInfo: { pid: 12345, starttime: "Thu Apr 24 12:00:00 2026", argv0: "gemini" },
    geminiSessionId: null,
    stdout: "", stderr: "",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "gemini_error");
});

test("gemini buildJobRecord: queued, success, and structured output paths", () => {
  const invocation = makeInvocation({
    target: "gemini",
    model: "gemini-3-flash-preview",
    binary: "gemini",
  });
  const queued = buildGeminiJobRecord(invocation, null, []);
  assert.deepEqual(Object.keys(queued).sort(), [...EXPECTED_KEYS].sort());
  assert.equal(queued.status, "queued");
  assert.equal(queued.claude_session_id, null);
  assert.equal(queued.gemini_session_id, null);

  const pidInfo = { pid: 12345, starttime: "Thu Apr 24 12:00:00 2026", argv0: "gemini" };
  const running = buildGeminiJobRecord(invocation, {
    status: "running",
    exitCode: null,
    parsed: null,
    pidInfo,
    geminiSessionId: null,
  }, []);
  assert.equal(running.status, "running");
  assert.deepEqual(running.pid_info, pidInfo);
  assert.equal(running.ended_at, null);

  const completed = buildGeminiJobRecord(invocation, {
    exitCode: 0,
    parsed: {
      ok: true,
      result: "",
      structured: { verdict: "pass" },
      denials: ["Write"],
      costUsd: 0.5,
      usage: { totalTokenCount: 42 },
    },
    pidInfo: { pid: 12345, starttime: "Thu Apr 24 12:00:00 2026", argv0: "gemini" },
    geminiSessionId: GEMINI_UUID,
  }, ["M file.txt"]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.gemini_session_id, GEMINI_UUID);
  assert.deepEqual(completed.structured_output, { verdict: "pass" });
  assert.deepEqual(completed.permission_denials, ["Write"]);
  assert.deepEqual(completed.mutations, ["M file.txt"]);
  assert.equal(completed.cost_usd, 0.5);
  assert.deepEqual(completed.usage, { totalTokenCount: 42 });
});

test("gemini buildJobRecord: spawn, parse, and prompt-defense paths", () => {
  const invocation = makeInvocation({
    target: "gemini",
    model: "gemini-3-flash-preview",
    binary: "gemini",
  });
  const spawnFailed = buildGeminiJobRecord(invocation, {
    exitCode: null,
    parsed: null,
    pidInfo: null,
    geminiSessionId: null,
    errorMessage: "spawn gemini ENOENT",
  }, []);
  assert.equal(spawnFailed.status, "failed");
  assert.equal(spawnFailed.error_code, "spawn_failed");
  assert.equal(spawnFailed.error_message, "spawn gemini ENOENT");

  const parseFailed = buildGeminiJobRecord(invocation, {
    exitCode: 0,
    parsed: { ok: false, reason: "json_parse_error", result: null, structured: null, denials: [] },
    pidInfo: null,
    geminiSessionId: null,
  }, []);
  assert.equal(parseFailed.status, "failed");
  assert.equal(parseFailed.error_code, "parse_error");

  assert.throws(
    () => buildGeminiJobRecord(makeInvocation({ ...invocation, prompt: "secret" }), null, []),
    /prompt/i,
  );
});

test("gemini buildJobRecord: default, validation, and non-parse failure branches", () => {
  const invocation = makeInvocation({
    target: "gemini",
    parent_job_id: undefined,
    resume_chain: undefined,
    model: "gemini-3-flash-preview",
    binary: "gemini",
    dispose_effective: undefined,
    scope_base: undefined,
    scope_paths: undefined,
    schema_spec: undefined,
  });
  const queued = buildGeminiJobRecord(invocation, null, []);
  assert.equal(queued.parent_job_id, null);
  assert.deepEqual(queued.resume_chain, []);
  assert.equal(queued.dispose_effective, false);
  assert.equal(queued.scope_base, null);
  assert.equal(queued.scope_paths, null);
  assert.equal(queued.schema_spec, null);
  assert.equal(Object.isFrozen(queued), true);

  const noParsed = buildGeminiJobRecord(invocation, {
    exitCode: 2,
    parsed: null,
    pidInfo: null,
    geminiSessionId: null,
  }, []);
  assert.equal(noParsed.status, "failed");
  assert.equal(noParsed.error_code, "gemini_error");
  assert.equal(noParsed.error_message, null);

  const emptyStdout = buildGeminiJobRecord(invocation, {
    exitCode: 0,
    parsed: { ok: false, reason: "empty_stdout", error: "no output", denials: "bad" },
    pidInfo: null,
    geminiSessionId: null,
  }, []);
  assert.equal(emptyStdout.error_code, "parse_error");
  assert.equal(emptyStdout.error_message, "no output");
  assert.deepEqual(emptyStdout.permission_denials, []);

  const targetError = buildGeminiJobRecord(invocation, {
    exitCode: 0,
    parsed: { ok: false, reason: "is_error", error: "blocked", result: null, structured: null, denials: [] },
    pidInfo: null,
    geminiSessionId: null,
  }, []);
  assert.equal(targetError.error_code, "gemini_error");
  assert.equal(targetError.error_message, "blocked");

  const missingMode = makeInvocation(invocation);
  delete missingMode.mode;
  assert.throws(() => buildGeminiJobRecord(null, null, []), /invocation object required/);
  assert.throws(() => buildGeminiJobRecord(missingMode, null, []), /missing required field "mode"/);
  assert.throws(() => buildGeminiJobRecord(invocation, null, null), /mutations must be an array/);
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
    parsed: { ok: true, result: "done", structured: null, denials: [],
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
      ok: true, result: "",
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

test("buildJobRecord: validates invocation shape and mutation array", () => {
  const missingJob = makeInvocation();
  delete missingJob.job_id;
  assert.throws(() => buildJobRecord(null, null, []), /invocation object required/);
  assert.throws(
    () => buildJobRecord(missingJob, null, []),
    /missing required field "job_id"/,
  );
  assert.throws(
    () => buildJobRecord(makeInvocation(), null, null),
    /mutations must be an array/,
  );
});

test("buildJobRecord: non-parse failures classify as target errors or unknown", () => {
  const noParsed = buildJobRecord(makeInvocation(), {
    exitCode: 2,
    parsed: null,
    pidInfo: makePidInfo(),
    claudeSessionId: null,
  }, []);
  assert.equal(noParsed.status, "failed");
  assert.equal(noParsed.error_code, "claude_error");
  assert.equal(noParsed.error_message, null);

  const parsedTargetError = buildJobRecord(makeInvocation(), {
    exitCode: 0,
    parsed: { ok: false, reason: "is_error", error: "tool denied", result: null, structured: null, denials: [] },
    pidInfo: makePidInfo(),
    claudeSessionId: null,
  }, []);
  assert.equal(parsedTargetError.error_code, "claude_error");
  assert.equal(parsedTargetError.error_message, "tool denied");
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
