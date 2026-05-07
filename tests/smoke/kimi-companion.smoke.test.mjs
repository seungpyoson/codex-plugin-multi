import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureGit, fixtureSeedRepo } from "../helpers/fixture-git.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/kimi/scripts/kimi-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/kimi-mock.mjs");
const KIMI_SESSION_ID = "22222222-3333-4444-9555-666666666666";
const KIMI_RESUMED_SESSION_ID = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";

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

function readStdoutLog(dataDir, jobId) {
  const { sidecarDir } = findJobPaths(dataDir, jobId);
  return JSON.parse(readFileSync(path.join(sidecarDir, "stdout.log"), "utf8"));
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

  test(`kimi ${mode} prompt includes provider live-verification context`, () => withRepo((cwd) => {
    const result = runCompanion(kimiPromptAssertionArgs(cwd, mode), {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "Live verification context",
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }));

  test(`kimi ${mode} prompt includes delegated review contract fields`, () => withRepo((cwd) => {
    const result = runCompanion(kimiPromptAssertionArgs(cwd, mode), {
      cwd,
      env: {
        KIMI_MOCK_ASSERT_PROMPT_INCLUDES: "Delegated review quality contract",
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }));
}

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
  assert.match(record.suggested_action, /run `kimi` interactively/);
  const { record: persisted } = readOnlyJobRecord(result.dataDir);
  assert.equal(persisted.job_id, record.job_id);
  assert.equal(persisted.error_code, "timeout");
}));

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
    assert.equal(meta.result, "Mock Kimi response.");
    assert.equal(meta.kimi_session_id, KIMI_SESSION_ID);
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
      disclosure: "Selected source content was sent to Kimi Code CLI for external review.",
    });
  } finally {
    await waitForProcessExit(launchedPid);
    rmSync(result.dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
  assert.equal(record.result, "Mock Kimi response.");
  assert.equal("max_steps_per_turn" in record, false);
  const paths = findJobPaths(dataDir, payload.job_id);
  assert.equal(existsSync(paths.legacyRuntimeOptionsPath), false);
  assert.equal(existsSync(paths.runtimeOptionsPath), true);
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

test("kimi continue resumes from step-limit failure and reuses private max-step budget", () => withRepo((cwd) => {
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
  ], {
    cwd,
    dataDir,
    env: {
      KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48",
      KIMI_MOCK_ASSERT_RESUME_ID: KIMI_SESSION_ID,
    },
  });
  assert.equal(continued.status, 0, continued.stderr);
  const continuedRecord = parseJson(continued.stdout);
  assert.equal(continuedRecord.status, "completed");
  assert.equal(continuedRecord.parent_job_id, firstRecord.job_id);
  assert.equal(continuedRecord.resume_chain[0], KIMI_SESSION_ID);
  assert.equal(continuedRecord.kimi_session_id, KIMI_RESUMED_SESSION_ID);
  assert.equal("max_steps_per_turn" in continuedRecord, false);
}));

test("kimi background continue resumes from step-limit failure", () => withRepo((cwd) => {
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

  const launched = runCompanion([
    "continue",
    "--job",
    firstRecord.job_id,
    "--cwd",
    cwd,
    "--background",
    "--",
    "Continue this review.",
  ], {
    cwd,
    dataDir,
    env: {
      KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN: "48",
      KIMI_MOCK_ASSERT_RESUME_ID: KIMI_SESSION_ID,
    },
  });
  assert.equal(launched.status, 0, launched.stderr);
  const payload = parseJson(launched.stdout);
  assert.equal(payload.event, "launched");

  const continuedRecord = waitForTerminalRecord(dataDir, payload.job_id);
  assert.equal(continuedRecord.status, "completed");
  assert.equal(continuedRecord.parent_job_id, firstRecord.job_id);
  assert.equal(continuedRecord.resume_chain[0], KIMI_SESSION_ID);
  assert.equal(continuedRecord.kimi_session_id, KIMI_RESUMED_SESSION_ID);
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
      KIMI_MOCK_ASSERT_CWD: realpathSync(tmpdir()),
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
    disclosure: "Selected source content may be sent to Kimi Code CLI for external review.",
  });
  assert.equal(record.status, "completed");
  assert.equal(record.external_review.source_content_transmission, "sent");
}));

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
        KIMI_MOCK_ASSERT_FILE: mode === "adversarial-review" ? "changed.txt" : "seed.txt",
        KIMI_MOCK_ASSERT_CWD: realpathSync(tmpdir()),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.target, "kimi");
    assert.equal(record.mode, mode);
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Mock Kimi response.");
    assert.equal(record.kimi_session_id, KIMI_SESSION_ID);
    assert.equal(record.claude_session_id, null);
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
      disclosure: "Selected source content was sent to Kimi Code CLI for external review.",
    });
    const { record: persisted } = readOnlyJobRecord(result.dataDir);
    assert.equal(persisted.job_id, record.job_id);
    assert.equal(persisted.result, "Mock Kimi response.");
    assert.deepEqual(persisted.external_review, record.external_review);
    const fx = readStdoutLog(result.dataDir, record.job_id);
    assert.ok(fx.t7_cwd, "mock didn't record cwd");
    const tmpRoot = realpathSync(tmpdir());
    assert.notEqual(fx.t7_cwd, tmpRoot, "Kimi review must not use the temp root itself as cwd");
    assert.equal(fx.t7_cwd.startsWith(tmpRoot), true,
      `Kimi review must run from a neutral temp cwd under ${tmpRoot}; got ${fx.t7_cwd}`);
    assert.equal(fx.t7_include_dirs.includes(fx.t7_cwd), false, "neutral cwd must not be the scoped include directory");
    assert.equal(existsSync(fx.t7_cwd), false, `neutral Kimi cwd must be cleaned after the run: ${fx.t7_cwd}`);
    assert.equal(persisted.review_metadata.prompt_contract_version, 1);
    assert.equal(persisted.review_metadata.prompt_provider, "Kimi");
    assert.equal(persisted.review_metadata.raw_output.parsed_ok, true);
    assert.match(persisted.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
    assert.equal(persisted.review_metadata.audit_manifest.request.model, persisted.model);
    assert.equal(persisted.review_metadata.audit_manifest.request.timeout_ms, 600000);
    assert.match(persisted.review_metadata.audit_manifest.prompt_builder.plugin_commit, /^[a-f0-9]{40}$/);
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
