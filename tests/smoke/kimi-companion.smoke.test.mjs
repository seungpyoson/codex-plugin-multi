import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureBranchDiffRepo, fixtureGit, fixtureSeedRepo } from "../helpers/fixture-git.mjs";
import { badVerdictReviewFixture, requestChangesReviewFixture } from "../helpers/review-fixtures.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/kimi/scripts/kimi-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/kimi-mock.mjs");
const MODELS_CONFIG = path.join(REPO_ROOT, "plugins/kimi/config/models.json");
const KIMI_SESSION_ID = "22222222-3333-4444-9555-666666666666";
const KIMI_RESUMED_SESSION_ID = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

function writeIndexCorruptingBinary(dir, repoPath) {
  const binary = path.join(dir, "corrupt-index-kimi");
  writeFileSync(binary, [
    "#!/bin/sh",
    `printf corrupt > ${JSON.stringify(path.join(repoPath, ".git", "index"))}`,
    "printf '{\"session_id\":\"22222222-3333-4444-9555-666666666666\",\"response\":\"Verdict: APPROVE\\\\nBlocking findings\\\\n- None. The selected source was inspected before mutation detection failed.\\\\nNon-blocking concerns\\\\n- None for this fixture.\\\\nTest gaps\\\\n- Existing smoke coverage exercises this post-run mutation failure path, including preserving the completed result when the later mutation scan fails.\\\\nInspection status\\\\n- Source inspection completed; the later mutation scan failed independently and is surfaced as metadata rather than a review failure.\\\\nChecklist:\\\\n- PASS selected source was inspected.\\\\n- PASS no blocker was invented.\\\\n- PASS mutation failure was surfaced.\"}\\n'",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(binary, 0o755);
  return binary;
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

async function waitForTerminalJob(dataDir, jobId, timeoutMs = 5000) {
  const stateRoot = path.join(dataDir, "state");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(stateRoot)) {
      for (const workspaceDir of readdirSync(stateRoot)) {
        const metaPath = path.join(stateRoot, workspaceDir, "jobs", `${jobId}.json`);
        if (!existsSync(metaPath)) continue;
        const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
        if (parsed.status === "completed" || parsed.status === "failed") {
          return parsed;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`worker never wrote terminal meta for ${jobId}`);
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  if (!Number.isInteger(pid)) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e?.code === "ESRCH") return;
      throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`worker process ${pid} did not exit`);
}

function findJobPaths(dataDir, jobId) {
  const stateRoot = path.join(dataDir, "state");
  for (const workspaceDir of readdirSync(stateRoot)) {
    const jobsDir = path.join(stateRoot, workspaceDir, "jobs");
    const metaPath = path.join(jobsDir, `${jobId}.json`);
    if (existsSync(metaPath)) {
      return {
        jobsDir,
        metaPath,
        sidecarDir: path.join(jobsDir, jobId),
        runtimeOptionsPath: path.join(jobsDir, jobId, "runtime-options.json"),
        legacyRuntimeOptionsPath: path.join(jobsDir, `${jobId}.runtime-options`),
      };
    }
  }
  assert.fail(`job ${jobId} not found under ${stateRoot}`);
}

function findWorkspaceStatePath(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  for (const workspaceDir of readdirSync(stateRoot)) {
    const statePath = path.join(stateRoot, workspaceDir, "state.json");
    if (existsSync(statePath)) return statePath;
  }
  assert.fail(`no workspace state.json under ${stateRoot}`);
}

function readStdoutLog(dataDir, jobId) {
  const { sidecarDir } = findJobPaths(dataDir, jobId);
  return JSON.parse(readFileSync(path.join(sidecarDir, "stdout.log"), "utf8"));
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function withKimiModelsConfig(config, fn) {
  const prior = readFileSync(MODELS_CONFIG, "utf8");
  writeFileSync(MODELS_CONFIG, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    return fn();
  } finally {
    writeFileSync(MODELS_CONFIG, prior, "utf8");
  }
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
  const tempRoot = realpathSync(tmpdir());
  try {
    const result = runCompanion(["ping"], {
      cwd,
      env: {
        KIMI_CODE_API_KEY: "secret-test-value",
        KIMI_MOCK_ASSERT_CWD_NOT: tempRoot,
        KIMI_MOCK_ASSERT_CWD_PREFIX: tempRoot,
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
    assert.equal(parsed.auth_mode, "subscription");
    assert.equal(parsed.selected_auth_path, "subscription_oauth");
    assert.equal(parsed.selected_route, "subscription_oauth");
    assert.equal(parsed.fallback_reason, null);
    assert.deepEqual(parsed.ignored_env_credentials, ["KIMI_CODE_API_KEY", "MOONSHOT_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_ignored");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi doctor probes configured review model, not only native auth", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-doctor-review-model-"));
  try {
    const result = runCompanion(["doctor"], {
      cwd,
      env: { KIMI_MOCK_CAPACITY_MODEL: "kimi-code/kimi-for-coding" },
    });
    assert.equal(result.status, 2, result.stderr);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "rate_limited");
    assert.equal(parsed.ready, false);
    assert.equal(parsed.auth_mode, "subscription");
    assert.equal(parsed.selected_auth_path, "subscription_oauth");
    assert.equal(parsed.selected_route, "subscription_oauth");
    assert.equal(parsed.fallback_reason, null);
    assert.match(parsed.summary, /capacity-limited/i);
    assert.match(parsed.detail, /kimi-code\/kimi-for-coding/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi doctor default timeout allows slow review-model startup", { timeout: 70000 }, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-doctor-slow-review-model-"));
  try {
    const result = runCompanion(["doctor"], {
      cwd,
      env: { KIMI_MOCK_DELAY_MS: "31000" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.auth_mode, "subscription");
    assert.equal(parsed.selected_auth_path, "subscription_oauth");
    assert.equal(parsed.selected_route, "subscription_oauth");
    assert.equal(parsed.fallback_reason, null);
    assert.equal(parsed.model, "kimi-code/kimi-for-coding");
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

test("kimi ping classifies Codex sandbox denial for Kimi state as sandbox_blocked", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-sandbox-denied-"));
  const bin = path.join(cwd, "kimi-denied");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write("[Errno 1] Operation not permitted: '/Users/test/.kimi/tmpabc.tmp'\\n");
process.exit(1);
`, "utf8");
  chmodSync(bin, 0o755);
  try {
    const result = spawnSync("node", [COMPANION, "ping", "--binary", bin], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CODEX_SANDBOX: "seatbelt", KIMI_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "kimi-denied-data-")) },
    });
    assert.equal(result.status, 2);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "sandbox_blocked");
    assert.equal(parsed.ready, false);
    assert.match(parsed.summary, /Codex sandbox/);
    assert.match(parsed.next_action, /~\/\.kimi\/logs/);
    assert.match(parsed.next_action, /fall back to ~\/\.kimi/);
    assert.match(parsed.next_action, /writable_roots/);
    assert.match(parsed.detail, /Operation not permitted/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi ping classifies Codex sandbox denial when traceback truncates before Kimi path", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-sandbox-long-denied-"));
  const bin = path.join(cwd, "kimi-long-denied");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write("Traceback (most recent call last)\\\\n" + "x".repeat(700) + "\\\\nPermissionError: [Errno 1] Operation not permitted: '/Users/test/.kimi/logs/kimi.log'\\\\n");
process.exit(1);
`, "utf8");
  chmodSync(bin, 0o755);
  try {
    const result = spawnSync("node", [COMPANION, "ping", "--binary", bin], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CODEX_SANDBOX: "seatbelt", KIMI_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "kimi-long-denied-data-")) },
    });
    assert.equal(result.status, 2);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "sandbox_blocked");
    assert.equal(parsed.ready, false);
    assert.match(parsed.next_action, /~\/\.kimi\/logs/);
    assert.match(parsed.next_action, /fall back to ~\/\.kimi/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi ping classifies Codex sandbox denial for Kimi OAuth files before auth hints", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-sandbox-auth-denied-"));
  const bin = path.join(cwd, "kimi-auth-denied");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write("PermissionError: [Errno 1] Operation not permitted: '/Users/test/.kimi/auth.json'\\n");
process.exit(1);
`, "utf8");
  chmodSync(bin, 0o755);
  try {
    const result = spawnSync("node", [COMPANION, "ping", "--binary", bin], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CODEX_SANDBOX: "seatbelt", KIMI_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "kimi-auth-denied-data-")) },
    });
    assert.equal(result.status, 2);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "sandbox_blocked");
    assert.match(parsed.next_action, /writable_roots/);
    assert.match(parsed.next_action, /~\/\.kimi\/logs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi ping classifies Codex sandbox denial for bare Kimi state directory", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-sandbox-dir-denied-"));
  const bin = path.join(cwd, "kimi-dir-denied");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write("Permission denied: '/Users/test/.kimi'\\n");
process.exit(1);
`, "utf8");
  chmodSync(bin, 0o755);
  try {
    const result = spawnSync("node", [COMPANION, "ping", "--binary", bin], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CODEX_SANDBOX: "seatbelt", KIMI_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "kimi-dir-denied-data-")) },
    });
    assert.equal(result.status, 2);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "sandbox_blocked");
    assert.match(parsed.next_action, /~\/\.kimi\/logs/);
    assert.match(parsed.next_action, /fall back to ~\/\.kimi/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi ping does not classify unrelated permission error plus Kimi mention as sandbox_blocked", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-sandbox-false-positive-"));
  const bin = path.join(cwd, "kimi-unrelated-denied");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write("PermissionError: [Errno 1] Operation not permitted: '/workspace/output.log'\\n");
