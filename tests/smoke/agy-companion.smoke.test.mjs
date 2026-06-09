import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureBranchDiffRepo, fixtureGit, fixtureSeedRepo } from "../helpers/fixture-git.mjs";

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
    "if (process.env.AGY_CAPTURE_OUT) writeFileSync(process.env.AGY_CAPTURE_OUT, JSON.stringify({ cwd: process.cwd(), addDir, addDirReal, args }) + '\\n');",
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
    } finally {
      rmTree(dataDir);
      rmTree(cwd);
    }
  });
}

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

test("agy source-bearing review points target at scoped containment, not source cwd", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-containment-cwd-"));
  const binary = writeAgyCaptureMock(cwd);
  const capturePath = path.join(cwd, "capture.json");
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review scoped add-dir"],
    { cwd, env: { AGY_CAPTURE_OUT: capturePath } },
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
    { cwd, env: { AGY_CAPTURE_OUT: capturePath } },
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
    assert.equal(record.review_quality.failed_review_slot, true);
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
