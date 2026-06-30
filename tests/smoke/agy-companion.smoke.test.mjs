import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { fixtureBranchDiffRepo, fixtureGit, fixtureSeedRepo } from "../helpers/fixture-git.mjs";
import { resolveConcurrencyAdmission } from "../../plugins/agy/scripts/lib/provider-route-policy.mjs";
import {
  acquireProviderWorkloadLease,
  releaseProviderWorkloadLease,
} from "../../plugins/agy/scripts/lib/review-workload.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/agy/scripts/agy-companion.mjs");
const AGY_ARGV_SAFE_SOURCE_PACKET_BYTES = 96 * 1024;
const AGY_RENDERED_PROMPT_ARGV_MAX_BYTES = 112 * 1024;

function rmTree(target) {
  rmSync(target, { recursive: true, force: true });
}

function writeExecutable(dir, name, source) {
  const bin = path.join(dir, name);
  writeFileSync(bin, source, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

function writeAgyMock(dir) {
  return writeExecutable(dir, "agy-mock", [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'models') { console.log('gemini-3.1-pro\\nclaude-sonnet-4.6'); process.exit(0); }",
    "const promptIndex = args.indexOf('--print');",
    "const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';",
    "const file = /BEGIN AGY FILE \\d+: ([^\\n]+)/.exec(prompt)?.[1] || 'selected source';",
    "if (/auth failure/i.test(prompt)) { console.error('login required'); process.exit(1); }",
    "console.log('Verdict: APPROVE');",
    "console.log('Blocking findings');",
    "console.log('- None. I inspected ' + file + ' and found no blocking issues.');",
    "console.log('- Scope inspected: I reviewed the supplied selected source packet for ' + file + ', including the diff context, file path, and review prompt scope. I checked for source-routing leaks, behavioral regressions, missing tests, and security-sensitive changes. The reviewed evidence was the selected AGY source packet rather than an unrestricted workspace walk.');",
    "console.log('Non-blocking concerns');",
    "console.log('- None. The selected source file ' + file + ' was reviewed for this scope.');",
    "console.log('- Residual risk: no additional concern was found after checking the selected source packet against the requested mode, scope base, and expected external-review contract.');",
    "console.log('Prompt hash input length: ' + prompt.length);",
    "",
  ].join("\n"));
}

function writeAgyCaptureMock(dir) {
  return writeExecutable(dir, "agy-capture-mock", [
    "#!/usr/bin/env node",
    "const { realpathSync, writeFileSync } = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
    "const addDirIndex = args.indexOf('--add-dir');",
    "const addDir = addDirIndex >= 0 ? args[addDirIndex + 1] : null;",
    "const addDirReal = addDir ? realpathSync.native(addDir) : null;",
    "const promptIndex = args.indexOf('--print');",
    "const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';",
    "if (process.env.RELAY_TEST_CAPTURE_OUT) writeFileSync(process.env.RELAY_TEST_CAPTURE_OUT, JSON.stringify({ cwd: process.cwd(), addDir, addDirReal, args, prompt }) + '\\n');",
    "const file = /BEGIN AGY FILE \\d+: ([^\\n]+)/.exec(prompt)?.[1] || 'selected source';",
    "console.log('Verdict: APPROVE');",
    "console.log('Blocking findings');",
    "console.log('- None. I inspected ' + file + ' and found no blocking issues.');",
    "console.log('- Scope inspected: I reviewed the supplied selected source packet for ' + file + ', including the diff context, file path, and review prompt scope. I checked for source-routing leaks, behavioral regressions, missing tests, and security-sensitive changes. The reviewed evidence was the selected AGY source packet rather than an unrestricted workspace walk.');",
    "console.log('Non-blocking concerns');",
    "console.log('- None. The selected source file ' + file + ' was reviewed for this scope.');",
    "console.log('- Residual risk: no additional concern was found after checking the selected source packet against the requested mode, scope base, and expected external-review contract.');",
    "",
  ].join("\n"));
}

function writeAgySpawnCountingMock(dir) {
  return writeExecutable(dir, "agy-spawn-counting-mock", [
    "#!/usr/bin/env node",
    "const { appendFileSync } = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (process.env.RELAY_TEST_SPAWN_COUNT_OUT) appendFileSync(process.env.RELAY_TEST_SPAWN_COUNT_OUT, JSON.stringify({ args }) + '\\n');",
    "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
    "console.log('Verdict: APPROVE');",
    "console.log('Blocking findings');",
    "console.log('- None. I inspected the selected source and found no blocking issues.');",
    "console.log('- Scope inspected: I reviewed the supplied selected source packet, including the diff context, file path, and review prompt scope. I checked for source-routing leaks, behavioral regressions, missing tests, and security-sensitive changes.');",
    "console.log('Non-blocking concerns');",
    "console.log('- None. The selected source file was reviewed for this scope.');",
    "console.log('- Residual risk: no additional concern was found after checking the selected source packet against the requested mode, scope base, and expected external-review contract.');",
    "",
  ].join("\n"));
}

function writeAgyAuthFailureMock(dir) {
  return writeExecutable(dir, "agy-auth-mock", [
    "#!/usr/bin/env node",
    "const { appendFileSync } = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
    "const promptIndex = args.indexOf('--print');",
    "const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';",
    "if (process.env.RELAY_TEST_CAPTURE_OUT) appendFileSync(process.env.RELAY_TEST_CAPTURE_OUT, JSON.stringify({ args, prompt }) + '\\n');",
    "console.error('login required');",
    "process.exit(1);",
    "",
  ].join("\n"));
}

function writeAgyTimeoutMock(dir) {
  return writeExecutable(dir, "agy-timeout-mock", [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
    "const promptIndex = args.indexOf('--print');",
    "const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';",
    "if (/relay-agy-readiness/.test(prompt)) { console.log('relay-agy-readiness'); process.exit(0); }",
    "setTimeout(() => {}, 60000);",
    "",
  ].join("\n"));
}

function writeAgyNoiseMock(dir) {
  return writeExecutable(dir, "agy-noise-mock", [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
    "console.log('I looked around and maybe everything is fine.');",
    "",
  ].join("\n"));
}

function writeAgyMutatingMock(dir) {
  return writeExecutable(dir, "agy-mutating-mock", [
    "#!/usr/bin/env node",
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
    "const mutationRoot = process.env.RELAY_TEST_MUTATION_TARGET || process.cwd();",
    "writeFileSync(join(mutationRoot, 'agy-mutated.txt'), 'AGY target wrote to source workspace\\n', 'utf8');",
    "console.log('Verdict: APPROVE');",
    "console.log('Blocking findings');",
    "console.log('- None. I inspected the selected source and found no blocking issues.');",
    "console.log('- Scope inspected: I reviewed the supplied selected source packet, including the diff context, file path, and review prompt scope. I checked for source-routing leaks, behavioral regressions, missing tests, and security-sensitive changes.');",
    "console.log('Non-blocking concerns');",
    "console.log('- None. The selected source file was reviewed for this scope.');",
    "console.log('- Residual risk: no additional concern was found after checking the selected source packet against the requested mode, scope base, and expected external-review contract.');",
    "",
  ].join("\n"));
}

function runCompanion(args, { cwd, env = {}, dataDir = mkdtempSync(path.join(tmpdir(), "agy-smoke-data-")) } = {}) {
  assert.equal(existsSync(COMPANION), true, "AGY companion entrypoint must exist");
  const home = path.join(dataDir, "home");
  const result = spawnSync("node", [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      AGY_PLUGIN_DATA: dataDir,
      ...env,
    },
  });
  return { ...result, dataDir };
}