process.stderr.write("Loaded config defaults from /Users/test/.kimi/config.json\\n");
process.exit(1);
`, "utf8");
  chmodSync(bin, 0o755);
  try {
    const result = spawnSync("node", [COMPANION, "ping", "--binary", bin], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CODEX_SANDBOX: "seatbelt", KIMI_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "kimi-unrelated-denied-data-")) },
    });
    assert.equal(result.status, 2);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "error");
    assert.doesNotMatch(parsed.next_action, /writable_roots/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi ping ignores false-like CODEX_SANDBOX values for sandbox classification", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-sandbox-false-env-"));
  const bin = path.join(cwd, "kimi-false-env-denied");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write("PermissionError: [Errno 1] Operation not permitted: '/Users/test/.kimi/auth.json'\\n");
process.exit(1);
`, "utf8");
  chmodSync(bin, 0o755);
  try {
    for (const value of ["false", "0"]) {
      const result = spawnSync("node", [COMPANION, "ping", "--binary", bin], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, CODEX_SANDBOX: value, KIMI_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "kimi-false-env-denied-data-")) },
      });
      assert.equal(result.status, 2);
      const parsed = parseJson(result.stdout);
      assert.notEqual(parsed.status, "sandbox_blocked");
      assert.doesNotMatch(parsed.next_action, /writable_roots/);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi ping classifies indented continuation-line Kimi permission denials", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-sandbox-continuation-"));
  const bin = path.join(cwd, "kimi-continuation-denied");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write("PermissionError: [Errno 1] Operation not permitted:\\n    '/Users/test/.kimi/config.toml'\\n");
