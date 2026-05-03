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
  EXPECTED_KEYS as GEMINI_EXPECTED_KEYS,
  SCHEMA_VERSION as GEMINI_SCHEMA_VERSION,
} from "../../plugins/gemini/scripts/lib/job-record.mjs";
import {
  buildJobRecord as buildKimiJobRecord,
  EXPECTED_KEYS as KIMI_EXPECTED_KEYS,
  SCHEMA_VERSION as KIMI_SCHEMA_VERSION,
} from "../../plugins/kimi/scripts/lib/job-record.mjs";
import {
  buildExternalReview,
  EXTERNAL_REVIEW_KEYS,
  SOURCE_CONTENT_TRANSMISSION,
  sourceContentTransmissionForExecution,
} from "../../plugins/claude/scripts/lib/external-review.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = resolvePath(HERE, "..", "..",
  "plugins/claude/skills/claude-result-handling/SKILL.md");
const EXTERNAL_REVIEW_SKILL_MDS = [
  SKILL_MD,
  resolvePath(HERE, "..", "..", "plugins/claude/skills/claude-delegation/SKILL.md"),
  resolvePath(HERE, "..", "..", "plugins/gemini/skills/gemini-delegation/SKILL.md"),
  resolvePath(HERE, "..", "..", "plugins/kimi/skills/kimi-delegation/SKILL.md"),
  resolvePath(HERE, "..", "..", "plugins/api-reviewers/skills/api-reviewers-delegation/SKILL.md"),
];

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const CLAUDE_UUID = "11111111-2222-4333-8444-555555555555";
const GEMINI_UUID = "22222222-3333-4444-9555-666666666666";

function sentButNoCleanResult(provider) {
  return `Selected source content was sent to ${provider} for external review, but the run ended before a clean result was produced.`;
}

function sentButCancelled(provider) {
  return `Selected source content was sent to ${provider} for external review; the operator cancelled the run before it completed.`;
}

function notSentCancelled(provider) {
  return `Selected source content was not sent to ${provider}; the operator cancelled the run before the target process was started.`;
}

function notSentScopeRejected(provider) {
  return `Selected source content was not sent to ${provider}; the review scope was rejected before the target process was started.`;
}

function notSentSpawnFailed(provider) {
  return `Selected source content was not sent to ${provider}; the target process was not spawned.`;
}