function heldAgyWorkloadLease({ cwd, dataDir, workloadLockDir }) {
  const home = path.join(dataDir, "home");
  const agyHome = path.join(home, ".antigravity");
  mkdirSync(agyHome, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    RELAY_PROVIDER_WORKLOAD_LOCK_DIR: workloadLockDir,
  };
  const admissionContext = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    sharedStateIdentity: agyHome,
    provider: "agy",
    route: "subscription",
    env,
  });
  const admission = acquireProviderWorkloadLease({
    ...admissionContext,
    provider: "agy",
    jobId: "held-agy-job",
    cwd,
    sourceBearing: true,
    env,
  });
  return { home, admission };
}

async function waitForOnlyJobRecord(dataDir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return readOnlyJobRecord(dataDir);
    } catch (error) {
      lastError = error;
      await sleep(25);
    }
  }
  throw lastError ?? new Error(`timed out waiting for AGY JobRecord under ${dataDir}`);
}

async function waitForChildClose(closePromise, child, timeoutMs = 5000) {
  const result = await Promise.race([
    closePromise,
    sleep(timeoutMs).then(() => ({ timedOut: true })),
  ]);
  if (result?.timedOut) {
    child.kill("SIGKILL");
    throw new Error(`timed out waiting for AGY companion child pid ${child.pid}`);
  }
  return result;
}

function firstWorkspaceJobsDir(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  const workspaceDirs = readdirSync(stateRoot);
  assert.equal(workspaceDirs.length, 1, `expected one state workspace, got ${workspaceDirs.join(",")}`);
  return path.join(stateRoot, workspaceDirs[0], "jobs");
}

function readOnlyJobRecord(dataDir) {
  const jobsDir = firstWorkspaceJobsDir(dataDir);
  const records = [];
  for (const entry of readdirSync(jobsDir)) {
    if (!entry.endsWith(".json")) continue;
    const metaPath = path.join(jobsDir, entry);
    records.push({ metaPath, record: JSON.parse(readFileSync(metaPath, "utf8")) });
  }
  assert.equal(records.length, 1, `expected exactly one JobRecord, got ${records.length}`);
  return records[0];
}

function writePriorSourceSentFailure(dataDir, cwd, selectedPath = "selected.txt") {
  const jobsDir = firstWorkspaceJobsDir(dataDir);
  const jobId = "11111111-2222-4333-8444-555555555555";
  writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    job_id: jobId,
    target: "agy",
    parent_job_id: null,
    agy_session_id: null,
    resume_chain: [],
    mode: "custom-review",
    mode_profile_name: "custom-review",
    model: null,
    cwd,
    workspace_root: cwd,
    containment: "worktree",
    scope: "custom",
    dispose_effective: true,
    scope_base: null,
    scope_paths: [selectedPath],
    prompt_head: "prior failed review",
    review_metadata: {
      prompt_contract_version: "2026-05-19",
      prompt_provider: "Google Antigravity CLI",
      scope: "custom",
      scope_base: null,
      scope_paths: [selectedPath],
      raw_output: null,
      audit_manifest: {
        selected_source: {
          files: [{
            path: selectedPath,
            bytes: 21,
            lines: 1,
            content_hash: { algorithm: "sha256", value: "a87ab19afe98a324e4a064637918156df9420745d2b2d2960307698bb405a000" },
          }],
          totals: { files: 1, bytes: 21, lines: 1 },
        },
        source_content_transmission: "sent",
        review_slot: {
          retry_fingerprint: "agy-same-packet-retry",
          source_state: "sent",
          verdict: "failed",
          not_counted_reason: null,
        },
        review_quality: {
          failed_review_slot: true,
          semantic_failure_reasons: [],
        },
        error_code: "review_not_completed",
      },
    },
    schema_spec: null,
    binary: "agy-mock",
    status: "failed",
    started_at: "2026-06-01T00:00:00.000Z",
    ended_at: "2026-06-01T00:00:01.000Z",
    exit_code: 1,
    error_code: "review_not_completed",
    error_message: "prior failed after source send",
    external_review: {
      source_content_transmission: "sent",
      review_slot: {
        retry_fingerprint: "agy-same-packet-retry",
        source_state: "sent",
        verdict: "failed",
        not_counted_reason: null,
      },
    },
    runtime_diagnostics: null,
    result: null,
    mutations: [],
    schema_version: 10,
  }, null, 2));
}