process.exit(1);
`, "utf8");
  chmodSync(bin, 0o755);
  try {
    const result = spawnSync("node", [COMPANION, "ping", "--binary", bin], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CODEX_SANDBOX: "seatbelt", KIMI_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "kimi-continuation-denied-data-")) },
    });
    assert.equal(result.status, 2);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "sandbox_blocked");
    assert.match(parsed.next_action, /writable_roots/);
    assert.match(parsed.next_action, /~\/\.kimi\/logs/);
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

test("kimi run rejects --timeout-ms without a value", () => withRepo((cwd) => {
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
    "--",
    "Review this scope.",
  ], { cwd });
  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.error, "bad_args");
  assert.match(parsed.message, /--timeout-ms must be a positive integer number of milliseconds/);
}));

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

  test(`kimi ${mode} prompt omits provider live-verification context`, () => withRepo((cwd) => {
    const result = runCompanion(kimiPromptAssertionArgs(cwd, mode), {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_EXCLUDES: "Live verification context",
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }));

  test(`kimi ${mode} prompt uses shared compact delegated review contract`, () => withRepo((cwd) => {
    const result = runCompanion(kimiPromptAssertionArgs(cwd, mode), {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "Delegated compact review contract",
        KIMI_MOCK_ASSERT_PROMPT_EXCLUDES: "Delegated review quality contract",
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }));
}

test("kimi ping rejects unsupported auth-mode instead of ignoring it", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-ping-auth-mode-"));
  try {
    const result = runCompanion(["ping", "--auth-mode", "api_key"], { cwd });
    assert.equal(result.status, 1);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.error, "bad_args");
    assert.match(parsed.message, /Kimi supports subscription auth only/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi continue rejects unsupported auth-mode instead of folding it into the prompt", () => withRepo((cwd) => {
  const runRes = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--",
    "Review this scope.",
  ], { cwd });
  try {
    assert.equal(runRes.status, 0, runRes.stderr);
    const parent = parseJson(runRes.stdout);
    const result = runCompanion([
      "continue",
      "--job",
      parent.job_id,
      "--auth-mode",
      "api_key",
      "--cwd",
      cwd,
      "--",
      "Follow up.",
    ], { cwd, dataDir: runRes.dataDir });
    assert.equal(result.status, 1);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.error, "bad_args");
    assert.match(parsed.message, /Kimi supports subscription auth only/);
  } finally {
    rmSync(runRes.dataDir, { recursive: true, force: true });
  }
}));

test("kimi custom-review prompt includes selected source content", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-inline-source-cwd-"));
  try {
    fixtureSeedRepo(cwd, {
      fileName: "seed.txt",
      fileContents: "kimi inline source sentinel\n",
    });
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "kimi inline source sentinel",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, false);
    assert.deepEqual(record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi custom-review applies adapter source-packet capacity before Kimi launch", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-adapter-source-cap-cwd-"));
  let dataDir = null;
  try {
    fixtureSeedRepo(cwd);
    writeFileSync(path.join(cwd, "large.txt"), "k".repeat(40 * 1024));
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "large.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "MUST_NOT_REACH_KIMI",
      },
    });
    dataDir = result.dataDir;
    assert.equal(result.status, 2);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "source_packet_too_large");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_send_allowed, false);
    assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_packet_budget_bytes, 32 * 1024);
    assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_packet_action, "narrow_source_packet");
    assert.doesNotMatch(result.stdout, /external_review_launched|MUST_NOT_REACH_KIMI/);
  } finally {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi custom-review rejects over-budget source packets before Kimi launch", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-source-packet-cwd-"));
  const files = [];
  let dataDir = null;
  try {
    fixtureSeedRepo(cwd);
    for (let index = 0; index < 3; index += 1) {
      const file = `packet-${index}.txt`;
      files.push(file);
      writeFileSync(path.join(cwd, file), "x".repeat(180 * 1024));
    }
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      files.join(","),
      "--foreground",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "MUST_NOT_REACH_KIMI",
      },
    });
    dataDir = result.dataDir;
    assert.equal(result.status, 2);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "source_packet_too_large");
    assert.match(record.error_message, /Narrow or shard the Kimi source packet/);
    assert.equal(record.error_cause, "pre_send_source_packet_budget");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_send_allowed, false);
    assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_packet_action, "narrow_source_packet");
    assert.doesNotMatch(result.stdout, /external_review_launched|MUST_NOT_REACH_KIMI/);
  } finally {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi background custom-review rejects over-budget source packets before prompt sidecar write", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-bg-source-packet-cwd-"));
  const files = [];
  let dataDir = null;
  try {
    fixtureSeedRepo(cwd);
    for (let index = 0; index < 3; index += 1) {
      const file = `packet-${index}.txt`;
      files.push(file);
      writeFileSync(path.join(cwd, file), "x".repeat(180 * 1024));
    }
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      files.join(","),
      "--background",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "MUST_NOT_REACH_KIMI",
      },
    });
    dataDir = result.dataDir;
    assert.equal(result.status, 2);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "source_packet_too_large");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_send_allowed, false);
    const { metaPath } = readOnlyJobRecord(dataDir);
    const promptPath = path.join(path.dirname(metaPath), record.job_id, "prompt.txt");
    assert.equal(existsSync(promptPath), false, "blocked background source packet must not persist prompt sidecar");
    assert.doesNotMatch(result.stdout, /external_review_launched|MUST_NOT_REACH_KIMI/);
  } finally {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi custom-review explicit large source override records policy and sends source", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-source-packet-override-cwd-"));
  const files = [];
  let dataDir = null;
  try {
    fixtureSeedRepo(cwd);
    for (let index = 0; index < 3; index += 1) {
      const file = `packet-${index}.txt`;
      files.push(file);
      writeFileSync(path.join(cwd, file), "k".repeat(180 * 1024));
    }
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      files.join(","),
      "--foreground",
      "--allow-large-source-packet",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "KIMI FILE 1: packet-0.txt",
      },
    });
    dataDir = result.dataDir;
    assert.equal(result.status, 0, result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    const policy = record.review_metadata.audit_manifest.source_packet_policy;
    assert.equal(policy.source_send_allowed, true);
    assert.equal(policy.source_packet_action, "send_after_source_packet_override");
    assert.equal(policy.source_packet_within_budget, false);
    assert.ok(policy.selected_source_bytes > policy.source_packet_budget_bytes);
    assert.equal(policy.source_packet_override_approved, true);
    assert.equal(policy.source_packet_override_source, "--allow-large-source-packet");
  } finally {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi custom-review records explicit review-slot waiver disposition", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-review-slot-waiver-cwd-"));
  let dataDir = null;
  try {
    fixtureSeedRepo(cwd);
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--review-slot-disposition",
      "waive",
      "--review-slot-waiver-artifact",
      "reviews/waiver-180.md",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "KIMI FILE 1: seed.txt",
      },
    });
    dataDir = result.dataDir;
    assert.equal(result.status, 0, result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.review_metadata.audit_manifest.review_slot.disposition, "waive");
    assert.equal(record.review_metadata.audit_manifest.review_slot.waiver_artifact, "reviews/waiver-180.md");
    assert.equal(record.review_metadata.audit_manifest.review_slot.override_artifact, null);
    assert.equal(record.external_review.review_slot.disposition, "waive");
  } finally {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi result --job-id aliases --job for a finished job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-result-job-id-cwd-"));
  fixtureSeedRepo(cwd);
  const result = runCompanion([
    "run",
    "--mode",
    "review",
    "--cwd",
    cwd,
    "--foreground",
    "--",
    "seed",
  ], { cwd });
  try {
    assert.equal(result.status, 0, result.stderr);
    const record = parseJson(result.stdout);
    const retrieved = runCompanion([
      "result",
      "--job-id",
      record.job_id,
      "--cwd",
      cwd,
    ], { cwd, dataDir: result.dataDir });
    assert.equal(retrieved.status, 0, retrieved.stderr);
    const meta = parseJson(retrieved.stdout);
    assert.equal(meta.id, record.job_id);
    assert.equal(meta.status, "completed");
    assert.equal(meta.external_review.provider, "Kimi Code CLI");
  } finally {
    rmSync(result.dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi result from wrong cwd returns retrieval guidance", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "kimi-result-right-cwd-")));
  const wrongCwd = realpathSync(mkdtempSync(path.join(tmpdir(), "kimi-result-wrong-cwd-")));
  fixtureSeedRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-result-wrong-cwd-data-"));
  const corruptJobsDir = path.join(dataDir, "state", "000-corrupt", "jobs");
  mkdirSync(corruptJobsDir, { recursive: true });
  const result = runCompanion([
    "run",
    "--mode",
    "review",
    "--cwd",
    cwd,
    "--foreground",
    "--",
    "seed",
  ], { cwd, dataDir });
  try {
    assert.equal(result.status, 0, result.stderr);
    const record = parseJson(result.stdout);
    writeFileSync(path.join(corruptJobsDir, `${record.job_id}.json`), "{ malformed");
    const retrieved = runCompanion([
      "result",
      "--job",
      record.job_id,
    ], { cwd: wrongCwd, dataDir });
    assert.equal(retrieved.status, 1);
    const parsed = parseJson(retrieved.stdout);
    assert.equal(parsed.error, "not_found");
    assert.equal(parsed.job_id, record.job_id);
    assert.equal(parsed.matched_workspace, true);
    assert.equal("matched_workspace_root" in parsed, false);
    assert.doesNotMatch(JSON.stringify(parsed), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(parsed.suggested_action, /different workspace/);
    assert.match(parsed.suggested_action, /--cwd <workspace used when the job was launched>/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(wrongCwd, { recursive: true, force: true });
  }
});

test("kimi result with duplicate job id across workspaces reports state collision", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "kimi-result-collision-cwd-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-result-collision-data-"));
  const jobId = "00000000-0000-4000-8000-00000000c013";
  try {
    for (const entry of ["collision-a", "collision-b"]) {
      const jobsDir = path.join(dataDir, "state", entry, "jobs");
      mkdirSync(jobsDir, { recursive: true });
      writeFileSync(path.join(jobsDir, `${jobId}.json`), `${JSON.stringify({
        id: jobId,
        job_id: jobId,
        status: "completed",
        workspace_root: path.join(dataDir, entry),
      })}\n`, "utf8");
    }
    const result = runCompanion([
      "result",
      "--job",
      jobId,
      "--cwd",
      cwd,
    ], { cwd, dataDir });
    assert.equal(result.status, 1);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.error, "not_found");
    assert.equal(parsed.error_code, "state_collision");
    assert.equal(parsed.matched_workspace_count, 2);
    assert.match(parsed.suggested_action, /state collision/i);
    assert.equal("matched_workspace_root" in parsed, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi custom-review blocks fresh same-packet resend after a failed source-sent slot", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-review-slot-fresh-retry-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-review-slot-fresh-retry-data-"));
  const badResult = badVerdictReviewFixture("Kimi fresh retry guard marker.");
  try {
    fixtureSeedRepo(cwd);
    const commonArgs = [
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ];
    const commonOptions = {
      cwd,
      dataDir,
      env: { KIMI_MOCK_RESPONSE: badResult },
    };

    const first = runCompanion(commonArgs, commonOptions);
    assert.equal(first.status, 2, first.stderr);
    const firstRecord = parseJson(first.stdout);
    assert.equal(firstRecord.error_code, "review_not_completed");
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");

    const second = runCompanion(commonArgs, commonOptions);
    assert.equal(second.status, 2, second.stderr);
    const secondRecord = parseJson(second.stdout);
    assert.equal(secondRecord.error_code, "review_slot_disposition_required");
    assert.equal(secondRecord.external_review.source_content_transmission, "not_sent");
    assert.equal(secondRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
    assert.equal(
      secondRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "review_slot_retry_blocked",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi custom-review blocks fresh same-packet resend after a request-changes slot", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-review-slot-request-changes-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-review-slot-request-changes-data-"));
  const requestChangesResult = requestChangesReviewFixture("Kimi request-changes retry guard marker.");
  try {
    fixtureSeedRepo(cwd);
    const commonArgs = [
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ];
    const commonOptions = {
      cwd,
      dataDir,
      env: { KIMI_MOCK_RESPONSE: requestChangesResult },
    };

    const first = runCompanion(commonArgs, commonOptions);
    assert.equal(first.status, 0, first.stderr);
    const firstRecord = parseJson(first.stdout);
    assert.equal(firstRecord.status, "completed");
    assert.equal(firstRecord.external_review.review_slot?.verdict, "request_changes");
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");

    const second = runCompanion(commonArgs, commonOptions);
    assert.equal(second.status, 2, second.stderr);
    const secondRecord = parseJson(second.stdout);
    assert.equal(secondRecord.error_code, "review_slot_disposition_required");
    assert.equal(secondRecord.external_review.source_content_transmission, "not_sent");
    assert.equal(secondRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
    assert.equal(
      secondRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "review_slot_retry_blocked",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi custom-review fails shallow missing-verdict output as review_not_completed", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-shallow-review-cwd-"));
  let dataDir = null;
  try {
    fixtureSeedRepo(cwd, {
      fileName: "seed.txt",
      fileContents: "kimi shallow review sentinel\n",
    });
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_RESPONSE: "Looks fine.",
      },
    });
    dataDir = result.dataDir;
    assert.equal(result.status, 2, result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "review_not_completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, true);
    assert.deepEqual(
      record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons,
      ["shallow_output", "missing_verdict"],
    );

    const retry = runCompanion([
      "continue",
      "--job",
      record.job_id,
      "--foreground",
      "--cwd",
      cwd,
      "--",
      "retry selected source",
    ], {
      cwd,
      dataDir,
    });
    assert.equal(retry.status, 2, retry.stderr);
    const retryRecord = parseJson(retry.stdout);
    assert.equal(retryRecord.error_code, "resend_confirmation_required");
    assert.equal(retryRecord.external_review.source_content_transmission, "not_sent");
    assert.equal(
      retryRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "resend_confirmation_required",
    );
  } finally {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi review preserves result when post-run mutation detection is unavailable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-mut-post-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-mut-post-data-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "kimi-mut-post-bin-"));
  try {
    fixtureSeedRepo(cwd);
    const binary = writeIndexCorruptingBinary(binDir, cwd);
    const result = runCompanion([
      "run",
      "--mode",
      "review",
      "--cwd",
      cwd,
      "--binary",
      binary,
      "--foreground",
      "--",
      "review",
    ], { cwd, dataDir });
    assert.equal(result.status, 0, result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "completed");
    assert.match(record.result, /mutation detection failed/);
    assert.ok(record.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must be surfaced, got ${JSON.stringify(record.mutations)}`);
    assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, false);
    assert.ok(
      !record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons.includes("source_mutation_detected"),
      JSON.stringify(record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("kimi custom-review hard-fails a valid review when source mutates", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-mutation-hardfail-cwd-"));
  try {
    fixtureSeedRepo(cwd, {
      fileName: "seed.txt",
      fileContents: "kimi mutation hardfail sentinel\n",
    });
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_MUTATE_FILE: path.join(cwd, "seed.txt"),
      },
    });
    assert.equal(result.status, 2, result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "review_not_completed");
    assert.match(record.result, /Mock Kimi response/);
    assert.ok(record.mutations.includes(" M seed.txt"), JSON.stringify(record.mutations));
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.review_metadata.audit_manifest.status, "failed");
    assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, true);
    assert.ok(
      record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons.includes("source_mutation_detected"),
      JSON.stringify(record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi custom-review missing verdict replay gives bounded source-bearing recovery guidance", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-missing-verdict-replay-cwd-"));
  const exactKimiResult = [
    "The Phase 6 external review is complete. The review identified **3 blocking findings** that must be fixed before implementation approval:",
    "",
    "1. **CRITICAL**: The admission state wiring through `build_bolt_v3_live_node` → strategy registration → `run_bolt_v3_live_node` is entirely unspecified in the plan.",
    "2. **HIGH**: `StrategyRegistrationContext` and `StrategyBuildContext` lack admission state fields, creating a hidden trap that risks global state or dual paths.",
    "3. **HIGH**: The `run_bolt_v3_live_node` signature change needed to receive and arm the state is not documented.",
    "",
    "Additionally, `src/strategies/eth_chainlink_taker.rs` was declared in scope but not supplied, so it was marked **NOT REVIEWED**.",
    "",
    "The full severity-ranked findings, non-blocking concerns, and answers to the five review questions are in the approved plan file. Let me know if you want me to help draft the fixes for the blocking findings or update the plan documents accordingly.",
  ].join("\n");
  try {
    fixtureSeedRepo(cwd, {
      fileName: "seed.txt",
      fileContents: "kimi missing verdict replay sentinel\n",
    });
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_RESPONSE: exactKimiResult,
      },
    });

    assert.equal(result.status, 2, result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "review_not_completed");
    assert.equal(record.error_message, "review_quality_failed:missing_verdict");
    assert.match(record.error_summary, /omitted the required verdict marker/);
    assert.match(record.error_cause, /substantive review prose/);
    assert.match(record.suggested_action, /narrowing the scope/);
    assert.match(record.suggested_action, /sharding/);
    assert.match(record.suggested_action, /relaying/);
    assert.match(record.suggested_action, /interactive Kimi/);
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.result, exactKimiResult);
    assert.deepEqual(
      record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons,
      ["missing_verdict"],
    );
    assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi adversarial prompt uses invocation mode, not profile name, for mode line", () => withRepo((cwd) => {
  const result = runCompanion(kimiPromptAssertionArgs(cwd, "adversarial-review"), {
    cwd,
    env: {
      KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "You are performing an adversarial code review.",
    },
  });
  assert.equal(result.status, 0, result.stderr);
}));

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
  assert.match(record.suggested_action, /Do not automatically resend selected source/);
  assert.match(record.suggested_action, /fresh matching approval token/);
  const { record: persisted } = readOnlyJobRecord(result.dataDir);
  assert.equal(persisted.job_id, record.job_id);
  assert.equal(persisted.error_code, "timeout");
}));

