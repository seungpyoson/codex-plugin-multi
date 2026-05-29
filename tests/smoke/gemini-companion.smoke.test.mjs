import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, realpathSync,
  writeFileSync, chmodSync, mkdirSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureBranchDiffRepo, fixtureSeedRepo } from "../helpers/fixture-git.mjs";
import { badVerdictReviewFixture, requestChangesReviewFixture } from "../helpers/review-fixtures.mjs";
import {
  apiKeyAuthMode as geminiApiKeyAuthMode,
  subscriptionAuthMode as geminiSubscriptionAuthMode,
} from "../../plugins/gemini/scripts/lib/auth-selection.mjs";
import {
  acquireProviderWorkloadLease,
  releaseProviderWorkloadLease,
} from "../../scripts/lib/review-workload.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/gemini/scripts/gemini-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/gemini-mock.mjs");
const GEMINI_SESSION_ID = "22222222-3333-4444-9555-666666666666";
const RESUMED_GEMINI_SESSION_ID = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";
const GEMINI_SMOKE_POLL_TIMEOUT_MS = Number(process.env.GEMINI_SMOKE_POLL_TIMEOUT_MS ?? 30000);

// #16 follow-up 9: fixtureSeedRepo scrubs inherited GIT_* env vars so a
// stale GIT_DIR/GIT_WORK_TREE in the parent process cannot hijack fixture
// commits into the caller checkout.
function seedMinimalRepo(cwd) {
  fixtureSeedRepo(cwd);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runCompanion(args, { cwd, env = {}, dataDir = mkdtempSync(path.join(tmpdir(), "gemini-smoke-data-")) } = {}) {
  const workloadLockDir = env.CODEX_PLUGIN_MULTI_PROVIDER_WORKLOAD_LOCK_DIR
    ?? path.join(dataDir, "provider-workload");
  const res = spawnSync("node", [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GEMINI_BINARY: MOCK,
      GEMINI_PLUGIN_DATA: dataDir,
      CODEX_PLUGIN_MULTI_PROVIDER_WORKLOAD_LOCK_DIR: workloadLockDir,
      ...env,
    },
  });
  return { ...res, dataDir };
}

function geminiAuthModeArgs(mode) {
  return ["--auth-mode", mode];
}

function sleepSync(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function rmTree(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (e) {
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(e.code) || attempt === 4) {
        throw e;
      }
      sleepSync(50);
    }
  }
}

function assertPreflightSafetyFields(result) {
  assert.equal(result.target_spawned, false);
  assert.equal(result.selected_scope_sent_to_provider, false);
  assert.equal(result.requires_external_provider_consent, true);
}

function assertGeminiApiKeyMissingError(result) {
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_authed");
  assert.equal(Object.hasOwn(result, "ready"), false);
  assert.equal(result.auth_mode, "api_key");
  assert.equal(result.selected_auth_path, "api_key_env_missing");
  assert.equal(result.auth_policy, "api_key_env_required");
  assert.match(result.summary, /Gemini API-key auth was requested/);
  assert.match(result.next_action, /GEMINI_API_KEY or GOOGLE_API_KEY/);
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

function writeMarkerBinary(dir, markerPath) {
  const binary = path.join(dir, "target-cli");
  writeFileSync(binary, [
    "#!/bin/sh",
    `printf spawned > ${JSON.stringify(markerPath)}`,
    "printf '{\"session_id\":\"22222222-3333-4444-9555-666666666666\",\"response\":\"spawned\"}\\n'",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(binary, 0o755);
  return binary;
}

function writeIndexCorruptingBinary(dir, repoPath) {
  const binary = path.join(dir, "corrupt-index-cli");
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

function readStdoutLog(dataDir, jobId) {
  const stateRoot = path.join(dataDir, "state");
  for (const dir of readdirSync(stateRoot)) {
    const p = path.join(stateRoot, dir, "jobs", jobId, "stdout.log");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error(`no stdout.log for ${jobId}`);
}

test("gemini run api_key auth failure includes structured diagnostics before spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-run-api-key-missing-cwd-"));
  const missingBinary = path.join(cwd, "missing-gemini-binary");
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--auth-mode", "api_key",
     "--model", "gemini-3-flash-preview", "--binary", missingBinary,
     "--cwd", cwd, "--", "auth missing"],
    { cwd, env: { GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 1);
    assertGeminiApiKeyMissingError(JSON.parse(stdout));
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review background: launched event and terminal JobRecord", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--background", "--model", "gemini-3-flash-preview",
     "--scope-paths", "seed.txt", "--timeout-ms", "345678", "--cwd", cwd, "--", "background rescue task"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const launched = JSON.parse(stdout);
    assert.equal(launched.event, "launched");
    assert.equal(launched.target, "gemini");
    assert.equal(typeof launched.job_id, "string");
    assert.equal(Number.isInteger(launched.pid), true);
    assert.deepEqual(launched.external_review, {
      marker: "EXTERNAL REVIEW",
      provider: "Gemini CLI",
      run_kind: "background",
      job_id: launched.job_id,
      session_id: null,
      parent_job_id: null,
      mode: "custom-review",
      scope: "custom",
      scope_base: null,
      scope_paths: ["seed.txt"],
      source_content_transmission: "may_be_sent",
      review_slot: null,
      disclosure: "Selected source content may be sent to Gemini CLI for external review.",
    });

    const stateRoot = path.join(dataDir, "state");
    const deadline = Date.now() + GEMINI_SMOKE_POLL_TIMEOUT_MS;
    let meta = null;
    while (Date.now() < deadline) {
      for (const dir of readdirSync(stateRoot)) {
        const metaPath = path.join(stateRoot, dir, "jobs", `${launched.job_id}.json`);
        if (existsSync(metaPath)) {
          const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
          if (parsed.status === "completed" || parsed.status === "failed") {
            meta = parsed;
            break;
          }
        }
      }
      if (meta) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.ok(meta, "worker never wrote terminal meta");
    assert.equal(meta.status, "completed");
    assert.equal(meta.review_metadata.audit_manifest.request.timeout_ms, 345678);
    assert.match(meta.result, /Mock Gemini response\./);
    assert.equal(meta.gemini_session_id, GEMINI_SESSION_ID);
    assert.equal(meta.external_review.review_slot?.verdict, "approved");
    assert.equal(meta.external_review.review_slot?.source_state, "sent");
    assert.deepEqual(meta.external_review, {
      ...launched.external_review,
      session_id: GEMINI_SESSION_ID,
      source_content_transmission: "sent",
      review_slot: meta.external_review.review_slot,
      disclosure: "Selected source content was sent to Gemini CLI for external review.",
    });
    assert.equal("prompt" in meta, false, "full prompt must not appear on JobRecord");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review maps held workload lease to provider_workload_blocked without spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-workload-block-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-workload-block-data-"));
  const workloadLockDir = path.join(dataDir, "provider-workload");
  seedMinimalRepo(cwd);
  const admission = acquireProviderWorkloadLease({
    provider: "gemini",
    jobId: "held-gemini-job",
    cwd,
    sourceBearing: true,
    env: { CODEX_PLUGIN_MULTI_PROVIDER_WORKLOAD_LOCK_DIR: workloadLockDir },
  });
  assert.equal(admission.ok, true);

  try {
    const { stdout, stderr, status } = runCompanion(
      ["run", "--mode=custom-review", "--foreground", "--model", "gemini-3-flash-preview",
       "--cwd", cwd, "--scope-paths", "seed.txt", "--", "review selected source"],
      {
        cwd,
        dataDir,
        env: {
          CODEX_PLUGIN_MULTI_PROVIDER_WORKLOAD_LOCK_DIR: workloadLockDir,
          GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "MUST_NOT_REACH_GEMINI",
        },
      },
    );

    assert.equal(status, 2, `exit ${status}: stderr=${stderr}; stdout=${stdout}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "provider_workload_blocked");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.runtime_diagnostics.provider_workload.reason, "active_same_provider_job");
    assert.equal(record.runtime_diagnostics.provider_workload.holder.job_id, "held-gemini-job");
    assert.doesNotMatch(stdout, /MUST_NOT_REACH_GEMINI|external_review_launched/);
  } finally {
    releaseProviderWorkloadLease(admission.lease);
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini result --job-id aliases --job for a finished job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-result-job-id-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "seed"],
    { cwd },
  );
  try {
    assert.equal(status, 0, stderr);
    const record = JSON.parse(stdout);
    const result = runCompanion(
      ["result", "--job-id", record.job_id, "--cwd", cwd],
      { cwd, dataDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const meta = JSON.parse(result.stdout);
    assert.equal(meta.id, record.job_id);
    assert.equal(meta.status, "completed");
    assert.equal(meta.external_review.provider, "Gemini CLI");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review guides substantive missing-verdict retry without automatic resend", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bad-verdict-cwd-"));
  seedMinimalRepo(cwd);
  const badResult = badVerdictReviewFixture("Gemini missing verdict replay marker.");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--scope-paths", "seed.txt", "--", "review selected source"],
    { cwd, env: { GEMINI_MOCK_RESPONSE: badResult } },
  );
  try {
    assert.equal(status, 2, `exit ${status}: stderr=${stderr}; stdout=${stdout}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "review_not_completed");
    assert.equal(record.error_message, "review_quality_failed:missing_verdict");
    assert.equal(record.result, badResult);
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.deepEqual(
      record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons,
      ["missing_verdict"],
    );
    assert.match(record.suggested_action, /Do not automatically resend selected source/i);
    assert.match(record.suggested_action, /fresh matching approval token/i);
    assert.match(record.suggested_action, /narrowing the scope/i);
    assert.match(record.suggested_action, /sharding/i);
    assert.match(record.suggested_action, /relaying/i);
    assert.match(record.suggested_action, /interactive Gemini/i);

    const retry = runCompanion(
      ["continue", "--job", record.job_id, "--foreground", "--cwd", cwd, "--", "retry selected source"],
      { cwd, dataDir },
    );
    assert.equal(retry.status, 0, `exit ${retry.status}: stderr=${retry.stderr}; stdout=${retry.stdout}`);
    const retryRecord = JSON.parse(retry.stdout);
    assert.equal(retryRecord.status, "completed");
    assert.equal(retryRecord.error_code, null);
    assert.equal(retryRecord.external_review.source_content_transmission, "not_sent");
    assert.equal(
      retryRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "resume_without_source_resend",
    );
    assert.equal(retryRecord.review_metadata.audit_manifest.source_packet_policy.selected_source_bytes, 0);
    assert.equal(retryRecord.review_metadata.audit_manifest.source_packet_policy.resume_without_source_resend, true);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini result from wrong cwd returns retrieval guidance", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "gemini-result-right-cwd-")));
  const wrongCwd = realpathSync(mkdtempSync(path.join(tmpdir(), "gemini-result-wrong-cwd-")));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-result-wrong-cwd-data-"));
  const corruptJobsDir = path.join(dataDir, "state", "000-corrupt", "jobs");
  mkdirSync(corruptJobsDir, { recursive: true });
  const { stdout, stderr, status } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "seed"],
    { cwd, dataDir },
  );
  try {
    assert.equal(status, 0, stderr);
    const record = JSON.parse(stdout);
    writeFileSync(path.join(corruptJobsDir, `${record.job_id}.json`), "{ malformed");
    const result = runCompanion(
      ["result", "--job", record.job_id],
      { cwd: wrongCwd, dataDir },
    );
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.error, "not_found");
    assert.equal(parsed.job_id, record.job_id);
    assert.equal(parsed.matched_workspace, true);
    assert.equal("matched_workspace_root" in parsed, false);
    assert.doesNotMatch(JSON.stringify(parsed), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(parsed.suggested_action, /different workspace/);
    assert.match(parsed.suggested_action, /--cwd <workspace used when the job was launched>/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(wrongCwd);
  }
});

test("gemini result with duplicate job id across workspaces reports state collision", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "gemini-result-collision-cwd-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-result-collision-data-"));
  const jobId = "00000000-0000-4000-8000-00000000c012";
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
    const result = runCompanion(
      ["result", "--job", jobId, "--cwd", cwd],
      { cwd, dataDir },
    );
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.error, "not_found");
    assert.equal(parsed.error_code, "state_collision");
    assert.equal(parsed.matched_workspace_count, 2);
    assert.match(parsed.suggested_action, /state collision/i);
    assert.equal("matched_workspace_root" in parsed, false);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini rescue background: active job appears in default status", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-status-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "delayed background rescue task"],
    { cwd, env: { GEMINI_MOCK_DELAY_MS: "5000" } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const launched = JSON.parse(stdout);
    const runningDeadline = Date.now() + GEMINI_SMOKE_POLL_TIMEOUT_MS;
    let running = null;
    while (Date.now() < runningDeadline && !running) {
      const statusRes = spawnSync("node", [COMPANION, "status", "--cwd", cwd], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
      });
      assert.equal(statusRes.status, 0, `exit ${statusRes.status}: ${statusRes.stderr}`);
      const parsed = JSON.parse(statusRes.stdout);
      running = parsed.jobs.find((job) => job.job_id === launched.job_id);
      if (!running) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(running, "active background job was hidden from default gemini status");
    assert.equal(running.status, "running");
    assert.ok(running.pid_info?.pid, "running Gemini job must carry pid_info");

    const terminalDeadline = Date.now() + 7000;
    let terminal = null;
    while (Date.now() < terminalDeadline && !terminal) {
      const statusRes = spawnSync("node", [COMPANION, "status", "--cwd", cwd], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
      });
      assert.equal(statusRes.status, 0, `exit ${statusRes.status}: ${statusRes.stderr}`);
      const parsed = JSON.parse(statusRes.stdout);
      terminal = parsed.jobs.find((job) => job.job_id === launched.job_id && job.status !== "running");
      if (!terminal) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(terminal, "background job did not finish before cleanup");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini cancel: signals a running background job (issue #22 sub-task 1)", async () => {
  // Mirror of the Claude cancel smoke. Pre-#22, gemini-companion's
  // dispatch routed `cancel` to fail("not_implemented") so users had no
  // way to cancel a Gemini background job through the documented surface.
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-cancel-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "long background task"],
    { cwd, env: { GEMINI_MOCK_DELAY_MS: "5000" } },
  );
  try {
    assert.equal(status, 0, stderr);
    const launched = JSON.parse(stdout);
    const deadline = Date.now() + GEMINI_SMOKE_POLL_TIMEOUT_MS;
    let running = null;
    while (Date.now() < deadline && !running) {
      const statusRes = spawnSync("node", [COMPANION, "status", "--cwd", cwd], {
        cwd, encoding: "utf8",
        env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
      });
      assert.equal(statusRes.status, 0, statusRes.stderr);
      const statusObj = JSON.parse(statusRes.stdout);
      running = statusObj.jobs.find((j) => j.id === launched.job_id && j.status === "running");
      if (!running) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(running, "background gemini job never became visible as running");
    assert.ok(running.pid_info?.pid, "running gemini job must carry pid_info for safe cancel");

    const cancelRes = spawnSync("node", [
      COMPANION, "cancel", "--job", launched.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
    });
    // Two acceptable outcomes: signaled (signal landed) or unverifiable
    // (mock spawn raced and pid capture failed). What MUST NOT happen is
    // a "not_implemented" error from the dispatch.
    assert.notEqual(cancelRes.status, 1, `gemini cancel must be implemented; stderr=${cancelRes.stderr}`);
    const cancel = JSON.parse(cancelRes.stdout);
    assert.notEqual(cancel.error, "not_implemented",
      `gemini cancel must not fall through to not_implemented; got ${JSON.stringify(cancel)}`);
    if (running.pid_info.capture_error) {
      // Issue #25 follow-up: a running job whose pid_info lacks a
      // complete ownership proof is "unverifiable" — exit 2 means
      // "refused for safety; operator must investigate." Exit 0 would
      // lie that the cancel post-condition (process gone) holds.
      assert.equal(cancelRes.status, 2,
        `capture_error path must exit 2 (refused, unverifiable); stderr=${cancelRes.stderr}`);
      assert.equal(cancel.status, "unverifiable");
      assert.match(cancel.suggested_action, /process inspection|ownership/i);
    } else {
      // Mock can exit between attachPidCapture's 'spawn' snapshot and
      // verifyPidInfo at cancel time. All four post-spawn outcomes are
      // valid; what must NOT happen is a status/exit-code mismatch.
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
        assert.equal(cancel.signal, "SIGTERM");
        assert.equal(cancel.pid, running.pid_info.pid);
      }
    }
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini cancel: queued job → cancel_pending, marker written, exit 0", () => {
  // Class 1 + Finding A: a queued (not-yet-running) job cannot be
  // already_terminal — the worker hasn't spawned anything. Cancel must
  // drop a marker so the worker refuses to spawn on pickup.
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-cancel-queued-cwd-"));
  seedMinimalRepo(cwd);
  const runRes = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "seed"],
    { cwd },
  );
  try {
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(runRes.dataDir);
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "queued", pid_info: null }, null, 2)}\n`, "utf8");
    // listJobs reads state.json — patch that too so cmdCancel sees the queued shape.
    const stateRoot = path.join(runRes.dataDir, "state");
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
      COMPANION, "cancel", "--job", record.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, GEMINI_PLUGIN_DATA: runRes.dataDir },
    });
    assert.equal(cancelRes.status, 0, cancelRes.stderr);
    const cancel = JSON.parse(cancelRes.stdout);
    assert.equal(cancel.status, "cancel_pending");
    assert.equal(cancel.ok, true);
    assert.equal(cancel.job_status, "queued");

    const wsDir = path.dirname(metaPath);
    const markerPath = path.join(wsDir, record.job_id, "cancel-requested.flag");
    assert.ok(existsSync(markerPath),
      `cancel_pending must write a marker at ${markerPath}`);
  } finally {
    rmTree(runRes.dataDir);
    rmTree(cwd);
  }
});

test("gemini _run-worker: cancel marker prevents target spawn, sets status=cancelled", () => {
  // Class 1 + Finding A end-to-end: worker MUST exit before spawning the
  // target binary when a marker is present. Otherwise the model call
  // happens (cost + side effects) and only the post-run consumer would
  // convert "completed" → "cancelled".
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-worker-cancel-cwd-"));
  seedMinimalRepo(cwd);
  const runRes = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "seed"],
    { cwd },
  );
  try {
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(runRes.dataDir);
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "queued", pid_info: null }, null, 2)}\n`, "utf8");

    const wsDir = path.dirname(metaPath);
    const markerDir = path.join(wsDir, record.job_id);
    mkdirSync(markerDir, { recursive: true });
    const promptPath = path.join(markerDir, "prompt.txt");
    writeFileSync(promptPath, "queued prompt with selected source\n", { mode: 0o600 });
    const markerPath = path.join(markerDir, "cancel-requested.flag");
    writeFileSync(markerPath, new Date().toISOString() + "\n");

    const workerRes = spawnSync("node", [
      COMPANION, "_run-worker", "--cwd", cwd, "--job", record.job_id,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, GEMINI_BINARY: MOCK, GEMINI_PLUGIN_DATA: runRes.dataDir },
    });
    assert.equal(workerRes.status, 0,
      `worker must exit 0 when marker present; stderr=${workerRes.stderr}`);

    const finalMeta = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(finalMeta.status, "cancelled",
      `worker must persist status=cancelled; got ${finalMeta.status}`);
    assert.equal(finalMeta.pid_info, null,
      "worker must not record pid_info when refusing to spawn");
    assert.equal(existsSync(markerPath), false,
      "worker must consume (unlink) the marker on pickup");
    assert.equal(existsSync(promptPath), false,
      "worker must remove prompt sidecar when queued cancel prevents target spawn");
  } finally {
    rmTree(runRes.dataDir);
    rmTree(cwd);
  }
});