test("agy doctor uses a mocked source-free binary and reports readiness without source transmission", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-doctor-cwd-"));
  const binary = writeAgyMock(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["doctor", "--binary", binary, "--cwd", cwd],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.provider, "agy");
    assert.equal(record.ready, true);
    assert.equal(record.source_content_transmission, "not_sent");
    assert.match(record.models.join("\n"), /gemini-3\.1-pro/);
    assert.doesNotMatch(stdout + stderr, /AGY_API_KEY|GOOGLE_API_KEY|selected source body/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy preflight validates scoped review setup without launching target or sending source", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-preflight-cwd-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(cwd, "capture.json");
  const { base, changedFileName } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["preflight", "--mode", "review", "--binary", binary, "--cwd", cwd, "--scope-base", base],
    { cwd, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.ok, true);
    assert.equal(record.event, "preflight");
    assert.equal(record.target, "agy");
    assert.equal(record.mode, "review");
    assert.equal(record.scope, "branch-diff");
    assert.equal(record.scope_base, base);
    assert.equal(record.file_count, 1);
    assert.deepEqual(record.files, [changedFileName]);
    assert.equal(record.source_content_transmission, "not_sent");
    assert.equal(existsSync(capturePath), false, "preflight must not launch the AGY target binary");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

for (const mode of ["review", "adversarial-review"]) {
  test(`agy ${mode} foreground lifecycle jsonl emits review-only terminal JobRecord`, () => {
    const cwd = mkdtempSync(path.join(tmpdir(), `agy-${mode}-cwd-`));
    const binary = writeAgyMock(cwd);
    const { base, changedFileName } = fixtureBranchDiffRepo(cwd);
    const { stdout, stderr, status, dataDir } = runCompanion(
      ["run", "--mode", mode, "--foreground", "--lifecycle-events", "jsonl",
       "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", `${mode}: inspect selected source`],
      { cwd },
    );
    try {
      assert.equal(status, 0, `exit ${status}: ${stderr}`);
      const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.length, 2);
      const [launched, record] = lines;
      assert.equal(launched.event, "external_review_launched");
      assert.equal(launched.target, "agy");
      assert.equal(launched.job_id, record.job_id);
      assert.deepEqual(launched.external_review, {
        marker: "EXTERNAL REVIEW",
        provider: "Google Antigravity CLI",
        run_kind: "foreground",
        job_id: record.job_id,
        session_id: null,
        parent_job_id: null,
        mode,
        scope: "branch-diff",
        scope_base: base,
        scope_paths: null,
        source_content_transmission: "may_be_sent",
        review_slot: null,
        disclosure: "Selected source content may be sent to Google Antigravity CLI for external review.",
      });
      assert.equal(record.target, "agy");
      assert.equal(record.status, "completed");
      assert.equal(record.event, "external_review_terminal");
      assert.equal(record.external_review.source_content_transmission, "sent");
      assert.equal(record.review_metadata.audit_manifest.selected_route, "subscription_oauth");
      const result = runCompanion(["result", "--job", record.job_id, "--cwd", cwd], { cwd, dataDir });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const persistedAudit = JSON.parse(result.stdout).review_metadata.audit_manifest;
      assert.equal(persistedAudit.route_step, "subscription");
      assert.deepEqual(
        persistedAudit.route_steps.map((step) => step.route),
        ["subscription", "direct_api", "openrouter"],
      );
      assert.equal(persistedAudit.selected_route, "subscription_oauth");
      assert.equal(persistedAudit.auth_path, "subscription_oauth");
      assert.equal(persistedAudit.billing_path, null);
      assert.equal(record.review_metadata.audit_manifest.selected_source.files[0].path, changedFileName);
    } finally {
      rmTree(dataDir);
      rmTree(cwd);
    }
  });
}

test("agy custom-review maps held workload lease to provider_workload_blocked without spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-workload-block-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "agy-workload-block-data-"));
  const captureDir = mkdtempSync(path.join(tmpdir(), "agy-workload-block-capture-"));
  const workloadLockDir = path.join(dataDir, "provider-workload");
  const capturePath = path.join(captureDir, "spawn.jsonl");
  fixtureSeedRepo(cwd);
  const binary = writeAgySpawnCountingMock(cwd);
  const { home, admission } = heldAgyWorkloadLease({ cwd, dataDir, workloadLockDir });
  assert.equal(admission.ok, true);

  try {
    const { stdout, stderr, status } = runCompanion([
      "run",
      "--mode", "custom-review",
      "--foreground",
      "--lifecycle-events", "jsonl",
      "--binary", binary,
      "--cwd", cwd,
      "--scope-paths", "seed.txt",
      "--",
      "Review this scope.",
    ], {
      cwd,
      dataDir,
      env: {
        HOME: home,
        RELAY_PROVIDER_WORKLOAD_LOCK_DIR: workloadLockDir,
        RELAY_TEST_SPAWN_COUNT_OUT: capturePath,
      },
    });

    assert.equal(status, 2, stderr || stdout);
    const terminal = stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.error_code, "provider_workload_blocked");
    assert.equal(terminal.external_review.source_content_transmission, "not_sent");
    const result = runCompanion(["result", "--job", terminal.job_id, "--cwd", cwd], { cwd, dataDir });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = JSON.parse(result.stdout);
    const providerWorkload = record.runtime_diagnostics?.provider_workload;
    assert.equal(providerWorkload.reason, "active_same_provider_job");
    assert.equal(providerWorkload.holder, null);
    assert.equal(existsSync(capturePath), false, "workload block must happen before AGY readiness or review spawn");
    assert.doesNotMatch(stdout, /held-agy-job/);
  } finally {
    releaseProviderWorkloadLease(admission.lease);
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(captureDir);
  }
});