test("kimi foreground run fails closed on Codex sandbox denial before review launch", () => withRepo((cwd) => {
  const bin = path.join(cwd, "kimi-state-denied");
  writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write("PermissionError: [Errno 1] Operation not permitted: '/Users/test/.kimi/logs/kimi.log'\\n");
process.exit(1);
`, "utf8");
  chmodSync(bin, 0o755);
  const result = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--lifecycle-events",
    "jsonl",
    "--binary",
    bin,
    "--",
    "Review this scope.",
  ], { cwd, env: { CODEX_SANDBOX: "seatbelt" } });
  assert.equal(result.status, 2);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1, "sandbox preflight must not emit external_review_launched");
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "sandbox_blocked");
  assert.match(record.error_summary, /Codex sandbox/);
  assert.match(record.suggested_action, /writable_roots|~\/\.kimi/);
  assert.equal(record.pid_info ?? null, null);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.external_review.disclosure, /not sent/);
  assert.equal(record.error_code, "sandbox_blocked");
  assert.equal(record.review_quality.failed_review_slot, false);
}));

test("kimi source-bearing preflight failures redact selected source from error messages", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-preflight-redact-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-preflight-redact-data-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "kimi-preflight-redact-bin-"));
  try {
    const missingBinary = path.join(binDir, "missing-kimi-binary");
    fixtureSeedRepo(cwd, {
      fileName: "seed.txt",
      fileContents: missingBinary,
    });
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--binary",
      missingBinary,
      "--",
      "Review this scope.",
    ], { cwd, dataDir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.error_message.includes(missingBinary), false, record.error_message);
    assert.match(record.error_message, /\[redacted_source_excerpt\]/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("kimi run ignores stale successful doctor and re-preflights before source send", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-run-stale-doctor-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-run-stale-doctor-data-"));
  try {
    fixtureSeedRepo(cwd, {
      fileName: "seed.txt",
      fileContents: "KIMI_STALE_DOCTOR_SOURCE_SENTINEL\n",
    });
    const doctor = runCompanion(["doctor"], { cwd, dataDir });
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--lifecycle-events",
      "jsonl",
      "--",
      "Review this scope.",
    ], {
      cwd,
      dataDir,
      env: { KIMI_MOCK_CAPACITY_MODEL: "kimi-code/kimi-for-coding" },
    });

    assert.equal(doctor.dataDir, result.dataDir, "stale doctor proof must reuse the same plugin data dir");
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assert.equal(parseJson(doctor.stdout).ready, true);
    assert.equal(result.status, 2);
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, "stale doctor success must not emit launch before fresh preflight");
    const [record] = lines;
    assert.equal(record.error_code, "spawn_failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.doesNotMatch(result.stdout, /KIMI_STALE_DOCTOR_SOURCE_SENTINEL/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi foreground review --timeout-ms overrides review timeout audit metadata", () => withRepo((cwd) => {
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
    "123456",
    "--",
    "Review this scope.",
  ], { cwd });
  assert.equal(result.status, 0, result.stderr);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 123456);
  const { record: persisted } = readOnlyJobRecord(result.dataDir);
  assert.equal(persisted.review_metadata.audit_manifest.request.timeout_ms, 123456);
}));

test("kimi background running review record preserves timeout audit metadata", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-running-timeout-audit-cwd-"));
  fixtureSeedRepo(cwd);
  let dataDir = null;
  let launchedPid = null;
  let targetPid = null;
  try {
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--background",
      "--timeout-ms",
      "345678",
      "--",
      "Review this scope.",
    ], { cwd, env: { KIMI_MOCK_DELAY_MS: "30000" } });
    dataDir = result.dataDir;
    assert.equal(result.status, 0, result.stderr);
    const launched = parseJson(result.stdout);
    launchedPid = launched.pid;

    const deadline = Date.now() + 5000;
    let running = null;
    while (Date.now() < deadline && !running) {
      const statusRes = spawnSync("node", [COMPANION, "status", "--cwd", cwd], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, KIMI_PLUGIN_DATA: dataDir },
      });
      assert.equal(statusRes.status, 0, statusRes.stderr);
      const status = parseJson(statusRes.stdout);
      running = status.jobs.find((job) => job.id === launched.job_id && job.status === "running");
      if (!running) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(running, "background kimi job never became visible as running");
    targetPid = running.pid_info?.pid ?? null;
    assert.equal(
      running.review_metadata?.audit_manifest?.request?.timeout_ms,
      345678,
      "running records need timeout metadata so stale reconciliation can honor the wrapper budget",
    );
    assert.equal(
      running.review_metadata?.audit_manifest?.review_quality?.failed_review_slot,
      false,
      "running lifecycle records must not be marked as failed review slots before terminal audit",
    );
  } finally {
    if (Number.isInteger(targetPid)) {
      try { process.kill(targetPid, "SIGKILL"); } catch { /* process already gone */ }
    }
    if (Number.isInteger(launchedPid)) {
      try { process.kill(launchedPid, "SIGTERM"); } catch { /* process already gone */ }
      await waitForProcessExit(launchedPid).catch(() => {});
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi foreground review retries a capacity-limited primary model with configured fallback", () => withRepo((cwd) => withKimiModelsConfig({
  review_quality: "kimi-code/primary-capacity-limited",
  rescue: "kimi-code/primary-capacity-limited",
  fallbacks: {
    review_quality: ["kimi-code/fallback-review"],
    rescue: [],
    native: [],
  },
}, () => {
  const result = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--",
    "Review this scope.",
  ], {
    cwd,
    env: { KIMI_MOCK_CAPACITY_MODEL: "kimi-code/primary-capacity-limited" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /primary-capacity-limited.*retrying with kimi-code\/fallback-review/);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.model, "kimi-code/fallback-review");
  assert.equal(record.review_metadata.audit_manifest.request.model, "kimi-code/fallback-review");
  const { record: persisted } = readOnlyJobRecord(result.dataDir);
  assert.equal(persisted.model, "kimi-code/fallback-review");
})));

test("kimi run rejects Git binary policy errors distinctly before target spawn", () => withRepo((cwd) => {
  const marker = path.join(cwd, "malicious-git-ran");
  const maliciousGit = path.join(cwd, "malicious-git");
  writeFileSync(maliciousGit, `#!/bin/sh\necho executed > ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
  chmodSync(maliciousGit, 0o700);
  const result = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--",
    "Review this scope.",
  ], { cwd, env: { CODEX_PLUGIN_MULTI_GIT_BINARY: maliciousGit } });
  assert.equal(result.status, 1, result.stderr);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "git_binary_rejected");
  assert.match(parsed.message, /CODEX_PLUGIN_MULTI_GIT_BINARY/);
  assert.equal(existsSync(marker), false, "rejected git override must not execute");
}));

test("kimi foreground review KIMI_REVIEW_TIMEOUT_MS sets review timeout audit metadata", () => withRepo((cwd) => {
  const result = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--",
    "Review this scope.",
  ], { cwd, env: { KIMI_REVIEW_TIMEOUT_MS: "234567" } });
  assert.equal(result.status, 0, result.stderr);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 234567);
  const { record: persisted } = readOnlyJobRecord(result.dataDir);
  assert.equal(persisted.review_metadata.audit_manifest.request.timeout_ms, 234567);
}));

for (const invalidTimeoutEnv of ["-1", "9007199254740992"]) {
  test(`kimi foreground review rejects invalid KIMI_REVIEW_TIMEOUT_MS ${invalidTimeoutEnv}`, () => withRepo((cwd) => {
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ], { cwd, env: { KIMI_REVIEW_TIMEOUT_MS: invalidTimeoutEnv } });
    assert.equal(result.status, 1);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.error, "bad_args");
    assert.match(parsed.message, /KIMI_REVIEW_TIMEOUT_MS must be a positive integer number of milliseconds/);
  }));
}

