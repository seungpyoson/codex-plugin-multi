// Smoke tests: drives claude-companion.mjs with the Claude mock on PATH.
// Covers the foreground review / adversarial-review / rescue paths + error
// surfaces. Real Claude CLI is never invoked — CLAUDE_BINARY overrides to
// tests/smoke/claude-mock.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// spawnSync is reused for git init in the mutation-detection smoke.
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureGitEnv, fixtureSeedRepo } from "../helpers/fixture-git.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/claude-mock.mjs");
const CLAUDE_SMOKE_POLL_TIMEOUT_MS = Number(process.env.CLAUDE_SMOKE_POLL_TIMEOUT_MS ?? 30000);

function runCompanion(args, { cwd, env = {}, dataDir = mkdtempSync(path.join(tmpdir(), "companion-smoke-")) } = {}) {
  // Point the companion at a fresh PLUGIN_DATA dir so tests don't step on
  // each other's state or on the user's real ~/.cache.
  const res = spawnSync("node", [COMPANION, ...args], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_BINARY: MOCK,
      CLAUDE_PLUGIN_DATA: dataDir,
      ...env,
    },
    encoding: "utf8",
  });
  return { ...res, dataDir };
}

function cleanup(dataDir) {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function assertPreflightSafetyFields(result) {
  assert.equal(result.target_spawned, false);
  assert.equal(result.selected_scope_sent_to_provider, false);
  assert.equal(result.requires_external_provider_consent, true);
}

function assertClaudeApiKeyMissingError(result) {
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_authed");
  assert.equal(Object.hasOwn(result, "ready"), false);
  assert.equal(result.auth_mode, "api_key");
  assert.equal(result.selected_auth_path, "api_key_env_missing");
  assert.equal(result.auth_policy, "api_key_env_required");
  assert.match(result.summary, /Claude API-key auth was requested/);
  assert.match(result.next_action, /ANTHROPIC_API_KEY or CLAUDE_API_KEY/);
}

function writeExecutable(dir, name, source) {
  const bin = path.join(dir, name);
  writeFileSync(bin, source, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

function readOnlyJobRecord(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  const records = [];
  for (const workspaceDir of readdirSync(stateRoot)) {
    const jobsDir = path.join(stateRoot, workspaceDir, "jobs");
    if (!existsSync(jobsDir)) continue;
    for (const entry of readdirSync(jobsDir)) {
      if (!entry.endsWith(".json")) continue;
      const metaPath = path.join(jobsDir, entry);
      records.push({ metaPath, record: JSON.parse(readFileSync(metaPath, "utf8")) });
    }
  }
  assert.equal(records.length, 1, `expected exactly one JobRecord, got ${records.length}`);
  return records[0];
}

// T7.2: review mode's profile has scope=working-tree, which populates via
// `git ls-files` + copy. Non-git cwds can no longer run review (spec §21.4).
// Uses fixtureSeedRepo (#16 follow-up 9) so a stale GIT_DIR /
// GIT_WORK_TREE / GIT_INDEX_FILE in the parent process cannot hijack the
// fixture into mutating the caller checkout.
function seedMinimalRepo(cwd) {
  fixtureSeedRepo(cwd);
}

test("run: api_key auth failure includes structured diagnostics before spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-run-api-key-missing-"));
  const missingBinary = path.join(cwd, "missing-claude-binary");
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--auth-mode", "api_key",
     "--model", "claude-haiku-4-5-20251001", "--binary", missingBinary,
     "--cwd", cwd, "--", "auth missing"],
    { cwd, env: { ANTHROPIC_API_KEY: "", CLAUDE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 1);
    assertClaudeApiKeyMissingError(JSON.parse(stdout));
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --foreground: emits JobRecord with status=completed", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review: x=1"],
    { cwd, env: { CLAUDE_MOCK_ASSERT_PROMPT_INCLUDES: "Provider: Claude Code" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    // T7.4 (§21.3.2): foreground stdout is a JobRecord — no `ok` top-level.
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.mode, "review");
    assert.equal(result.model, "claude-haiku-4-5-20251001");
    assert.ok(result.job_id, "job_id set");
    assert.equal(result.result, "Mock Claude response.");
    assert.deepEqual(result.permission_denials, []);
    assert.equal(result.schema_version, 10, "schema_version bumped for delegated review metadata and runtime diagnostics");
    assert.equal(result.review_metadata.prompt_contract_version, 1);
    assert.equal(result.review_metadata.prompt_provider, "Claude Code");
    assert.equal(result.review_metadata.raw_output.parsed_ok, true);
    assert.match(result.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
    assert.equal(result.review_metadata.audit_manifest.request.model, "claude-haiku-4-5-20251001");
    assert.equal(result.review_metadata.audit_manifest.request.timeout_ms, 600000);
    assert.match(result.review_metadata.audit_manifest.prompt_builder.plugin_commit, /^[a-f0-9]{40}$/);
    assert.notEqual(
      result.review_metadata.audit_manifest.prompt_builder.plugin_commit,
      result.review_metadata.audit_manifest.git_identity.head_sha,
      "plugin_commit must identify the plugin source, not the reviewed repository head"
    );
    assert.equal(result.review_metadata.audit_manifest.scope_resolution.scope, result.scope);
    assert.equal(result.review_metadata.audit_manifest.selected_source.files.length > 0, true);
    assert.equal(JSON.stringify(result.review_metadata.audit_manifest).includes("review: x=1"), false);
    assert.equal("prompt" in result, false,
      "§21.3.1: full prompt must not appear on JobRecord");
    assert.equal("ok" in result, false,
      "§21.3.2: no hand-assembled `ok` field; consumers derive from status");
    assert.equal("warning" in result, false,
      "§21.3: no top-level warning; mutations array is the signal");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --foreground lifecycle jsonl emits launch event before terminal JobRecord", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-lifecycle-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--lifecycle-events", "jsonl",
     "--model", "claude-haiku-4-5-20251001", "--cwd", cwd, "--", "review: x=1"],
    { cwd }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    const [launched, record] = lines;
    assert.equal(launched.event, "external_review_launched");
    assert.equal(launched.target, "claude");
    assert.equal(launched.status, "launched");
    assert.equal(launched.job_id, record.job_id);
    assert.deepEqual(launched.external_review, {
      marker: "EXTERNAL REVIEW",
      provider: "Claude Code",
      run_kind: "foreground",
      job_id: record.job_id,
      session_id: null,
      parent_job_id: null,
      mode: "review",
      scope: "working-tree",
      scope_base: null,
      scope_paths: null,
      source_content_transmission: "may_be_sent",
      disclosure: "Selected source content may be sent to Claude Code for external review.",
    });
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --foreground: --timeout-ms overrides review timeout audit metadata", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-timeout-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--timeout-ms", "123456", "--", "review timeout override"],
    { cwd, env: { CLAUDE_MOCK_ASSERT_PROMPT_INCLUDES: "Provider: Claude Code" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.review_metadata.audit_manifest.request.timeout_ms, 123456);
    const { record: persisted } = readOnlyJobRecord(dataDir);
    assert.equal(persisted.review_metadata.audit_manifest.request.timeout_ms, 123456);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review rejects --timeout-ms without a value", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-timeout-missing-"));
  seedMinimalRepo(cwd);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--timeout-ms", "--", "review timeout missing"],
    { cwd }
  );
  try {
    assert.equal(status, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.error, "bad_args");
    assert.match(result.message, /--timeout-ms must be a positive integer number of milliseconds/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --foreground: CLAUDE_REVIEW_TIMEOUT_MS sets review timeout audit metadata", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-env-timeout-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review timeout env override"],
    {
      cwd,
      env: {
        CLAUDE_REVIEW_TIMEOUT_MS: "234567",
        CLAUDE_MOCK_ASSERT_PROMPT_INCLUDES: "Provider: Claude Code",
      },
    }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.review_metadata.audit_manifest.request.timeout_ms, 234567);
    const { record: persisted } = readOnlyJobRecord(dataDir);
    assert.equal(persisted.review_metadata.audit_manifest.request.timeout_ms, 234567);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review rejects invalid CLAUDE_REVIEW_TIMEOUT_MS", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-env-timeout-invalid-"));
  seedMinimalRepo(cwd);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review invalid timeout env"],
    { cwd, env: { CLAUDE_REVIEW_TIMEOUT_MS: "not-a-number" } }
  );
  try {
    assert.equal(status, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.error, "bad_args");
    assert.match(result.message, /CLAUDE_REVIEW_TIMEOUT_MS must be a positive integer number of milliseconds/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --foreground lifecycle jsonl suppresses launch event on scope failure", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-lifecycle-scope-fail-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--lifecycle-events", "jsonl",
     "--model", "claude-haiku-4-5-20251001", "--binary", path.join(cwd, "missing-claude"),
     "--cwd", cwd, "--", "review"],
    { cwd }
  );
  try {
    assert.equal(status, 2, `exit ${status}: stderr=${stderr}`);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.match(record.error_message, /scope_population_failed: cannot evaluate gitignored files/);
    assert.match(record.disclosure_note, /not spawned/);
    assert.match(record.disclosure_note, /not sent/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --background lifecycle jsonl suppresses launch event on scope failure", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-lifecycle-bg-scope-fail-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--background", "--lifecycle-events", "jsonl",
     "--model", "claude-haiku-4-5-20251001", "--cwd", cwd, "--", "review"],
    { cwd }
  );
  try {
    assert.equal(status, 2, `exit ${status}: stderr=${stderr}`);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.match(record.error_message, /scope_population_failed: cannot evaluate gitignored files/);
    assert.match(record.disclosure_note, /not spawned/);
    assert.match(record.disclosure_note, /not sent/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run rejects invalid lifecycle event mode as structured bad args", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-lifecycle-bad-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--lifecycle-events", "pretty",
     "--model", "claude-haiku-4-5-20251001", "--cwd", cwd, "--", "review"],
    { cwd }
  );
  try {
    assert.equal(status, 1);
    assert.doesNotMatch(stderr, /unhandled/i);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "bad_args");
    assert.match(parsed.message, /--lifecycle-events must be jsonl/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --foreground: surfaces mutation detection failure without dropping result", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-mut-fail-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review"],
    { cwd, env: { CLAUDE_MOCK_MUTATE_FILE: path.join(cwd, ".git", "index") } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.result, "Mock Claude response.");
    assert.ok(result.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must be surfaced, got ${JSON.stringify(result.mutations)}`);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --foreground: corrupt index fails closed before target spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-mut-spawn-fail-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--binary", path.join(cwd, "missing-claude"), "--cwd", cwd, "--", "review"],
    { cwd }
  );
  try {
    assert.equal(status, 2, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "failed");
    assert.match(result.error_message, /scope_population_failed: cannot evaluate gitignored files/);
    assert.match(result.error_summary, /Review scope was rejected/);
    assert.match(result.error_cause, /gitignored files/);
    assert.match(result.suggested_action, /branch-diff/);
    assert.match(result.disclosure_note, /not spawned/);
    assert.match(result.disclosure_note, /not sent/);
    assert.deepEqual(result.mutations, [],
      "scope filtering fails before mutation detection and target spawn");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=rescue: uses default model from config/models.json", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  // No --model; rescue defaults to "default" tier.
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground",
     "--model", "claude-haiku-4-5-20251001", // mock needs a fixture-hitting model
     "--cwd", cwd, "--", "investigate: why is x null"],
    { cwd }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.mode, "rescue");
    assert.ok(result.job_id);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: meta.json persisted to workspace state", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "hello"],
    { cwd }
  );
  try {
    const { job_id } = JSON.parse(stdout);
    // State dir is deterministic: <PLUGIN_DATA>/state/<slug>-<hash>/jobs/<job_id>.json
    const stateRoot = path.join(dataDir, "state");
    let found = null;
    for (const dir of readdirSync(stateRoot)) {
      const metaPath = path.join(stateRoot, dir, "jobs", `${job_id}.json`);
      if (existsSync(metaPath)) { found = metaPath; break; }
    }
    assert.ok(found, `meta.json not found under ${stateRoot}`);
    const meta = JSON.parse(readFileSync(found, "utf8"));
    assert.equal(meta.id, job_id);
    assert.equal(meta.job_id, job_id,
      "T7.3: new records carry job_id distinct from any session UUID");
    assert.equal(meta.target, "claude");
    assert.equal(meta.status, "completed");
    assert.equal(meta.mode, "review");
    // Claude echoes back --session-id as session_id in its JSON output, so on
    // a fresh run where the companion passes job_id as --session-id, the mock
    // (and real CLI) return that same UUID. The persisted field is the
    // stdout-captured value, not the sent one — see spec §21.1.
    assert.equal(meta.claude_session_id, job_id,
      "claude_session_id must be set from parsed.session_id");
    // Forbidden: the legacy `session_id` alias that duplicated job_id.
    assert.equal(meta.session_id, undefined,
      "legacy session_id field must not be present on new-shape records");
    // JobRecord schema version and full-prompt omission stay explicit.
    assert.equal(meta.schema_version, 10);
    assert.equal("prompt" in meta, false,
      "§21.3.1: full `prompt` field must not be persisted");
    // T7.4: result field populated on foreground completion (symmetry with bg).
    assert.equal(meta.result, "Mock Claude response.");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: missing Claude stdout session_id persists null, not job or resume identity", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "hello"],
    { cwd, env: { CLAUDE_MOCK_OMIT_SESSION_ID: "1" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.claude_session_id, null,
      "claude_session_id must come only from parsed Claude stdout session_id");
    assert.notEqual(result.claude_session_id, result.job_id,
      "job_id must not be fabricated as claude_session_id");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: rejects bad --mode", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  const { stderr, status, dataDir } = runCompanion(
    ["run", "--mode=chaos", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "x"],
    { cwd }
  );
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /--mode must be one of/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

// NOTE — T7.6 relocations:
//   - "run --background: ... terminal meta arrives" (finding #1-H1)  → invariants.test.mjs
//   - "T7.4 / §21.3.1: full prompt must not appear ..." (finding #9) → invariants.test.mjs
// This file keeps the behaviors unique to companion-level smoke (prompt
// sidecar cleanup, status/result/cancel/ping/etc.) The finding-scoped
// regressions have exactly one home: tests/smoke/invariants.test.mjs.

test("T7.4 / §21.3.2: prompt sidecar is deleted after worker consumes it", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-bg-sidecar-"));
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "bg sidecar task"],
    { cwd }
  );
  try {
    assert.equal(status, 0);
    const ev = JSON.parse(stdout);
    const stateRoot = path.join(dataDir, "state");
    // Poll until the record is terminal.
    const deadline = Date.now() + 10000;
    let done = false;
    let jobDir = null;
    while (Date.now() < deadline && !done) {
      for (const dir of readdirSync(stateRoot)) {
        const metaPath = path.join(stateRoot, dir, "jobs", `${ev.job_id}.json`);
        jobDir = path.join(stateRoot, dir, "jobs", ev.job_id);
        if (existsSync(metaPath)) {
          const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
          if (parsed.status === "completed" || parsed.status === "failed") {
            done = true; break;
          }
        }
      }
      if (!done) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(done, "worker never finished");
    // After the worker consumed the prompt, the sidecar must be gone.
    assert.equal(existsSync(path.join(jobDir, "prompt.txt")), false,
      "§21.3.1: prompt sidecar must be deleted after worker consumes it");
    // Settle: meta.json flips to terminal BEFORE upsertJob writes state.json
    // and BEFORE writeSidecar emits stdout.log/stderr.log. Without this
    // wait, the recursive cleanup races the worker's tail writes and Linux
    // CI flakes with `ENOTEMPTY` on rmdir of state/<subdir>/.
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --background: worker spawn failure writes failed JobRecord instead of launched", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-bg-spawn-fail-runner-"));
  const missingCwd = path.join(cwd, "missing-cwd");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", missingCwd, "--", "bg sidecar task"],
    { cwd },
  );
  try {
    assert.notEqual(status, 0, "launcher must fail instead of emitting a false launched event");
    const error = JSON.parse(stdout);
    assert.equal(error.error, "spawn_failed");
    assert.match(error.message, /background worker spawn failed/);
    assert.match(stderr, /background worker spawn failed/);

    const { metaPath, record } = readOnlyJobRecord(dataDir);
    assert.equal(record.status, "failed");
    assert.equal(record.cwd, missingCwd);
    assert.match(record.error_message, /background worker spawn failed/);
    assert.equal("prompt" in record, false, "full prompt must not appear on JobRecord");
    assert.equal(
      existsSync(path.join(path.dirname(metaPath), record.job_id, "prompt.txt")),
      false,
      "prompt sidecar must be removed when the worker never launches",
    );
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --background: active job is visible as running and can be cancelled", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-bg-cancel-"));
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "long background task"],
    { cwd, env: { CLAUDE_MOCK_DELAY_MS: "5000" } },
  );
  try {
    assert.equal(status, 0, stderr);
    const launched = JSON.parse(stdout);
    const deadline = Date.now() + CLAUDE_SMOKE_POLL_TIMEOUT_MS;
    let running = null;
    while (Date.now() < deadline && !running) {
      const statusRes = spawnSync("node", [
        path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
        "status", "--cwd", cwd,
      ], {
        cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
      });
      assert.equal(statusRes.status, 0, statusRes.stderr);
      const statusObj = JSON.parse(statusRes.stdout);
      running = statusObj.jobs.find((j) => j.id === launched.job_id && j.status === "running");
      if (!running) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(running, "background job never became visible as running");
    assert.ok(running.pid_info?.pid, "running job must carry pid_info for safe cancellation");

    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", launched.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    const cancel = JSON.parse(cancelRes.stdout);
    if (running.pid_info.capture_error) {
      // Issue #25 follow-up: a running job whose pid_info lacks a complete
      // ownership proof is "unverifiable" — exit 2 means "refused for
      // safety; operator must investigate." Exit 0 would lie that the
      // cancel post-condition (process gone) holds.
      assert.equal(cancelRes.status, 2,
        `capture_error path must exit 2 (refused, unverifiable); stderr=${cancelRes.stderr}`);
      assert.equal(cancel.status, "no_pid_info");
      // No pid_info → no signal sent → job will run to natural completion
      // (or remain running until timeout). We just need it to reach SOME
      // terminal state so the test doesn't leak background workers.
      const terminalDeadline = Date.now() + 7000;
      let terminal = null;
      while (Date.now() < terminalDeadline && !terminal) {
        const statusRes = spawnSync("node", [
          path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
          "status", "--cwd", cwd,
        ], {
          cwd, encoding: "utf8",
          env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
        });
        assert.equal(statusRes.status, 0, statusRes.stderr);
        const statusObj = JSON.parse(statusRes.stdout);
        terminal = statusObj.jobs.find((j) => j.id === launched.job_id && j.status !== "running");
        if (!terminal) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(terminal, "job with incomplete pid_info did not finish before cleanup");
    } else {
      // The mock binary is fast — between attachPidCapture's snapshot at
      // 'spawn' and cmdCancel's verifyPidInfo, the mock can exit and (rarely)
      // its pid can be reused. All four post-spawn outcomes are valid:
      //   signaled / already_dead → exit 0 (cancel post-condition holds)
      //   stale_pid / unverifiable → exit 2 (refused for safety)
      // What MUST NOT happen is signaled-but-non-zero or stale_pid-but-zero.
      const exitOk =
        (cancel.status === "signaled" && cancelRes.status === 0) ||
        (cancel.status === "already_dead" && cancelRes.status === 0) ||
        (cancel.status === "stale_pid" && cancelRes.status === 2) ||
        (cancel.status === "unverifiable" && cancelRes.status === 2);
      assert.ok(
        exitOk,
        `unexpected (status, exit) pair (${JSON.stringify(cancel.status)}, ${cancelRes.status}); stderr=${cancelRes.stderr}`,
      );
      if (cancel.status === "signaled") {
        // #16 follow-up 2: a real signal-driven cancel must produce a
        // `cancelled` terminal record, not a `failed` one. Poll until the
        // worker finalizes, then assert the persisted status.
        const terminalDeadline = Date.now() + 7000;
        let terminalRecord = null;
        while (Date.now() < terminalDeadline && !terminalRecord) {
          const statusRes = spawnSync("node", [
            path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
            "status", "--cwd", cwd, "--all",
          ], {
            cwd, encoding: "utf8",
            env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
          });
          assert.equal(statusRes.status, 0, statusRes.stderr);
          const statusObj = JSON.parse(statusRes.stdout);
          terminalRecord = statusObj.jobs.find((j) =>
            j.id === launched.job_id && j.status !== "running" && j.status !== "queued");
          if (!terminalRecord) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(terminalRecord, "cancelled background job did not reach a terminal state");
        assert.equal(terminalRecord.status, "cancelled",
          `signal-driven cancel must classify as cancelled; got ${terminalRecord.status}`);
        assert.equal(terminalRecord.error_code, null,
          "cancelled is a clean terminal state — no error_code");
        // Default status (no --all) must still surface the cancelled job
        // because cancelled is continuable (#16 follow-up 4).
        const defaultStatusRes = spawnSync("node", [
          path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
          "status", "--cwd", cwd,
        ], {
          cwd, encoding: "utf8",
          env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
        });
        const defaultStatus = JSON.parse(defaultStatusRes.stdout);
        assert.ok(defaultStatus.jobs.some((j) => j.id === launched.job_id && j.status === "cancelled"),
          "default status (no --all) must include cancelled jobs");
      }
    }
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: SIGTERM-trapping target classifies as cancelled, not completed (issue #22 sub-task 2)", {
  skip: process.env.CODEX_PLUGIN_COVERAGE === "1" && process.platform === "darwin"
    ? "NODE_V8_COVERAGE can make macOS sandbox deny ps; regular npm test covers SIGTERM-trap cancel"
    : false,
}, async () => {
  // Without the cancel-marker fix, a target that handles SIGTERM and exits
  // 0 with valid JSON output is mis-classified as `completed` — operator's
  // cancel intent is silently lost. With the marker, cmdCancel writes a
  // sentinel before signaling and finalization forces status=cancelled.
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-trap-cancel-"));
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "long task"],
    { cwd, env: { CLAUDE_MOCK_DELAY_MS: "30000", CLAUDE_MOCK_TRAP_SIGTERM: "1" } },
  );
  try {
    assert.equal(status, 0, stderr);
    const launched = JSON.parse(stdout);
    // Wait until the job is visible as running (mock has spawned, pid_info written).
    const runDeadline = Date.now() + CLAUDE_SMOKE_POLL_TIMEOUT_MS;
    let running = null;
    while (Date.now() < runDeadline && !running) {
      const sr = spawnSync("node", [
        path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
        "status", "--cwd", cwd,
      ], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
      const so = JSON.parse(sr.stdout);
      running = so.jobs.find((j) => j.id === launched.job_id && j.status === "running");
      if (!running) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(running, "background job never visible as running");

    // Cancel — the trapping mock will exit 0 with valid JSON, signal=null.
    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", launched.job_id, "--cwd", cwd,
    ], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
    const cancel = JSON.parse(cancelRes.stdout);
    const exitOk =
      (cancel.status === "signaled" && cancelRes.status === 0) ||
      (cancel.status === "already_dead" && cancelRes.status === 0) ||
      (cancel.status === "no_pid_info" && cancelRes.status === 2) ||
      (cancel.status === "unverifiable" && cancelRes.status === 2);
    assert.ok(exitOk,
      `unexpected SIGTERM-trap cancel outcome (${JSON.stringify(cancel.status)}, ${cancelRes.status}); stderr=${cancelRes.stderr}`);
    if (cancelRes.status !== 0) return;

    // Wait for the worker to finalize. The mock has a long natural-delay
    // fallback so this should complete quickly only if SIGTERM trapping
    // engaged or the ESRCH-after-marker race was handled as already_dead.
    const termDeadline = Date.now() + 10000;
    let terminal = null;
    let lastStatusSeen = null;
    while (Date.now() < termDeadline && !terminal) {
      // Use --all because origin/main's cmdStatus default filter is
      // running|completed|failed — it would hide the cancelled record we
      // want to assert on. (PR #21's status UX fix expands the default
      // filter; this test deliberately doesn't depend on it.)
      const sr = spawnSync("node", [
        path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
        "status", "--all", "--cwd", cwd,
      ], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
      const so = JSON.parse(sr.stdout);
      const seen = so.jobs.find((j) => j.id === launched.job_id);
      lastStatusSeen = seen?.status ?? "(missing)";
      terminal = so.jobs.find((j) => j.id === launched.job_id && j.status !== "running");
      if (!terminal) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(terminal, `job did not finalize after cancel; last status seen=${lastStatusSeen}`);
    assert.equal(terminal.status, "cancelled",
      `cancel-marker must force status=cancelled even when target trapped SIGTERM and exited 0; got ${JSON.stringify(terminal)}`);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: ESRCH after ownership verification is already_dead, not signal_failed", {
  skip: process.env.CODEX_PLUGIN_COVERAGE === "1"
    ? "regular npm test covers ESRCH kill race; coverage mode already imports companion in cancel smoke"
    : false,
}, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cancel-esrch-"));
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "long task"],
    { cwd, env: { CLAUDE_MOCK_DELAY_MS: "30000" } },
  );
  try {
    assert.equal(status, 0, stderr);
    const launched = JSON.parse(stdout);
    const runDeadline = Date.now() + CLAUDE_SMOKE_POLL_TIMEOUT_MS;
    let running = null;
    while (Date.now() < runDeadline && !running) {
      const sr = spawnSync("node", [
        path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
        "status", "--cwd", cwd,
      ], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
      const so = JSON.parse(sr.stdout);
      running = so.jobs.find((j) => j.id === launched.job_id && j.status === "running");
      if (!running) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(running, "background job never visible as running");
    if (running.pid_info?.capture_error) return;

    const preload = path.join(cwd, "kill-esrch-after-signal.mjs");
    writeFileSync(preload, `
const origKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (signal === "SIGTERM") {
    try { origKill(pid, signal); } catch {}
    const err = new Error("kill ESRCH");
    err.code = "ESRCH";
    throw err;
  }
  return origKill(pid, signal);
};
`, "utf8");
    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", launched.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
        NODE_OPTIONS: `--import=${preload}`,
      },
    });
    const cancel = JSON.parse(cancelRes.stdout);
    if (cancel.status === "no_pid_info") {
      assert.equal(cancelRes.status, 2, cancelRes.stderr);
      return;
    }
    assert.equal(cancelRes.status, 0, cancelRes.stderr);
    assert.equal(cancel.status, "already_dead");
    assert.equal(cancel.pid, running.pid_info.pid);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continue --job: resumes a prior session via --resume", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-continue-"));
  writeFileSync(path.join(cwd, "seed.txt"), "continue timeout seed\n");
  const dataDir = mkdtempSync(path.join(tmpdir(), "continue-data-"));
  const priorTimeoutMs = 777777;
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=custom-review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--scope-paths", "seed.txt",
      "--timeout-ms", String(priorTimeoutMs),
      "--cwd", cwd, "--", "seed",
    ], { cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_REVIEW_TIMEOUT_MS: "" } });
    const { job_id } = JSON.parse(runRes.stdout);
    const contRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "continue", "--job", job_id, "--foreground", "--lifecycle-events", "jsonl",
      "--cwd", cwd, "--", "follow-up",
    ], { cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_REVIEW_TIMEOUT_MS: "" } });
    assert.equal(contRes.status, 0, contRes.stderr);
    const lines = contRes.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    const [launched, out] = lines;
    assert.equal(launched.event, "external_review_launched");
    assert.equal(launched.external_review.parent_job_id, job_id);
    assert.notEqual(out.job_id, job_id, "continue must mint a new job_id");
    // T7.4 (§21.3): foreground stdout is a JobRecord, not an ok-envelope.
    assert.equal(out.status, "completed");
    assert.equal(out.parent_job_id, job_id, "resume carries parent_job_id");
    assert.equal(out.review_metadata.audit_manifest.request.timeout_ms, priorTimeoutMs);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continue --job: --timeout-ms overrides prior timeout and env", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-continue-timeout-override-"));
  writeFileSync(path.join(cwd, "seed.txt"), "continue timeout override seed\n");
  const dataDir = mkdtempSync(path.join(tmpdir(), "continue-timeout-override-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=custom-review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--scope-paths", "seed.txt",
      "--timeout-ms", "777777",
      "--cwd", cwd, "--", "seed",
    ], { cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_REVIEW_TIMEOUT_MS: "" } });
    assert.equal(runRes.status, 0, runRes.stderr);
    const { job_id } = JSON.parse(runRes.stdout);
    const contRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "continue", "--job", job_id, "--foreground",
      "--timeout-ms", "555555",
      "--cwd", cwd, "--", "follow-up",
    ], { cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_REVIEW_TIMEOUT_MS: "999999" } });
    assert.equal(contRes.status, 0, contRes.stderr);
    const out = JSON.parse(contRes.stdout);
    assert.equal(out.review_metadata.audit_manifest.request.timeout_ms, 555555);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continue --job: api_key auth failure includes structured diagnostics before spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-continue-api-key-missing-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "continue-api-key-missing-data-"));
  try {
    const runRes = runCompanion(
      ["run", "--mode=rescue", "--foreground", "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const prior = JSON.parse(runRes.stdout);
    const missingBinary = path.join(cwd, "missing-claude-continue-binary");
    const contRes = runCompanion(
      ["continue", "--job", prior.job_id, "--foreground", "--auth-mode", "api_key",
       "--cwd", cwd, "--", "follow-up"],
      {
        cwd,
        dataDir,
        env: {
          ANTHROPIC_API_KEY: "",
          CLAUDE_API_KEY: "",
          CLAUDE_BINARY: missingBinary,
        },
      },
    );
    assert.equal(contRes.status, 1);
    assertClaudeApiKeyMissingError(JSON.parse(contRes.stdout));
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continue --job: refuses to resume a running job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-continue-running-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "continue-running-data-"));
  try {
    const runRes = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(dataDir);
    writeFileSync(metaPath, `${JSON.stringify({ ...record, status: "running" }, null, 2)}\n`, "utf8");

    const contRes = runCompanion(
      ["continue", "--job", record.job_id, "--foreground",
       "--cwd", cwd, "--", "follow-up"],
      { cwd, dataDir },
    );
    assert.notEqual(contRes.status, 0);
    assert.match(contRes.stderr, /cannot continue job in status "running"/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continue --job: resumes a cancelled terminal job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-continue-cancelled-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "continue-cancelled-data-"));
  try {
    const runRes = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(dataDir);
    writeFileSync(metaPath, `${JSON.stringify({ ...record, status: "cancelled" }, null, 2)}\n`, "utf8");

    const contRes = runCompanion(
      ["continue", "--job", record.job_id, "--foreground",
       "--cwd", cwd, "--", "follow-up"],
      { cwd, dataDir },
    );
    assert.equal(contRes.status, 0, contRes.stderr);
    const continued = JSON.parse(contRes.stdout);
    assert.equal(continued.parent_job_id, record.job_id);
    assert.equal(continued.status, "completed");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --foreground: sidecar write failures warn but preserve terminal status (#16 follow-up 1)", () => {
  // Per #16 follow-up 1: stdout.log/stderr.log are diagnostic sidecars,
  // not the contractual job result. A failed sidecar write must surface
  // as a stderr warning, not as `finalization_failed`. The terminal
  // JobRecord (meta + state) must reflect the real run outcome.
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-sidecar-warn-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "sidecar-warn-data-"));
  try {
    seedMinimalRepo(cwd);
    const res = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir, env: { CLAUDE_MOCK_SIDECAR_CONFLICT: "1" } },
    );
    // Sidecar conflict is a warning, not a fatal error. Exit code reflects
    // the real terminal status (0 on completed).
    assert.equal(res.status, 0, `expected completed exit; got ${res.status}: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /unhandled/i);
    assert.match(res.stderr, /warning: sidecar .* write failed/i,
      "sidecar failure must surface as a one-line stderr warning");
    const record = JSON.parse(res.stdout);
    assert.equal(record.status, "completed",
      "terminal JobRecord must reflect the real run outcome despite sidecar failure");
    assert.equal(record.error_code, null);
    // The persisted meta + state must agree with stdout (no split-brain).
    const { record: persisted } = readOnlyJobRecord(dataDir);
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.job_id, record.job_id);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("result --job: meta path that is a directory returns a friendly error, not unhandled EISDIR (PR #21 review MED 1)", async () => {
  // Set up a job dir with a directory at the meta path. Any code path
  // that ends up with meta.json being a directory (META_CONFLICT, or a
  // crash mid-rename) used to crash result --job with an unhandled
  // EISDIR stacktrace. Wrap the readFileSync so consumers see a clean
  // {ok:false, error:"read_failed"} payload.
  //
  // Use the lib's own resolveJobFile so the path matches what cmdResult
  // computes — bypasses the need to introspect state subdirs.
  const { configureState, resolveJobFile, ensureStateDir, getStateConfig } =
    await import("../../plugins/claude/scripts/lib/state.mjs");
  const initial = { ...getStateConfig() };
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-eisdir-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "eisdir-data-"));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  configureState({
    pluginDataEnv: "CLAUDE_PLUGIN_DATA",
    fallbackStateRootDir: path.join(dataDir, "fallback"),
  });
  try {
    seedMinimalRepo(cwd);
    const id = "00000000-0000-4000-8000-00000000eisd";
    ensureStateDir(cwd);
    const metaPath = resolveJobFile(cwd, id);
    mkdirSync(metaPath, { recursive: true });

    const res = runCompanion(["result", "--job", id, "--cwd", cwd],
      { cwd, dataDir });
    assert.notEqual(res.status, 0, "result must fail when meta is a directory");
    assert.doesNotMatch(res.stderr, /unhandled/i,
      "must NOT crash with an unhandled stacktrace");
    const err = JSON.parse(res.stdout);
    assert.equal(err.error, "read_failed");
    assert.match(err.message, /cannot read meta.json/);
    assert.equal(err.error_code, "EISDIR");
  } finally {
    configureState(initial);
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --foreground: meta-write conflict produces fallback failed record, no permanent running (#16 follow-up 1)", () => {
  // CLAUDE_MOCK_META_CONFLICT pre-creates the meta.json target as a
  // directory before claude-mock exits; the companion's writeJobFile
  // rename then fails. The companion must:
  //   - exit non-zero with finalization_failed,
  //   - leave a coherent fallback record in state.json (not "running"),
  //   - not crash with "unhandled".
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-meta-conflict-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "meta-conflict-data-"));
  try {
    seedMinimalRepo(cwd);
    const res = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir, env: { CLAUDE_MOCK_META_CONFLICT: "1" } },
    );
    assert.notEqual(res.status, 0, "meta write failure must exit non-zero");
    assert.doesNotMatch(res.stderr, /unhandled/i);
    const err = JSON.parse(res.stdout);
    assert.equal(err.error, "finalization_failed");
    // state.json must not show a permanent active "running" record. Read the
    // jobs list and assert no active job remains for this workspace.
    const stateRoot = path.join(dataDir, "state");
    let stateJobs = [];
    for (const dir of readdirSync(stateRoot)) {
      const stateFile = path.join(stateRoot, dir, "state.json");
      if (!existsSync(stateFile)) continue;
      stateJobs = JSON.parse(readFileSync(stateFile, "utf8")).jobs ?? [];
    }
    assert.equal(
      stateJobs.some((j) => j.status === "running" || j.status === "queued"),
      false,
      "fallback failed-record must overwrite the running entry; got " +
      JSON.stringify(stateJobs.map((j) => ({ id: j.id, status: j.status })))
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ————— T7.2 containment/scope smoke tests —————
// The three `run --isolated*` tests from M5 are GONE — `--isolated` is no
// longer a CLI flag. The four tests below replace them and additionally lock
// down M6 finding #4 (review can't see dirty tree).

// Helper: seed a git repo with one committed file, then modify it uncommitted.
// Same isolation discipline as seedMinimalRepo (#16 follow-up 9).
function seedDirtyRepo(cwd) {
  fixtureSeedRepo(cwd, { fileName: "seed.txt", fileContents: "original\n" });
  spawnSync("bash", ["-c", "printf modified > seed.txt"], {
    cwd, encoding: "utf8", env: fixtureGitEnv(),
  });
}

// Helper: read stdout.log sidecar (contains the mock's full fixture JSON
// including the T7.2 oracle fields: t7_saw_file, t7_cwd_match, t7_add_dir_files).
function readStdoutLog(dataDir, jobId) {
  const stateRoot = path.join(dataDir, "state");
  for (const dir of readdirSync(stateRoot)) {
    const p = path.join(stateRoot, dir, "jobs", jobId, "stdout.log");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error(`no stdout.log for job ${jobId}`);
}

// NOTE — T7.6 relocation:
//   "review sees dirty working tree (M6 finding #4)"  →  invariants.test.mjs
// Canonical home is the regression matrix. The adversarial-review /
// rescue / dispose tests below remain here — they exercise containment +
// scope combinations that are wider than a single finding.

test("adversarial-review scope=branch-diff: only changed files appear in --add-dir", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-adv-"));
  // main: has old.md. feature: adds foo.md.
  // #16 follow-up 9: sanitized env so the parent process's GIT_DIR cannot
  // hijack `git checkout -qb feature` into the caller checkout.
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd, env: fixtureGitEnv() });
  spawnSync("bash", ["-c",
    "echo old > old.md && git add old.md && " +
    "git -c core.hooksPath=/dev/null commit -q -m main && " +
    "git checkout -qb feature && " +
    "echo foo > foo.md && git add foo.md && " +
    "git -c core.hooksPath=/dev/null commit -q -m feature"], { cwd, env: fixtureGitEnv() });
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=adversarial-review", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "focus"],
    { cwd, env: { CLAUDE_MOCK_LIST_ADDDIR: "1" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const result = JSON.parse(stdout);
    const fx = readStdoutLog(dataDir, result.job_id);
    const files = fx.t7_add_dir_files ?? [];
    assert.deepEqual(result.runtime_diagnostics.scope_path_mappings, [{
      original: path.join(cwd, "foo.md"),
      contained: path.join(result.runtime_diagnostics.add_dir, "foo.md"),
      relative: "foo.md",
      inside_add_dir: true,
    }]);
    assert.ok(files.includes("foo.md"),
      `branch-diff scope missing foo.md; saw: ${files.join(",")}`);
    assert.ok(!files.includes("old.md"),
      `branch-diff scope leaked old.md; saw: ${files.join(",")}`);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("adversarial-review scope=branch-diff: scope paths narrow copied and audited files", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-adv-paths-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd, env: fixtureGitEnv() });
  spawnSync("bash", ["-c",
    "echo old > old.md && git add old.md && " +
    "git -c core.hooksPath=/dev/null commit -q -m main && " +
    "git checkout -qb feature && " +
    "echo wanted > wanted.md && echo extra > extra.md && git add wanted.md extra.md && " +
    "git -c core.hooksPath=/dev/null commit -q -m feature"], { cwd, env: fixtureGitEnv() });
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=adversarial-review", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--scope-paths", "wanted.md", "--", "focus"],
    { cwd, env: { CLAUDE_MOCK_LIST_ADDDIR: "1" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const result = JSON.parse(stdout);
    const fx = readStdoutLog(dataDir, result.job_id);
    const files = fx.t7_add_dir_files ?? [];
    assert.deepEqual(files, ["wanted.md"]);
    assert.deepEqual(
      result.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
      ["wanted.md"]
    );
    assert.equal(
      result.review_metadata.audit_manifest.scope_resolution.reason,
      "git diff -z --name-only main...HEAD -- filtered by explicit --scope-paths"
    );
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("custom-review scope=custom: reviews explicit bundle files from a non-git directory", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-custom-review-"));
  try {
    writeFileSync(path.join(cwd, "PR23.diff"), "diff --git a/x b/x\n");
    writeFileSync(path.join(cwd, "notes.md"), "review notes\n");
    writeFileSync(path.join(cwd, "private.log"), "not selected\n");

    const { stdout, status, stderr, dataDir } = runCompanion(
      ["run", "--mode=custom-review", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--scope-paths", "PR23.diff,notes.md", "--",
       "Review the selected bundle files using relative paths."],
      { cwd, env: { CLAUDE_MOCK_ASSERT_FILE: "PR23.diff", CLAUDE_MOCK_LIST_ADDDIR: "1" } }
    );
    try {
      assert.equal(status, 0, `exit ${status}: ${stderr}`);
      const result = JSON.parse(stdout);
      assert.equal(result.mode, "custom-review");
      assert.equal(result.scope, "custom");
      assert.deepEqual(result.scope_paths, ["PR23.diff", "notes.md"]);
      assert.ok(result.runtime_diagnostics.add_dir,
        "custom-review should persist the exact --add-dir path granted to Claude");
      assert.ok(result.runtime_diagnostics.child_cwd,
        "custom-review should persist the exact child cwd used for Claude");
      assert.notEqual(result.runtime_diagnostics.add_dir, result.runtime_diagnostics.child_cwd,
        "custom-review should run from a neutral cwd, not the scoped add-dir");
      assert.deepEqual(result.runtime_diagnostics.scope_path_mappings, [
        {
          original: path.join(cwd, "PR23.diff"),
          contained: path.join(result.runtime_diagnostics.add_dir, "PR23.diff"),
          relative: "PR23.diff",
          inside_add_dir: true,
        },
        {
          original: path.join(cwd, "notes.md"),
          contained: path.join(result.runtime_diagnostics.add_dir, "notes.md"),
          relative: "notes.md",
          inside_add_dir: true,
        },
      ]);
      const fx = readStdoutLog(dataDir, result.job_id);
      assert.equal(fx.t7_saw_file, true, "custom-review should include PR23.diff in --add-dir");
      assert.deepEqual(fx.t7_add_dir_files.sort(), ["PR23.diff", "notes.md"]);
      assert.equal(fx.t7_add_dir, result.runtime_diagnostics.add_dir);
      assert.equal(existsSync(result.runtime_diagnostics.child_cwd), false,
        `neutral Claude cwd should be disposed after custom review: ${result.runtime_diagnostics.child_cwd}`);
    } finally {
      cleanup(dataDir);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("preflight custom-review summarizes selected bundle files without launching Claude", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-preflight-"));
  const missingBinary = path.join(cwd, "missing-claude");
  try {
    writeFileSync(path.join(cwd, "PR23.diff"), "diff --git a/x b/x\n");
    writeFileSync(path.join(cwd, "notes.md"), "review notes\n");
    writeFileSync(path.join(cwd, "private.log"), "not selected\n");

    const { stdout, status, stderr, dataDir } = runCompanion(
      ["preflight", "--mode=custom-review",
       "--cwd", cwd, "--scope-paths", "PR23.diff,notes.md",
       "--binary", missingBinary],
      { cwd }
    );
    try {
      assert.equal(status, 0, `exit ${status}: ${stderr}`);
      const result = JSON.parse(stdout);
      assert.equal(result.event, "preflight");
      assert.equal(result.target, "claude");
      assert.equal(result.mode, "custom-review");
      assert.equal(result.scope, "custom");
      assert.equal(result.file_count, 2);
      assert.ok(result.byte_count > 0);
      assert.deepEqual(result.files.sort(), ["PR23.diff", "notes.md"]);
      assertPreflightSafetyFields(result);
      assert.match(result.disclosure_note, /not spawned/i);
    } finally {
      cleanup(dataDir);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("preflight bad args still emits provider safety fields", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-preflight-bad-args-"));
  try {
    const { stdout, status, dataDir } = runCompanion(
      ["preflight", "--mode=nope", "--cwd", cwd],
      { cwd }
    );
    try {
      assert.equal(status, 1);
      const result = JSON.parse(stdout);
      assert.equal(result.event, "preflight");
      assert.equal(result.target, "claude");
      assert.equal(result.error, "bad_args");
      assertPreflightSafetyFields(result);
    } finally {
      cleanup(dataDir);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("preflight scope failures still emit provider safety fields", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-preflight-scope-fail-"));
  try {
    writeFileSync(path.join(cwd, "notes.md"), "review notes\n");
    const { stdout, status, dataDir } = runCompanion(
      ["preflight", "--mode=custom-review", "--cwd", cwd, "--scope-paths", "missing.md"],
      { cwd }
    );
    try {
      assert.equal(status, 2);
      const result = JSON.parse(stdout);
      assert.equal(result.event, "preflight");
      assert.equal(result.target, "claude");
      assert.equal(result.error, "scope_failed");
      assertPreflightSafetyFields(result);
    } finally {
      cleanup(dataDir);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rescue runs in sourceCwd (containment=none): --add-dir === cwd", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-rescue-"));
  seedDirtyRepo(cwd);
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "fix"],
    { cwd, env: { CLAUDE_MOCK_ASSERT_FILE: "seed.txt" } }
  );
  try {
    assert.equal(status, 0, stderr);
    const result = JSON.parse(stdout);
    const fx = readStdoutLog(dataDir, result.job_id);
    // On macOS, /var/folders/... symlinks to /private/var/folders/...;
    // so Claude's --add-dir path may be either form. Accept both.
    const realCwd = realpathSync(cwd);
    assert.ok(fx.t7_add_dir === cwd || fx.t7_add_dir === realCwd,
      `rescue must pass sourceCwd as --add-dir; got ${fx.t7_add_dir}, expected ${cwd} or ${realCwd}`);
    assert.equal(fx.t7_saw_file, true, "rescue should see the dirty file in sourceCwd");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("review worktree disposed by profile default (dispose_default=true)", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-dispose-"));
  fixtureSeedRepo(cwd, { fileName: "seed", fileContents: "seed\n" });
  // ASSERT_FILE env triggers the mock to record t7_add_dir into its fixture
  // (which the companion persists into stdout.log). Without it the mock has
  // no reason to echo the path back and the test can't inspect it.
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review"],
    { cwd, env: { CLAUDE_MOCK_ASSERT_FILE: "seed", CLAUDE_MOCK_ASSERT_CWD: realpathSync(tmpdir()) } }
  );
  try {
    assert.equal(status, 0, stderr);
    const result = JSON.parse(stdout);
    const fx = readStdoutLog(dataDir, result.job_id);
    // The worktree path the mock saw must no longer exist on disk.
    assert.ok(fx.t7_add_dir, "mock didn't record add_dir");
    assert.ok(fx.t7_cwd, "mock didn't record cwd");
    assert.notEqual(fx.t7_cwd, fx.t7_add_dir, "Claude review must run from a neutral cwd, not the scoped add-dir");
    assert.notEqual(fx.t7_cwd_real, fx.t7_add_dir_real, "Claude review cwd must resolve outside the scoped add-dir");
    assert.equal(existsSync(fx.t7_cwd), false,
      `neutral Claude cwd should be disposed after review: ${fx.t7_cwd}`);
    assert.equal(existsSync(fx.t7_add_dir), false,
      `review worktree ${fx.t7_add_dir} should be disposed (dispose_default=true)`);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: pre/post git-status sidecars written in a git cwd", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-git-"));
  // Make a minimal git repo with a seed file so git status has meaningful output.
  fixtureSeedRepo(cwd, { fileName: "seed", fileContents: "seed\n" });
  const { stdout, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review this"],
    { cwd }
  );
  try {
    const { job_id } = JSON.parse(stdout);
    const stateRoot = path.join(dataDir, "state");
    let jobsDir = null;
    for (const dir of readdirSync(stateRoot)) {
      const candidate = path.join(stateRoot, dir, "jobs", job_id);
      if (existsSync(candidate)) { jobsDir = candidate; break; }
    }
    assert.ok(jobsDir, `job sidecar dir not found under ${stateRoot}`);
    // Both snapshots written (may be empty strings for a clean seeded repo — that's OK).
    assert.ok(existsSync(path.join(jobsDir, "git-status-before.txt")), "before snapshot missing");
    assert.ok(existsSync(path.join(jobsDir, "git-status-after.txt")), "after snapshot missing");
    assert.ok(existsSync(path.join(jobsDir, "stdout.log")), "stdout.log missing");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("doctor: returns the same readiness contract as ping", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  const { stdout, status, dataDir } = runCompanion(["doctor"], { cwd });
  try {
    assert.equal(status, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "ok");
    assert.equal(result.ready, true);
    assert.match(result.summary, /ready/i);
    assert.match(result.next_action, /review/i);
    assert.equal(result.auth_mode, "subscription");
    assert.equal(result.selected_auth_path, "subscription_oauth");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ping: returns status=ok with the mock claude binary", () => {
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { ANTHROPIC_API_KEY: "secret-test-value" } }
  );
  try {
    assert.equal(status, 0, `ping exit ${status}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "ok");
    assert.equal(result.ready, true);
    assert.match(result.summary, /ready/i);
    assert.deepEqual(result.ignored_env_credentials, ["ANTHROPIC_API_KEY"]);
    assert.equal(result.auth_policy, "api_key_env_ignored");
    assert.equal(result.auth_mode, "subscription");
    assert.equal(result.selected_auth_path, "subscription_oauth");
    assert.doesNotMatch(stdout, /secret-test-value/);
    assert.equal(result.model, "claude-haiku-4-5-20251001");
    assert.ok(result.session_id);
  } finally {
    cleanup(dataDir);
  }
});

test("ping: explicit api_key auth allows Claude provider key by name only", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "claude-ping-api-key-mode-"));
  const binary = writeExecutable(tmp, "claude-api-key-mode", `#!/usr/bin/env node
if (process.env.ANTHROPIC_API_KEY !== "secret-test-value") {
  process.stderr.write("missing ANTHROPIC_API_KEY\\n");
  process.exit(9);
}
process.stdout.write(JSON.stringify({
  type: "result",
  is_error: false,
  result: "ok",
  session_id: "33333333-3333-4333-8333-333333333333"
}) + "\\n");
`);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--auth-mode", "api_key", "--binary", binary, "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { ANTHROPIC_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.auth_mode, "api_key");
    assert.equal(result.selected_auth_path, "api_key_env");
    assert.deepEqual(result.allowed_env_credentials, ["ANTHROPIC_API_KEY"]);
    assert.equal(result.auth_policy, "api_key_env_allowed");
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    cleanup(dataDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ping: auto auth prefers Claude API key when present", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "claude-ping-auto-auth-"));
  const binary = writeExecutable(tmp, "claude-auto-auth", `#!/usr/bin/env node
if (process.env.ANTHROPIC_API_KEY !== "secret-test-value") {
  process.stderr.write("missing ANTHROPIC_API_KEY\\n");
  process.exit(9);
}
process.stdout.write(JSON.stringify({
  type: "result",
  is_error: false,
  result: "ok",
  session_id: "33333333-3333-4333-8333-333333333333"
}) + "\\n");
`);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--auth-mode", "auto", "--binary", binary, "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { ANTHROPIC_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.auth_mode, "auto");
    assert.equal(result.selected_auth_path, "api_key_env");
    assert.deepEqual(result.allowed_env_credentials, ["ANTHROPIC_API_KEY"]);
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    cleanup(dataDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ping: api_key auth fails before Claude spawn when no provider key is present", () => {
  const missingBinary = path.join(tmpdir(), "missing-claude-api-key-mode-binary");
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--auth-mode", "api_key", "--binary", missingBinary, "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { ANTHROPIC_API_KEY: "", CLAUDE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "not_authed");
    assert.equal(result.auth_mode, "api_key");
    assert.equal(result.selected_auth_path, "api_key_env_missing");
    assert.match(result.next_action, /ANTHROPIC_API_KEY|CLAUDE_API_KEY/);
  } finally {
    cleanup(dataDir);
  }
});

test("ping: not_found includes readiness guidance", () => {
  const missingBinary = path.join(tmpdir(), "missing-claude-ping-binary");
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--binary", missingBinary, "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { ANTHROPIC_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "not_found");
    assert.equal(result.ready, false);
    assert.match(result.summary, /not found/i);
    assert.match(result.next_action, /Install Claude Code/);
    assert.deepEqual(result.ignored_env_credentials, ["ANTHROPIC_API_KEY"]);
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    cleanup(dataDir);
  }
});

test("ping: succeeds without --model and forbids tool exploration in the prompt", () => {
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["ping"],
    {
      cwd: tmpdir(),
      env: { CLAUDE_MOCK_ASSERT_PROMPT_INCLUDES: "Do not use any tools" },
    }
  );
  try {
    assert.equal(status, 0, `ping exit ${status}: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "ok");
    assert.equal(result.model, null);
    assert.ok(result.session_id);
  } finally {
    cleanup(dataDir);
  }
});

test("ping: failure detail falls back to target stdout when stderr is empty", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "claude-ping-stdout-"));
  const binary = writeExecutable(tmp, "claude-stdout-error", `#!/usr/bin/env node
process.stdout.write("OAuth2 flow incomplete\\n");
process.exit(7);
`);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { CLAUDE_BINARY: binary } },
  );
  try {
    assert.equal(status, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "not_authed");
    assert.equal(result.ready, false);
    assert.match(result.next_action, /claude auth login/);
    assert.match(result.detail, /OAuth2 flow incomplete/);
  } finally {
    cleanup(dataDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ping: Claude JSON auth errors surface result text, not raw JSON", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "claude-ping-json-auth-"));
  const binary = writeExecutable(tmp, "claude-json-auth-error", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result",
  is_error: true,
  result: "Not logged in · Please run /login",
  session_id: "33333333-3333-4333-8333-333333333333"
}) + "\\n");
process.exit(1);
`);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { CLAUDE_BINARY: binary } },
  );
  try {
    assert.equal(status, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "not_authed");
    assert.equal(result.ready, false);
    assert.equal(result.detail, "Not logged in · Please run /login");
  } finally {
    cleanup(dataDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ping: not_authed reports ignored parent API-key auth without exposing values", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "claude-ping-api-key-auth-"));
  const binary = writeExecutable(tmp, "claude-api-key-auth-error", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result",
  is_error: true,
  result: "Not logged in · Please run /login",
  session_id: "33333333-3333-4333-8333-333333333333"
}) + "\\n");
process.exit(1);
`);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { CLAUDE_BINARY: binary, ANTHROPIC_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "not_authed");
    assert.deepEqual(result.ignored_env_credentials, ["ANTHROPIC_API_KEY"]);
    assert.equal(result.auth_policy, "api_key_env_ignored");
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    cleanup(dataDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ping: generic stdout mentioning authoring is not classified as auth", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "claude-ping-authoring-"));
  const binary = writeExecutable(tmp, "claude-authoring-error", `#!/usr/bin/env node
process.stdout.write("authoring authority logging failed\\n");
process.exit(7);
`);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { CLAUDE_BINARY: binary } },
  );
  try {
    assert.equal(status, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "error");
    assert.equal(result.ready, false);
    assert.match(result.next_action, /rerun setup/);
    assert.match(result.detail, /authoring authority logging failed/);
  } finally {
    cleanup(dataDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ping: malformed successful stdout reports parsed result missing without crashing", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "claude-ping-malformed-ok-"));
  const binary = writeExecutable(tmp, "claude-malformed-ok", `#!/usr/bin/env node
process.stdout.write("not json\\n");
process.exit(0);
`);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir(), env: { CLAUDE_BINARY: binary } },
  );
  try {
    assert.equal(status, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "error");
    assert.equal(result.ready, false);
    assert.equal(result.detail, "parsed result missing");
    assert.match(JSON.stringify(result.raw), /json_parse_error|not json/);
  } finally {
    cleanup(dataDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("status: empty workspace returns empty jobs list", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-status-"));
  const { stdout, status, dataDir } = runCompanion(["status", "--cwd", cwd], { cwd });
  try {
    assert.equal(status, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.jobs.length, 0);
    assert.ok(result.workspace_root);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("status: lists a job after a review run", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-status2-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "status2-data-"));
  try {
    // Run a review to seed a job.
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(runRes.status, 0, runRes.stderr);
    const { job_id } = JSON.parse(runRes.stdout);
    // Status should list it.
    const statusRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "status", "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(statusRes.status, 0, statusRes.stderr);
    const statusObj = JSON.parse(statusRes.stdout);
    const match = statusObj.jobs.find((j) => j.id === job_id);
    assert.ok(match, `job ${job_id} not in status output`);
    assert.equal(match.status, "completed");
    assert.equal(match.external_review.provider, "Claude Code");
    assert.equal(match.external_review.job_id, job_id);
    assert.equal(
      match.external_review.disclosure,
      "Selected source content was sent to Claude Code for external review.",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("result --job: returns meta for a finished job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-result-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "result-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    const { job_id } = JSON.parse(runRes.stdout);
    const resultRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "result", "--job", job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(resultRes.status, 0, resultRes.stderr);
    const meta = JSON.parse(resultRes.stdout);
    assert.equal(meta.id, job_id);
    assert.equal(meta.status, "completed");
    assert.equal(meta.external_review.provider, "Claude Code");
    assert.equal(meta.external_review.job_id, job_id);
    assert.equal(
      meta.external_review.disclosure,
      "Selected source content was sent to Claude Code for external review.",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("result --job with unknown id: returns not_found", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-result404-"));
  const { stderr, status, dataDir } = runCompanion(
    ["result", "--job", "00000000-0000-4000-8000-000000000000", "--cwd", cwd],
    { cwd }
  );
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /no meta.json/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: queued job → cancel_pending, marker written, exit 0", () => {
  // Class 1 + Finding A: a job that is queued but not yet running cannot
  // be "already_terminal" — the worker hasn't spawned anything. Cancel
  // must drop a marker so the worker refuses to spawn on pickup, and
  // return cancel_pending so operators distinguish "intent recorded" from
  // "intent moot."
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cancel-queued-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "cancel-queued-data-"));
  try {
    // Foreground run completes; we then patch the persisted state to the
    // pre-spawn shape (status=queued, pid_info=null) to exercise the
    // queued-cancel path without timing races against a real worker.
    const runRes = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(dataDir);
    const queuedRecord = { ...record, status: "queued", pid_info: null };
    writeFileSync(metaPath, `${JSON.stringify(queuedRecord, null, 2)}\n`, "utf8");
    // listJobs reads state.json — patch that too so cmdCancel's view matches.
    const stateRoot = path.join(dataDir, "state");
    const statePath = (() => {
      for (const d of readdirSync(stateRoot)) {
        const p = path.join(stateRoot, d, "state.json");
        if (existsSync(p)) return p;
      }
      throw new Error("no state.json");
    })();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const idx = state.jobs.findIndex((j) => j.id === record.job_id);
    state.jobs[idx] = { ...state.jobs[idx], status: "queued", pid_info: null };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", record.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(cancelRes.status, 0, cancelRes.stderr);
    const cancel = JSON.parse(cancelRes.stdout);
    assert.equal(cancel.status, "cancel_pending");
    assert.equal(cancel.ok, true);
    assert.equal(cancel.job_status, "queued");

    // Marker must exist at <jobsDir>/<jobId>/cancel-requested.flag so that
    // cmdRunWorker (and executeRun's post-run consumer) can pick it up.
    const wsDir = path.dirname(metaPath); // jobs/
    const markerPath = path.join(wsDir, record.job_id, "cancel-requested.flag");
    assert.ok(existsSync(markerPath),
      `cancel_pending must write a marker at ${markerPath}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("_run-worker: cancel marker prevents target spawn, sets status=cancelled", () => {
  // Class 1 + Finding A end-to-end: when the launcher dropped a cancel
  // marker on a queued job, the worker MUST exit before spawning the
  // target binary. Otherwise the model call happens (cost + side effects)
  // and only the post-run consumer would convert "completed" → "cancelled".
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-worker-cancel-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "worker-cancel-data-"));
  try {
    const runRes = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(dataDir);
    // Patch back to queued so _run-worker accepts the job (terminal jobs
    // are refused at the top of cmdRunWorker).
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "queued", pid_info: null }, null, 2)}\n`, "utf8");

    // Drop the cancel marker manually — this is what cmdCancel writes
    // when it sees a queued job.
    const wsDir = path.dirname(metaPath);
    const markerDir = path.join(wsDir, record.job_id);
    spawnSync("mkdir", ["-p", markerDir]);
    const promptPath = path.join(markerDir, "prompt.txt");
    writeFileSync(promptPath, "queued prompt with selected source\n", { mode: 0o600 });
    const markerPath = path.join(markerDir, "cancel-requested.flag");
    writeFileSync(markerPath, new Date().toISOString() + "\n");

    const workerRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "_run-worker", "--cwd", cwd, "--job", record.job_id,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(workerRes.status, 0,
      `worker must exit 0 when marker present; stderr=${workerRes.stderr}`);

    const finalMeta = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(finalMeta.status, "cancelled",
      `worker must persist status=cancelled; got ${finalMeta.status}`);
    // pid_info stays null — the target was never spawned.
    assert.equal(finalMeta.pid_info, null,
      "worker must not record pid_info when refusing to spawn");
    // Marker was consumed (unlinked) so a second pickup wouldn't double-cancel.
    assert.equal(existsSync(markerPath), false,
      "worker must consume (unlink) the marker on pickup");
    assert.equal(existsSync(promptPath), false,
      "worker must remove prompt sidecar when queued cancel prevents target spawn");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("claude _run-worker fails before spawn when api_key auth has no provider key", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "claude-worker-auth-missing-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "claude-worker-auth-missing-data-"));
  const markerPath = path.join(dataDir, "spawned");
  const binary = writeExecutable(dataDir, "claude-marker", [
    "#!/bin/sh",
    `printf spawned > ${JSON.stringify(markerPath)}`,
    "printf '{\"session_id\":\"11111111-2222-4333-8444-555555555555\",\"result\":\"spawned\"}\\n'",
    "exit 0",
    "",
  ].join("\n"));
  seedMinimalRepo(cwd);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const state = await import("../../plugins/claude/scripts/lib/state.mjs");
    const { newJobId } = await import("../../plugins/claude/scripts/lib/identity.mjs");
    const { buildJobRecord } = await import("../../plugins/claude/scripts/lib/job-record.mjs");
    const { resolveProfile } = await import("../../plugins/claude/scripts/lib/mode-profiles.mjs");
    state.configureState({
      pluginDataEnv: "CLAUDE_PLUGIN_DATA",
      sessionIdEnv: "CLAUDE_COMPANION_SESSION_ID",
    });
    const profile = resolveProfile("rescue");
    const jobId = newJobId();
    const invocation = Object.freeze({
      job_id: jobId,
      target: "claude",
      parent_job_id: null,
      resume_chain: [],
      mode_profile_name: profile.name,
      mode: "rescue",
      model: "claude-haiku-4-5-20251001",
      cwd,
      workspace_root: cwd,
      containment: profile.containment,
      scope: profile.scope,
      dispose_effective: profile.dispose_default,
      scope_base: null,
      scope_paths: null,
      prompt_head: "auth missing",
      schema_spec: null,
      binary,
      auth_mode: "api_key",
      run_kind: "background",
      started_at: new Date().toISOString(),
    });
    const queued = buildJobRecord(invocation, null, []);
    state.writeJobFile(cwd, jobId, queued);
    state.upsertJob(cwd, queued);
    const promptPath = path.join(state.resolveJobsDir(cwd), jobId, "prompt.txt");
    mkdirSync(path.dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, "auth missing", "utf8");

    const worker = spawnSync("node", [
      COMPANION, "_run-worker", "--cwd", cwd, "--job", jobId, "--auth-mode", "api_key",
    ], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_BINARY: binary,
        CLAUDE_PLUGIN_DATA: dataDir,
        ANTHROPIC_API_KEY: "",
        CLAUDE_API_KEY: "",
      },
    });
    assert.notEqual(worker.status, 0, "worker should fail without a provider API key");
    const error = JSON.parse(worker.stdout);
    assert.equal(error.error, "not_authed");
    assert.equal(error.selected_auth_path, "api_key_env_missing");
    const finalRecord = JSON.parse(readFileSync(state.resolveJobFile(cwd, jobId), "utf8"));
    assert.equal(finalRecord.status, "failed");
    assert.match(finalRecord.error_message, /explicit api_key auth requires/);
    assert.equal(existsSync(promptPath), false, "worker must remove prompt sidecar on auth refusal");
    assert.equal(existsSync(markerPath), false, "worker must not spawn target when auth is missing");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: queued + marker write failure → cancel_failed, exit 1", () => {
  // Class 1 follow-up (reviewer Vector 3): the queued-cancel branch's marker
  // is the entire cancel mechanism (no SIGTERM fallback). If the write
  // throws (disk full, perms, parent dir is a regular file), exit 0 with
  // cancel_pending would lie about durability. Must exit 1, error:cancel_failed.
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cancel-fail-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "cancel-fail-data-"));
  try {
    const runRes = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(dataDir);
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "queued", pid_info: null }, null, 2)}\n`, "utf8");
    // Patch state.json to match.
    const stateRoot = path.join(dataDir, "state");
    const statePath = (() => {
      for (const d of readdirSync(stateRoot)) {
        const p = path.join(stateRoot, d, "state.json");
        if (existsSync(p)) return p;
      }
      throw new Error("no state.json");
    })();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const idx = state.jobs.findIndex((j) => j.id === record.job_id);
    state.jobs[idx] = { ...state.jobs[idx], status: "queued", pid_info: null };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    // Booby-trap the marker dir: writeCancelMarker calls
    // mkdirSync(<jobsDir>/<jobId>, { recursive: true }) — placing a regular
    // file at that path makes the mkdir throw ENOTDIR. Remove any
    // pre-existing per-job dir first (the seed run created it for sidecars).
    const wsDir = path.dirname(metaPath);
    const expectedMarkerDir = path.join(wsDir, record.job_id);
    rmSync(expectedMarkerDir, { recursive: true, force: true });
    writeFileSync(expectedMarkerDir, "blocker", "utf8");

    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", record.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(cancelRes.status, 1,
      `marker write failure must exit 1; stderr=${cancelRes.stderr}`);
    const cancel = JSON.parse(cancelRes.stdout);
    assert.equal(cancel.error, "cancel_failed");
    assert.equal(cancel.ok, false);
    assert.match(cancel.message ?? "", /could not durably record cancel intent/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: unknown job status → bad_state, exit 1", () => {
  // Class 1 follow-up (reviewer Vector 5): if state.json is corrupted such
  // that job.status is something we don't recognize (not running, not
  // truly-terminal, not queued), the code MUST surface the corruption
  // rather than silently treat it as queued and write a marker.
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cancel-bad-state-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "cancel-bad-state-data-"));
  try {
    const runRes = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(dataDir);
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "errored" }, null, 2)}\n`, "utf8");
    const stateRoot = path.join(dataDir, "state");
    const statePath = (() => {
      for (const d of readdirSync(stateRoot)) {
        const p = path.join(stateRoot, d, "state.json");
        if (existsSync(p)) return p;
      }
      throw new Error("no state.json");
    })();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const idx = state.jobs.findIndex((j) => j.id === record.job_id);
    state.jobs[idx] = { ...state.jobs[idx], status: "errored" };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", record.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(cancelRes.status, 1,
      `unknown status must exit 1; stderr=${cancelRes.stderr}`);
    const cancel = JSON.parse(cancelRes.stdout);
    assert.equal(cancel.error, "bad_state");
    assert.match(cancel.message ?? "", /unexpected job status/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: already_terminal for a completed job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cancel-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "cancel-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    const { job_id } = JSON.parse(runRes.stdout);
    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(cancelRes.status, 0);
    const response = JSON.parse(cancelRes.stdout);
    assert.equal(response.status, "already_terminal");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("claude _run-worker refuses terminal JobRecord without overwriting it", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-worker-terminal-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "worker-terminal-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=rescue", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(runRes.status, 0, runRes.stderr);
    const completed = JSON.parse(runRes.stdout);
    assert.equal(completed.status, "completed");

    const workerRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "_run-worker", "--cwd", cwd, "--job", completed.job_id,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.notEqual(workerRes.status, 0, "terminal worker re-entry must be refused");

    const { record } = readOnlyJobRecord(dataDir);
    assert.equal(record.status, "completed", "terminal worker re-entry must not overwrite record");
    assert.equal(record.job_id, completed.job_id);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