test("agy custom-review reports Antigravity state-dir admission failures without spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-admission-state-cwd-"));
  const captureDir = mkdtempSync(path.join(tmpdir(), "agy-admission-state-capture-"));
  const capturePath = path.join(captureDir, "spawn.jsonl");
  fixtureSeedRepo(cwd);
  const binary = writeAgySpawnCountingMock(cwd);
  const notDirectory = path.join(cwd, "not-a-directory");
  writeFileSync(notDirectory, "not a directory\n", "utf8");
  const blockedHome = path.join(notDirectory, "state");

  const { stdout, stderr, status, dataDir } = runCompanion([
    "run",
    "--mode", "custom-review",
    "--foreground",
    "--lifecycle-events", "jsonl",
    "--binary", binary,
    "--cwd", cwd,
    "--scope-paths", "seed.txt",
    "--",
    "Review this scope.",
  ], {
    cwd,
    env: {
      ANTIGRAVITY_HOME: blockedHome,
      RELAY_TEST_SPAWN_COUNT_OUT: capturePath,
    },
  });

  try {
    assert.equal(status, 2, stderr || stdout);
    const terminal = stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.error_code, "provider_workload_blocked");
    assert.equal(terminal.external_review.source_content_transmission, "not_sent");
    const result = runCompanion(["result", "--job", terminal.job_id, "--cwd", cwd], { cwd, dataDir });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = JSON.parse(result.stdout);
    assert.equal(
      record.runtime_diagnostics?.provider_workload?.reason,
      "concurrency_admission_state_dir_unavailable",
    );
    assert.match(record.error_message, /Antigravity state directory could not be resolved/);
    assert.doesNotMatch(record.error_message, new RegExp(notDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(existsSync(capturePath), false, "admission failure must happen before AGY readiness or review spawn");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(captureDir);
  }
});

test("agy review fails the review slot when the target mutates source workspace files", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-mutation-cwd-"));
  const binary = writeAgyMutatingMock(cwd);
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review mutation detection"],
    { cwd, env: { RELAY_TEST_MUTATION_TARGET: cwd } },
  );
  try {
    assert.equal(status, 1, `exit ${status}: ${stderr}`);
    const record = stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(record.status, "failed");
    assert.equal(record.review_quality.failed_review_slot, true);
    assert.equal(record.external_review.source_content_transmission, "sent");
    const result = runCompanion(["result", "--job", record.job_id, "--cwd", cwd], { cwd, dataDir });
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
    const persisted = JSON.parse(result.stdout);
    assert.match(persisted.mutations.join("\n"), /agy-mutated\.txt/);
    assert.match(
      persisted.review_metadata.audit_manifest.review_quality.semantic_failure_reasons.join("\n"),
      /source_mutation_detected/,
    );
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy custom-review uses explicit scope paths without branch-diff fallback", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-custom-cwd-"));
  const binary = writeAgyMock(cwd);
  writeFileSync(path.join(cwd, "selected.txt"), "selected source body\n", "utf8");
  writeFileSync(path.join(cwd, "unselected.txt"), "unselected source body\n", "utf8");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "selected.txt", "--", "review explicit file"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    const [launched, record] = lines;
    assert.equal(launched.external_review.scope, "custom");
    assert.equal(launched.external_review.scope_base, null);
    assert.deepEqual(launched.external_review.scope_paths, ["selected.txt"]);
    assert.equal(record.external_review.scope, "custom");
    assert.deepEqual(record.external_review.scope_paths, ["selected.txt"]);
    assert.equal(record.review_metadata.audit_manifest.selected_source.files.length, 1);
    assert.equal(record.review_metadata.audit_manifest.selected_source.files[0].path, "selected.txt");
    assert.doesNotMatch(stdout + stderr, /unselected source body/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy custom-review rejects over-budget source packets before AGY launch", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-over-budget-cwd-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(cwd, "agy-capture.json");
  const largePath = path.join(cwd, "large.txt");
  writeFileSync(largePath, `${"x".repeat(AGY_ARGV_SAFE_SOURCE_PACKET_BYTES + 4096)}\n`, "utf8");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "large.txt", "--timeout-ms", "12345",
     "--", "review large packet"],
    { cwd, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}\n${stdout}`);
    assert.equal(existsSync(capturePath), false, "AGY mock must not spawn for blocked source packet");
    const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.event === "external_review_launched"), false);
    assert.equal(events.length, 1);
    const record = events[0];
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "source_packet_too_large");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    const policy = record.runtime_diagnostics?.source_packet_policy;
    assert.ok(policy, "source packet policy diagnostic must be present");
    assert.equal(policy.source_send_allowed, false);
    assert.equal(policy.source_packet_policy_error_code, "source_packet_too_large");
    assert.equal(policy.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 12345);
    assert.equal(record.review_metadata.audit_manifest.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, false);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "not_required");
    assert.equal(record.review_metadata.audit_manifest.packet_recovery.reason, "source_packet_too_large");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy custom-review rejects rendered prompts that exceed the --print argv transport cap", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-rendered-argv-budget-cwd-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(cwd, "agy-capture.json");
  const tinyDir = path.join(cwd, "tiny");
  mkdirSync(tinyDir);
  for (let i = 0; i < 1700; i += 1) {
    writeFileSync(path.join(tinyDir, `file-${String(i).padStart(4, "0")}.txt`), "x\n", "utf8");
  }

  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "tiny/**", "--timeout-ms", "12345",
     "--allow-large-source-packet", "--", "review many tiny files"],
    { cwd, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}\n${stdout}`);
    assert.equal(existsSync(capturePath), false, "AGY mock must not spawn when rendered argv is too large");
    const record = readOnlyJobRecord(dataDir).record;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "prompt_too_large");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.match(record.error_message, /rendered AGY --print argv/);
    const policy = record.runtime_diagnostics?.source_packet_policy;
    assert.ok(policy, "source packet policy diagnostic must be present");
    assert.equal(policy.source_send_allowed, false);
    assert.equal(policy.source_packet_policy_error_code, "prompt_too_large");
    assert.equal(policy.source_content_transmission, "not_sent");
    assert.ok(policy.selected_source_bytes < AGY_ARGV_SAFE_SOURCE_PACKET_BYTES);
    assert.ok(policy.rendered_prompt_bytes > AGY_RENDERED_PROMPT_ARGV_MAX_BYTES);
    assert.equal(policy.rendered_prompt_argv_budget_bytes, AGY_RENDERED_PROMPT_ARGV_MAX_BYTES);
    assert.equal(policy.source_packet_override_approved, true);
    assert.equal(policy.source_packet_override_source, "--allow-large-source-packet");
    const recovery = record.review_metadata.audit_manifest.packet_recovery;
    assert.equal(recovery.reason, "prompt_too_large");
    assert.equal(
      recovery.provider_capabilities.rendered_prompt_budget_chars,
      AGY_RENDERED_PROMPT_ARGV_MAX_BYTES,
    );
    assert.equal(record.review_metadata.audit_manifest.source_content_transmission, "not_sent");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy custom-review keeps resume_without_source_resend disabled and continue fail-closed", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-no-resume-resend-cwd-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(cwd, "agy-capture.json");
  writeFileSync(path.join(cwd, "selected.txt"), "selected source body\n", "utf8");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "selected.txt",
     "--resume-without-source-resend", "--", "review with agy no-resend divergence"],
    { cwd, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}\n${stdout}`);
    assert.equal(existsSync(capturePath), true, "normal AGY run should still reach the target");
    const record = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).at(-1);
    assert.equal(record.status, "completed");
    const policy = record.review_metadata.audit_manifest.source_packet_policy;
    assert.equal(policy.resume_without_source_resend, false);
    assert.notEqual(policy.source_packet_action, "resume_without_source_resend");

    const rejectedContinue = runCompanion(
      ["continue", "--job", record.job_id, "--cwd", cwd, "--resume-without-source-resend", "--", "continue without source"],
      { cwd, dataDir },
    );
    assert.equal(rejectedContinue.status, 1);
    const rejected = JSON.parse(rejectedContinue.stdout);
    assert.equal(rejected.error_code, "bad_args");
    assert.match(rejected.error_message, /continue|resume|unsupported/i);
    assert.equal(rejected.source_content_transmission, "not_sent");

    const persisted = readOnlyJobRecord(dataDir).record;
    assert.equal(
      persisted.review_metadata.audit_manifest.source_packet_policy.resume_without_source_resend,
      false,
    );
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy run reads prompt text from --prompt-file instead of treating the flag as focus", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-prompt-file-cwd-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(cwd, "agy-capture.json");
  const promptFile = path.join(cwd, "prompt.txt");
  writeFileSync(path.join(cwd, "selected.txt"), "selected source body\n", "utf8");
  writeFileSync(promptFile, "AGY_PROMPT_FILE_SENTINEL\n", { mode: 0o600 });
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "selected.txt", "--prompt-file", promptFile],
    { cwd, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}\n${stdout}`);
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.match(capture.prompt, /AGY_PROMPT_FILE_SENTINEL/);
    assert.doesNotMatch(capture.prompt, /--prompt-file/);
    assert.doesNotMatch(capture.prompt, new RegExp(promptFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy run rejects prompt-file mixed with positional prompt text", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-prompt-file-positional-cwd-"));
  const binary = writeAgyMock(cwd);
  const promptFile = path.join(cwd, "prompt.txt");
  writeFileSync(promptFile, "file prompt\n", { mode: 0o600 });
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--binary", binary, "--cwd", cwd,
     "--prompt-file", promptFile, "--", "positional prompt"],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const record = JSON.parse(stdout);
    assert.equal(record.error_code, "bad_args");
    assert.match(record.error_message, /either with --prompt-file or after -- separator/);
    assert.equal(record.source_content_transmission, "not_sent");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy run rejects empty or unreadable prompt-file before source transmission", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-prompt-file-bad-cwd-"));
  const binary = writeAgyMock(cwd);
  const emptyFile = path.join(cwd, "empty-prompt.txt");
  const missingFile = path.join(cwd, "missing-prompt.txt");
  writeFileSync(emptyFile, "\n", { mode: 0o600 });
  const cases = [
    {
      promptFile: emptyFile,
      pattern: /must contain a non-empty prompt/,
    },
    {
      promptFile: missingFile,
      pattern: /could not read --prompt-file/,
    },
  ];
  try {
    for (const { promptFile, pattern } of cases) {
      const { stdout, status, dataDir } = runCompanion(
        ["run", "--mode", "review", "--foreground", "--binary", binary, "--cwd", cwd, "--prompt-file", promptFile],
        { cwd },
      );
      try {
        assert.equal(status, 1);
        const record = JSON.parse(stdout);
        assert.equal(record.error_code, "bad_args");
        assert.match(record.error_message, pattern);
        assert.equal(record.source_content_transmission, "not_sent");
      } finally {
        rmTree(dataDir);
      }
    }
  } finally {
    rmTree(cwd);
  }
});