test("kimi background run: launched event and terminal JobRecord carry external_review", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-bg-cwd-"));
  fixtureSeedRepo(cwd);
  let launchedPid = null;
  const result = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--timeout-ms",
    "345678",
    "--background",
    "--",
    "Review this scope.",
  ], { cwd });
  try {
    assert.equal(result.status, 0, result.stderr);
    const launched = parseJson(result.stdout);
    launchedPid = launched.pid;
    assert.equal(launched.event, "launched");
    assert.equal(launched.target, "kimi");
    assert.equal(launched.mode, "custom-review");
    assert.equal(launched.external_review.run_kind, "background");
    assert.equal(launched.external_review.parent_job_id, null);
    assert.equal(launched.external_review.session_id, null);
    assert.equal(
      launched.external_review.disclosure,
      "Selected source content may be sent to Kimi Code CLI for external review.",
    );
    assert.equal(launched.external_review.source_content_transmission, "may_be_sent");

    const meta = await waitForTerminalJob(result.dataDir, launched.job_id);
    assert.equal(meta.status, "completed");
    assert.equal(meta.review_metadata.audit_manifest.request.timeout_ms, 345678);
    assert.match(meta.result, /Mock Kimi response\./);
    assert.equal(meta.kimi_session_id, KIMI_SESSION_ID);
    assert.equal(meta.external_review.review_slot?.verdict, "approved");
    assert.equal(meta.external_review.review_slot?.source_state, "sent");
    assert.deepEqual(meta.external_review, {
      marker: "EXTERNAL REVIEW",
      provider: "Kimi Code CLI",
      run_kind: "background",
      job_id: launched.job_id,
      session_id: KIMI_SESSION_ID,
      parent_job_id: null,
      mode: "custom-review",
      scope: "custom",
      scope_base: null,
      scope_paths: ["seed.txt"],
      source_content_transmission: "sent",
      review_slot: meta.external_review.review_slot,
      disclosure: "Selected source content was sent to Kimi Code CLI for external review.",
    });
  } finally {
    await waitForProcessExit(launchedPid);
    rmSync(result.dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi cancel: queued job writes cancel marker and exits 0", () => withRepo((cwd) => {
  const runRes = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--",
    "Review this scope.",
  ], { cwd });
  try {
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(runRes.dataDir);
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "queued", pid_info: null }, null, 2)}\n`, "utf8");

    const statePath = findWorkspaceStatePath(runRes.dataDir);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const idx = state.jobs.findIndex((job) => job.id === record.job_id);
    assert.notEqual(idx, -1, "queued job must exist in state.json");
    state.jobs[idx] = { ...state.jobs[idx], status: "queued", pid_info: null };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const cancelRes = spawnSync("node", [
      COMPANION,
      "cancel",
      "--job",
      record.job_id,
      "--cwd",
      cwd,
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, KIMI_PLUGIN_DATA: runRes.dataDir },
    });
    assert.equal(cancelRes.status, 0, cancelRes.stderr);
    const cancel = parseJson(cancelRes.stdout);
    assert.deepEqual(cancel, {
      ok: true,
      status: "cancel_pending",
      job_status: "queued",
      job_id: record.job_id,
    });

    const markerPath = path.join(path.dirname(metaPath), record.job_id, "cancel-requested.flag");
    assert.equal(existsSync(markerPath), true, `cancel marker missing at ${markerPath}`);
  } finally {
    rmSync(runRes.dataDir, { recursive: true, force: true });
  }
}));

test("kimi _run-worker: cancel marker removes prompt sidecar before target spawn", () => withRepo((cwd) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-worker-cancel-data-"));
  try {
    const runRes = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ], { cwd, dataDir });
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(dataDir);
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "queued", pid_info: null }, null, 2)}\n`, "utf8");

    const wsDir = path.dirname(metaPath);
    const markerDir = path.join(wsDir, record.job_id);
    mkdirSync(markerDir, { recursive: true });
    const promptPath = path.join(markerDir, "prompt.txt");
    writeFileSync(promptPath, "queued prompt with selected source\n", { mode: 0o600 });
    const markerPath = path.join(markerDir, "cancel-requested.flag");
    writeFileSync(markerPath, `${new Date().toISOString()}\n`);

    const workerRes = spawnSync("node", [
      COMPANION,
      "_run-worker",
      "--cwd",
      cwd,
      "--job",
      record.job_id,
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, KIMI_BINARY: MOCK, KIMI_PLUGIN_DATA: dataDir },
    });
    assert.equal(workerRes.status, 0, workerRes.stderr);

    const finalMeta = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(finalMeta.status, "cancelled");
    assert.equal(finalMeta.pid_info, null);
    assert.equal(existsSync(markerPath), false,
      "worker must consume queued cancel marker");
    assert.equal(existsSync(promptPath), false,
      "worker must remove prompt sidecar when queued cancel prevents target spawn");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}));

test("kimi cancel: SIGTERM-trapping target finalizes as cancelled, not completed", {
  skip: process.env.CODEX_PLUGIN_COVERAGE === "1" && process.platform === "darwin"
    ? "NODE_V8_COVERAGE can make macOS sandbox deny ps; regular smoke covers SIGTERM-trap cancel"
    : false,
}, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-trap-cancel-cwd-"));
  fixtureSeedRepo(cwd);
  let launchedPid = null;
  let targetPid = null;
  const result = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--background",
    "--",
    "Review this scope.",
  ], { cwd, env: { KIMI_MOCK_DELAY_MS: "30000", KIMI_MOCK_TRAP_SIGTERM: "1" } });
  try {
    assert.equal(result.status, 0, result.stderr);
    const launched = parseJson(result.stdout);
    launchedPid = launched.pid;

    const deadline = Date.now() + 5000;
    let running = null;
    while (Date.now() < deadline && !running) {
      const statusRes = spawnSync("node", [COMPANION, "status", "--cwd", cwd], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, KIMI_PLUGIN_DATA: result.dataDir },
      });
      const status = parseJson(statusRes.stdout);
      running = status.jobs.find((job) => job.id === launched.job_id && job.status === "running");
      if (!running) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(running, "background kimi job never became visible as running");
    assert.ok(running.pid_info?.pid, "running kimi job must carry pid_info for safe cancel");
    targetPid = running.pid_info.pid;

    const cancelRes = spawnSync("node", [
      COMPANION,
      "cancel",
      "--job",
      launched.job_id,
      "--cwd",
      cwd,
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, KIMI_PLUGIN_DATA: result.dataDir },
    });
    const cancel = parseJson(cancelRes.stdout);
    const acceptedOutcome =
      (cancel.status === "signaled" && cancelRes.status === 0) ||
      (cancel.status === "already_dead" && cancelRes.status === 0) ||
      (cancel.status === "no_pid_info" && cancelRes.status === 2) ||
      (cancel.status === "unverifiable" && cancelRes.status === 2);
    assert.ok(
      acceptedOutcome,
      `unexpected cancel outcome ${JSON.stringify(cancel)} exit=${cancelRes.status} stderr=${cancelRes.stderr}`,
    );
    if (cancelRes.status !== 0) return;

    const terminal = waitForTerminalRecord(result.dataDir, launched.job_id, { timeoutMs: 10000 });
    assert.equal(terminal.status, "cancelled",
      `cancel marker must force status=cancelled even when target traps SIGTERM; got ${JSON.stringify(terminal)}`);
    assert.equal(
      terminal.review_metadata?.audit_manifest?.review_quality?.failed_review_slot,
      true,
      "cancelled source-sent review must not count as a successful review slot",
    );
  } finally {
    if (Number.isInteger(targetPid)) {
      try { process.kill(targetPid, "SIGKILL"); } catch { /* process already gone */ }
    }
    await waitForProcessExit(launchedPid).catch(() => {});
    rmSync(result.dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi cancel: blocked process inspection is unverifiable and does not signal", () => withRepo((cwd) => {
  const runRes = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--",
    "Review this scope.",
  ], { cwd });
  try {
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(runRes.dataDir);
    const pidInfo = {
      pid: 12345,
      starttime: "12345",
      argv0: "node",
      capture_error: "process inspection denied by sandbox",
    };
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "running", pid_info: pidInfo }, null, 2)}\n`, "utf8");

    const statePath = findWorkspaceStatePath(runRes.dataDir);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const idx = state.jobs.findIndex((job) => job.id === record.job_id);
    assert.notEqual(idx, -1, "running job must exist in state.json");
    state.jobs[idx] = { ...state.jobs[idx], status: "running", pid_info: pidInfo };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const cancelRes = spawnSync("node", [
      COMPANION,
      "cancel",
      "--job",
      record.job_id,
      "--cwd",
      cwd,
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, KIMI_PLUGIN_DATA: runRes.dataDir },
    });
    assert.equal(cancelRes.status, 2, cancelRes.stderr);
    const cancel = parseJson(cancelRes.stdout);
    assert.equal(cancel.ok, false);
    assert.equal(cancel.status, "unverifiable");
    assert.equal(cancel.pid, 12345);
    assert.match(cancel.detail, /process inspection/i);
    assert.match(cancel.suggested_action, /process inspection|ownership/i);
  } finally {
    rmSync(runRes.dataDir, { recursive: true, force: true });
  }
}));

test("kimi background worker spawn failure writes failed JobRecord instead of launched", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-bg-spawn-fail-runner-"));
  const missingCwd = path.join(cwd, "missing-cwd");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "kimi-k2-0905",
     "--cwd", missingCwd, "--", "background rescue task"],
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
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi run --foreground: state lock timeout preserves finalization_failed meta", () => withRepo((cwd) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-state-lock-timeout-data-"));
  const preload = path.join(cwd, "short-lock-timeout.mjs");
  writeFileSync(preload, `
