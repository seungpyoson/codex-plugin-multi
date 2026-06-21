import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    "if (process.env.AGY_CAPTURE_OUT) writeFileSync(process.env.AGY_CAPTURE_OUT, JSON.stringify({ cwd: process.cwd(), addDir, addDirReal, args, prompt }) + '\\n');",
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
    "const { appendFileSync } = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
    "const promptIndex = args.indexOf('--print');",
    "const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';",
    "if (process.env.AGY_CAPTURE_OUT) appendFileSync(process.env.AGY_CAPTURE_OUT, JSON.stringify({ args, prompt }) + '\\n');",
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
    "const mutationRoot = process.env.AGY_MUTATION_TARGET || process.cwd();",
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
    { cwd, env: { AGY_CAPTURE_OUT: capturePath } },
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
      assert.equal(record.review_metadata.audit_manifest.selected_source.files[0].path, changedFileName);
    } finally {
      rmTree(dataDir);
      rmTree(cwd);
    }
  });
}

test("agy review fails the review slot when the target mutates source workspace files", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-mutation-cwd-"));
  const binary = writeAgyMutatingMock(cwd);
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review mutation detection"],
    { cwd, env: { AGY_MUTATION_TARGET: cwd } },
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
  writeFileSync(largePath, `${"x".repeat((256 * 1024) + 4096)}\n`, "utf8");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "large.txt", "--", "review large packet"],
    { cwd, env: { AGY_CAPTURE_OUT: capturePath } },
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
    assert.equal(record.review_metadata.audit_manifest.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.packet_recovery.reason, "source_packet_too_large");
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
    { cwd, env: { AGY_CAPTURE_OUT: capturePath } },
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
    { cwd, dataDir, env: { AGY_CAPTURE_OUT: capturePath } },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    writePriorSourceSentFailure(dataDir, cwd);
    rmSync(capturePath, { force: true });

    const blocked = runCompanion(
      ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
       "--binary", binary, "--cwd", cwd, "--scope-paths", "selected.txt", "--", "retry same packet"],
      { cwd, dataDir, env: { AGY_CAPTURE_OUT: capturePath } },
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
      { cwd, dataDir, env: { AGY_CAPTURE_OUT: capturePath } },
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
  writeFileSync(path.join(cwd, "large.txt"), `${"x".repeat((256 * 1024) + 4096)}\n`, "utf8");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-paths", "large.txt",
     "--allow-large-source-packet", "--", "review large packet with explicit override"],
    { cwd, env: { AGY_CAPTURE_OUT: capturePath } },
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
  const capturePath = path.join(cwd, "agy-auth-capture.jsonl");
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review auth failure handling"],
    { cwd, env: { AGY_CAPTURE_OUT: capturePath } },
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