test("gemini _run-worker fails before spawn when api_key auth has no provider key", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-worker-auth-missing-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-worker-auth-missing-data-"));
  const markerPath = path.join(dataDir, "spawned");
  const binary = writeMarkerBinary(dataDir, markerPath);
  seedMinimalRepo(cwd);
  const previous = process.env.GEMINI_PLUGIN_DATA;
  process.env.GEMINI_PLUGIN_DATA = dataDir;
  try {
    const state = await import("../../plugins/gemini/scripts/lib/state.mjs");
    const { newJobId } = await import("../../plugins/gemini/scripts/lib/identity.mjs");
    const { buildJobRecord } = await import("../../plugins/gemini/scripts/lib/job-record.mjs");
    const { resolveProfile } = await import("../../plugins/gemini/scripts/lib/mode-profiles.mjs");
    state.configureState({
      pluginDataEnv: "GEMINI_PLUGIN_DATA",
      sessionIdEnv: "GEMINI_COMPANION_SESSION_ID",
    });
    const profile = resolveProfile("rescue");
    const jobId = newJobId();
    const invocation = Object.freeze({
      job_id: jobId,
      target: "gemini",
      parent_job_id: null,
      resume_chain: [],
      mode_profile_name: profile.name,
      mode: "rescue",
      model: "gemini-3-flash-preview",
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
        GEMINI_BINARY: binary,
        GEMINI_PLUGIN_DATA: dataDir,
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
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
    if (previous === undefined) delete process.env.GEMINI_PLUGIN_DATA;
    else process.env.GEMINI_PLUGIN_DATA = previous;
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini cancel: queued + marker write failure → cancel_failed, exit 1", () => {
  // Class 1 follow-up (reviewer Vector 3): the queued-cancel branch's marker
  // is the entire cancel mechanism. Write failure must not lie via cancel_pending.
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-cancel-fail-cwd-"));
  seedMinimalRepo(cwd);
  const runRes = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "seed"],
    { cwd },
  );
  try {
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(runRes.dataDir);
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "queued", pid_info: null }, null, 2)}\n`, "utf8");
    const stateRoot = path.join(runRes.dataDir, "state");
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

    // Booby-trap: writeCancelMarker mkdirs <jobsDir>/<jobId> recursively.
    // Replace the per-job dir with a regular file so mkdir throws ENOTDIR.
    const wsDir = path.dirname(metaPath);
    const expectedMarkerDir = path.join(wsDir, record.job_id);
    rmSync(expectedMarkerDir, { recursive: true, force: true });
    writeFileSync(expectedMarkerDir, "blocker", "utf8");

    const cancelRes = spawnSync("node", [
      COMPANION, "cancel", "--job", record.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, GEMINI_PLUGIN_DATA: runRes.dataDir },
    });
    assert.equal(cancelRes.status, 1,
      `marker write failure must exit 1; stderr=${cancelRes.stderr}`);
    const cancel = JSON.parse(cancelRes.stdout);
    assert.equal(cancel.error, "cancel_failed");
    assert.equal(cancel.ok, false);
  } finally {
    rmTree(runRes.dataDir);
    rmTree(cwd);
  }
});

test("gemini cancel: unknown job status → bad_state, exit 1", () => {
  // Class 1 follow-up (reviewer Vector 5): unknown statuses must surface
  // as bad_state, not silently fall into the queued marker-writing branch.
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-cancel-bad-state-cwd-"));
  seedMinimalRepo(cwd);
  const runRes = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "seed"],
    { cwd },
  );
  try {
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(runRes.dataDir);
    writeFileSync(metaPath,
      `${JSON.stringify({ ...record, status: "errored" }, null, 2)}\n`, "utf8");
    const stateRoot = path.join(runRes.dataDir, "state");
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
      COMPANION, "cancel", "--job", record.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, GEMINI_PLUGIN_DATA: runRes.dataDir },
    });
    assert.equal(cancelRes.status, 1,
      `unknown status must exit 1; stderr=${cancelRes.stderr}`);
    const cancel = JSON.parse(cancelRes.stdout);
    assert.equal(cancel.error, "bad_state");
    assert.match(cancel.message ?? "", /unexpected job status/);
  } finally {
    rmTree(runRes.dataDir);
    rmTree(cwd);
  }
});

test("gemini cancel: already_terminal for a completed job (issue #22 sub-task 1)", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-cancel-terminal-cwd-"));
  seedMinimalRepo(cwd);
  const runRes = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "quick task"],
    { cwd },
  );
  try {
    assert.equal(runRes.status, 0, runRes.stderr);
    const completed = JSON.parse(runRes.stdout);
    const cancelRes = spawnSync("node", [
      COMPANION, "cancel", "--job", completed.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, GEMINI_PLUGIN_DATA: runRes.dataDir },
    });
    assert.equal(cancelRes.status, 0, cancelRes.stderr);
    const cancel = JSON.parse(cancelRes.stdout);
    assert.equal(cancel.status, "already_terminal");
    assert.equal(cancel.job_status, "completed");
  } finally {
    rmTree(runRes.dataDir);
    rmTree(cwd);
  }
});

test("gemini cancel: SIGTERM-trapping target classifies as cancelled, not completed (issue #22 sub-task 2)", {
  skip: process.env.CODEX_PLUGIN_COVERAGE === "1" && process.platform === "darwin"
    ? "NODE_V8_COVERAGE can make macOS sandbox deny ps; regular npm test covers SIGTERM-trap cancel"
    : false,
}, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-trap-cancel-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "long task"],
    { cwd, env: { GEMINI_MOCK_DELAY_MS: "30000", GEMINI_MOCK_TRAP_SIGTERM: "1" } },
  );
  try {
    assert.equal(status, 0, stderr);
    const launched = JSON.parse(stdout);
    const runDeadline = Date.now() + GEMINI_SMOKE_POLL_TIMEOUT_MS;
    let running = null;
    while (Date.now() < runDeadline && !running) {
      const sr = spawnSync("node", [COMPANION, "status", "--cwd", cwd], {
        cwd, encoding: "utf8", env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
      });
      const so = JSON.parse(sr.stdout);
      running = so.jobs.find((j) => j.id === launched.job_id && j.status === "running");
      if (!running) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(running, "background gemini job never visible as running");

    const cancelRes = spawnSync("node", [
      COMPANION, "cancel", "--job", launched.job_id, "--cwd", cwd,
    ], { cwd, encoding: "utf8", env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir } });
    const cancel = JSON.parse(cancelRes.stdout);
    const exitOk =
      (cancel.status === "signaled" && cancelRes.status === 0) ||
      (cancel.status === "already_dead" && cancelRes.status === 0) ||
      (cancel.status === "no_pid_info" && cancelRes.status === 2) ||
      (cancel.status === "unverifiable" && cancelRes.status === 2);
    assert.ok(exitOk,
      `unexpected SIGTERM-trap cancel outcome (${JSON.stringify(cancel.status)}, ${cancelRes.status}); stderr=${cancelRes.stderr}`);
    if (cancelRes.status !== 0) return;

    // Natural completion is delayed well beyond this window, so finalization
    // here should mean SIGTERM trapping engaged or the ESRCH-after-marker race
    // was handled as already_dead.
    const termDeadline = Date.now() + 10000;
    let terminal = null;
    while (Date.now() < termDeadline && !terminal) {
      // --all so the cancelled record (filtered by default cmdStatus on
      // origin/main) is visible to the polling assertion.
      const sr = spawnSync("node", [COMPANION, "status", "--all", "--cwd", cwd], {
        cwd, encoding: "utf8", env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
      });
      const so = JSON.parse(sr.stdout);
      terminal = so.jobs.find((j) => j.id === launched.job_id && j.status !== "running");
      if (!terminal) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(terminal, "job did not finalize after cancel");
    assert.equal(terminal.status, "cancelled",
      `cancel-marker must force status=cancelled even when target trapped SIGTERM; got ${JSON.stringify(terminal)}`);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini cancel: ESRCH after ownership verification is already_dead, not signal_failed", {
  skip: process.env.CODEX_PLUGIN_COVERAGE === "1"
    ? "regular npm test covers ESRCH kill race; coverage mode already imports companion in cancel smoke"
    : false,
}, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-cancel-esrch-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "long task"],
    { cwd, env: { GEMINI_MOCK_DELAY_MS: "30000" } },
  );
  try {
    assert.equal(status, 0, stderr);
    const launched = JSON.parse(stdout);
    const runDeadline = Date.now() + GEMINI_SMOKE_POLL_TIMEOUT_MS;
    let running = null;
    while (Date.now() < runDeadline && !running) {
      const sr = spawnSync("node", [COMPANION, "status", "--cwd", cwd], {
        cwd, encoding: "utf8", env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
      });
      const so = JSON.parse(sr.stdout);
      running = so.jobs.find((j) => j.id === launched.job_id && j.status === "running");
      if (!running) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(running, "background gemini job never visible as running");
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
      COMPANION, "cancel", "--job", launched.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: {
        ...process.env,
        GEMINI_PLUGIN_DATA: dataDir,
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
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini cancel: not_found for an unknown job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-cancel-notfound-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-cancel-notfound-data-"));
  try {
    const cancelRes = spawnSync("node", [
      COMPANION, "cancel", "--job", "00000000-0000-4000-8000-000000000999", "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
    });
    assert.notEqual(cancelRes.status, 0);
    const cancel = JSON.parse(cancelRes.stdout);
    assert.equal(cancel.error, "not_found");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini background worker spawn failure writes failed JobRecord instead of launched", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-spawn-fail-runner-"));
  const missingCwd = path.join(cwd, "missing-cwd");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "gemini-3-flash-preview",
     "--cwd", missingCwd, "--approval-token", "spawn-failure-approval-token", "--", "background rescue task"],
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
    assert.equal(
      existsSync(path.join(path.dirname(metaPath), record.job_id, "runtime-options.json")),
      false,
      "runtime-options sidecar must be removed when the worker never launches",
    );
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini run --background: runtime-options write failure removes prompt sidecar", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-runtime-sidecar-fail-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "gemini runtime options failure source sentinel\n",
  });
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-runtime-sidecar-fail-data-"));
  const preload = path.join(REPO_ROOT, "tests/helpers/fail-runtime-options-rename.mjs");
  const result = runCompanion(
    ["run", "--mode=custom-review", "--background", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--scope-paths", "seed.txt", "--", "review selected source"],
    {
      cwd,
      dataDir,
      env: {
        NODE_OPTIONS: `--import ${preload}`,
        CODEX_TEST_FAIL_RENAME_BASENAME: "runtime-options.json",
      },
    },
  );
  try {
    assert.notEqual(result.status, 0, "launcher must fail before emitting a launched event");
    const error = JSON.parse(result.stdout);
    assert.equal(error.error, "sidecar_failed");
    assert.match(error.message, /runtime-options\.json|rename failure|sidecar write failed/);

    const { metaPath, record } = readOnlyJobRecord(dataDir);
    assert.equal(record.status, "failed");
    assert.match(record.error_message, /background prompt sidecar write failed/);
    const sidecarDir = path.join(path.dirname(metaPath), record.job_id);
    assert.equal(existsSync(path.join(sidecarDir, "prompt.txt")), false,
      "prompt sidecar must be removed when runtime-options write fails after prompt write");
    assert.equal(existsSync(path.join(sidecarDir, "runtime-options.json")), false,
      "runtime-options sidecar must not persist after failed atomic rename");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini continue foreground: resumes prior job session", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-continue-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, "seed.txt"), "continue timeout seed\n");
  const priorTimeoutMs = 777777;
  const first = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--model", "gemini-3-flash-preview",
     "--scope-paths", "seed.txt", "--timeout-ms", String(priorTimeoutMs),
     "--cwd", cwd, "--", "initial rescue task"],
    { cwd, env: { GEMINI_REVIEW_TIMEOUT_MS: "" } },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    const prior = JSON.parse(first.stdout);
    assert.equal(prior.status, "completed");
    assert.equal(prior.gemini_session_id, GEMINI_SESSION_ID);

    const continued = runCompanion(
      ["continue", "--job", prior.job_id, "--foreground", "--cwd", cwd, "--", "continue rescue task"],
      { cwd, dataDir: first.dataDir, env: { GEMINI_REVIEW_TIMEOUT_MS: "" } },
    );
    assert.equal(continued.status, 0, `exit ${continued.status}: ${continued.stderr}`);
    const record = JSON.parse(continued.stdout);
    assert.equal(record.target, "gemini");
    assert.equal(record.status, "completed");
    assert.equal(record.parent_job_id, prior.job_id);
    assert.deepEqual(record.resume_chain, [prior.gemini_session_id]);
    assert.equal(record.gemini_session_id, RESUMED_GEMINI_SESSION_ID);
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, priorTimeoutMs);

    const fx = readStdoutLog(first.dataDir, record.job_id);
    assert.equal(fx.t7_resume_id, prior.gemini_session_id);
    assert.equal(fx.t7_prompt_from_stdin, true, "Gemini continue prompt must arrive on stdin, not argv");
    assert.equal("prompt" in record, false, "full prompt must not appear on JobRecord");
  } finally {
    rmTree(first.dataDir);
    rmTree(cwd);
  }
});

test("gemini continue from wrong cwd returns workspace retrieval guidance", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "gemini-continue-right-cwd-")));
  const wrongCwd = realpathSync(mkdtempSync(path.join(tmpdir(), "gemini-continue-wrong-cwd-")));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, "seed.txt"), "gemini wrong cwd continue seed\n");
  const first = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--model", "gemini-3-flash-preview",
     "--scope-paths", "seed.txt", "--cwd", cwd, "--", "initial task"],
    { cwd },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    const prior = JSON.parse(first.stdout);

    const continued = runCompanion(
      ["continue", "--job", prior.job_id, "--foreground", "--", "continue task"],
      { cwd: wrongCwd, dataDir: first.dataDir },
    );
    assert.equal(continued.status, 1);
    const parsed = JSON.parse(continued.stdout);
    assert.equal(parsed.error, "not_found");
    assert.equal(parsed.job_id, prior.job_id);
    assert.equal(parsed.matched_workspace, true);
    assert.equal("matched_workspace_root" in parsed, false);
    assert.doesNotMatch(JSON.stringify(parsed), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(parsed.suggested_action, /different workspace/);
    assert.match(parsed.suggested_action, /continue --job/);
    assert.match(parsed.suggested_action, /--cwd <workspace used when the job was launched>/);
  } finally {
    rmTree(first.dataDir);
    rmTree(cwd);
    rmTree(wrongCwd);
  }
});

test("gemini continue foreground: --timeout-ms overrides prior timeout and env", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-continue-timeout-override-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, "seed.txt"), "continue timeout override seed\n");
  const first = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--model", "gemini-3-flash-preview",
     "--scope-paths", "seed.txt", "--timeout-ms", "777777",
     "--cwd", cwd, "--", "initial rescue task"],
    { cwd, env: { GEMINI_REVIEW_TIMEOUT_MS: "" } },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    const prior = JSON.parse(first.stdout);

    const continued = runCompanion(
      ["continue", "--job", prior.job_id, "--foreground", "--timeout-ms", "555555",
       "--cwd", cwd, "--", "continue rescue task"],
      { cwd, dataDir: first.dataDir, env: { GEMINI_REVIEW_TIMEOUT_MS: "999999" } },
    );
    assert.equal(continued.status, 0, `exit ${continued.status}: ${continued.stderr}`);
    const record = JSON.parse(continued.stdout);
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 555555);
  } finally {
    rmTree(first.dataDir);
    rmTree(cwd);
  }
});

test("gemini continue api_key auth failure includes structured diagnostics before spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-continue-api-key-missing-cwd-"));
  seedMinimalRepo(cwd);
  const first = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "initial rescue task"],
    { cwd },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    const prior = JSON.parse(first.stdout);
    const missingBinary = path.join(cwd, "missing-gemini-continue-binary");
    const continued = runCompanion(
      ["continue", "--job", prior.job_id, "--foreground", "--auth-mode", "api_key",
       "--cwd", cwd, "--", "continue rescue task"],
      {
        cwd,
        dataDir: first.dataDir,
        env: {
          GEMINI_API_KEY: "",
          GOOGLE_API_KEY: "",
          GEMINI_BINARY: missingBinary,
        },
      },
    );
    assert.equal(continued.status, 1);
    assertGeminiApiKeyMissingError(JSON.parse(continued.stdout));
  } finally {
    rmTree(first.dataDir);
    rmTree(cwd);
  }
});

test("gemini continue foreground: refuses to resume a running job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-continue-running-cwd-"));
  seedMinimalRepo(cwd);
  const first = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "initial rescue task"],
    { cwd },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    const { metaPath, record } = readOnlyJobRecord(first.dataDir);
    writeFileSync(metaPath, `${JSON.stringify({ ...record, status: "running" }, null, 2)}\n`, "utf8");

    const continued = runCompanion(
      ["continue", "--job", record.job_id, "--foreground", "--cwd", cwd, "--", "continue rescue task"],
      { cwd, dataDir: first.dataDir },
    );
    assert.notEqual(continued.status, 0);
    assert.match(continued.stderr, /cannot continue job in status "running"/);
  } finally {
    rmTree(first.dataDir);
    rmTree(cwd);
  }
});

test("gemini continue foreground: resumes a cancelled terminal job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-continue-cancelled-cwd-"));
  seedMinimalRepo(cwd);
  const first = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "initial rescue task"],
    { cwd },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    const { metaPath, record } = readOnlyJobRecord(first.dataDir);
    writeFileSync(metaPath, `${JSON.stringify({ ...record, status: "cancelled" }, null, 2)}\n`, "utf8");

    const continued = runCompanion(
      ["continue", "--job", record.job_id, "--foreground", "--cwd", cwd, "--", "continue rescue task"],
      { cwd, dataDir: first.dataDir },
    );
    assert.equal(continued.status, 0, `exit ${continued.status}: ${continued.stderr}`);
    const out = JSON.parse(continued.stdout);
    assert.equal(out.parent_job_id, record.job_id);
    assert.equal(out.status, "completed");
  } finally {
    rmTree(first.dataDir);
    rmTree(cwd);
  }
});

test("gemini continue background: launched event and resumed terminal JobRecord", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-continue-bg-cwd-"));
  seedMinimalRepo(cwd);
  const first = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "initial rescue task"],
    { cwd },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    const prior = JSON.parse(first.stdout);
    assert.equal(prior.gemini_session_id, GEMINI_SESSION_ID);

    const continued = runCompanion(
      ["continue", "--job", prior.job_id, "--background", "--lifecycle-events", "jsonl",
       "--cwd", cwd, "--", "background continue task"],
      { cwd, dataDir: first.dataDir },
    );
    assert.equal(continued.status, 0, `exit ${continued.status}: ${continued.stderr}`);
    const launched = JSON.parse(continued.stdout);
    assert.equal(launched.event, "launched");
    assert.equal(launched.target, "gemini");
    assert.equal(launched.parent_job_id, prior.job_id);
    assert.equal(typeof launched.job_id, "string");
    assert.equal(Number.isInteger(launched.pid), true);
    assert.equal(launched.external_review.parent_job_id, prior.job_id);
    assert.equal(launched.external_review.run_kind, "background");
    assert.equal(
      launched.external_review.disclosure,
      "Selected source content may be sent to Gemini CLI for external review.",
    );

    const stateRoot = path.join(first.dataDir, "state");
    const deadline = Date.now() + GEMINI_SMOKE_POLL_TIMEOUT_MS;
    let meta = null;
    while (Date.now() < deadline) {
      for (const dir of readdirSync(stateRoot)) {
        const metaPath = path.join(stateRoot, dir, "jobs", `${launched.job_id}.json`);
        if (existsSync(metaPath)) {
          const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
          if (parsed.status === "completed" || parsed.status === "failed") {
            meta = parsed;
            break;
          }
        }
      }
      if (meta) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.ok(meta, "worker never wrote terminal meta");
    assert.equal(meta.status, "completed");
    assert.equal(meta.parent_job_id, prior.job_id);
    assert.deepEqual(meta.resume_chain, [prior.gemini_session_id]);
    assert.match(meta.result, /Mock Gemini response\./);
    assert.equal(meta.gemini_session_id, RESUMED_GEMINI_SESSION_ID);
    assert.equal(meta.external_review.parent_job_id, prior.job_id);
    assert.equal(meta.external_review.run_kind, "background");
    assert.equal(meta.external_review.session_id, RESUMED_GEMINI_SESSION_ID);
    assert.equal(
      meta.external_review.disclosure,
      "Selected source content was sent to Gemini CLI for external review.",
    );

    let fx = null;
    while (Date.now() < deadline && !fx) {
      try {
        fx = readStdoutLog(first.dataDir, meta.job_id);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(fx, "worker never wrote stdout.log");
    assert.equal(fx.t7_resume_id, prior.gemini_session_id);
    assert.equal("prompt" in meta, false, "full prompt must not appear on JobRecord");
  } finally {
    rmTree(first.dataDir);
    rmTree(cwd);
  }
});

test("gemini _run-worker refuses terminal JobRecord without overwriting it", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-worker-reentry-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "background rescue task"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const launched = JSON.parse(stdout);
    const stateRoot = path.join(dataDir, "state");
    const deadline = Date.now() + GEMINI_SMOKE_POLL_TIMEOUT_MS;
    let meta = null;
    let metaPath = null;
    while (Date.now() < deadline) {
      for (const dir of readdirSync(stateRoot)) {
        const candidate = path.join(stateRoot, dir, "jobs", `${launched.job_id}.json`);
        if (existsSync(candidate)) {
          const parsed = JSON.parse(readFileSync(candidate, "utf8"));
          if (parsed.status === "completed" || parsed.status === "failed") {
            meta = parsed;
            metaPath = candidate;
            break;
          }
        }
      }
      if (meta) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(meta, "worker never wrote terminal meta");
    assert.equal(meta.status, "completed");

    const rerun = spawnSync("node", [
      COMPANION, "_run-worker", "--cwd", cwd, "--job", launched.job_id,
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GEMINI_BINARY: MOCK, GEMINI_PLUGIN_DATA: dataDir },
    });
    assert.notEqual(rerun.status, 0, "manual _run-worker re-entry should fail");
    const after = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(after.status, "completed");
    assert.match(after.result, /Mock Gemini response\./);
    assert.equal(after.gemini_session_id, GEMINI_SESSION_ID);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini _run-worker writes failed JobRecord when queued prompt sidecar is missing", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-worker-missing-prompt-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-worker-missing-prompt-data-"));
  seedMinimalRepo(cwd);
  const previous = process.env.GEMINI_PLUGIN_DATA;
  process.env.GEMINI_PLUGIN_DATA = dataDir;
  try {
    const state = await import("../../plugins/gemini/scripts/lib/state.mjs");
    const { newJobId } = await import("../../plugins/gemini/scripts/lib/identity.mjs");
    const { buildJobRecord } = await import("../../plugins/gemini/scripts/lib/job-record.mjs");
    const { resolveProfile } = await import("../../plugins/gemini/scripts/lib/mode-profiles.mjs");
    state.configureState({
      pluginDataEnv: "GEMINI_PLUGIN_DATA",
      sessionIdEnv: "GEMINI_COMPANION_SESSION_ID",
    });
    const profile = resolveProfile("rescue");
    const jobId = newJobId();
    const invocation = Object.freeze({
      job_id: jobId,
      target: "gemini",
      parent_job_id: null,
      resume_chain: [],
      mode_profile_name: profile.name,
      mode: "rescue",
      model: "gemini-3-flash-preview",
      cwd,
      workspace_root: cwd,
      containment: profile.containment,
      scope: profile.scope,
      dispose_effective: profile.dispose_default,
      scope_base: null,
      scope_paths: null,
      prompt_head: "missing sidecar",
      schema_spec: null,
      binary: MOCK,
      run_kind: "background",
      started_at: new Date().toISOString(),
    });
    const queued = buildJobRecord(invocation, null, []);
    state.writeJobFile(cwd, jobId, queued);
    state.upsertJob(cwd, queued);

    const worker = spawnSync("node", [
      COMPANION, "_run-worker", "--cwd", cwd, "--job", jobId,
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GEMINI_BINARY: MOCK, GEMINI_PLUGIN_DATA: dataDir },
    });
    assert.notEqual(worker.status, 0, "worker should fail without prompt sidecar");
    const finalRecord = JSON.parse(readFileSync(state.resolveJobFile(cwd, jobId), "utf8"));
    assert.equal(finalRecord.status, "failed");
    assert.match(finalRecord.error_message, /prompt sidecar missing/);
    assert.equal("prompt" in finalRecord, false, "full prompt must not appear on JobRecord");
  } finally {
    if (previous === undefined) delete process.env.GEMINI_PLUGIN_DATA;
    else process.env.GEMINI_PLUGIN_DATA = previous;
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini _run-worker audit manifest matches prompt sidecar source snapshot after source changes", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-worker-scope-race-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "old worker source sentinel\n",
  });
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-worker-scope-race-data-"));
  const previous = process.env.GEMINI_PLUGIN_DATA;
  process.env.GEMINI_PLUGIN_DATA = dataDir;
  try {
    const state = await import("../../plugins/gemini/scripts/lib/state.mjs");
    const { newJobId } = await import("../../plugins/gemini/scripts/lib/identity.mjs");
    const { buildJobRecord } = await import("../../plugins/gemini/scripts/lib/job-record.mjs");
    const { resolveProfile } = await import("../../plugins/gemini/scripts/lib/mode-profiles.mjs");
    state.configureState({
      pluginDataEnv: "GEMINI_PLUGIN_DATA",
      sessionIdEnv: "GEMINI_COMPANION_SESSION_ID",
    });
    const profile = resolveProfile("custom-review");
    const jobId = newJobId();
    const invocation = Object.freeze({
      job_id: jobId,
      target: "gemini",
      parent_job_id: null,
      resume_chain: [],
      mode_profile_name: profile.name,
      mode: "custom-review",
      model: "gemini-3-flash-preview",
      cwd,
      workspace_root: cwd,
      containment: profile.containment,
      scope: profile.scope,
      dispose_effective: profile.dispose_default,
      scope_base: null,
      scope_paths: ["seed.txt"],
      prompt_head: "review selected source",
      review_prompt_contract_version: 1,
      review_prompt_provider: "Gemini CLI",
      timeout_ms: 900000,
      schema_spec: null,
      binary: MOCK,
      run_kind: "background",
      auth_mode: "subscription",
      started_at: new Date().toISOString(),
    });
    const queued = buildJobRecord(invocation, null, []);
    state.writeJobFile(cwd, jobId, queued);
    state.upsertJob(cwd, queued);
    const promptPath = path.join(state.resolveJobsDir(cwd), jobId, "prompt.txt");
    mkdirSync(path.dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, [
      "Provider: Gemini CLI",
      "BEGIN GEMINI FILE 1: seed.txt",
      "old worker source sentinel",
      "",
      "END GEMINI FILE 1: seed.txt",
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
        GEMINI_BINARY: MOCK,
        GEMINI_PLUGIN_DATA: dataDir,
        GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "old worker source sentinel",
      },
    });
    assert.equal(worker.status, 0, `worker stderr=${worker.stderr}; stdout=${worker.stdout}`);
    const finalRecord = JSON.parse(readFileSync(state.resolveJobFile(cwd, jobId), "utf8"));
    assert.equal(finalRecord.status, "completed");
    const [selectedFile] = finalRecord.review_metadata.audit_manifest.selected_source.files;
    assert.equal(selectedFile.path, "seed.txt");
    assert.equal(selectedFile.content_hash.value, sha256("old worker source sentinel\n"));
  } finally {
    if (previous === undefined) delete process.env.GEMINI_PLUGIN_DATA;
    else process.env.GEMINI_PLUGIN_DATA = previous;
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review foreground: policy-first, stdin transport, /tmp cwd, scoped include dir", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-cwd-"));
  seedMinimalRepo(cwd);
  const neutralCwd = realpathSync(tmpdir());
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review: x=1"],
    { cwd, env: { CODEX_SANDBOX: "", GEMINI_MOCK_ASSERT_FILE: "seed.txt", GEMINI_MOCK_ASSERT_CWD: neutralCwd } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.target, "gemini");
    assert.equal(record.status, "completed");
    assert.match(record.result, /Mock Gemini response\./);
    assert.equal(record.claude_session_id, null);
    assert.equal(record.gemini_session_id, GEMINI_SESSION_ID);
    assert.equal(record.containment, "worktree");
    assert.equal(record.scope, "working-tree");

    const fx = readStdoutLog(dataDir, record.job_id);
    assert.notEqual(fx.t7_cwd, neutralCwd, "Gemini review must not use the temp root itself as the workspace root");
    assert.equal(fx.t7_cwd.startsWith(neutralCwd), true, `Gemini review must run from a neutral temp cwd under ${neutralCwd}; got ${fx.t7_cwd}`);
    assert.equal(existsSync(fx.t7_cwd), false, `neutral Gemini cwd must be cleaned after the run: ${fx.t7_cwd}`);
    assert.equal(fx.t7_include_dirs.includes(fx.t7_cwd), false, "neutral cwd must not be the scoped include directory");
    assert.equal(fx.t7_saw_file, true, `Gemini must receive scoped include dir containing seed.txt; got ${fx.t7_include_dirs}`);
    assert.equal(fx.t7_policy_loaded, true, "Gemini review must pass bundled read-only policy");
    assert.equal(fx.t7_sandbox, true, "Gemini review must pass the sandbox flag");
    assert.equal(fx.t7_skip_trust, true, "Gemini review must pass --skip-trust so plan approval is not downgraded");
    assert.equal(fx.t7_prompt_from_stdin, true, "Gemini prompt must arrive on stdin, not argv");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review --scope-base preserves branch-diff scope through target execution", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-scope-base-"));
  const { base } = fixtureBranchDiffRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--scope-base", base, "--", "review: x=1"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.scope, "branch-diff");
    assert.deepEqual(
      record.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
      ["foo.md"]
    );
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini continue preserves prior review branch-diff scope through target execution", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-continue-scope-base-"));
  const { base } = fixtureBranchDiffRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-continue-scope-base-data-"));
  try {
    const runRes = runCompanion(
      ["run", "--mode=review", "--foreground", "--cwd", cwd, "--scope-base", base, "--", "review: x=1"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const prior = JSON.parse(runRes.stdout);
    const contRes = runCompanion(
      ["continue", "--job", prior.job_id, "--foreground", "--cwd", cwd, "--", "follow-up"],
      { cwd, dataDir },
    );
    assert.equal(contRes.status, 0, contRes.stderr);
    const continued = JSON.parse(contRes.stdout);
    assert.equal(continued.scope, "branch-diff");
    assert.deepEqual(
      continued.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
      ["foo.md"]
    );
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review foreground lifecycle jsonl emits launch event before terminal projection", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-lifecycle-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--lifecycle-events", "jsonl",
     "--cwd", cwd, "--", "review: x=1"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    const [launched, record] = lines;
    assert.equal(launched.event, "external_review_launched");
    assert.equal(launched.target, "gemini");
    assert.equal(launched.status, "launched");
    assert.equal(launched.job_id, record.job_id);
    assert.deepEqual(launched.external_review, {
      marker: "EXTERNAL REVIEW",
      provider: "Gemini CLI",
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
      disclosure: "Selected source content may be sent to Gemini CLI for external review.",
    });
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.event, "external_review_terminal");
    assert.equal(Object.hasOwn(record, "result"), false);
    assert.equal(Object.hasOwn(record, "runtime_diagnostics"), false);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review foreground lifecycle jsonl suppresses launch event on scope failure", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-lifecycle-scope-fail-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--lifecycle-events", "jsonl",
     "--binary", path.join(cwd, "missing-gemini"), "--cwd", cwd, "--", "review"],
    { cwd },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.match(record.error_message, /scope_population_failed: cannot evaluate gitignored files/);
    assert.match(record.disclosure_note, /not spawned/);
    assert.match(record.disclosure_note, /not sent/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review background lifecycle jsonl suppresses launch event on scope failure", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-bg-lifecycle-scope-fail-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--background", "--lifecycle-events", "jsonl",
     "--cwd", cwd, "--", "review"],
    { cwd },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.match(record.error_message, /scope_population_failed: cannot evaluate gitignored files/);
    assert.match(record.disclosure_note, /not spawned/);
    assert.match(record.disclosure_note, /not sent/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini run rejects invalid lifecycle event mode as structured bad args", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-lifecycle-bad-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--lifecycle-events", "pretty",
     "--cwd", cwd, "--", "review: x=1"],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    assert.doesNotMatch(stderr, /unhandled/i);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "bad_args");
    assert.match(parsed.message, /--lifecycle-events must be jsonl/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review foreground: omits native Gemini sandbox inside Codex sandbox", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-codex-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review: x=1"],
    { cwd, env: {
      CODEX_SANDBOX: "seatbelt",
      GEMINI_MOCK_ASSERT_FILE: "seed.txt",
      GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "Provider: Gemini CLI",
    } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.review_metadata.prompt_contract_version, 1);
    assert.equal(record.review_metadata.prompt_provider, "Gemini CLI");
    assert.equal(record.review_metadata.raw_output.parsed_ok, true);
    assert.match(record.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
    assert.equal(record.review_metadata.audit_manifest.request.model, record.model);
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 900000);
    assert.match(record.review_metadata.audit_manifest.prompt_builder.plugin_commit, /^[a-f0-9]{40}$/);
    assert.equal(record.review_metadata.audit_manifest.selected_route, "subscription_oauth");
    assert.equal(record.review_metadata.audit_manifest.fallback_reason, null);
    assert.equal(record.review_metadata.audit_manifest.auth_path, "subscription_oauth");
    assert.equal(record.review_metadata.audit_manifest.billing_path, null);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, false);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "not_required");
    assert.equal(record.review_metadata.audit_manifest.approval_scope, null);
    assert.notEqual(
      record.review_metadata.audit_manifest.prompt_builder.plugin_commit,
      record.review_metadata.audit_manifest.git_identity.head_sha,
      "plugin_commit must identify the plugin source, not the reviewed repository head"
    );
    assert.equal(record.review_metadata.audit_manifest.scope_resolution.scope, record.scope);
    assert.equal(record.review_metadata.audit_manifest.selected_source.files.length > 0, true);
    assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("review: x=1"), false);
    assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("seed\\n"), false);

    const fx = readStdoutLog(dataDir, record.job_id);
    assert.equal(fx.t7_policy_loaded, true, "Gemini review must still pass bundled read-only policy");
    assert.equal(fx.t7_sandbox, false, "Gemini -s must be omitted under Codex to avoid nested sandbox-exec");
    assert.equal(fx.t7_skip_trust, true, "Gemini review must still pass --skip-trust");
    assert.equal(fx.t7_prompt_from_stdin, true, "Gemini prompt must arrive on stdin, not argv");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review prompt includes selected source content", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-inline-source-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "gemini inline source sentinel\n",
  });
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--cwd", cwd, "--scope-paths", "seed.txt", "--", "review selected source"],
    { cwd, env: {
      CODEX_SANDBOX: "seatbelt",
      GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "gemini inline source sentinel",
    } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}; stdout=${stdout}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review rejects over-budget source packets before Gemini launch", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-source-packet-cwd-"));
  seedMinimalRepo(cwd);
  const files = [];
  for (let index = 0; index < 3; index += 1) {
    const file = `packet-${index}.txt`;
    files.push(file);
    writeFileSync(path.join(cwd, file), "x".repeat(180 * 1024));
  }

  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--cwd", cwd, "--scope-paths", files.join(","), "--", "review selected source"],
    { cwd, env: { GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "MUST_NOT_REACH_GEMINI" } },
  );
  try {
    assert.equal(status, 2);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "source_packet_too_large");
    assert.match(record.error_message, /Narrow or shard the Gemini CLI source packet/);
    assert.equal(record.error_cause, "pre_send_source_packet_budget");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_send_allowed, false);
    assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_packet_action, "narrow_source_packet");
    assert.doesNotMatch(stdout, /external_review_launched|MUST_NOT_REACH_GEMINI/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini background custom-review rejects over-budget source packets before prompt sidecar write", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-source-packet-cwd-"));
  seedMinimalRepo(cwd);
  const files = [];
  for (let index = 0; index < 3; index += 1) {
    const file = `packet-${index}.txt`;
    files.push(file);
    writeFileSync(path.join(cwd, file), "x".repeat(180 * 1024));
  }

  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--background", "--cwd", cwd, "--scope-paths", files.join(","), "--", "review selected source"],
    { cwd, env: { GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "MUST_NOT_REACH_GEMINI" } },
  );
  try {
    assert.equal(status, 2);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "source_packet_too_large");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_send_allowed, false);
    const { metaPath } = readOnlyJobRecord(dataDir);
    const promptPath = path.join(path.dirname(metaPath), record.job_id, "prompt.txt");
    assert.equal(existsSync(promptPath), false, "blocked background source packet must not persist prompt sidecar");
    assert.doesNotMatch(stdout, /external_review_launched|MUST_NOT_REACH_GEMINI/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review explicit large source override records policy and sends source", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-source-packet-override-cwd-"));
  seedMinimalRepo(cwd);
  const files = [];
  for (let index = 0; index < 3; index += 1) {
    const file = `packet-${index}.txt`;
    files.push(file);
    writeFileSync(path.join(cwd, file), "x".repeat(180 * 1024));
  }

  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--cwd", cwd, "--scope-paths", files.join(","),
     "--allow-large-source-packet", "--", "review selected source"],
    { cwd, env: { GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "GEMINI FILE 1: packet-0.txt" } },
  );
  try {
    assert.equal(status, 0, stdout);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    const policy = record.review_metadata.audit_manifest.source_packet_policy;
    assert.equal(policy.source_send_allowed, true);
    assert.equal(policy.source_packet_action, "send_after_source_packet_override");
    assert.equal(policy.source_packet_override_approved, true);
    assert.equal(policy.source_packet_override_source, "--allow-large-source-packet");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review records explicit review-slot waiver disposition", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-slot-waiver-cwd-"));
  seedMinimalRepo(cwd);

  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--cwd", cwd, "--scope-paths", "seed.txt",
     "--review-slot-disposition", "waive",
     "--review-slot-waiver-artifact", "reviews/waiver-180.md",
     "--", "review selected source"],
    { cwd, env: { GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "GEMINI FILE 1: seed.txt" } },
  );
  try {
    assert.equal(status, 0, stdout);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.review_metadata.audit_manifest.review_slot.disposition, "waive");
    assert.equal(record.review_metadata.audit_manifest.review_slot.waiver_artifact, "reviews/waiver-180.md");
    assert.equal(record.review_metadata.audit_manifest.review_slot.override_artifact, null);
    assert.equal(record.external_review.review_slot.disposition, "waive");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review blocks fresh same-packet resend after a failed source-sent slot", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-slot-fresh-retry-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-review-slot-fresh-retry-data-"));
  const invocationCountPath = path.join(dataDir, "target-invocations.txt");
  seedMinimalRepo(cwd);
  const badResult = badVerdictReviewFixture("Gemini fresh retry guard marker.");
  const commonArgs = [
    "run", "--mode=custom-review", "--foreground", "--model", "gemini-3-flash-preview",
    "--cwd", cwd, "--scope-paths", "seed.txt", "--", "review selected source",
  ];
  const commonOptions = {
    cwd,
    dataDir,
    env: {
      GEMINI_MOCK_RESPONSE: badResult,
      GEMINI_MOCK_INVOCATION_COUNT_PATH: invocationCountPath,
      GEMINI_MOCK_INVOCATION_COUNT_PROMPT_INCLUDES: "GEMINI FILE 1: seed.txt",
    },
  };

  try {
    const first = runCompanion(commonArgs, commonOptions);
    assert.equal(first.status, 2, `exit ${first.status}: stderr=${first.stderr}; stdout=${first.stdout}`);
    const firstRecord = JSON.parse(first.stdout);
    assert.equal(firstRecord.error_code, "review_not_completed");
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");

    const second = runCompanion(commonArgs, commonOptions);
    assert.equal(second.status, 2, `exit ${second.status}: stderr=${second.stderr}; stdout=${second.stdout}`);
    const secondRecord = JSON.parse(second.stdout);
    assert.equal(secondRecord.error_code, "review_slot_disposition_required");
    assert.equal(secondRecord.external_review.source_content_transmission, "not_sent");
    assert.equal(secondRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
    assert.equal(
      secondRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "review_slot_retry_blocked",
    );
    assert.equal(readFileSync(invocationCountPath, "utf8"), "1");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review blocks fresh same-packet resend after a request-changes slot", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-slot-request-changes-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-review-slot-request-changes-data-"));
  seedMinimalRepo(cwd);
  const requestChangesResult = requestChangesReviewFixture("Gemini request-changes retry guard marker.");
  const commonArgs = [
    "run", "--mode=custom-review", "--foreground", "--model", "gemini-3-flash-preview",
    "--cwd", cwd, "--scope-paths", "seed.txt", "--", "review selected source",
  ];
  const commonOptions = {
    cwd,
    dataDir,
    env: { GEMINI_MOCK_RESPONSE: requestChangesResult },
  };

  try {
    const first = runCompanion(commonArgs, commonOptions);
    assert.equal(first.status, 0, `exit ${first.status}: stderr=${first.stderr}; stdout=${first.stdout}`);
    const firstRecord = JSON.parse(first.stdout);
    assert.equal(firstRecord.status, "completed");
    assert.equal(firstRecord.external_review.review_slot?.verdict, "request_changes");
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");

    const second = runCompanion(commonArgs, commonOptions);
    assert.equal(second.status, 2, `exit ${second.status}: stderr=${second.stderr}; stdout=${second.stdout}`);
    const secondRecord = JSON.parse(second.stdout);
    assert.equal(secondRecord.error_code, "review_slot_disposition_required");
    assert.equal(secondRecord.external_review.source_content_transmission, "not_sent");
    assert.equal(secondRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
    assert.equal(
      secondRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "review_slot_retry_blocked",
    );
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review prompt omits provider-specific live verification context", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-context-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-review-context-bin-"));
  seedMinimalRepo(cwd);
  try {
    const binary = path.join(binDir, "gemini-review-context");
    writeFileSync(binary, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.includes("reply with exactly: pong.")) {
  process.stdout.write(JSON.stringify({
    session_id: "${GEMINI_SESSION_ID}",
    response: "pong"
  }) + "\\n");
  process.exit(0);
}
for (const expected of [
  "You are performing a code review. Prioritize bugs, behavioral regressions, and missing tests.",
  "Your final answer must be self-contained",
]) {
  if (!prompt.includes(expected)) {
    process.stderr.write("missing prompt text: " + expected + "\\n");
    process.exit(1);
  }
}
if (prompt.includes("Live verification context:")) {
  process.stderr.write("unexpected provider-specific live verification context\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  session_id: "${GEMINI_SESSION_ID}",
  response: "Verdict: APPROVE\\nBlocking findings\\n- None. I inspected seed.txt.\\nNon-blocking concerns\\n- None.\\nInspection status\\n- I inspected seed.txt."
}) + "\\n");
`, "utf8");
    chmodSync(binary, 0o755);
    const { stdout, stderr, status, dataDir } = runCompanion(
      ["run", "--mode=review", "--foreground", "--binary", binary, "--cwd", cwd, "--", "review prompt contract"],
      { cwd },
    );
    try {
      assert.equal(status, 0, `exit ${status}: ${stderr}; stdout=${stdout}`);
      const record = JSON.parse(stdout);
      assert.equal(record.status, "completed");
    } finally {
      rmTree(dataDir);
    }
  } finally {
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini review foreground: --timeout-ms overrides review timeout audit metadata", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-timeout-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--timeout-ms", "123456", "--", "review timeout override"],
    { cwd, env: {
      CODEX_SANDBOX: "seatbelt",
      GEMINI_MOCK_ASSERT_FILE: "seed.txt",
      GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "Provider: Gemini CLI",
    } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 123456);
    const { record: persisted } = readOnlyJobRecord(dataDir);
    assert.equal(persisted.review_metadata.audit_manifest.request.timeout_ms, 123456);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review foreground rejects --timeout-ms without a value", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-timeout-missing-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--timeout-ms", "--", "review timeout missing"],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.error, "bad_args");
    assert.match(result.message, /--timeout-ms must be a positive integer number of milliseconds/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review foreground: GEMINI_REVIEW_TIMEOUT_MS sets review timeout audit metadata", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-env-timeout-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review timeout env override"],
    { cwd, env: {
      CODEX_SANDBOX: "seatbelt",
      GEMINI_REVIEW_TIMEOUT_MS: "234567",
      GEMINI_MOCK_ASSERT_FILE: "seed.txt",
      GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "Provider: Gemini CLI",
    } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 234567);
    const { record: persisted } = readOnlyJobRecord(dataDir);
    assert.equal(persisted.review_metadata.audit_manifest.request.timeout_ms, 234567);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review foreground rejects invalid GEMINI_REVIEW_TIMEOUT_MS", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-env-timeout-invalid-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review invalid timeout env"],
    { cwd, env: { GEMINI_REVIEW_TIMEOUT_MS: "Infinity" } },
  );
  try {
    assert.equal(status, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.error, "bad_args");
    assert.match(result.message, /GEMINI_REVIEW_TIMEOUT_MS must be a positive integer number of milliseconds/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review does not silently fallback when review_quality capacity is exhausted", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-fallback-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review: x=1"],
    { cwd, env: { GEMINI_MOCK_CAPACITY_MODEL: "gemini-3.1-pro-preview" } },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    assert.doesNotMatch(stderr, /retrying with gemini-3-flash-preview/);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.model, "gemini-3.1-pro-preview");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review: scoped include dir contains explicit bundle files", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-custom-review-"));
  writeFileSync(path.join(cwd, "PR23.diff"), "diff --git a/x b/x\n");
  writeFileSync(path.join(cwd, "notes.md"), "review notes\n");
  writeFileSync(path.join(cwd, "private.log"), "not selected\n");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--foreground",
     "--cwd", cwd, "--scope-paths", "PR23.diff,notes.md", "--",
     "Review the selected bundle files using relative paths."],
    { cwd, env: { GEMINI_MOCK_ASSERT_FILE: "PR23.diff" } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.target, "gemini");
    assert.equal(record.status, "completed");
    assert.equal(record.mode, "custom-review");
    assert.equal(record.scope, "custom");
    assert.deepEqual(record.scope_paths, ["PR23.diff", "notes.md"]);

    const fx = readStdoutLog(dataDir, record.job_id);
    assert.equal(fx.t7_saw_file, true, `Gemini custom-review must receive PR23.diff; got ${fx.t7_include_dirs}`);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini preflight custom-review summarizes selected bundle files without launching Gemini", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-preflight-"));
  const missingBinary = path.join(cwd, "missing-gemini");
  writeFileSync(path.join(cwd, "PR23.diff"), "diff --git a/x b/x\n");
  writeFileSync(path.join(cwd, "notes.md"), "review notes\n");
  writeFileSync(path.join(cwd, "private.log"), "not selected\n");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["preflight", "--mode=custom-review",
     "--cwd", cwd, "--scope-paths", "PR23.diff,notes.md",
     "--binary", missingBinary],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.event, "preflight");
    assert.equal(result.target, "gemini");
    assert.equal(result.mode, "custom-review");
    assert.equal(result.scope, "custom");
    assert.equal(result.file_count, 2);
    assert.ok(result.byte_count > 0);
    assert.deepEqual(result.files.sort(), ["PR23.diff", "notes.md"]);
    assertPreflightSafetyFields(result);
    assert.match(result.disclosure_note, /not spawned/i);
    assert.match(result.disclosure_note, /external provider/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini preflight bad args still emits provider safety fields", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-preflight-bad-args-"));
  const { stdout, status, dataDir } = runCompanion(
    ["preflight", "--mode=nope", "--cwd", cwd],
    { cwd },
  );
  try {
    assert.equal(status, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.event, "preflight");
    assert.equal(result.target, "gemini");
    assert.equal(result.error, "bad_args");
    assertPreflightSafetyFields(result);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini preflight scope failures still emit provider safety fields", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-preflight-scope-fail-"));
  writeFileSync(path.join(cwd, "notes.md"), "review notes\n");
  const { stdout, status, dataDir } = runCompanion(
    ["preflight", "--mode=custom-review", "--cwd", cwd, "--scope-paths", "missing.md"],
    { cwd },
  );
  try {
    assert.equal(status, 2);
    const result = JSON.parse(stdout);
    assert.equal(result.event, "preflight");
    assert.equal(result.target, "gemini");
    assert.equal(result.error, "scope_failed");
    assertPreflightSafetyFields(result);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini preflight rejects Git binary policy errors before executing the override", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-preflight-git-policy-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-preflight-git-policy-data-"));
  const marker = path.join(cwd, "malicious-git-ran");
  try {
    seedMinimalRepo(cwd);
    const maliciousGit = path.join(cwd, "malicious-git");
    writeFileSync(maliciousGit, `#!/bin/sh\necho executed > ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
    chmodSync(maliciousGit, 0o700);
    const res = runCompanion(
      ["preflight", "--mode=custom-review", "--cwd", cwd, "--scope-paths", "seed.txt"],
      { cwd, dataDir, env: { CODEX_PLUGIN_MULTI_GIT_BINARY: maliciousGit } },
    );
    assert.equal(res.status, 1, `exit ${res.status}: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "git_binary_rejected");
    assert.match(parsed.message, /CODEX_PLUGIN_MULTI_GIT_BINARY/);
    assert.equal(existsSync(marker), false, "rejected git override must not execute");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review fails closed when pre-run ignore filtering is unavailable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-mut-pre-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review"],
    { cwd },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.match(record.error_message, /scope_population_failed: cannot evaluate gitignored files/);
    assert.match(record.error_summary, /Review scope was rejected/);
    assert.match(record.error_cause, /gitignored files/);
    assert.match(record.suggested_action, /branch-diff/);
    assert.match(record.disclosure_note, /not spawned/);
    assert.match(record.disclosure_note, /external provider/);
    assert.deepEqual(record.mutations, [],
      "scope filtering fails before mutation detection and target spawn");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review corrupt index fails closed before target spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-mut-spawn-fail-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--binary", path.join(cwd, "missing-gemini"), "--cwd", cwd, "--", "review"],
    { cwd },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.match(record.error_message, /scope_population_failed: cannot evaluate gitignored files/);
    assert.deepEqual(record.mutations, [],
      "scope filtering fails before mutation detection and target spawn");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini review preserves result when post-run mutation detection is unavailable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-mut-post-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-mut-post-data-"));
  seedMinimalRepo(cwd);
  const binary = writeIndexCorruptingBinary(dataDir, cwd);
  const res = spawnSync("node", [
    COMPANION, "run", "--mode=review", "--foreground",
    "--binary", binary,
    "--cwd", cwd, "--", "review",
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GEMINI_PLUGIN_DATA: dataDir,
    },
  });
  try {
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    const record = JSON.parse(res.stdout);
    assert.equal(record.status, "completed");
    assert.match(record.result, /mutation detection failed/);
    assert.ok(record.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must be surfaced, got ${JSON.stringify(record.mutations)}`);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini custom-review hard-fails a valid review when source mutates", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-mutation-hardfail-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-mutation-hardfail-data-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-mutation-hardfail-bin-"));
  try {
    fixtureSeedRepo(cwd, {
      fileName: "seed.txt",
      fileContents: "gemini mutation hardfail sentinel\n",
    });
    const binary = path.join(binDir, "gemini-mutating-review");
    writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(path.join(cwd, "seed.txt"))}, "mutated by gemini mock\\n");
process.stdout.write(JSON.stringify({
  session_id: "${GEMINI_SESSION_ID}",
  response: "Verdict: APPROVE\\nBlocking findings\\n- None. The selected source was inspected before mutation.\\nNon-blocking concerns\\n- None.\\nInspection status\\n- I inspected seed.txt."
}) + "\\n");
`, "utf8");
    chmodSync(binary, 0o755);
    const { stdout, status } = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--cwd",
      cwd,
      "--binary",
      binary,
      "--scope-paths",
      "seed.txt",
      "--foreground",
      "--",
      "Review this scope.",
    ], { cwd, dataDir });
    assert.equal(status, 2, stdout);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "review_not_completed");
    assert.match(record.result, /selected source was inspected/i);
    assert.ok(record.mutations.includes(" M seed.txt"), JSON.stringify(record.mutations));
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.review_metadata.audit_manifest.status, "failed");
    assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, true);
    assert.ok(
      record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons.includes("source_mutation_detected"),
      JSON.stringify(record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons),
    );
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini run rejects Git binary policy errors distinctly before target spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-git-policy-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-git-policy-data-"));
  const marker = path.join(cwd, "malicious-git-ran");
  try {
    seedMinimalRepo(cwd);
    const maliciousGit = path.join(cwd, "malicious-git");
    writeFileSync(maliciousGit, `#!/bin/sh\necho executed > ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
    chmodSync(maliciousGit, 0o700);
    const res = runCompanion([
      "run", "--mode=custom-review", "--foreground",
      "--model", "gemini-3-flash-preview",
      "--cwd", cwd,
      "--scope-paths", "seed.txt",
      "--", "review policy rejection",
    ], {
      cwd,
      dataDir,
      env: { CODEX_PLUGIN_MULTI_GIT_BINARY: maliciousGit },
    });
    assert.equal(res.status, 1, `exit ${res.status}: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "git_binary_rejected");
    assert.match(parsed.message, /CODEX_PLUGIN_MULTI_GIT_BINARY/);
    assert.equal(existsSync(marker), false, "rejected git override must not execute");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini scope population failure skips target CLI spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-scope-abort-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-scope-abort-data-"));
  const marker = path.join(dataDir, "spawned.marker");
  const binary = writeMarkerBinary(dataDir, marker);
  seedMinimalRepo(cwd);
  mkdirSync(path.join(cwd, "target-dir"));
  writeFileSync(path.join(cwd, "target-dir/file.txt"), "nested\n");
  symlinkSync("target-dir", path.join(cwd, "dir-link"));
  const res = spawnSync("node", [
    COMPANION, "run", "--mode=review", "--foreground",
    "--model", "gemini-3-flash-preview",
    "--cwd", cwd, "--", "focus",
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GEMINI_BINARY: binary,
      GEMINI_PLUGIN_DATA: dataDir,
    },
  });
  try {
    assert.equal(res.status, 2, `exit ${res.status}: ${res.stderr}`);
    const record = JSON.parse(res.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.exit_code, null);
    assert.match(record.error_message, /unsafe_symlink/);
    assert.match(record.error_summary, /Review scope was rejected/);
    assert.match(record.error_cause, /symlink/i);
    assert.match(record.suggested_action, /branch-diff/);
    assert.match(record.disclosure_note, /not spawned/);
    assert.match(record.disclosure_note, /external provider/);
    assert.equal(existsSync(marker), false, "target CLI marker proves Gemini binary was spawned");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini status default surfaces continuable terminal states; --all includes queued (#16 follow-up 4)", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-status-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-status-data-"));
  seedMinimalRepo(cwd);
  try {
    const previous = process.env.GEMINI_PLUGIN_DATA;
    process.env.GEMINI_PLUGIN_DATA = dataDir;
    const state = await import("../../plugins/gemini/scripts/lib/state.mjs");
    for (const status of ["queued", "cancelled", "stale", "running", "completed", "failed"]) {
      state.upsertJob(cwd, { id: `job-${status}`, status });
    }
    if (previous === undefined) delete process.env.GEMINI_PLUGIN_DATA;
    else process.env.GEMINI_PLUGIN_DATA = previous;

    const res = spawnSync("node", [COMPANION, "status", "--cwd", cwd], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
    });
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    // #16 follow-up 4: cancelled and stale are continuable terminal states,
    // so default status must include them. Only queued (transient pre-spawn)
    // is hidden from the default view.
    assert.deepEqual(
      parsed.jobs.map((job) => job.status).sort(),
      ["cancelled", "completed", "failed", "running", "stale"],
    );

    const allRes = spawnSync("node", [COMPANION, "status", "--all", "--cwd", cwd], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GEMINI_PLUGIN_DATA: dataDir },
    });
    assert.equal(allRes.status, 0, `exit ${allRes.status}: ${allRes.stderr}`);
    const allParsed = JSON.parse(allRes.stdout);
    assert.deepEqual(
      allParsed.jobs.map((job) => job.status).sort(),
      ["cancelled", "completed", "failed", "queued", "running", "stale"],
    );
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini run --foreground: sidecar write failures warn but preserve terminal status (#16 follow-up 1)", () => {
  // Mirror of the Claude sidecar-warn smoke test for parity coverage.
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-sidecar-warn-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "sidecar warn"],
    { cwd, env: { GEMINI_MOCK_SIDECAR_CONFLICT: "1" } },
  );
  try {
    assert.equal(status, 0, `expected completed exit; got ${status}: ${stderr}`);
    assert.doesNotMatch(stderr, /unhandled/i);
    assert.match(stderr, /warning: sidecar .* write failed/i,
      "Gemini sidecar failure must surface as a one-line stderr warning");
    const record = JSON.parse(stdout);
    assert.equal(record.status, "completed",
      "terminal JobRecord must reflect the real run outcome despite sidecar failure");
    assert.equal(record.error_code, null);
    const { record: persisted } = readOnlyJobRecord(dataDir);
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.job_id, record.job_id);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini run --foreground: meta-write conflict produces fallback failed record, no permanent running (#16 follow-up 1)", () => {
  // Mirror of the Claude meta-conflict test. The Gemini mock walks
  // GEMINI_PLUGIN_DATA/state/*/jobs to discover the queued meta path.
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-meta-conflict-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "meta conflict"],
    { cwd, env: { GEMINI_MOCK_META_CONFLICT: "1" } },
  );
  try {
    assert.notEqual(status, 0, "meta write failure must exit non-zero");
    assert.doesNotMatch(stderr, /unhandled/i);
    const err = JSON.parse(stdout);
    assert.equal(err.error, "finalization_failed");
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
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini run --foreground: state lock timeout preserves finalization_failed meta", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-state-lock-timeout-"));
  seedMinimalRepo(cwd);
  const preload = path.join(cwd, "short-lock-timeout.mjs");
  writeFileSync(preload, `
import { configureState } from ${JSON.stringify(path.join(REPO_ROOT, "plugins/gemini/scripts/lib/state.mjs"))};
configureState({ lockTimeoutMs: 150 });
`, "utf8");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "state lock timeout"],
    {
      cwd,
      env: {
        GEMINI_MOCK_STATE_LOCK_CONFLICT: "1",
        NODE_OPTIONS: `--import=${preload}`,
      },
    },
  );
  try {
    assert.notEqual(status, 0, "state lock timeout must fail finalization");
    assert.doesNotMatch(stderr, /unhandled/i);
    const err = JSON.parse(stdout);
    assert.equal(err.error, "finalization_failed");
    assert.match(err.message, /state_lock_timeout/);

    const { record } = readOnlyJobRecord(dataDir);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "finalization_failed");
    assert.match(record.error_message, /state_lock_timeout/);
    assert.equal(record.external_review.source_content_transmission, "sent");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini ping returns ok with the mock gemini binary using default subscription auth", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-cwd-"));
  const tempRoot = realpathSync(tmpdir());
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["ping", "--model", "gemini-3-flash-preview"],
    {
      cwd,
      env: {
        GEMINI_API_KEY: "secret-test-value",
        GEMINI_MOCK_ASSERT_CWD_PREFIX: tempRoot,
        GEMINI_MOCK_ASSERT_CWD_NOT: tempRoot,
      },
    },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.ready, true);
    assert.match(parsed.summary, /ready/i);
    assert.deepEqual(parsed.ignored_env_credentials, ["GEMINI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_ignored");
    assert.equal(parsed.auth_mode, "subscription");
    assert.equal(parsed.selected_auth_path, "subscription_oauth");
    assert.doesNotMatch(stdout, /secret-test-value/);
    assert.equal(parsed.model, "gemini-3-flash-preview");
    assert.equal(parsed.session_id, GEMINI_SESSION_ID);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini doctor returns readiness contract", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-doctor-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["doctor"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.ready, true);
    assert.match(parsed.summary, /ready/i);
    assert.match(parsed.next_action, /review/i);
    assert.equal(parsed.auth_mode, "subscription");
    assert.equal(parsed.selected_auth_path, "subscription_oauth");
    assert.deepEqual(parsed.ignored_env_credentials, ["GEMINI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_ignored");
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini doctor reports review-quality capacity exhaustion without fallback", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-doctor-review-fallback-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["doctor"],
    { cwd, env: { GEMINI_MOCK_CAPACITY_MODEL: "gemini-3.1-pro-preview" } },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    assert.doesNotMatch(stderr, /retrying with gemini-3-flash-preview/);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "rate_limited");
    assert.equal(parsed.ready, false);
    assert.equal(parsed.model_fallback, undefined);
    assert.match(parsed.summary, /capacity-limited/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini ping explicit api_key auth allows provider key by name only", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-api-key-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-api-key-bin-"));
  const binary = path.join(binDir, "gemini-api-key-mode");
  writeFileSync(binary, `#!/usr/bin/env node
if (process.env.GEMINI_API_KEY !== "secret-test-value") {
  process.stderr.write("missing GEMINI_API_KEY\\n");
  process.exit(9);
}
process.stdout.write(JSON.stringify({
  session_id: "${GEMINI_SESSION_ID}",
  response: "Mock Gemini response."
}) + "\\n");
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--auth-mode", "api_key", "--binary", binary, "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.auth_mode, "api_key");
    assert.equal(parsed.selected_auth_path, "api_key_env");
    assert.deepEqual(parsed.allowed_env_credentials, ["GEMINI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_allowed");
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping default subscription auth ignores API key when present", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-subscription-default-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-subscription-default-bin-"));
  const binary = path.join(binDir, "gemini-subscription-default");
  writeFileSync(binary, `#!/usr/bin/env node
if (process.env.GEMINI_API_KEY) {
  process.stderr.write("GEMINI_API_KEY should be ignored for subscription probe\\n");
  process.exit(9);
}
process.stdout.write(JSON.stringify({
  session_id: "${GEMINI_SESSION_ID}",
  response: "Mock Gemini response."
}) + "\\n");
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--binary", binary, "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.auth_mode, "subscription");
    assert.equal(parsed.selected_auth_path, "subscription_oauth");
    assert.deepEqual(parsed.ignored_env_credentials, ["GEMINI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_ignored");
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping subscription auth falls back to API key when subscription is unavailable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-subscription-api-fallback-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-subscription-api-fallback-bin-"));
  const binary = path.join(binDir, "gemini-subscription-api-fallback");
  writeFileSync(binary, `#!/usr/bin/env node
if (process.env.GEMINI_API_KEY === "secret-test-value") {
  process.stdout.write(JSON.stringify({
    session_id: "${GEMINI_SESSION_ID}",
    response: "Mock Gemini response."
  }) + "\\n");
  process.exit(0);
}
process.stderr.write("OAuth2 not authenticated\\n");
process.exit(1);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--binary", binary, "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.auth_mode, "subscription");
    assert.equal(parsed.selected_auth_path, "api_key_env");
    assert.deepEqual(parsed.allowed_env_credentials, ["GEMINI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_fallback");
    assert.deepEqual(parsed.auth_fallback, {
      from: "subscription_oauth",
      to: "api_key_env",
      reason: "not_authed",
    });
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping api_key auth fails before target spawn when no provider key is present", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-api-key-missing-cwd-"));
  const missingBinary = path.join(tmpdir(), "missing-gemini-api-key-mode-binary");
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--auth-mode", "api_key", "--binary", missingBinary, "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "not_authed");
    assert.equal(parsed.auth_mode, "api_key");
    assert.equal(parsed.selected_auth_path, "api_key_env_missing");
    assert.match(parsed.next_action, /GEMINI_API_KEY|GOOGLE_API_KEY/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini ping classifies Codex sandbox denial for Gemini state as sandbox_blocked", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-sandbox-blocked-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-sandbox-blocked-bin-"));
  const binary = path.join(binDir, "gemini-sandbox-blocked");
  writeFileSync(binary, `#!/usr/bin/env node
process.stderr.write("PermissionError: [Errno 1] Operation not permitted: '/Users/test/.gemini/settings.json'\\n");
process.exit(1);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--binary", binary, "--model", "gemini-3-flash-preview"],
    { cwd, env: { CODEX_SANDBOX: "seatbelt", GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "sandbox_blocked");
    assert.equal(parsed.ready, false);
    assert.match(parsed.summary, /sandbox/i);
    assert.match(parsed.next_action, /~\/\.gemini|writable_roots/);
    assert.match(parsed.detail, /\.gemini\/settings\.json/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping default timeout allows slow OAuth startup", { timeout: 25000 }, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-slow-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-slow-bin-"));
  const binary = path.join(binDir, "gemini-slow-ok");
  writeFileSync(binary, `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    session_id: "${GEMINI_SESSION_ID}",
    response: "ready after slow OAuth startup"
  }) + "\\n");
}, 16000);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["ping", "--binary", binary, "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr || stdout}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.ready, true);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping succeeds without --model and forbids tool exploration in the prompt", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-default-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["ping"],
    {
      cwd,
      env: { GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "Do not use any tools" },
    },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.model, null);
    assert.equal(parsed.session_id, GEMINI_SESSION_ID);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini ping reports native capacity exhaustion without silent fallback", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-native-fallback-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["ping"],
    { cwd, env: { GEMINI_MOCK_CAPACITY_MODEL: "unknown" } },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    assert.doesNotMatch(stderr, /retrying with gemini-2\.5-flash/);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "rate_limited");
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.model_fallback, undefined);
    assert.match(parsed.summary, /capacity-limited/i);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini run sandbox denial fails closed before review launch", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-run-sandbox-blocked-cwd-"));
  seedMinimalRepo(cwd);
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-run-sandbox-blocked-bin-"));
  const binary = path.join(binDir, "gemini-sandbox-blocked");
  writeFileSync(binary, `#!/usr/bin/env node
process.stderr.write("PermissionError: [Errno 1] Operation not permitted: '/Users/test/.gemini/oauth.json'\\n");
process.exit(1);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--lifecycle-events", "jsonl", "--binary", binary,
     "--model", "gemini-3-flash-preview", "--cwd", cwd, "--", "review this change"],
    { cwd, env: { CODEX_SANDBOX: "seatbelt", GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 2);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, "sandbox preflight must not emit external_review_launched");
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "sandbox_blocked");
    assert.match(record.error_summary, /sandbox/i);
    assert.match(record.suggested_action, /~\/\.gemini|writable_roots/);
    assert.equal(record.pid_info ?? null, null);
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.match(record.external_review.disclosure, /not sent/);
    assert.equal(record.error_code, "sandbox_blocked");
    assert.equal(record.review_quality.failed_review_slot, false);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini source-bearing preflight failures redact selected source from error messages", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-preflight-redact-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-preflight-redact-data-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-preflight-redact-bin-"));
  try {
    const missingBinary = path.join(binDir, "missing-gemini-binary");
    fixtureSeedRepo(cwd, {
      fileName: "seed.txt",
      fileContents: missingBinary,
    });
    const result = runCompanion([
      "run",
      "--mode",
      "custom-review",
      "--foreground",
      "--binary",
      missingBinary,
      "--cwd",
      cwd,
      "--scope-paths",
      "seed.txt",
      "--",
      "review selected source",
    ], { cwd, dataDir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const record = JSON.parse(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.error_message.includes(missingBinary), false, record.error_message);
    assert.match(record.error_message, /\[redacted_source_excerpt\]/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini run ignores stale successful doctor and re-preflights before source send", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-run-stale-doctor-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-run-stale-doctor-data-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "GEMINI_STALE_DOCTOR_SOURCE_SENTINEL\n",
  });
  const doctor = runCompanion(
    ["doctor", "--model", "gemini-3-flash-preview"],
    { cwd, dataDir, env: { GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } },
  );
  const result = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--lifecycle-events", "jsonl",
     "--model", "gemini-3-flash-preview", "--cwd", cwd,
     "--scope-paths", "seed.txt", "--", "review this scope"],
    {
      cwd,
      dataDir,
      env: {
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        GEMINI_MOCK_CAPACITY_MODEL: "gemini-3-flash-preview",
      },
    },
  );
  try {
    assert.equal(doctor.dataDir, result.dataDir, "stale doctor proof must reuse the same plugin data dir");
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assert.equal(JSON.parse(doctor.stdout).ready, true);
    assert.equal(result.status, 2);
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, "stale doctor success must not emit launch before fresh preflight");
    const [record] = lines;
    assert.equal(record.error_code, "spawn_failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.doesNotMatch(result.stdout, /GEMINI_STALE_DOCTOR_SOURCE_SENTINEL/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini run subscription auth does not source-send through API fallback without approval", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-run-subscription-api-fallback-blocked-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "GEMINI_AUTO_FALLBACK_SOURCE_SENTINEL\n",
  });
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-run-subscription-api-fallback-blocked-bin-"));
  const leakMarker = path.join(binDir, "source-leaked");
  const binary = path.join(binDir, "gemini-subscription-api-fallback-blocked");
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (process.env.GEMINI_API_KEY !== "secret-test-value") {
    process.stderr.write("OAuth2 not authenticated\\n");
    process.exit(1);
  }
  if (prompt.includes("reply with exactly: pong")) {
    process.stderr.write("API key revoked: not authenticated\\n");
    process.exit(1);
  }
  if (prompt.includes("GEMINI_AUTO_FALLBACK_SOURCE_SENTINEL")) {
    writeFileSync(${JSON.stringify(leakMarker)}, "leaked");
  }
  process.stdout.write(JSON.stringify({
    session_id: "${GEMINI_SESSION_ID}",
    response: "Verdict: APPROVE\\nBlocking findings\\n- None.\\nNon-blocking concerns\\n- None.\\nInspection status\\n- I inspected seed.txt."
  }) + "\\n");
  process.exit(0);
});
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--lifecycle-events", "jsonl",
     ...geminiAuthModeArgs(geminiSubscriptionAuthMode()), "--binary", binary, "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--scope-paths", "seed.txt", "--", "review selected source"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 2);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, "fallback preflight failure must not emit external_review_launched");
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "not_authed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(existsSync(leakMarker), false, "selected source reached API-key fallback review spawn");
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini run explicit api_key source-bearing review requires approval before spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-run-explicit-api-source-approval-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "GEMINI_EXPLICIT_API_SOURCE_SENTINEL\n",
  });
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-run-explicit-api-source-approval-bin-"));
  const leakMarker = path.join(binDir, "source-leaked");
  const binary = path.join(binDir, "gemini-explicit-api-source-approval");
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (prompt.includes("GEMINI_EXPLICIT_API_SOURCE_SENTINEL")) {
    writeFileSync(${JSON.stringify(leakMarker)}, "leaked");
  }
  process.stdout.write(JSON.stringify({
    session_id: "${GEMINI_SESSION_ID}",
    response: "Verdict: APPROVE\\nBlocking findings\\n- None.\\nNon-blocking concerns\\n- None.\\nInspection status\\n- I inspected seed.txt."
  }) + "\\n");
  process.exit(0);
});
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--lifecycle-events", "jsonl",
     ...geminiAuthModeArgs(geminiApiKeyAuthMode()), "--binary", binary, "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--scope-paths", "seed.txt", "--", "review selected source"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 2);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, "unapproved API source send must not emit external_review_launched");
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "approval_required");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.selected_route, "direct_api");
    assert.equal(record.review_metadata.audit_manifest.fallback_reason, "explicit_api");
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, true);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "required");
    assert.equal(existsSync(leakMarker), false, "selected source reached unapproved Gemini API-key review spawn");
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini approval-request explicit api_key source-bearing review token unlocks matching run", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-approval-request-api-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "GEMINI_APPROVAL_REQUEST_API_SOURCE_SENTINEL\n",
  });
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-approval-request-api-bin-"));
  const leakMarker = path.join(binDir, "source-leaked");
  const binary = path.join(binDir, "gemini-approval-request-api");
  writeFileSync(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.includes("GEMINI_APPROVAL_REQUEST_API_SOURCE_SENTINEL")) {
  writeFileSync(${JSON.stringify(leakMarker)}, "leaked");
}
process.stdout.write(JSON.stringify({
  session_id: "${GEMINI_SESSION_ID}",
  response: "Verdict: APPROVE\\nBlocking findings\\n- None.\\nNon-blocking concerns\\n- None.\\nInspection status\\n- I inspected seed.txt."
}) + "\\n");
`, "utf8");
  chmodSync(binary, 0o755);
  const commonOptions = [
    "--mode=custom-review",
    ...geminiAuthModeArgs(geminiApiKeyAuthMode()),
    "--binary", binary,
    "--model", "gemini-3-flash-preview",
    "--cwd", cwd,
    "--scope-paths", "seed.txt",
  ];
  const approval = runCompanion(
    ["approval-request", ...commonOptions, "--", "review selected source"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(approval.status, 0, approval.stderr || approval.stdout);
    const request = JSON.parse(approval.stdout);
    assert.equal(request.event, "external_review_approval_request");
    assert.equal(request.provider, "gemini");
    assert.equal(request.source_content_transmission, "not_sent");
    assert.equal(request.selected_route, "direct_api");
    assert.equal(request.fallback_reason, "explicit_api");
    assert.equal(request.source_send_approval_required, true);
    assert.equal(request.source_send_approval_state, "required");
    assert.equal(request.approval_scope, "session");
    assert.match(request.approval_token.value, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(leakMarker), false, "approval-request must not launch Gemini or send selected source");

    const run = runCompanion(
      ["run", "--foreground", "--lifecycle-events", "jsonl",
       ...commonOptions, "--approval-token", request.approval_token.value, "--", "review selected source"],
      { cwd, dataDir: approval.dataDir, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const lines = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const record = lines.at(-1);
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, true);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "approved");
    assert.equal(existsSync(leakMarker), true, "matching approval token should allow source-bearing Gemini launch");
    assert.doesNotMatch(approval.stdout + run.stdout, /secret-test-value/);
  } finally {
    rmTree(approval.dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini approval-request blocks same-packet request-changes retry without disposition", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-approval-request-retry-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "gemini-approval-request-retry-data-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "GEMINI_APPROVAL_RETRY_SOURCE_SENTINEL\n",
  });
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-approval-request-retry-bin-"));
  const binary = path.join(binDir, "gemini-approval-request-retry");
  const reviewText = requestChangesReviewFixture("Gemini API-key approval retry guard marker.");
  writeFileSync(binary, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  session_id: "${GEMINI_SESSION_ID}",
  response: ${JSON.stringify(reviewText)}
}) + "\\n");
`, "utf8");
  chmodSync(binary, 0o755);
  const commonOptions = [
    "--mode=custom-review",
    ...geminiAuthModeArgs(geminiApiKeyAuthMode()),
    "--binary", binary,
    "--model", "gemini-3-flash-preview",
    "--cwd", cwd,
    "--scope-paths", "seed.txt",
  ];
  const env = { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" };

  try {
    const approval = runCompanion(
      ["approval-request", ...commonOptions, "--", "review selected source"],
      { cwd, dataDir, env },
    );
    assert.equal(approval.status, 0, approval.stderr || approval.stdout);
    const request = JSON.parse(approval.stdout);

    const run = runCompanion(
      ["run", "--foreground", "--lifecycle-events", "jsonl", ...commonOptions, "--approval-token", request.approval_token.value, "--", "review selected source"],
      { cwd, dataDir, env },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const record = run.stdout.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(record.external_review.review_slot?.verdict, "request_changes");
    assert.equal(record.external_review.source_content_transmission, "sent");

    const blockedApproval = runCompanion(
      ["approval-request", ...commonOptions, "--", "review selected source"],
      { cwd, dataDir, env },
    );
    assert.equal(blockedApproval.status, 1, blockedApproval.stderr || blockedApproval.stdout);
    const blocked = JSON.parse(blockedApproval.stdout);
    assert.equal(blocked.error, "review_slot_disposition_required");
    assert.equal(blocked.review_slot.retry_count, 1);
    assert.equal(blocked.review_slot.verdict, "failed_slot");
    assert.equal(blocked.source_packet_policy.source_packet_action, "review_slot_retry_blocked");
    assert.equal(Object.hasOwn(blocked, "approval_token"), false);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini approval-request token unlocks matching background api_key source-bearing review", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-approval-token-api-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "GEMINI_BACKGROUND_APPROVED_API_SOURCE_SENTINEL\n",
  });
  const commonOptions = [
    "--mode=custom-review",
    ...geminiAuthModeArgs(geminiApiKeyAuthMode()),
    "--binary", MOCK,
    "--model", "gemini-3-flash-preview",
    "--cwd", cwd,
    "--scope-paths", "seed.txt",
  ];
  const approval = runCompanion(
    ["approval-request", ...commonOptions, "--", "review selected source"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(approval.status, 0, approval.stderr || approval.stdout);
    const request = JSON.parse(approval.stdout);
    assert.equal(request.source_content_transmission, "not_sent");
    assert.equal(request.source_send_approval_required, true);
    assert.equal(request.source_send_approval_state, "required");

    const launched = runCompanion(
      ["run", "--background", "--lifecycle-events", "jsonl",
       ...commonOptions, "--approval-token", request.approval_token.value, "--", "review selected source"],
      {
        cwd,
        dataDir: approval.dataDir,
        env: {
          GEMINI_API_KEY: "secret-test-value",
          GOOGLE_API_KEY: "",
          GEMINI_MOCK_ASSERT_PROMPT_INCLUDES: "GEMINI_BACKGROUND_APPROVED_API_SOURCE_SENTINEL",
        },
      },
    );
    assert.equal(launched.status, 0, launched.stderr || launched.stdout);
    const launchEvent = JSON.parse(launched.stdout);
    assert.equal(launchEvent.external_review.source_content_transmission, "may_be_sent");

    const deadline = Date.now() + GEMINI_SMOKE_POLL_TIMEOUT_MS;
    let terminal = null;
    let lastStale = null;
    while (Date.now() < deadline && !terminal) {
      const statusRes = spawnSync("node", [COMPANION, "status", "--all", "--cwd", cwd], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GEMINI_PLUGIN_DATA: approval.dataDir },
      });
      assert.equal(statusRes.status, 0, statusRes.stderr);
      const status = JSON.parse(statusRes.stdout);
      const job = status.jobs.find((candidate) => candidate.job_id === launchEvent.job_id);
      if (job?.status === "stale") {
        lastStale = job;
      } else if (job && ["completed", "failed", "cancelled"].includes(job.status)) {
        terminal = job;
      }
      if (!terminal) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.ok(terminal, `background approved API-key review did not reach terminal state; last stale=${JSON.stringify(lastStale)}`);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.external_review.source_content_transmission, "sent");
    assert.equal(terminal.review_metadata.audit_manifest.source_send_approval_required, true);
    assert.equal(terminal.review_metadata.audit_manifest.source_send_approval_state, "approved");
    assert.doesNotMatch(approval.stdout + launched.stdout + JSON.stringify(terminal), /secret-test-value/);
  } finally {
    rmTree(approval.dataDir);
    rmTree(cwd);
  }
});