test("agy custom-review blocks same-packet resend after a failed source-sent slot until confirmed", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-resend-cwd-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(cwd, "agy-resend-capture.json");
  const dataDir = mkdtempSync(path.join(tmpdir(), "agy-resend-data-"));
  writeFileSync(path.join(cwd, "selected.txt"), "selected source body\n", "utf8");
  const first = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "selected.txt", "--", "seed queued record"],
    { cwd, dataDir, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    writePriorSourceSentFailure(dataDir, cwd);
    rmSync(capturePath, { force: true });

    const blocked = runCompanion(
      ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
       "--binary", binary, "--cwd", cwd, "--scope-paths", "selected.txt", "--", "retry same packet"],
      { cwd, dataDir, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
    );
    assert.equal(blocked.status, 2, `exit ${blocked.status}: ${blocked.stderr}\n${blocked.stdout}`);
    assert.equal(existsSync(capturePath), false, "blocked resend must not spawn AGY");
    const blockedRecord = blocked.stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(blockedRecord.error_code, "resend_confirmation_required");
    assert.equal(blockedRecord.external_review.source_content_transmission, "not_sent");
    assert.equal(
      blockedRecord.runtime_diagnostics.source_packet_policy.source_packet_action,
      "resend_confirmation_required",
    );

    const confirmed = runCompanion(
      ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
       "--binary", binary, "--cwd", cwd, "--scope-paths", "selected.txt",
       "--resend-confirmation-approved", "--", "retry same packet confirmed"],
      { cwd, dataDir, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
    );
    assert.equal(confirmed.status, 0, `exit ${confirmed.status}: ${confirmed.stderr}\n${confirmed.stdout}`);
    const confirmedRecord = confirmed.stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(
      confirmedRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "send_after_resend_confirmation",
    );
    assert.equal(confirmedRecord.external_review.source_content_transmission, "sent");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy custom-review permits explicit large source packet override", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-over-budget-override-cwd-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(cwd, "agy-capture.json");
  writeFileSync(path.join(cwd, "large.txt"), `${"x".repeat(AGY_ARGV_SAFE_SOURCE_PACKET_BYTES + 4096)}\n`, "utf8");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "large.txt",
     "--allow-large-source-packet", "--", "review large packet with explicit override"],
    { cwd, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}\n${stdout}`);
    assert.equal(existsSync(capturePath), true, "override should proceed to AGY launch");
    const record = stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    const policy = record.review_metadata.audit_manifest.source_packet_policy;
    assert.equal(policy.source_packet_action, "send_after_source_packet_override");
    assert.equal(policy.source_packet_override_approved, true);
    assert.equal(policy.source_packet_override_source, "--allow-large-source-packet");
    assert.equal(policy.source_content_transmission, "may_be_sent");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy run rejects --background as unsupported foreground-only posture", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-background-cwd-"));
  const binary = writeAgyMock(cwd);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--background", "--binary", binary, "--cwd", cwd, "--", "review background rejection"],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const record = JSON.parse(stdout);
    assert.equal(record.error_code, "bad_args");
    assert.match(record.error_message, /--background.*unsupported|foreground-only/i);
    assert.equal(record.source_content_transmission, "not_sent");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy source-bearing review points target at scoped containment, not source cwd", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-containment-cwd-"));
  const captureDir = mkdtempSync(path.join(tmpdir(), "agy-containment-capture-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(captureDir, "capture.json");
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review scoped add-dir"],
    { cwd, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(record.status, "completed");
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.notEqual(capture.cwd, cwd);
    assert.notEqual(capture.addDir, cwd);
    assert.equal(capture.cwd, capture.addDirReal);
    assert.match(path.basename(capture.addDir), /^agy-worktree-/);
    assert.equal(existsSync(capture.addDir), false, "scoped containment should be cleaned after foreground run");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(captureDir);
  }
});

test("agy empty branch-diff fails closed before prompt fallback or target spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-empty-branch-diff-cwd-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(cwd, "capture.json");
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "selected source body must not be sent\n",
    message: "seed",
  });
  const base = fixtureGit(cwd, ["rev-parse", "HEAD"]).stdout.trim();
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review empty branch diff"],
    { cwd, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "scope_failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(existsSync(capturePath), false, "target AGY binary must not spawn on empty branch-diff");
    assert.doesNotMatch(stdout + stderr, /selected source body must not be sent/);
    assert.match(record.error_message, /branch-diff selected no files/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy custom-review rejects symlink scope paths that escape the workspace", { skip: process.platform === "win32" }, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-custom-symlink-cwd-"));
  const escapeDir = mkdtempSync(path.join(tmpdir(), "agy-custom-symlink-escape-"));
  const binary = writeAgyMock(cwd);
  writeFileSync(path.join(escapeDir, "secret.txt"), "outside workspace secret body\n", "utf8");
  symlinkSync(path.join(escapeDir, "secret.txt"), path.join(cwd, "linked-secret.txt"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "linked-secret.txt", "--", "review explicit file"],
    { cwd },
  );
  try {
    assert.equal(status, 2);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "scope_failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.match(record.error_message, /escapes workspace|outside source root/);
    assert.doesNotMatch(stdout + stderr, /outside workspace secret body/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(escapeDir);
  }
});

test("agy run rejects invalid --timeout-ms before source transmission", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-timeout-bad-cwd-"));
  const binary = writeAgyMock(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--timeout-ms", "0.5",
     "--binary", binary, "--cwd", cwd, "--", "review invalid timeout"],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const record = JSON.parse(stdout);
    assert.equal(record.error_code, "bad_args");
    assert.equal(record.source_content_transmission, "not_sent");
    assert.match(record.error_message, /--timeout-ms must be a positive integer number of milliseconds/);
    assert.doesNotMatch(stdout + stderr, /selected source body/i);

    const tooLarge = runCompanion(
      ["run", "--mode", "review", "--foreground", "--timeout-ms", "2147483648",
       "--binary", binary, "--cwd", cwd, "--", "review too-large timeout"],
      { cwd },
    );
    assert.equal(tooLarge.status, 1);
    const tooLargeRecord = JSON.parse(tooLarge.stdout);
    assert.equal(tooLargeRecord.error_code, "bad_args");
    assert.equal(tooLargeRecord.source_content_transmission, "not_sent");
    assert.match(tooLargeRecord.error_message, /--timeout-ms must be between 1 and 2147483647 milliseconds/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy status and result read the persisted foreground JobRecord", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-status-result-cwd-"));
  const binary = writeAgyMock(cwd);
  const { base } = fixtureBranchDiffRepo(cwd);
  const runResult = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review persisted result"],
    { cwd },
  );
  try {
    assert.equal(runResult.status, 0, `exit ${runResult.status}: ${runResult.stderr}`);
    const record = runResult.stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(record.status, "completed");

    const result = runCompanion(
      ["result", "--job", record.job_id, "--cwd", cwd],
      { cwd, dataDir: runResult.dataDir },
    );
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).job_id, record.job_id);

    const statusResult = runCompanion(
      ["status", "--cwd", cwd],
      { cwd, dataDir: runResult.dataDir },
    );
    assert.equal(statusResult.status, 0, `exit ${statusResult.status}: ${statusResult.stderr}`);
    const statusRecord = JSON.parse(statusResult.stdout);
    assert.deepEqual(statusRecord.jobs.map((job) => job.id), [record.job_id]);
  } finally {
    rmTree(runResult.dataDir);
    rmTree(cwd);
  }
});

test("agy markdown lifecycle emits an external review launch card before the terminal record", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-markdown-cwd-"));
  const binary = writeAgyMock(cwd);
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "markdown",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review markdown lifecycle"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    assert.match(stdout, /^### EXTERNAL REVIEW\n/);
    assert.match(stdout, /\| Provider \| Google Antigravity CLI \|/);
    assert.match(stdout, /\| Scope \| branch-diff /);
    assert.match(stdout, /\| Source \| may_be_sent \|/);
    assert.match(stdout, /\| Source \| sent \|/);
    assert.equal(stdout.match(/^### EXTERNAL REVIEW$/gm).length, 2);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy doctor missing binary reports structured not_found without source transmission", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-missing-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["doctor", "--binary", path.join(cwd, "missing-agy"), "--cwd", cwd],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const record = JSON.parse(stdout);
    assert.equal(record.provider, "agy");
    assert.equal(record.ready, false);
    assert.equal(record.error_code, "not_found");
    assert.equal(record.source_content_transmission, "not_sent");
    assert.doesNotMatch(stdout + stderr, /selected source body/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy source-bearing auth failure fails before source transmission", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-auth-cwd-"));
  const binary = writeAgyAuthFailureMock(cwd);
  const capturePath = path.join(cwd, "agy-auth-capture.jsonl");
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review auth failure handling"],
    { cwd, env: { RELAY_TEST_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(status, 1);
    const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.event === "external_review_launched"), false);
    const record = events.at(-1);
    assert.equal(record.error_code, "not_authed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    const invocations = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.length, 1);
    assert.doesNotMatch(invocations[0].prompt, /BEGIN AGY FILE|foo\n|\+foo|selected source body/i);
    assert.doesNotMatch(stdout + stderr, /login required.*selected source/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy timeout returns terminal timeout without retry", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-timeout-cwd-"));
  const binary = writeAgyTimeoutMock(cwd);
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--timeout-ms", "25", "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review timeout handling"],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const record = stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(record.error_code, "timeout");
    assert.equal(record.review_quality.failed_review_slot, true);
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.doesNotMatch(stdout + stderr, /foo\\n|\+foo|selected source body/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy queued cancel marker exits before target spawn", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-pre-spawn-cancel-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "agy-pre-spawn-cancel-data-"));
  const binary = writeAgySpawnCountingMock(cwd);
  const countPath = path.join(cwd, "agy-spawn-count.txt");
  writeFileSync(path.join(cwd, "selected.txt"), "selected source body\n", "utf8");

  let stdout = "";
  let stderr = "";
  let closed = false;
  const child = spawn("node", [
    COMPANION,
    "run",
    "--mode",
    "custom-review",
    "--foreground",
    "--lifecycle-events",
    "jsonl",
    "--binary",
    binary,
    "--cwd",
    cwd,
    "--scope-paths",
    "selected.txt",
    "--",
    "review queued cancel marker",
  ], {
    cwd,
    env: {
      ...process.env,
      AGY_PLUGIN_DATA: dataDir,
      RELAY_TEST_SPAWN_COUNT_OUT: countPath,
      RELAY_TEST_AGY_AFTER_QUEUE_DELAY_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closePromise = new Promise((resolve) => {
    child.on("close", (status, signal) => {
      closed = true;
      resolve({ status, signal });
    });
  });

  try {
    const { metaPath, record: queuedRecord } = await waitForOnlyJobRecord(dataDir);
    assert.equal(queuedRecord.status, "queued");
    assert.equal(queuedRecord.pid_info, null);

    const cancelRes = spawnSync("node", [
      COMPANION,
      "cancel",
      "--job",
      queuedRecord.job_id,
      "--cwd",
      cwd,
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, AGY_PLUGIN_DATA: dataDir },
    });
    assert.equal(cancelRes.status, 0, cancelRes.stderr);
    assert.deepEqual(JSON.parse(cancelRes.stdout), {
      ok: true,
      status: "cancel_pending",
      job_status: "queued",
      job_id: queuedRecord.job_id,
    });

    const childResult = await waitForChildClose(closePromise, child);
    assert.equal(childResult.status, 0, `exit ${childResult.status} signal ${childResult.signal}: ${stderr}\n${stdout}`);
    assert.equal(existsSync(countPath), false, "pre-spawn cancel must not invoke AGY readiness or review target");
    const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "cancelled");

    const finalMeta = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(finalMeta.status, "cancelled");
    assert.equal(finalMeta.pid_info, null);
  } finally {
    if (!closed) {
      child.kill("SIGKILL");
      await waitForChildClose(closePromise, child, 1000).catch(() => {});
    }
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy cancel reports not_found without source transmission", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-cancel-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["cancel", "--job", "missing-job", "--cwd", cwd],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const record = JSON.parse(stdout);
    assert.equal(record.ok, false);
    assert.equal(record.error_code, "not_found");
    assert.doesNotMatch(stderr, /Usage:/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy non-review stdout noise is not accepted as a completed review", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-noise-cwd-"));
  const binary = writeAgyNoiseMock(cwd);
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review non-review output"],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const record = stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "review_not_completed");
    assert.equal(record.review_quality.failed_review_slot, true);
    assert.equal(record.external_review.source_content_transmission, "sent");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

function resolveRealGit() {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" });
  return String(which.stdout ?? "").trim().split(/\r?\n/).filter(Boolean)[0] ?? "";
}

// Brace-match concatenated JSON values from a stdout stream. printJson() (and fail())
// pretty-print with JSON.stringify(obj, null, 2), so the terminal record can span multiple
// lines — a line-based JSON.parse would break on it. Returns the parsed objects in order.
function parseJsonStream(raw) {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") { inStr = true; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && start >= 0) { objs.push(JSON.parse(raw.slice(start, i + 1))); start = -1; } }
  }
  return objs;
}

// PR #218 round-2 HIGH (source-disclosure INVERSION) + round-3 (escape finalization):
// a git-binary policy rejection raised by a POST-spawn workspace re-resolution — e.g. a
// mid-run .git boundary topology change that moves the RELAY_GIT_BINARY override inside a
// new workspace boundary so the cached resolveGitBinary key misses and re-validation throws.
// Round-2: that throw used to escape run() to main().catch -> fail(), which hard-coded
// source_content_transmission:"not_sent" — a FALSE disclosure (the source was already
// delivered to the target at execve). Round-3: run() now catches the escape and finalizes a
// terminal JobRecord through the SAME buildJobRecord path as an in-band post-run rejection,
// so the foreground converges with the durable record instead of leaking the source-bearing
// worktree or orphaning a queued record (see tests/unit/agy-run-git-policy-escape.test.mjs).
// classifyExecution reclassifies the post-spawn git_binary_rejected (pidInfo present) to the
// content-received agy_error catch-all; disclosure resolves SENT and the git-policy cause
// stays in error_message. Pre-spawn (no pidInfo) still discloses NOT_SENT (next test).
test("agy post-spawn git_binary_rejected (mid-run .git topology change) discloses SENT, not a false not_sent", () => {
  const realGit = resolveRealGit();
  assert.ok(realGit, "a real git binary must be resolvable for this test");
  const root = mkdtempSync(path.join(tmpdir(), "agy-inv-"));
  const cwd = path.join(root, "ws");
  mkdirSync(cwd);
  try {
    const { base } = fixtureBranchDiffRepo(cwd);
    // Override git binary OUTSIDE the workspace at spawn time (a sibling under root).
    const gitbin = path.join(root, "gitbin");
    mkdirSync(gitbin);
    const override = writeExecutable(gitbin, "git", `#!/bin/sh\nexec ${JSON.stringify(realGit)} "$@"\n`);
    const capturePath = path.join(root, "captured-prompt.txt");
    // Mock captures the --print prompt (proves the source was sent) and creates root/.git
    // mid-run: root then becomes the outermost workspace boundary and contains gitbin, so
    // the post-spawn resolveGitBinary cacheKey misses and re-validation rejects the override.
    const mock = writeExecutable(root, "agy-topology-mock", [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
      "const pi = args.indexOf('--print');",
      `fs.writeFileSync(${JSON.stringify(capturePath)}, pi >= 0 ? args[pi + 1] : '');`,
      `try { fs.mkdirSync(${JSON.stringify(path.join(root, ".git"))}); } catch {}`,
      "console.log('Verdict: APPROVE');",
      "console.log('Blocking findings');",
      "console.log('- None. I inspected the selected source packet and found no blocking issues. I checked source-routing leaks, behavioral regressions, missing tests, and security-sensitive changes against the selected AGY source rather than an unrestricted workspace walk.');",
      "console.log('Non-blocking concerns');",
      "console.log('- None. The selected source packet was reviewed for the requested mode, scope base, and external-review contract.');",
      "console.log('- Residual risk: no additional concern after checking the selected source packet.');",
      "",
    ].join("\n"));
    const { stdout, dataDir } = runCompanion(
      ["run", "--mode", "review", "--cwd", cwd, "--scope-base", base, "--timeout-ms", "30000", "please review the change"],
      { cwd, env: { RELAY_GIT_BINARY: override, AGY_BINARY: mock } },
    );
    try {
      assert.equal(existsSync(capturePath), true, "the mock AGY must have received the source prompt (proves the source was sent)");
      const terminal = parseJsonStream(stdout).at(-1);
      assert.equal(terminal.status, "failed", "the post-spawn escape must finalize a terminal failed record, not orphan a queued one");
      assert.equal(terminal.error_code ?? terminal.external_review?.error_code, "agy_error",
        "classifyExecution reclassifies post-spawn git_binary_rejected (pidInfo present) to the content-received agy_error catch-all");
      assert.ok(terminal.error_message && terminal.error_message.length > 0,
        "the git-binary policy cause must remain visible in error_message after reclassification");
      const disclosure = terminal.source_content_transmission ?? terminal.external_review?.source_content_transmission;
      assert.equal(disclosure, "sent", "a post-spawn failure after the source was sent must disclose SENT, never not_sent");
    } finally {
      rmTree(dataDir);
    }
  } finally {
    rmTree(root);
  }
});

