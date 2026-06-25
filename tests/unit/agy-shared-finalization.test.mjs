import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fixtureBranchDiffRepo } from "../helpers/fixture-git.mjs";
import { buildJobRecord } from "../../plugins/agy/scripts/lib/job-record.mjs";

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

function padReviewLines(count = 6) {
  return Array.from({ length: count }, (_, i) => (
    `- src/module${i}.js:${100 + i} inspected concrete control flow, source routing, tests, and security-sensitive behavior with enough detail to exceed the shared review-quality shallow threshold.`
  ));
}

function writeAgyReviewMock(dir, name, { body, stderr = "mock stderr sidecar\n" }) {
  return writeExecutable(dir, name, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
    `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.stdout.write(${JSON.stringify(body)});`,
    "",
  ].join("\n"));
}

function runCompanion(args, { cwd, dataDir = mkdtempSync(path.join(tmpdir(), "agy-shared-data-")), env = {} } = {}) {
  assert.equal(existsSync(COMPANION), true, "AGY companion entrypoint must exist");
  const result = spawnSync(process.execPath, [COMPANION, ...args], {
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

function parseJsonStream(raw) {
  const objs = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objs.push(JSON.parse(raw.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return objs;
}

function terminalRecord(run) {
  const records = parseJsonStream(run.stdout);
  assert.ok(records.length > 0, `missing terminal record; stdout=${run.stdout} stderr=${run.stderr}`);
  return records.at(-1);
}

function firstWorkspaceJobsDir(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  const workspaceDirs = readdirSync(stateRoot);
  assert.equal(workspaceDirs.length, 1, `expected one state workspace, got ${workspaceDirs.join(",")}`);
  return path.join(stateRoot, workspaceDirs[0], "jobs");
}

function jobDir(dataDir, jobId) {
  return path.join(firstWorkspaceJobsDir(dataDir), jobId);
}

async function loadCompanionInternals(exports) {
  const source = readFileSync(COMPANION, "utf8")
    .replace(/from "\.\/lib\/([^"]+)"/g, (_, rel) => (
      `from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "plugins/agy/scripts/lib", rel)).href)}`
    ))
    .replace(
      /\nmain\(\)\.catch\(\(error\) => \{[\s\S]*?\n\}\);\s*$/u,
      `\nexport { ${exports.join(", ")} };\n`,
    );
  assert.match(source, /export \{ /, "test loader must disable the AGY companion main() call");
  const dir = mkdtempSync(path.join(tmpdir(), "agy-internals-"));
  const modulePath = path.join(dir, "agy-companion-internals.mjs");
  writeFileSync(modulePath, source, "utf8");
  try {
    return await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
  } finally {
    rmTree(dir);
  }
}

function makeInvocation({ jobId = "agy-shared-finalization-job", cwd = tmpdir() } = {}) {
  return {
    job_id: jobId,
    target: "agy",
    mode: "review",
    mode_profile_name: "review",
    model: null,
    cwd,
    workspace_root: cwd,
    containment: "worktree",
    scope: "branch-diff",
    scope_base: "main",
    scope_paths: null,
    prompt_head: "review empty source",
    binary: "agy",
    started_at: new Date().toISOString(),
    run_kind: "review",
  };
}

test("quality-failed AGY review retains produced body in the persisted failed record", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-quality-failed-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "agy-quality-failed-data-"));
  const reviewBody = [
    "Verdict: REQUEST_CHANGES",
    "",
    "Blockers:",
    "- src/auth.js:42 auth validation is bypassed when the header is absent; this blocks merge.",
    ...padReviewLines(),
    "",
    "Follow-up:",
    "- Selected source inspection failed for the final runtime checklist; treat this as failed review slot because the reviewer could not inspect every required artifact.",
    "",
  ].join("\n");
  const binary = writeAgyReviewMock(cwd, "agy-quality-failed-mock", { body: reviewBody });
  const { base } = fixtureBranchDiffRepo(cwd);
  const run = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
      "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review quality failure"],
    { cwd, dataDir },
  );
  try {
    assert.equal(run.status, 1, `exit ${run.status}: ${run.stderr || run.stdout}`);
    const record = terminalRecord(run);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "review_not_completed");
    assert.equal(record.review_quality.failed_review_slot, true);
    const resultRun = runCompanion(["result", "--job", record.job_id, "--cwd", cwd], { cwd, dataDir });
    assert.equal(resultRun.status, 0, `exit ${resultRun.status}: ${resultRun.stderr || resultRun.stdout}`);
    const persisted = JSON.parse(resultRun.stdout);
    assert.equal(persisted.result, reviewBody);
    assert.ok(persisted.result.length > 500, "regression body must exceed shallow-review threshold");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("Blockers and Must fix phrasing are accepted by the shared review-quality gate", () => {
  for (const [label, section] of [["blockers", "Blockers:"], ["must-fix", "Must fix:"]]) {
    const cwd = mkdtempSync(path.join(tmpdir(), `agy-${label}-cwd-`));
    const dataDir = mkdtempSync(path.join(tmpdir(), `agy-${label}-data-`));
    const reviewBody = [
      "Verdict: REQUEST_CHANGES",
      "",
      section,
      "- src/auth.js:42 auth validation is bypassed when the header is absent; this blocks merge.",
      ...padReviewLines(),
      "",
      "Non-blocking concerns:",
      "- Residual risk: the focused source packet was reviewed and no additional non-blocking concern was found.",
      "",
    ].join("\n");
    const binary = writeAgyReviewMock(cwd, `agy-${label}-mock`, { body: reviewBody });
    const { base } = fixtureBranchDiffRepo(cwd);
    const run = runCompanion(
      ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
        "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", `review ${label} phrasing`],
      { cwd, dataDir },
    );
    try {
      assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr || run.stdout}`);
      const record = terminalRecord(run);
      assert.equal(record.status, "completed");
      assert.equal(record.error_code, null);
      assert.equal(record.review_quality.failed_review_slot, false);
      const resultRun = runCompanion(["result", "--job", record.job_id, "--cwd", cwd], { cwd, dataDir });
      assert.equal(resultRun.status, 0, `exit ${resultRun.status}: ${resultRun.stderr || resultRun.stdout}`);
      const persisted = JSON.parse(resultRun.stdout);
      assert.equal(persisted.result, reviewBody);
      assert.doesNotMatch(reviewBody, /Blocking findings/i);
    } finally {
      rmTree(dataDir);
      rmTree(cwd);
    }
  }
});

test("empty-source completed AGY review persists through buildJobRecord", async () => {
  const reviewBody = [
    "Verdict: APPROVE",
    "",
    "Blocking findings:",
    "- None. I inspected the repository state for this empty-source review and found no blocking issue.",
    ...padReviewLines(),
    "",
    "Non-blocking concerns:",
    "- Residual risk: no selected source files were present, and the review result still follows the shared contract.",
    "",
  ].join("\n");
  const { executionForRecord } = await loadCompanionInternals(["executionForRecord"]);
  const execution = executionForRecord({
    status: "completed",
    pidInfo: null,
    parsed: { ok: true, result: reviewBody, structured: null, denials: [] },
    exitCode: 0,
    endedAt: new Date().toISOString(),
    reviewAuditManifest: null,
    selectedFiles: [],
  });
  const record = buildJobRecord(makeInvocation(), execution, []);
  assert.equal(record.status, "completed");
  assert.equal(record.error_code, null);
  assert.equal(record.result, reviewBody);
});

test("AGY finalize path writes stdout and stderr sidecars", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-sidecar-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "agy-sidecar-data-"));
  const stderrText = "mock stderr sidecar content\n";
  const reviewBody = [
    "Verdict: APPROVE",
    "",
    "Blocking findings:",
    "- None. I inspected the selected source packet and found no blocking issue.",
    ...padReviewLines(),
    "",
    "Non-blocking concerns:",
    "- Residual risk: no additional non-blocking concerns were found after reviewing the selected source packet.",
    "",
  ].join("\n");
  const binary = writeAgyReviewMock(cwd, "agy-sidecar-mock", { body: reviewBody, stderr: stderrText });
  const { base } = fixtureBranchDiffRepo(cwd);
  const run = runCompanion(
    ["run", "--mode", "review", "--foreground", "--lifecycle-events", "jsonl",
      "--binary", binary, "--cwd", cwd, "--scope-base", base, "--", "review sidecars"],
    { cwd, dataDir },
  );
  try {
    assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr || run.stdout}`);
    const record = terminalRecord(run);
    const dir = jobDir(dataDir, record.job_id);
    assert.equal(readFileSync(path.join(dir, "stdout.log"), "utf8"), reviewBody);
    assert.equal(readFileSync(path.join(dir, "stderr.log"), "utf8"), stderrText);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});