import { configureState } from ${JSON.stringify(path.join(REPO_ROOT, "plugins/kimi/scripts/lib/state.mjs"))};
configureState({ lockTimeoutMs: 150 });
`, "utf8");
  try {
    const result = runCompanion([
      "run",
      "--mode",
      "rescue",
      "--cwd",
      cwd,
      "--foreground",
      "--",
      "State lock timeout.",
    ], {
      cwd,
      dataDir,
      env: {
        KIMI_MOCK_STATE_LOCK_CONFLICT: "1",
        NODE_OPTIONS: `--import=${preload}`,
      },
    });
    assert.notEqual(result.status, 0, "state lock timeout must fail finalization");
    assert.doesNotMatch(result.stderr, /unhandled/i);
    const err = parseJson(result.stdout);
    assert.equal(err.error, "finalization_failed");
    assert.match(err.message, /state_lock_timeout/);

    const { record } = readOnlyJobRecord(dataDir);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "finalization_failed");
    assert.match(record.error_message, /state_lock_timeout/);
    assert.equal(record.external_review.source_content_transmission, "sent");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}));

test("kimi _run-worker audit manifest matches prompt sidecar source snapshot after source changes", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-worker-scope-race-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "old worker source sentinel\n",
  });
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-worker-scope-race-data-"));
  const previous = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = dataDir;
  try {
    const state = await import("../../plugins/kimi/scripts/lib/state.mjs");
    const { newJobId } = await import("../../plugins/kimi/scripts/lib/identity.mjs");
    const { buildJobRecord } = await import("../../plugins/kimi/scripts/lib/job-record.mjs");
    const { resolveProfile } = await import("../../plugins/kimi/scripts/lib/mode-profiles.mjs");
    state.configureState({
      pluginDataEnv: "KIMI_PLUGIN_DATA",
      sessionIdEnv: "KIMI_COMPANION_SESSION_ID",
    });
    const profile = resolveProfile("custom-review");
    const jobId = newJobId();
    const invocation = Object.freeze({
      job_id: jobId,
      target: "kimi",
      parent_job_id: null,
      resume_chain: [],
      mode_profile_name: profile.name,
      mode: "custom-review",
      model: "kimi-k2-0711-preview",
      cwd,
      workspace_root: cwd,
      containment: profile.containment,
      scope: profile.scope,
      dispose_effective: profile.dispose_default,
      scope_base: null,
      scope_paths: ["seed.txt"],
      prompt_head: "review selected source",
      review_prompt_contract_version: 1,
      review_prompt_provider: "Kimi",
      timeout_ms: 900000,
      max_steps_per_turn: profile.max_steps_per_turn,
      schema_spec: null,
      binary: MOCK,
      run_kind: "background",
      started_at: new Date().toISOString(),
    });
    const queued = buildJobRecord(invocation, null, []);
    state.writeJobFile(cwd, jobId, queued);
    state.upsertJob(cwd, queued);
    const promptPath = path.join(state.resolveJobsDir(cwd), jobId, "prompt.txt");
    mkdirSync(path.dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, [
      "Provider: Kimi",
      "BEGIN KIMI FILE 1: seed.txt",
      "old worker source sentinel",
      "",
      "END KIMI FILE 1: seed.txt",
      "review selected source",
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(path.join(cwd, "seed.txt"), "new worker source sentinel\n", "utf8");

    const worker = spawnSync("node", [
      COMPANION, "_run-worker", "--cwd", cwd, "--job", jobId,
    ], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        KIMI_BINARY: MOCK,
        KIMI_PLUGIN_DATA: dataDir,
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "old worker source sentinel",
      },
    });
    assert.equal(worker.status, 0, `worker stderr=${worker.stderr}; stdout=${worker.stdout}`);
    const finalRecord = JSON.parse(readFileSync(state.resolveJobFile(cwd, jobId), "utf8"));
    assert.equal(finalRecord.status, "completed");
    const [selectedFile] = finalRecord.review_metadata.audit_manifest.selected_source.files;
    assert.equal(selectedFile.path, "seed.txt");
    assert.equal(selectedFile.content_hash.value, sha256("old worker source sentinel\n"));
  } finally {
    if (previous === undefined) delete process.env.KIMI_PLUGIN_DATA;
    else process.env.KIMI_PLUGIN_DATA = previous;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
      KIMI_MOCK_STEP_LIMIT_PREFIX_JSON: "1",
    },
  });
  assert.equal(result.status, 2);
  const record = parseJson(result.stdout);
  assert.equal(record.target, "kimi");
  assert.equal(record.mode, "custom-review");
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "step_limit_exceeded");
  assert.equal(record.kimi_session_id, KIMI_SESSION_ID);
  assert.match(record.error_message, /Max number of steps reached: 1/);
  assert.match(record.suggested_action, /higher step budget/i);
  assert.match(record.suggested_action, /narrower scope/i);
  const { record: persisted } = readOnlyJobRecord(result.dataDir);
  assert.equal(persisted.job_id, record.job_id);
  assert.equal(persisted.error_code, "step_limit_exceeded");
}));

test("kimi continue background: launched event and terminal JobRecord preserve timeout metadata", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-continue-bg-cwd-"));
  fixtureSeedRepo(cwd);
  let launchedPid = null;
  const first = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--",
    "Initial review.",
  ], { cwd });
  try {
    assert.equal(first.status, 0, first.stderr);
    const prior = parseJson(first.stdout);
    assert.equal(prior.status, "completed");
    assert.equal(prior.kimi_session_id, KIMI_SESSION_ID);

    const continued = runCompanion([
      "continue",
      "--job",
      prior.job_id,
      "--background",
      "--lifecycle-events",
      "jsonl",
      "--cwd",
      cwd,
      "--",
      "Continue the review.",
    ], { cwd, dataDir: first.dataDir });
    assert.equal(continued.status, 0, continued.stderr);
    const launched = parseJson(continued.stdout);
    launchedPid = launched.pid;
    assert.equal(launched.event, "launched");
    assert.equal(launched.target, "kimi");
    assert.equal(launched.parent_job_id, prior.job_id);
    assert.equal(launched.external_review.parent_job_id, prior.job_id);
    assert.equal(launched.external_review.run_kind, "background");
    assert.equal(
      launched.external_review.disclosure,
      "Selected source content may be sent to Kimi Code CLI for external review.",
    );

    const meta = await waitForTerminalJob(first.dataDir, launched.job_id);
    assert.equal(meta.status, "completed");
    assert.equal(meta.parent_job_id, prior.job_id);
    assert.deepEqual(meta.resume_chain, [KIMI_SESSION_ID]);
    assert.equal(meta.kimi_session_id, KIMI_RESUMED_SESSION_ID);
    assert.equal(meta.external_review.parent_job_id, prior.job_id);
    assert.equal(meta.external_review.run_kind, "background");
    assert.equal(meta.external_review.session_id, KIMI_RESUMED_SESSION_ID);
    assert.equal(
      meta.external_review.disclosure,
      "Selected source content was sent to Kimi Code CLI for external review.",
    );
  } finally {
    await waitForProcessExit(launchedPid);
    rmSync(first.dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

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

test("kimi run rejects --max-steps-per-turn without a value", () => withRepo((cwd) => {
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
    "--",
    "Review this scope.",
  ], { cwd });
  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.error, "bad_args");
  assert.match(parsed.message, /--max-steps-per-turn/);
}));

test("kimi background review preserves configured max-step budget outside public JobRecord", () => withRepo((cwd) => {
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
    env: { KIMI_REVIEW_TIMEOUT_MS: "", KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48" },
  });
  assert.equal(launched.status, 0, launched.stderr);
  const payload = parseJson(launched.stdout);
  assert.equal(payload.event, "launched");

  const record = waitForTerminalRecord(dataDir, payload.job_id);
  assert.equal(record.status, "completed");
  assert.match(record.result, /Mock Kimi response\./);
  assert.equal("max_steps_per_turn" in record, false);
  const paths = findJobPaths(dataDir, payload.job_id);
  assert.equal(existsSync(paths.legacyRuntimeOptionsPath), false);
  assert.equal(existsSync(paths.runtimeOptionsPath), false);
}));

test("kimi background review step-limit exhaustion preserves private max-step budget", () => withRepo((cwd) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-background-step-limit-data-"));
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
    env: {
      KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48",
      KIMI_MOCK_STEP_LIMIT: "1",
      KIMI_MOCK_STEP_LIMIT_PREFIX_JSON: "1",
    },
  });
  assert.equal(launched.status, 0, launched.stderr);
  const payload = parseJson(launched.stdout);
  assert.equal(payload.event, "launched");

  const record = waitForTerminalRecord(dataDir, payload.job_id);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "step_limit_exceeded");
  assert.equal(record.kimi_session_id, KIMI_SESSION_ID);
  assert.equal("max_steps_per_turn" in record, false);
}));

test("kimi continue reuses prior private max-step budget without JobRecord drift", () => withRepo((cwd) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-continue-max-steps-data-"));
  const priorTimeoutMs = 900000;
  const first = runCompanion([
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
    "--timeout-ms",
    String(priorTimeoutMs),
    "--",
    "Review this scope.",
  ], {
    cwd,
    dataDir,
    env: { KIMI_REVIEW_TIMEOUT_MS: "", KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48" },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstRecord = parseJson(first.stdout);
  assert.equal(firstRecord.status, "completed");
  assert.equal("max_steps_per_turn" in firstRecord, false);
  assert.equal(firstRecord.review_metadata.audit_manifest.request.timeout_ms, priorTimeoutMs);

  const continued = runCompanion([
    "continue",
    "--job",
    firstRecord.job_id,
    "--cwd",
    cwd,
    "--foreground",
    "--",
    "Continue this review.",
  ], {
    cwd,
    dataDir,
    env: { KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48" },
  });
  assert.equal(continued.status, 0, continued.stderr);
  const continuedRecord = parseJson(continued.stdout);
  assert.equal(continuedRecord.status, "completed");
  assert.equal(continuedRecord.parent_job_id, firstRecord.job_id);
  assert.equal("max_steps_per_turn" in continuedRecord, false);
  assert.equal(continuedRecord.review_metadata.audit_manifest.request.timeout_ms, priorTimeoutMs);
}));

test("kimi continue from wrong cwd returns workspace retrieval guidance", () => withRepo((cwd) => {
  const wrongCwd = realpathSync(mkdtempSync(path.join(tmpdir(), "kimi-continue-wrong-cwd-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-continue-wrong-cwd-data-"));
  try {
    const first = runCompanion([
      "run",
      "--mode",
      "review",
      "--cwd",
      cwd,
      "--foreground",
      "--",
      "Seed review.",
    ], { cwd, dataDir });
    assert.equal(first.status, 0, first.stderr);
    const prior = parseJson(first.stdout);

    const continued = runCompanion([
      "continue",
      "--job",
      prior.job_id,
      "--foreground",
      "--",
      "Continue review.",
    ], { cwd: wrongCwd, dataDir });
    assert.equal(continued.status, 1);
    const parsed = parseJson(continued.stdout);
    assert.equal(parsed.error, "not_found");
    assert.equal(parsed.job_id, prior.job_id);
    assert.equal(parsed.matched_workspace, true);
    assert.equal("matched_workspace_root" in parsed, false);
    assert.doesNotMatch(JSON.stringify(parsed), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(parsed.suggested_action, /different workspace/);
    assert.match(parsed.suggested_action, /continue --job/);
    assert.match(parsed.suggested_action, /--cwd <workspace used when the job was launched>/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(wrongCwd, { recursive: true, force: true });
  }
}));

test("kimi continue reuses audit timeout when runtime sidecar is missing", () => withRepo((cwd) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-continue-timeout-audit-fallback-data-"));
  const priorTimeoutMs = 888888;
  const first = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--timeout-ms",
    String(priorTimeoutMs),
    "--",
    "Review this scope.",
  ], {
    cwd,
    dataDir,
    env: { KIMI_REVIEW_TIMEOUT_MS: "" },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstRecord = parseJson(first.stdout);
  rmSync(findJobPaths(dataDir, firstRecord.job_id).runtimeOptionsPath, { force: true });

  const continued = runCompanion([
    "continue",
    "--job",
    firstRecord.job_id,
    "--cwd",
    cwd,
    "--foreground",
    "--",
    "Continue this review.",
  ], {
    cwd,
    dataDir,
    env: { KIMI_REVIEW_TIMEOUT_MS: "" },
  });
  assert.equal(continued.status, 0, continued.stderr);
  const continuedRecord = parseJson(continued.stdout);
  assert.equal(continuedRecord.review_metadata.audit_manifest.request.timeout_ms, priorTimeoutMs);
}));

test("kimi continue --timeout-ms overrides prior timeout and env", () => withRepo((cwd) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-continue-timeout-override-data-"));
  const first = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--timeout-ms",
    "777777",
    "--",
    "Review this scope.",
  ], {
    cwd,
    dataDir,
    env: { KIMI_REVIEW_TIMEOUT_MS: "" },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstRecord = parseJson(first.stdout);

  const continued = runCompanion([
    "continue",
    "--job",
    firstRecord.job_id,
    "--cwd",
    cwd,
    "--foreground",
    "--timeout-ms",
    "555555",
    "--",
    "Continue this review.",
  ], {
    cwd,
    dataDir,
    env: { KIMI_REVIEW_TIMEOUT_MS: "999999" },
  });
  assert.equal(continued.status, 0, continued.stderr);
  const continuedRecord = parseJson(continued.stdout);
  assert.equal(continuedRecord.review_metadata.audit_manifest.request.timeout_ms, 555555);
}));

test("kimi continue background: launched event and terminal JobRecord keep parent metadata", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-continue-bg-cwd-"));
  fixtureSeedRepo(cwd);
  let launchedPid = null;
  const first = runCompanion([
    "run",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
    "--foreground",
    "--",
    "Initial review.",
  ], { cwd });
  try {
    assert.equal(first.status, 0, first.stderr);
    const prior = parseJson(first.stdout);
    assert.equal(prior.status, "completed");
    assert.equal(prior.kimi_session_id, KIMI_SESSION_ID);

    const continued = runCompanion([
      "continue",
      "--job",
      prior.job_id,
      "--background",
      "--cwd",
      cwd,
      "--",
      "Continue the review.",
    ], { cwd, dataDir: first.dataDir });
    assert.equal(continued.status, 0, continued.stderr);
    const launched = parseJson(continued.stdout);
    launchedPid = launched.pid;
    assert.equal(launched.event, "launched");
    assert.equal(launched.target, "kimi");
    assert.equal(launched.parent_job_id, prior.job_id);
    assert.equal(launched.external_review.parent_job_id, prior.job_id);
    assert.equal(launched.external_review.run_kind, "background");
    assert.equal(
      launched.external_review.disclosure,
      "Selected source content may be sent to Kimi Code CLI for external review.",
    );

    const meta = await waitForTerminalJob(first.dataDir, launched.job_id);
    assert.equal(meta.status, "completed");
    assert.equal(meta.parent_job_id, prior.job_id);
    assert.deepEqual(meta.resume_chain, [KIMI_SESSION_ID]);
    assert.equal(meta.kimi_session_id, KIMI_RESUMED_SESSION_ID);
    assert.equal(meta.external_review.parent_job_id, prior.job_id);
    assert.equal(meta.external_review.run_kind, "background");
    assert.equal(meta.external_review.session_id, KIMI_RESUMED_SESSION_ID);
    assert.equal(
      meta.external_review.disclosure,
      "Selected source content was sent to Kimi Code CLI for external review.",
    );
  } finally {
    await waitForProcessExit(launchedPid);
    rmSync(first.dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi continue blocks no-source repair after step-limit failure", () => withRepo((cwd) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-continue-step-limit-data-"));
  const first = runCompanion([
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
    dataDir,
    env: {
      KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48",
      KIMI_MOCK_STEP_LIMIT: "1",
      KIMI_MOCK_STEP_LIMIT_PREFIX_JSON: "1",
      KIMI_MOCK_STEP_LIMIT_RESUME_ON_STDOUT: "1",
    },
  });
  assert.equal(first.status, 2, first.stderr);
  const firstRecord = parseJson(first.stdout);
  assert.equal(firstRecord.status, "failed");
  assert.equal(firstRecord.error_code, "step_limit_exceeded");
  assert.equal(firstRecord.kimi_session_id, KIMI_SESSION_ID);
  assert.equal("max_steps_per_turn" in firstRecord, false);

  const continued = runCompanion([
    "continue",
    "--job",
    firstRecord.job_id,
    "--cwd",
    cwd,
    "--foreground",
    "--",
    "Continue this review.",
  ], { cwd, dataDir });
  assert.equal(continued.status, 2, continued.stderr);
  const continuedRecord = parseJson(continued.stdout);
  assert.equal(continuedRecord.status, "failed");
  assert.equal(continuedRecord.error_code, "resend_confirmation_required");
  assert.equal(continuedRecord.parent_job_id, firstRecord.job_id);
  assert.equal(continuedRecord.resume_chain[0], KIMI_SESSION_ID);
  assert.equal(continuedRecord.kimi_session_id, null);
  assert.equal(
    continuedRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
    "resend_confirmation_required",
  );
  assert.equal(continuedRecord.external_review.source_content_transmission, "not_sent");
  assert.equal(continuedRecord.review_metadata.audit_manifest.selected_source.totals.files, 0);
  assert.equal("max_steps_per_turn" in continuedRecord, false);
}));

test("kimi background continue blocks no-source repair after step-limit failure", () => withRepo((cwd) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-background-continue-step-limit-data-"));
  const first = runCompanion([
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
    dataDir,
    env: {
      KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48",
      KIMI_MOCK_STEP_LIMIT: "1",
      KIMI_MOCK_STEP_LIMIT_PREFIX_JSON: "1",
    },
  });
  assert.equal(first.status, 2, first.stderr);
  const firstRecord = parseJson(first.stdout);
  assert.equal(firstRecord.error_code, "step_limit_exceeded");
  assert.equal(firstRecord.kimi_session_id, KIMI_SESSION_ID);

  const blocked = runCompanion([
    "continue",
    "--job",
    firstRecord.job_id,
    "--cwd",
    cwd,
    "--background",
    "--",
    "Continue this review.",
  ], { cwd, dataDir });
  assert.equal(blocked.status, 2, blocked.stderr);
  const continuedRecord = parseJson(blocked.stdout);
  assert.equal(continuedRecord.status, "failed");
  assert.equal(continuedRecord.error_code, "resend_confirmation_required");
  assert.equal(continuedRecord.parent_job_id, firstRecord.job_id);
  assert.equal(continuedRecord.resume_chain[0], KIMI_SESSION_ID);
  assert.equal(continuedRecord.kimi_session_id, null);
  assert.equal(
    continuedRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
    "resend_confirmation_required",
  );
  assert.equal(continuedRecord.external_review.source_content_transmission, "not_sent");
  assert.equal(continuedRecord.review_metadata.audit_manifest.selected_source.totals.files, 0);
  assert.equal("max_steps_per_turn" in continuedRecord, false);
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

test("kimi preflight rejects Git binary policy errors before executing the override", () => withRepo((cwd) => {
  const marker = path.join(cwd, "malicious-git-ran");
  const maliciousGit = path.join(cwd, "malicious-git");
  writeFileSync(maliciousGit, `#!/bin/sh\necho executed > ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
  chmodSync(maliciousGit, 0o700);
  const result = runCompanion([
    "preflight",
    "--mode",
    "custom-review",
    "--cwd",
    cwd,
    "--scope-paths",
    "seed.txt",
  ], { cwd, env: { CODEX_PLUGIN_MULTI_GIT_BINARY: maliciousGit } });
  assert.equal(result.status, 1, result.stderr);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "git_binary_rejected");
  assert.match(parsed.message, /CODEX_PLUGIN_MULTI_GIT_BINARY/);
  assert.equal(existsSync(marker), false, "rejected git override must not execute");
}));