test("JobRecord schema_version is bumped for external review provenance", () => {
  assert.equal(SCHEMA_VERSION, 9);
  assert.equal(GEMINI_SCHEMA_VERSION, 9);
  assert.equal(KIMI_SCHEMA_VERSION, 9);
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
    run_kind: "foreground",
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

test("external_review sub-fields have a canonical list and validated transmission enum", () => {
  const review = buildExternalReview({
    invocation: makeInvocation(),
    sessionId: CLAUDE_UUID,
    status: "completed",
    errorCode: null,
    sourceContentTransmission: SOURCE_CONTENT_TRANSMISSION.SENT,
  });
  assert.deepEqual(Object.keys(review), [...EXTERNAL_REVIEW_KEYS]);
  assert.throws(() => buildExternalReview({
    invocation: makeInvocation(),
    status: "completed",
    sourceContentTransmission: "senttt",
  }), /invalid sourceContentTransmission/);
});

test("external_review treats known post-spawn failure codes as sent", () => {
  assert.equal(sourceContentTransmissionForExecution({
    status: "failed",
    errorCode: "step_limit_exceeded",
    pidInfo: makePidInfo(),
  }), SOURCE_CONTENT_TRANSMISSION.SENT);
});

test("EXPECTED_KEYS is the spec §21.3 canonical list", () => {
  const required = [
    "id", "job_id", "target", "parent_job_id", "claude_session_id", "gemini_session_id", "kimi_session_id",
    "resume_chain", "pid_info",
    "mode", "mode_profile_name", "model", "cwd", "workspace_root",
    "containment", "scope", "dispose_effective", "scope_base", "scope_paths",
    "prompt_head", "schema_spec", "binary",
    "status", "started_at", "ended_at", "exit_code", "error_code", "error_message",
    "error_summary", "error_cause", "suggested_action", "external_review", "disclosure_note",
    "result", "structured_output", "permission_denials", "mutations",
    "cost_usd", "usage",
    "schema_version",
  ];
  assert.deepEqual([...EXPECTED_KEYS].sort(), required.sort());
});

test("provider EXPECTED_KEYS stay byte-for-byte aligned", () => {
  assert.deepEqual([...GEMINI_EXPECTED_KEYS], [...EXPECTED_KEYS]);
  assert.deepEqual([...KIMI_EXPECTED_KEYS], [...EXPECTED_KEYS]);
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
  assert.deepEqual(rec.external_review, {
    marker: "EXTERNAL REVIEW",
    provider: "Claude Code",
    run_kind: "foreground",
    job_id: rec.job_id,
    session_id: CLAUDE_UUID,
    parent_job_id: null,
    mode: "review",
    scope: "working-tree",
    scope_base: null,
    scope_paths: null,
    source_content_transmission: "sent",
    disclosure: "Selected source content was sent to Claude Code for external review.",
  });
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
  assert.equal(
    rec.external_review.disclosure,
    "Selected source content may be sent to Claude Code for external review.",
  );
  assert.equal(rec.external_review.source_content_transmission, "may_be_sent");
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
  assert.equal(rec.external_review.source_content_transmission, "sent");
  assert.equal(rec.external_review.disclosure, sentButCancelled("Claude Code"));
});

test("buildJobRecord: pre-spawn cancelled records mark source content not sent", () => {
  const rec = buildJobRecord(makeInvocation(), {
    status: "cancelled",
    exitCode: null,
    parsed: null,
    pidInfo: null,
    claudeSessionId: null,
  }, []);
  assert.equal(rec.status, "cancelled");
  assert.equal(rec.external_review.source_content_transmission, "not_sent");
  assert.equal(rec.external_review.disclosure, notSentCancelled("Claude Code"));
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
  assert.equal(rec.external_review.source_content_transmission, "sent");
  assert.equal(rec.external_review.disclosure, sentButCancelled("Gemini CLI"));
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
  assert.equal(rec.external_review.source_content_transmission, "sent");
  assert.equal(rec.external_review.disclosure, sentButNoCleanResult("Claude Code"));
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
  assert.equal(rec.external_review.source_content_transmission, "sent");
  assert.equal(rec.external_review.disclosure, sentButNoCleanResult("Gemini CLI"));
});

test("buildJobRecord: unsafe scope failures carry operator diagnostics", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: null,
    parsed: null,
    pidInfo: null,
    claudeSessionId: null,
    errorMessage: "unsafe_symlink: projects/memory resolves outside source root",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.equal(rec.error_message, "unsafe_symlink: projects/memory resolves outside source root");
  assert.match(rec.error_summary, /Review scope was rejected/);
  assert.match(rec.error_cause, /symlink/i);
  assert.match(rec.suggested_action, /branch-diff/);
  assert.match(rec.disclosure_note, /not spawned/);
  assert.match(rec.disclosure_note, /not sent/);
  assert.equal(
    rec.external_review.disclosure,
    notSentScopeRejected("Claude Code"),
  );
  assert.equal(rec.external_review.source_content_transmission, "not_sent");
});

test("gemini buildJobRecord: unsafe scope diagnostics mention provider disclosure", () => {
  const rec = buildGeminiJobRecord(makeInvocation({
    target: "gemini",
    model: "gemini-3-flash-preview",
    binary: "gemini",
  }), {
    exitCode: null,
    parsed: null,
    pidInfo: null,
    geminiSessionId: null,
    errorMessage: "scope_population_failed: cannot evaluate gitignored files for working-tree scope: bad index",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_summary, /Review scope was rejected/);
  assert.match(rec.error_cause, /gitignored files/);
  assert.match(rec.suggested_action, /working-tree/);
  assert.match(rec.disclosure_note, /not spawned/);
  assert.match(rec.disclosure_note, /external provider/);
  assert.equal(
    rec.external_review.disclosure,
    notSentScopeRejected("Gemini CLI"),
  );
  assert.equal(rec.external_review.source_content_transmission, "not_sent");
});

test("buildJobRecord: scope_base_missing provides targeted diagnostic", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
    errorMessage: "scope_base_missing: main is not a valid ref",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /unresolvable git ref/);
  assert.match(rec.suggested_action, /choose a valid base ref/);
});

test("buildJobRecord: scope_requires_git provides targeted diagnostic", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
    errorMessage: "scope_requires_git: not a git repo",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /requires a git repository/);
  assert.match(rec.suggested_action, /run from a git worktree/);
});

test("buildJobRecord: scope_requires_head provides targeted diagnostic", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
    errorMessage: "scope_requires_head: no commits yet",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /requires at least one commit/);
  assert.match(rec.suggested_action, /create an initial commit/);
});

test("buildJobRecord: scope_paths_required provides targeted diagnostic", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
    errorMessage: "scope_paths_required: custom scope needs paths",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /requires explicit paths/);
  assert.match(rec.suggested_action, /pass explicit --scope-paths/);
});

