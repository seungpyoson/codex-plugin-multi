import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureGit, fixtureSeedRepo } from "../helpers/fixture-git.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/kimi/scripts/kimi-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/kimi-mock.mjs");
const KIMI_SESSION_ID = "22222222-3333-4444-9555-666666666666";

function runCompanion(args, { cwd, env = {}, dataDir = mkdtempSync(path.join(tmpdir(), "kimi-smoke-data-")) } = {}) {
  const res = spawnSync("node", [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      KIMI_BINARY: MOCK,
      KIMI_PLUGIN_DATA: dataDir,
      ...env,
    },
  });
  return { ...res, dataDir };
}

function withRepo(fn) {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-smoke-repo-"));
  try {
    fixtureSeedRepo(cwd);
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function waitForTerminalRecord(dataDir, jobId, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const stateRoot = path.join(dataDir, "state");
    if (existsSync(stateRoot)) {
      for (const workspaceDir of readdirSync(stateRoot)) {
        const metaPath = path.join(stateRoot, workspaceDir, "jobs", `${jobId}.json`);
        if (!existsSync(metaPath)) continue;
        last = JSON.parse(readFileSync(metaPath, "utf8"));
        if (["completed", "failed", "cancelled", "stale"].includes(last.status)) return last;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.fail(`job ${jobId} did not become terminal; last=${JSON.stringify(last)}`);
}

function assertPreflightSafetyFields(result) {
  assert.equal(result.target_spawned, false);
  assert.equal(result.selected_scope_sent_to_provider, false);
  assert.equal(result.requires_external_provider_consent, true);
}

function kimiPromptAssertionArgs(cwd, mode) {
  const extraArgs = [];
  if (mode === "adversarial-review") {
    writeFileSync(path.join(cwd, "changed.txt"), "changed\n");
    assert.equal(fixtureGit(cwd, ["add", "changed.txt"]).status, 0);
    assert.equal(fixtureGit(cwd, ["commit", "-q", "-m", "changed"]).status, 0);
    extraArgs.push("--scope-base", "HEAD~1");
  }
  if (mode === "custom-review") {
    extraArgs.push("--scope-paths", "seed.txt");
  }
  return [
    "run",
    "--mode",
    mode,
    "--cwd",
    cwd,
    ...extraArgs,
    "--foreground",
    "--",
    "Review this file.",
  ];
}

test("kimi mock rejects unknown CLI flags", () => {
  const result = spawnSync("node", [MOCK, "--unknown-kimi-flag"], {
    cwd: tmpdir(),
    input: "",
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown flag --unknown-kimi-flag/);
});

test("kimi ping reports OAuth readiness and ignored API-key diagnostics", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-"));
  try {
    const result = runCompanion(["ping"], {
      cwd,
      env: {
        KIMI_CODE_API_KEY: "secret-test-value",
        MOONSHOT_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.model, null);
    assert.equal(parsed.session_id, KIMI_SESSION_ID);
    assert.deepEqual(parsed.ignored_env_credentials, ["KIMI_CODE_API_KEY", "MOONSHOT_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_ignored");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi ping classifies missing binary with readiness fields", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-missing-"));
  try {
    const result = spawnSync("node", [COMPANION, "ping", "--binary", path.join(cwd, "missing-kimi")], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, KIMI_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "kimi-missing-data-")) },
    });
    assert.equal(result.status, 2);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "not_found");
    assert.equal(parsed.ready, false);
    assert.match(parsed.summary, /binary was not found/);
    assert.match(parsed.next_action, /Install Kimi Code CLI/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi ping classifies timeout as transient latency", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-timeout-"));
  try {
    const result = runCompanion(["ping", "--timeout-ms", "20"], {
      cwd,
      env: { KIMI_MOCK_DELAY_MS: "200" },
    });
    assert.equal(result.status, 2);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "transient_timeout");
    assert.equal(parsed.ready, false);
    assert.match(parsed.summary, /timed out/i);
    assert.match(parsed.next_action, /Retry/);
    assert.equal(parsed.timeout_ms, 20);
    assert.match(parsed.detail, /configured timeoutMs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi ping rejects fractional timeout milliseconds", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-timeout-fraction-"));
  try {
    const result = runCompanion(["ping", "--timeout-ms", "0.5"], { cwd });
    assert.equal(result.status, 1);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.error, "bad_args");
    assert.match(parsed.message, /positive integer number of milliseconds/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const mode of ["review", "adversarial-review", "custom-review"]) {
  test(`kimi ${mode} prompt requires a self-contained final verdict`, () => withRepo((cwd) => {
    const result = runCompanion(kimiPromptAssertionArgs(cwd, mode), {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "Your final answer must be self-contained",
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }));

  test(`kimi ${mode} prompt includes provider live-verification context`, () => withRepo((cwd) => {
    const result = runCompanion(kimiPromptAssertionArgs(cwd, mode), {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "Live verification context",
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }));
}

test("kimi foreground review timeout returns actionable JobRecord", () => withRepo((cwd) => {
  const result = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--timeout-ms",
    "20",
    "--",
    "Review this scope.",
  ], { cwd, env: { KIMI_MOCK_DELAY_MS: "200" } });
  assert.equal(result.status, 2);
  const record = parseJson(result.stdout);
  assert.equal(record.target, "kimi");
  assert.equal(record.mode, "custom-review");
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "timeout");
  assert.match(record.error_summary, /^Kimi Code CLI timed out/);
  assert.match(record.suggested_action, /retry/i);
  assert.match(record.suggested_action, /run `kimi` interactively/);
  const { record: persisted } = readOnlyJobRecord(result.dataDir);
  assert.equal(persisted.job_id, record.job_id);
  assert.equal(persisted.error_code, "timeout");
}));

test("kimi foreground review step-limit exhaustion returns actionable JobRecord", () => withRepo((cwd) => {
  const result = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--max-steps-per-turn",
    "48",
    "--",
    "Review this scope.",
  ], {
    cwd,
    env: {
      KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48",
      KIMI_MOCK_STEP_LIMIT: "1",
    },
  });
  assert.equal(result.status, 2);
  const record = parseJson(result.stdout);
  assert.equal(record.target, "kimi");
  assert.equal(record.mode, "custom-review");
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "step_limit_exceeded");
  assert.match(record.error_message, /Max number of steps reached: 1/);
  assert.match(record.suggested_action, /higher step budget/i);
  assert.match(record.suggested_action, /narrower scope/i);
  const { record: persisted } = readOnlyJobRecord(result.dataDir);
  assert.equal(persisted.job_id, record.job_id);
  assert.equal(persisted.error_code, "step_limit_exceeded");
}));