test("kimi review foreground lifecycle jsonl emits launch event before terminal JobRecord", () => withRepo((cwd) => {
  const result = runCompanion([
    "run",
    "--mode",
    "review",
    "--cwd",
    cwd,
    "--foreground",
    "--lifecycle-events",
    "jsonl",
    "--",
    "Review this scope.",
  ], {
    cwd,
    env: {
      KIMI_MOCK_ASSERT_FILE: "seed.txt",
      KIMI_MOCK_ASSERT_CWD_NOT: realpathSync(tmpdir()),
      KIMI_MOCK_ASSERT_CWD_PREFIX: realpathSync(tmpdir()),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  const [launched, record] = lines;
  assert.equal(launched.event, "external_review_launched");
  assert.equal(launched.target, "kimi");
  assert.equal(launched.status, "launched");
  assert.equal(launched.job_id, record.job_id);
  assert.deepEqual(launched.external_review, {
    marker: "EXTERNAL REVIEW",
    provider: "Kimi Code CLI",
    run_kind: "foreground",
    job_id: record.job_id,
    session_id: null,
    parent_job_id: null,
    mode: "review",
    scope: "working-tree",
    scope_base: null,
    scope_paths: null,
    source_content_transmission: "may_be_sent",
    review_slot: null,
    disclosure: "Selected source content may be sent to Kimi Code CLI for external review.",
  });
  assert.equal(record.status, "completed");
  assert.equal(record.external_review.source_content_transmission, "sent");
}));

test("kimi review --scope-base preserves branch-diff scope through target execution", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-review-scope-base-"));
  try {
    const { base } = fixtureBranchDiffRepo(cwd);
    const result = runCompanion([
      "run",
      "--mode",
      "review",
      "--cwd",
      cwd,
      "--scope-base",
      base,
      "--foreground",
      "--",
      "Review this scope.",
    ], {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_FILE: "foo.md",
        KIMI_MOCK_ASSERT_CWD_NOT: realpathSync(tmpdir()),
        KIMI_MOCK_ASSERT_CWD_PREFIX: realpathSync(tmpdir()),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.scope, "branch-diff");
    const { record: persisted } = readOnlyJobRecord(result.dataDir);
    assert.deepEqual(
      persisted.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
      ["foo.md"]
    );
    rmSync(result.dataDir, { recursive: true, force: true });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi continue preserves prior review branch-diff scope through target execution", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-continue-scope-base-"));
  try {
    const { base } = fixtureBranchDiffRepo(cwd);
    const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-continue-scope-base-data-"));
    try {
      const runRes = runCompanion([
        "run", "--mode", "review", "--cwd", cwd, "--scope-base", base,
        "--foreground", "--", "Review this scope.",
      ], { cwd, dataDir });
      assert.equal(runRes.status, 0, runRes.stderr);
      const prior = parseJson(runRes.stdout);
      const contRes = runCompanion([
        "continue", "--job", prior.job_id, "--foreground", "--cwd", cwd, "--", "follow-up",
      ], { cwd, dataDir });
      assert.equal(contRes.status, 0, contRes.stderr);
      const continued = parseJson(contRes.stdout);
      assert.equal(continued.scope, "branch-diff");
      assert.deepEqual(
        continued.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
        ["foo.md"]
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("kimi review foreground lifecycle jsonl suppresses launch event on scope failure", () => withRepo((cwd) => {
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const result = runCompanion([
    "run",
    "--mode",
    "review",
    "--cwd",
    cwd,
    "--foreground",
    "--lifecycle-events",
    "jsonl",
    "--binary",
    path.join(cwd, "missing-kimi"),
    "--",
    "Review this scope.",
  ], { cwd });
  assert.equal(result.status, 2, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.match(record.error_message, /scope_population_failed: cannot evaluate gitignored files/);
  assert.match(record.disclosure_note, /not spawned/);
  assert.match(record.disclosure_note, /not sent/);
}));

test("kimi review background lifecycle jsonl suppresses launch event on scope failure", () => withRepo((cwd) => {
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const result = runCompanion([
    "run",
    "--mode",
    "review",
    "--cwd",
    cwd,
    "--background",
    "--lifecycle-events",
    "jsonl",
    "--",
    "Review this scope.",
  ], { cwd });
  assert.equal(result.status, 2, result.stderr);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.error_message, /scope_population_failed: cannot evaluate gitignored files/);
  assert.match(record.disclosure_note, /not spawned/);
  assert.match(record.disclosure_note, /not sent/);
}));

test("kimi run rejects invalid lifecycle event mode as structured bad args", () => withRepo((cwd) => {
  const result = runCompanion([
    "run",
    "--mode",
    "review",
    "--cwd",
    cwd,
    "--foreground",
    "--lifecycle-events",
    "pretty",
    "--",
    "Review this scope.",
  ], { cwd });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /unhandled/i);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "bad_args");
  assert.match(parsed.message, /--lifecycle-events must be jsonl/);
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
    ], {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_CWD_NOT: realpathSync(tmpdir()),
        KIMI_MOCK_ASSERT_CWD_PREFIX: realpathSync(tmpdir()),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.target, "kimi");
    assert.equal(record.mode, mode);
    assert.equal(record.status, "completed");
    assert.match(record.result, /Mock Kimi response\./);
    assert.equal(record.kimi_session_id, KIMI_SESSION_ID);
    assert.equal(record.claude_session_id, null);
    assert.equal(record.external_review.review_slot?.verdict, "approved");
    assert.equal(record.external_review.review_slot?.source_state, "sent");
    assert.deepEqual(record.external_review, {
      marker: "EXTERNAL REVIEW",
      provider: "Kimi Code CLI",
      run_kind: "foreground",
      job_id: record.job_id,
      session_id: KIMI_SESSION_ID,
      parent_job_id: null,
      mode,
      scope: mode === "adversarial-review" ? "branch-diff" : (mode === "custom-review" ? "custom" : "working-tree"),
      scope_base: mode === "adversarial-review" ? "HEAD~1" : null,
      scope_paths: mode === "custom-review" ? ["seed.txt"] : null,
      source_content_transmission: "sent",
      review_slot: record.external_review.review_slot,
      disclosure: "Selected source content was sent to Kimi Code CLI for external review.",
    });
    const { record: persisted } = readOnlyJobRecord(result.dataDir);
    assert.equal(persisted.job_id, record.job_id);
    assert.match(persisted.result, /Mock Kimi response\./);
    assert.deepEqual(persisted.external_review, record.external_review);
    const fx = readStdoutLog(result.dataDir, record.job_id);
    assert.ok(fx.t7_cwd, "mock didn't record cwd");
    const tmpRoot = realpathSync(tmpdir());
    assert.notEqual(fx.t7_cwd, tmpRoot, "Kimi review must not use the temp root itself as cwd");
    assert.equal(fx.t7_cwd.startsWith(tmpRoot), true,
      `Kimi review must run from a neutral temp cwd under ${tmpRoot}; got ${fx.t7_cwd}`);
    assert.equal(fx.t7_include_dirs.includes(fx.t7_cwd), false, "neutral cwd must not be the scoped include directory");
    assert.deepEqual(fx.t7_include_dirs, [], "Kimi source-bearing review must use prompt-contained source, not workspace tools");
    assert.equal(existsSync(fx.t7_cwd), false, `neutral Kimi cwd must be cleaned after the run: ${fx.t7_cwd}`);
    assert.match(fx.t7_agent_file, /kimi-policy-.*agent\.yaml$/);
    assert.match(fx.t7_mcp_config_file, /kimi-policy-.*empty-mcp\.json$/);
    assert.match(fx.t7_skills_dir, /kimi-policy-.*skills$/);
    assert.deepEqual(fx.t7_agent_allowed_tools, []);
    assert.deepEqual(fx.t7_agent_forbidden_tool_mentions, []);
    assert.equal(existsSync(fx.t7_agent_file), false, `Kimi agent file must be cleaned after run: ${fx.t7_agent_file}`);
    assert.equal(existsSync(fx.t7_mcp_config_file), false, `Kimi MCP config must be cleaned after run: ${fx.t7_mcp_config_file}`);
    assert.equal(existsSync(fx.t7_skills_dir), false, `Kimi skills dir must be cleaned after run: ${fx.t7_skills_dir}`);
    assert.equal(persisted.review_metadata.prompt_contract_version, 1);
    assert.equal(persisted.review_metadata.prompt_provider, "Kimi");
    assert.equal(persisted.review_metadata.raw_output.parsed_ok, true);
    assert.match(persisted.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
    assert.equal(persisted.review_metadata.audit_manifest.request.model, persisted.model);
    assert.equal(persisted.review_metadata.audit_manifest.request.timeout_ms, 900000);
    assert.match(persisted.review_metadata.audit_manifest.prompt_builder.plugin_commit, /^[a-f0-9]{40}$/);
    assert.equal(persisted.review_metadata.audit_manifest.selected_route, "subscription_oauth");
    assert.equal(persisted.review_metadata.audit_manifest.fallback_reason, null);
    assert.equal(persisted.review_metadata.audit_manifest.auth_path, "subscription_oauth");
    assert.equal(persisted.review_metadata.audit_manifest.billing_path, null);
    assert.equal(persisted.review_metadata.audit_manifest.source_send_approval_required, false);
    assert.equal(persisted.review_metadata.audit_manifest.source_send_approval_state, "not_required");
    assert.equal(persisted.review_metadata.audit_manifest.approval_scope, null);
    assert.notEqual(
      persisted.review_metadata.audit_manifest.prompt_builder.plugin_commit,
      persisted.review_metadata.audit_manifest.git_identity.head_sha,
      "plugin_commit must identify the plugin source, not the reviewed repository head"
    );
    assert.equal(persisted.review_metadata.audit_manifest.scope_resolution.scope, persisted.scope);
    assert.equal(persisted.review_metadata.audit_manifest.selected_source.files.length > 0, true);
    assert.equal(JSON.stringify(persisted.review_metadata.audit_manifest).includes("review: x=1"), false);
    assert.equal(JSON.stringify(persisted.review_metadata.audit_manifest).includes("seed\\n"), false);
  }));
}
