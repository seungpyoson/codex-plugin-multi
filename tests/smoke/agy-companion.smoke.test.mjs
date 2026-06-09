import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureBranchDiffRepo } from "../helpers/fixture-git.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/agy/scripts/agy-companion.mjs");

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
    "if (/auth failure/i.test(prompt)) { console.error('login required'); process.exit(1); }",
    "console.log('Verdict: APPROVE');",
    "console.log('Blocking findings');",
    "console.log('- None.');",
    "console.log('Prompt hash input length: ' + prompt.length);",
    "",
  ].join("\n"));
}

function writeAgyAuthFailureMock(dir) {
  return writeExecutable(dir, "agy-auth-mock", [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
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

function runCompanion(args, { cwd, env = {}, dataDir = mkdtempSync(path.join(tmpdir(), "agy-smoke-data-")) } = {}) {
  assert.equal(existsSync(COMPANION), true, "AGY companion entrypoint must exist");
  const result = spawnSync("node", [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      AGY_PLUGIN_DATA: dataDir,
      ...env,
    },
  });
  return { ...result, dataDir };
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
      assert.equal(record.review_metadata.audit_manifest.selected_source.files[0].path, changedFileName);
      assert.match(record.result, /Verdict: APPROVE/);
      assert.equal(record.agy_session_id, null);
    } finally {
      rmTree(dataDir);
      rmTree(cwd);
    }
  });
}

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
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review auth failure handling"],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const record = stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(record.error_code, "not_authed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
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
    assert.equal(record.review_metadata.audit_manifest.retry_count, 0);
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.doesNotMatch(stdout + stderr, /foo\\n|\+foo|selected source body/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("agy cancel rejects foreground and reports background cancel contract", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-cancel-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["cancel", "--job", "missing-job", "--cwd", cwd],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const record = JSON.parse(stdout);
    assert.equal(record.target, "agy");
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "not_found");
    assert.equal(record.source_content_transmission, "not_sent");
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
    assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, true);
    assert.equal(record.external_review.source_content_transmission, "sent");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});