test("kimi run rejects invalid max-step budgets before target launch", () => withRepo((cwd) => {
  const result = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--max-steps-per-turn",
    "0.5",
    "--",
    "Review this scope.",
  ], { cwd });
  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.error, "bad_args");
  assert.match(parsed.message, /--max-steps-per-turn/);
}));

test("kimi background review preserves configured max-step budget through queued JobRecord", () => withRepo((cwd) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-background-max-steps-data-"));
  const launched = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--background",
    "--max-steps-per-turn",
    "48",
    "--",
    "Review this scope.",
  ], {
    cwd,
    dataDir,
    env: { KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48" },
  });
  assert.equal(launched.status, 0, launched.stderr);
  const payload = parseJson(launched.stdout);
  assert.equal(payload.event, "launched");

  const record = waitForTerminalRecord(dataDir, payload.job_id);
  assert.equal(record.status, "completed");
  assert.equal(record.result, "Mock Kimi response.");
  assert.equal(record.max_steps_per_turn, 48);
}));

test("kimi preflight success and bad_args emit safety fields", () => withRepo((cwd) => {
  const ok = runCompanion(["preflight", "--mode", "review", "--cwd", cwd], { cwd });
  assert.equal(ok.status, 0, ok.stderr);
  const okJson = parseJson(ok.stdout);
  assert.equal(okJson.event, "preflight");
  assertPreflightSafetyFields(okJson);

  const bad = runCompanion(["preflight", "--mode", "rescue", "--cwd", cwd], { cwd });
  assert.equal(bad.status, 1);
  const badJson = parseJson(bad.stdout);
  assert.equal(badJson.error, "bad_args");
  assertPreflightSafetyFields(badJson);
}));

for (const mode of ["review", "adversarial-review", "custom-review"]) {
  test(`kimi ${mode} foreground writes completed JobRecord`, () => withRepo((cwd) => {
    const extraArgs = [];
    if (mode === "adversarial-review") {
      writeFileSync(path.join(cwd, "changed.txt"), "changed\n");
      assert.equal(fixtureGit(cwd, ["add", "changed.txt"]).status, 0);
      assert.equal(fixtureGit(cwd, ["commit", "-q", "-m", "changed"]).status, 0);
      extraArgs.push("--scope-base", "HEAD~1");
    }
    if (mode === "custom-review") {
      extraArgs.push("--scope-paths", "seed.txt");
    }
    const result = runCompanion([
      "run",
      "--mode",
      mode,
      "--cwd",
      cwd,
      ...extraArgs,
      "--foreground",
      "--",
      "Review this scope.",
    ], { cwd, env: { KIMI_MOCK_ASSERT_FILE: mode === "adversarial-review" ? "changed.txt" : "seed.txt" } });
    assert.equal(result.status, 0, result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.target, "kimi");
    assert.equal(record.mode, mode);
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Mock Kimi response.");
    assert.equal(record.kimi_session_id, KIMI_SESSION_ID);
    assert.equal(record.claude_session_id, null);
    const { record: persisted } = readOnlyJobRecord(result.dataDir);
    assert.equal(persisted.job_id, record.job_id);
    assert.equal(persisted.result, "Mock Kimi response.");
  }));
}