test("buildJobRecord: scope_empty provides targeted diagnostic", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: null,
    parsed: null,
    pidInfo: null,
    claudeSessionId: null,
    errorMessage: "scope_empty: branch-diff selected no files under /tmp/review-bundle",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /empty/i);
  assert.match(rec.suggested_action, /custom-review|--scope-paths/);
});

test("buildJobRecord: invalid_profile provides targeted diagnostic", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
    errorMessage: "invalid_profile: unknown profile setting",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /internally inconsistent/);
  assert.match(rec.suggested_action, /report this as a bug/i);
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
  assert.equal(spawnFailed.external_review.source_content_transmission, "not_sent");
  assert.equal(spawnFailed.external_review.disclosure, notSentSpawnFailed("Gemini CLI"));

  const parseFailed = buildGeminiJobRecord(invocation, {
    exitCode: 0,
    parsed: { ok: false, reason: "json_parse_error", result: null, structured: null, denials: [] },
    pidInfo: null,
    geminiSessionId: null,
  }, []);
  assert.equal(parseFailed.status, "failed");
  assert.equal(parseFailed.error_code, "parse_error");
  assert.equal(parseFailed.external_review.source_content_transmission, "sent");
  assert.equal(parseFailed.external_review.disclosure, sentButNoCleanResult("Gemini CLI"));

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
  assert.equal(noParsed.external_review.source_content_transmission, "sent");
  assert.equal(noParsed.external_review.disclosure, sentButNoCleanResult("Gemini CLI"));

  const emptyStdout = buildGeminiJobRecord(invocation, {
    exitCode: 0,
    parsed: { ok: false, reason: "empty_stdout", error: "no output", denials: "bad" },
    pidInfo: null,
    geminiSessionId: null,
  }, []);
  assert.equal(emptyStdout.error_code, "parse_error");
  assert.equal(emptyStdout.error_message, "no output");
  assert.equal(emptyStdout.external_review.source_content_transmission, "sent");
  assert.deepEqual(emptyStdout.permission_denials, []);

  const targetError = buildGeminiJobRecord(invocation, {
    exitCode: 0,
    parsed: { ok: false, reason: "is_error", error: "blocked", result: null, structured: null, denials: [] },
    pidInfo: null,
    geminiSessionId: null,
  }, []);
  assert.equal(targetError.error_code, "gemini_error");
  assert.equal(targetError.external_review.source_content_transmission, "sent");
  assert.equal(targetError.error_message, "blocked");
  assert.equal(targetError.external_review.disclosure, sentButNoCleanResult("Gemini CLI"));

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
  assert.equal(rec.external_review.source_content_transmission, "not_sent");
  assert.equal(rec.external_review.disclosure, notSentSpawnFailed("Claude Code"));
});

test("buildJobRecord: finalization_failed errorMessage classifies as finalization_failed (PR #21 review HIGH 1)", () => {
  // The companion's executeRun fallback synthesizes a record with
  // errorMessage="finalization_failed: meta=… ; state=…" when writeJobFile
  // or upsertJob fails. Previously this short-circuited to spawn_failed,
  // which lied about the cause: monitoring routed disk-full or lock-timeout
  // errors as missing-binary.
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: 0,
    parsed: { ok: true, result: "x", structured: null, denials: [] },
    pidInfo: makePidInfo(),
    claudeSessionId: CLAUDE_UUID,
    errorMessage: "finalization_failed: state=lock timeout after 5000ms",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "finalization_failed");
  assert.equal(rec.error_message,
    "finalization_failed: state=lock timeout after 5000ms");
  assert.equal(rec.external_review.disclosure, sentButNoCleanResult("Claude Code"));
});

test("gemini buildJobRecord: finalization_failed mirror", () => {
  const rec = buildGeminiJobRecord(
    makeInvocation({ target: "gemini", binary: "gemini" }),
    {
      exitCode: 0,
      parsed: { ok: true, result: "x", structured: null, denials: [] },
      pidInfo: makePidInfo(),
      geminiSessionId: GEMINI_UUID,
      errorMessage: "finalization_failed: meta=ENOSPC",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "finalization_failed");
  assert.equal(rec.external_review.disclosure, sentButNoCleanResult("Gemini CLI"));
});

test("buildJobRecord: signal-driven exit classifies as cancelled (#16 follow-up 2)", () => {
  // SIGTERM/SIGKILL with timedOut=false is operator cancel.
  for (const signal of ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]) {
    const rec = buildJobRecord(makeInvocation(), {
      exitCode: null,
      signal,
      timedOut: false,
      parsed: { ok: false, reason: "empty_stdout", result: null,
        structured: null, denials: [] },
      pidInfo: makePidInfo(),
      claudeSessionId: null,
    }, []);
    assert.equal(rec.status, "cancelled", `signal=${signal} must classify as cancelled`);
    assert.equal(rec.error_code, null);
    assert.equal(rec.error_message, null);
    assert.equal(rec.exit_code, null);
  }
});