// Symmetric guard: a genuine PRE-spawn git-binary rejection (override inside the workspace
// from the start) must still disclose not_sent — the target never spawned, so the source
// truly never left this process. The disclosure fix must not over-correct.
test("agy pre-spawn git_binary_rejected discloses not_sent (source genuinely not sent)", () => {
  const realGit = resolveRealGit();
  assert.ok(realGit, "a real git binary must be resolvable for this test");
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-presym-"));
  try {
    const { base } = fixtureBranchDiffRepo(cwd);
    // Override git binary INSIDE the workspace from the start -> policy reject pre-spawn,
    // before the target is ever spawned.
    const gitbin = path.join(cwd, "gitbin");
    mkdirSync(gitbin);
    const override = writeExecutable(gitbin, "git", `#!/bin/sh\nexec ${JSON.stringify(realGit)} "$@"\n`);
    const ranMarker = path.join(cwd, "MOCK_SOURCE_SPAWN");
    const mock = writeExecutable(cwd, "agy-never-mock", [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
      `if (args.includes('--print')) fs.writeFileSync(${JSON.stringify(ranMarker)}, '1');`,
      "console.log('Verdict: APPROVE');",
      "",
    ].join("\n"));
    const { stdout, dataDir } = runCompanion(
      ["run", "--mode", "review", "--cwd", cwd, "--scope-base", base, "--timeout-ms", "30000", "please review"],
      { cwd, env: { RELAY_GIT_BINARY: override, AGY_BINARY: mock } },
    );
    try {
      const terminal = parseJsonStream(stdout).at(-1);
      const disclosure = terminal.source_content_transmission ?? terminal.external_review?.source_content_transmission;
      assert.equal(terminal.error_code ?? terminal.external_review?.error_code, "git_binary_rejected");
      assert.equal(disclosure, "not_sent", "a pre-spawn failure must disclose not_sent");
      assert.equal(existsSync(ranMarker), false, "the target must never have spawned with source (source not sent)");
    } finally {
      rmTree(dataDir);
    }
  } finally {
    rmTree(cwd);
  }
});