test("gemini background explicit api_key source-bearing review requires approval before launch", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-explicit-api-source-approval-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "GEMINI_BACKGROUND_API_SOURCE_SENTINEL\n",
  });
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-bg-explicit-api-source-approval-bin-"));
  const leakMarker = path.join(binDir, "source-leaked");
  const binary = path.join(binDir, "gemini-bg-explicit-api-source-approval");
  writeFileSync(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.includes("GEMINI_BACKGROUND_API_SOURCE_SENTINEL")) {
  writeFileSync(${JSON.stringify(leakMarker)}, "leaked");
}
process.stdout.write(JSON.stringify({
  session_id: "${GEMINI_SESSION_ID}",
  response: "Verdict: APPROVE\\nBlocking findings\\n- None.\\nNon-blocking concerns\\n- None.\\nInspection status\\n- I inspected seed.txt."
}) + "\\n");
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=custom-review", "--background", "--lifecycle-events", "jsonl",
     ...geminiAuthModeArgs(geminiApiKeyAuthMode()), "--binary", binary, "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--scope-paths", "seed.txt", "--", "review selected source"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(status, 2, stdout);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "approval_required");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, true);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "required");
    assert.equal(existsSync(leakMarker), false, "selected source reached unapproved Gemini API-key background spawn");
    const { metaPath } = readOnlyJobRecord(dataDir);
    const promptPath = path.join(path.dirname(metaPath), record.job_id, "prompt.txt");
    assert.equal(existsSync(promptPath), false, "unapproved Gemini API-key background run must not persist selected source prompt sidecar");
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini background explicit api_key source-bearing continue requires approval before launch", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-continue-api-source-approval-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "GEMINI_BACKGROUND_CONTINUE_API_SOURCE_SENTINEL\n",
  });
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-bg-continue-api-source-approval-bin-"));
  const leakMarker = path.join(binDir, "source-leaked");
  const binary = path.join(binDir, "gemini-bg-continue-api-source-approval");
  writeFileSync(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.includes("GEMINI_BACKGROUND_CONTINUE_API_SOURCE_SENTINEL")) {
  writeFileSync(${JSON.stringify(leakMarker)}, "leaked");
}
process.stdout.write(JSON.stringify({
  session_id: "${RESUMED_GEMINI_SESSION_ID}",
  response: "Verdict: APPROVE\\nBlocking findings\\n- None.\\nNon-blocking concerns\\n- None.\\nInspection status\\n- I inspected seed.txt."
}) + "\\n");
`, "utf8");
  chmodSync(binary, 0o755);
  const first = runCompanion(
    ["run", "--mode=custom-review", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--scope-paths", "seed.txt", "--", "initial review"],
    { cwd },
  );
  try {
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const prior = JSON.parse(first.stdout);
    const continued = runCompanion(
      ["continue", "--job", prior.job_id, "--background", "--lifecycle-events", "jsonl",
       ...geminiAuthModeArgs(geminiApiKeyAuthMode()), "--binary", binary, "--model", "gemini-3-flash-preview",
       "--cwd", cwd, "--", "continue selected-source review"],
      { cwd, dataDir: first.dataDir, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
    );

    assert.equal(continued.status, 2, continued.stdout);
    const record = JSON.parse(continued.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "approval_required");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, true);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "required");
    assert.equal(existsSync(leakMarker), false, "selected source reached unapproved Gemini API-key background continue");
    const stateRoot = path.join(first.dataDir, "state");
    let metaPath = null;
    for (const workspaceDir of readdirSync(stateRoot)) {
      const candidate = path.join(stateRoot, workspaceDir, "jobs", `${record.job_id}.json`);
      if (existsSync(candidate)) {
        metaPath = candidate;
        break;
      }
    }
    assert.ok(metaPath, "failed continue JobRecord was not persisted");
    const promptPath = path.join(path.dirname(metaPath), record.job_id, "prompt.txt");
    assert.equal(existsSync(promptPath), false, "unapproved Gemini API-key background continue must not persist selected source prompt sidecar");
    assert.doesNotMatch(continued.stdout, /secret-test-value/);
  } finally {
    rmTree(first.dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini continue inherits prior api_key route before source-bearing preflight", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-continue-inherit-api-route-cwd-"));
  fixtureSeedRepo(cwd, {
    fileName: "seed.txt",
    fileContents: "GEMINI_CONTINUE_INHERIT_API_ROUTE_SENTINEL\n",
  });
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-continue-inherit-api-route-bin-"));
  const leakMarker = path.join(binDir, "continue-source-leaked");
  const binary = path.join(binDir, "gemini-continue-inherit-api-route");
  writeFileSync(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.includes("GEMINI_CONTINUE_INHERIT_API_ROUTE_SENTINEL")) {
  writeFileSync(${JSON.stringify(leakMarker)}, "leaked");
}
process.stdout.write(JSON.stringify({
  session_id: "${RESUMED_GEMINI_SESSION_ID}",
  response: "Verdict: APPROVE\\nBlocking findings\\n- None.\\nNon-blocking concerns\\n- None.\\nInspection status\\n- I inspected seed.txt."
}) + "\\n");
`, "utf8");
  chmodSync(binary, 0o755);

  const commonOptions = [
    "--mode=custom-review",
    ...geminiAuthModeArgs(geminiApiKeyAuthMode()),
    "--binary", binary,
    "--model", "gemini-3-flash-preview",
    "--cwd", cwd,
    "--scope-paths", "seed.txt",
  ];
  const approval = runCompanion(
    ["approval-request", ...commonOptions, "--", "initial source review"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
  );
  try {
    assert.equal(approval.status, 0, approval.stderr || approval.stdout);
    const request = JSON.parse(approval.stdout);
    const first = runCompanion(
      ["run", "--foreground", ...commonOptions, "--approval-token", request.approval_token.value, "--", "initial source review"],
      { cwd, dataDir: approval.dataDir, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const prior = JSON.parse(first.stdout);
    rmSync(leakMarker, { force: true });

    const continued = runCompanion(
      ["continue", "--job", prior.job_id, "--foreground", "--lifecycle-events", "jsonl",
       "--binary", binary, "--model", "gemini-3-flash-preview", "--cwd", cwd, "--", "continue selected-source review"],
      { cwd, dataDir: approval.dataDir, env: { GEMINI_API_KEY: "secret-test-value", GOOGLE_API_KEY: "" } },
    );

    assert.equal(continued.status, 2, continued.stdout);
    const lines = continued.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const record = lines.at(-1);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "approval_required");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest.selected_route, "direct_api");
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, true);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "required");
    assert.equal(existsSync(leakMarker), false, "continue silently changed auth route and sent source without matching API approval");
    assert.doesNotMatch(approval.stdout + first.stdout + continued.stdout, /secret-test-value/);
  } finally {
    rmTree(approval.dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping not_found includes readiness guidance", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-missing-cwd-"));
  const missingBinary = path.join(tmpdir(), "missing-gemini-ping-binary");
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--binary", missingBinary, "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "not_found");
    assert.equal(parsed.ready, false);
    assert.match(parsed.summary, /not found/i);
    assert.match(parsed.next_action, /Install Gemini CLI/);
    assert.deepEqual(parsed.ignored_env_credentials, ["GEMINI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_ignored");
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini ping model_fallback remains null when no native fallbacks are configured", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-multi-fallback-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-multi-fallback-bin-"));
  const binary = path.join(binDir, "gemini-multi-fallback");
  writeFileSync(binary, `#!/usr/bin/env node
const modelIndex = process.argv.indexOf("-m");
const model = modelIndex === -1 ? "unknown" : process.argv[modelIndex + 1];
if (model === "unknown" || model === "gemini-2.5-flash") {
  process.stderr.write("No capacity available for model " + model + " on the server\\n");
  process.stderr.write("RESOURCE_EXHAUSTED\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  session_id: "${GEMINI_SESSION_ID}",
  response: "Mock Gemini response.",
  stats: { models: { [model]: { tokens: { total: 12 } } } }
}) + "\\n");
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["ping"],
    { cwd, env: { GEMINI_BINARY: binary } },
  );
  try {
    assert.equal(status, 2, `exit ${status}: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.model_fallback, undefined);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping failure detail falls back to target stdout when stderr is empty", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-stdout-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-stdout-bin-"));
  const binary = path.join(binDir, "gemini-stdout-error");
  writeFileSync(binary, `#!/usr/bin/env node
process.stdout.write("credentials missing\\n");
process.exit(7);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_BINARY: binary } },
  );
  try {
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "not_authed");
    assert.equal(parsed.ready, false);
    assert.match(parsed.next_action, /gemini/);
    assert.match(parsed.detail, /credentials missing/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping classifies OAuth2 stdout as not_authed", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-oauth2-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-oauth2-bin-"));
  const binary = path.join(binDir, "gemini-oauth2-error");
  writeFileSync(binary, `#!/usr/bin/env node
process.stdout.write("OAuth2 flow incomplete\\n");
process.exit(7);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_BINARY: binary } },
  );
  try {
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "not_authed");
    assert.match(parsed.detail, /OAuth2 flow incomplete/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping trims OAuth stack traces to the diagnostic line", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-oauth-stack-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-oauth-stack-bin-"));
  const binary = path.join(binDir, "gemini-oauth-stack-error");
  writeFileSync(binary, `#!/usr/bin/env node
process.stderr.write("Error authenticating: FatalCancellationError: Authentication cancelled by user.\\n");
process.stderr.write("    at initOauthClient (/tmp/gemini/bundle.js:1:1)\\n");
process.stderr.write("    at async createCodeAssistContentGenerator (/tmp/gemini/bundle.js:2:1)\\n");
process.exit(7);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_BINARY: binary } },
  );
  try {
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "not_authed");
    assert.equal(parsed.detail, "Error authenticating: FatalCancellationError: Authentication cancelled by user.");
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping not_authed reports API-key fallback metadata without exposing values", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-api-key-auth-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-api-key-auth-bin-"));
  const binary = path.join(binDir, "gemini-api-key-auth-error");
  writeFileSync(binary, `#!/usr/bin/env node
process.stderr.write("Error authenticating: FatalCancellationError: Authentication cancelled by user.\\n");
process.exit(7);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_BINARY: binary, GEMINI_API_KEY: "secret-test-value" } },
  );
  try {
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "not_authed");
    assert.deepEqual(parsed.allowed_env_credentials, ["GEMINI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_fallback");
    assert.deepEqual(parsed.auth_fallback, {
      from: "subscription_oauth",
      to: "api_key_env",
      reason: "not_authed",
    });
    assert.doesNotMatch(stdout, /secret-test-value/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping generic stdout mentioning authoring is not classified as auth", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-authoring-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-authoring-bin-"));
  const binary = path.join(binDir, "gemini-authoring-error");
  writeFileSync(binary, `#!/usr/bin/env node
process.stdout.write("authoring authority logging failed\\n");
process.exit(7);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_BINARY: binary } },
  );
  try {
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.ready, false);
    assert.match(parsed.next_action, /rerun setup/);
    assert.equal(parsed.exit_code, 7);
    assert.match(parsed.detail, /authoring authority logging failed/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});

test("gemini ping generic error includes exit_code", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-generic-cwd-"));
  const binDir = mkdtempSync(path.join(tmpdir(), "gemini-ping-generic-bin-"));
  const binary = path.join(binDir, "gemini-generic-error");
  writeFileSync(binary, `#!/usr/bin/env node
process.stdout.write("plain failure\\n");
process.exit(7);
`, "utf8");
  chmodSync(binary, 0o755);
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "gemini-3-flash-preview"],
    { cwd, env: { GEMINI_BINARY: binary } },
  );
  try {
    assert.equal(status, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.ready, false);
    assert.match(parsed.next_action, /rerun setup/);
    assert.equal(parsed.exit_code, 7);
    assert.match(parsed.detail, /plain failure/);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
    rmTree(binDir);
  }
});