test("buildJobRecord: timedOut wins over signal (timeout, not cancelled)", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: null,
    signal: "SIGTERM",
    timedOut: true,
    parsed: { ok: false, reason: "empty_stdout", result: null,
      structured: null, denials: [] },
    pidInfo: makePidInfo(),
    claudeSessionId: null,
  }, []);
  assert.equal(rec.status, "failed",
    "wall-clock timeouts must classify as failed/timeout, not cancelled");
  assert.equal(rec.error_code, "timeout");
  assert.equal(rec.external_review.disclosure, sentButNoCleanResult("Claude Code"));
});

test("kimi buildJobRecord: timeout diagnostics use Kimi target display name", () => {
  const rec = buildKimiJobRecord(makeInvocation({ target: "kimi", binary: "kimi" }), {
    exitCode: null,
    signal: "SIGTERM",
    timedOut: true,
    parsed: { ok: false, reason: "empty_stdout", result: null,
      structured: null, denials: [] },
    pidInfo: makePidInfo(),
    kimiSessionId: null,
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "timeout");
  assert.match(rec.error_summary, /^Kimi Code CLI timed out/);
  assert.match(rec.error_cause, /foreground Kimi process/);
  assert.match(rec.suggested_action, /check Kimi service status/);
  assert.match(rec.suggested_action, /run `kimi` interactively/);
  assert.equal(rec.external_review.disclosure, sentButNoCleanResult("Kimi Code CLI"));
});

test("kimi buildJobRecord: timeout diagnostics use Claude target display name", () => {
  const rec = buildKimiJobRecord(makeInvocation({ target: "claude", binary: "claude" }), {
    exitCode: null,
    signal: "SIGTERM",
    timedOut: true,
    parsed: { ok: false, reason: "empty_stdout", result: null,
      structured: null, denials: [] },
    pidInfo: makePidInfo(),
    kimiSessionId: null,
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "timeout");
  assert.match(rec.error_summary, /^Claude Code CLI timed out/);
  assert.match(rec.error_cause, /foreground Claude process/);
  assert.match(rec.suggested_action, /check Claude service status/);
  assert.match(rec.suggested_action, /run `claude` interactively/);
});

test("gemini buildJobRecord: signal-driven exit classifies as cancelled", () => {
  const rec = buildGeminiJobRecord(
    makeInvocation({ target: "gemini", binary: "gemini" }),
    {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      parsed: { ok: false, reason: "empty_stdout", result: null,
        structured: null, denials: [] },
      pidInfo: makePidInfo(),
      geminiSessionId: null,
    }, []);
  assert.equal(rec.status, "cancelled");
  assert.equal(rec.error_code, null);
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
  assert.equal(rec.external_review.source_content_transmission, "sent");
  assert.equal(rec.external_review.disclosure, sentButNoCleanResult("Claude Code"));
});

test("buildJobRecord: claude empty_stdout parse failure preserves parsed error", () => {
  const rec = buildJobRecord(makeInvocation(), {
    exitCode: 0,
    parsed: { ok: false, reason: "empty_stdout", error: "no output", denials: "bad" },
    pidInfo: null,
    claudeSessionId: null,
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "parse_error");
  assert.equal(rec.error_message, "no output");
  assert.deepEqual(rec.permission_denials, []);
  assert.equal(rec.external_review.disclosure, sentButNoCleanResult("Claude Code"));
});

test("buildJobRecord: claude optional invocation defaults are normalized", () => {
  const invocation = makeInvocation({
    parent_job_id: undefined,
    resume_chain: undefined,
    dispose_effective: undefined,
    scope_base: undefined,
    scope_paths: undefined,
    schema_spec: undefined,
  });
  const rec = buildJobRecord(invocation, null, []);
  assert.equal(rec.parent_job_id, null);
  assert.deepEqual(rec.resume_chain, []);
  assert.equal(rec.dispose_effective, false);
  assert.equal(rec.scope_base, null);
  assert.equal(rec.scope_paths, null);
  assert.equal(rec.schema_spec, null);
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
  assert.equal(noParsed.external_review.disclosure, sentButNoCleanResult("Claude Code"));

  const parsedTargetError = buildJobRecord(makeInvocation(), {
    exitCode: 0,
    parsed: { ok: false, reason: "is_error", error: "tool denied", result: null, structured: null, denials: [] },
    pidInfo: makePidInfo(),
    claudeSessionId: null,
  }, []);
  assert.equal(parsedTargetError.error_code, "claude_error");
  assert.equal(parsedTargetError.error_message, "tool denied");
  assert.equal(parsedTargetError.external_review.disclosure, sentButNoCleanResult("Claude Code"));
});

// --- Gemini-side targeted scope diagnostic tests (Finding 2 — provider disclosure coverage) ---

test("gemini buildJobRecord: scope_base_missing carries targeted base-ref diagnostic", () => {
  const rec = buildGeminiJobRecord(makeInvocation({ target: "gemini", binary: "gemini" }), {
    exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
    errorMessage: "scope_base_missing: the provided base ref abc123 does not exist",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /base ref/i);
  assert.match(rec.suggested_action, /--scope-base/);
  assert.match(rec.disclosure_note, /external provider/);
});

test("gemini buildJobRecord: scope_requires_git carries git-worktree diagnostic", () => {
  const rec = buildGeminiJobRecord(makeInvocation({ target: "gemini", binary: "gemini" }), {
    exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
    errorMessage: "scope_requires_git: current directory is not a git repository",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /git/i);
  assert.match(rec.suggested_action, /git worktree/i);
  assert.match(rec.disclosure_note, /external provider/);
});

test("gemini buildJobRecord: scope_requires_head carries initial-commit diagnostic", () => {
  const rec = buildGeminiJobRecord(makeInvocation({ target: "gemini", binary: "gemini" }), {
    exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
    errorMessage: "scope_requires_head: repository has no commits",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /HEAD/i);
  assert.match(rec.suggested_action, /initial commit/i);
  assert.match(rec.disclosure_note, /external provider/);
});

test("gemini buildJobRecord: scope_paths_required carries explicit-paths diagnostic", () => {
  const rec = buildGeminiJobRecord(makeInvocation({ target: "gemini", binary: "gemini" }), {
    exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
    errorMessage: "scope_paths_required: custom scope requires explicit --scope-paths",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /scope path/i);
  assert.match(rec.suggested_action, /--scope-paths/);
  assert.match(rec.disclosure_note, /external provider/);
});

test("gemini buildJobRecord: scope_empty carries empty-scope diagnostic", () => {
  const rec = buildGeminiJobRecord(makeInvocation({ target: "gemini", binary: "gemini" }), {
    exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
    errorMessage: "scope_empty: custom scope matched no files for --scope-paths PR23.diff",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /empty/i);
  assert.match(rec.suggested_action, /--scope-paths/);
  assert.match(rec.disclosure_note, /external provider/);
});

test("gemini buildJobRecord: invalid_profile carries plugin-bug diagnostic, raw error preserved", () => {
  const rec = buildGeminiJobRecord(makeInvocation({ target: "gemini", binary: "gemini" }), {
    exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
    errorMessage: "invalid_profile: review profile missing required field: model_tier",
  }, []);
  assert.equal(rec.status, "failed");
  assert.equal(rec.error_code, "scope_failed");
  assert.match(rec.error_cause, /plugin|profile/i);
  assert.match(rec.suggested_action, /error_message/);
  assert.match(rec.disclosure_note, /external provider/);
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

test("external-review SKILL ASCII box rows are aligned", () => {
  let boxCount = 0;
  for (const skillPath of EXTERNAL_REVIEW_SKILL_MDS) {
    const skillText = readFileSync(skillPath, "utf8");
    const boxes = [...skillText.matchAll(/```text\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .filter((block) => block.includes("EXTERNAL REVIEW"))
      .filter((block) => block.split("\n").some((line) => /^ *\+/.test(line)));

    for (const box of boxes) {
      boxCount += 1;
      const rows = box.split("\n").filter((line) => /^ *[|+]/.test(line));
      assert.ok(rows.length >= 3, `expected bordered rows in ${skillPath}:\n${box}`);
      const commonIndent = rows[0].match(/^ */)[0].length;
      const indents = new Set(rows.map((line) => line.match(/^ */)[0].length));
      assert.deepEqual([...indents], [commonIndent],
        `external-review box rows have inconsistent leading spaces in ${skillPath}:\n${box}`);
      const widths = new Set(rows.map((line) => line.slice(commonIndent).length));
      assert.equal(widths.size, 1,
        `external-review box rows have inconsistent widths in ${skillPath}:\n${box}`);
    }
  }
  assert.ok(boxCount > 0, "expected at least one EXTERNAL REVIEW text box");
});
