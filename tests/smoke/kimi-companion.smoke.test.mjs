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

function assertPreflightSafetyFields(result) {
  assert.equal(result.target_spawned, false);
  assert.equal(result.selected_scope_sent_to_provider, false);
  assert.equal(result.requires_external_provider_consent, true);
}

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
