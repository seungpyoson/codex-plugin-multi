import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, realpathSync,
  writeFileSync, chmodSync, mkdirSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/gemini/scripts/gemini-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/gemini-mock.mjs");
const GEMINI_SESSION_ID = "22222222-3333-4444-9555-666666666666";
const RESUMED_GEMINI_SESSION_ID = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";
const GEMINI_SMOKE_POLL_TIMEOUT_MS = Number(process.env.GEMINI_SMOKE_POLL_TIMEOUT_MS ?? 5000);

function seedMinimalRepo(cwd) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
  spawnSync("bash", ["-c",
    "echo seed > seed.txt && git add seed.txt && " +
    "git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
}

function runCompanion(args, { cwd, env = {}, dataDir = mkdtempSync(path.join(tmpdir(), "gemini-smoke-data-")) } = {}) {
  const res = spawnSync("node", [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GEMINI_BINARY: MOCK,
      GEMINI_PLUGIN_DATA: dataDir,
      ...env,
    },
  });
  return { ...res, dataDir };
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
    "printf '{\"session_id\":\"22222222-3333-4444-9555-666666666666\",\"response\":\"spawned after corrupting index\"}\\n'",
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

test("gemini rescue background: launched event and terminal JobRecord", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-bg-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "background rescue task"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const launched = JSON.parse(stdout);
    assert.equal(launched.event, "launched");
    assert.equal(launched.target, "gemini");
    assert.equal(typeof launched.job_id, "string");
    assert.equal(Number.isInteger(launched.pid), true);

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
    assert.equal(meta.result, "Mock Gemini response.");
    assert.equal(meta.gemini_session_id, GEMINI_SESSION_ID);
    assert.equal("prompt" in meta, false, "full prompt must not appear on JobRecord");
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
    const runningDeadline = Date.now() + 3000;
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
    const deadline = Date.now() + 5000;
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
    // Two acceptable outcomes: signaled (signal landed) or no_pid_info
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
      assert.equal(cancel.status, "no_pid_info");
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
  } finally {
    rmTree(runRes.dataDir);
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
    const runDeadline = Date.now() + 5000;
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
    const runDeadline = Date.now() + 5000;
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
    rmTree(dataDir);
    rmTree(cwd);
  }
});

test("gemini continue foreground: resumes prior job session", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-continue-cwd-"));
  seedMinimalRepo(cwd);
  const first = runCompanion(
    ["run", "--mode=rescue", "--foreground", "--model", "gemini-3-flash-preview",
     "--cwd", cwd, "--", "initial rescue task"],
    { cwd },
  );
  try {
    assert.equal(first.status, 0, `exit ${first.status}: ${first.stderr}`);
    const prior = JSON.parse(first.stdout);
    assert.equal(prior.status, "completed");
    assert.equal(prior.gemini_session_id, GEMINI_SESSION_ID);

    const continued = runCompanion(
      ["continue", "--job", prior.job_id, "--foreground", "--cwd", cwd, "--", "continue rescue task"],
      { cwd, dataDir: first.dataDir },
    );
    assert.equal(continued.status, 0, `exit ${continued.status}: ${continued.stderr}`);
    const record = JSON.parse(continued.stdout);
    assert.equal(record.target, "gemini");
    assert.equal(record.status, "completed");
    assert.equal(record.parent_job_id, prior.job_id);
    assert.deepEqual(record.resume_chain, [prior.gemini_session_id]);
    assert.equal(record.gemini_session_id, RESUMED_GEMINI_SESSION_ID);

    const fx = readStdoutLog(first.dataDir, record.job_id);
    assert.equal(fx.t7_resume_id, prior.gemini_session_id);
    assert.equal(fx.t7_prompt_from_stdin, true, "Gemini continue prompt must arrive on stdin, not argv");
    assert.equal("prompt" in record, false, "full prompt must not appear on JobRecord");
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
      ["continue", "--job", prior.job_id, "--background", "--cwd", cwd, "--", "background continue task"],
      { cwd, dataDir: first.dataDir },
    );
    assert.equal(continued.status, 0, `exit ${continued.status}: ${continued.stderr}`);
    const launched = JSON.parse(continued.stdout);
    assert.equal(launched.event, "launched");
    assert.equal(launched.target, "gemini");
    assert.equal(launched.parent_job_id, prior.job_id);
    assert.equal(typeof launched.job_id, "string");
    assert.equal(Number.isInteger(launched.pid), true);

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
    assert.equal(meta.result, "Mock Gemini response.");
    assert.equal(meta.gemini_session_id, RESUMED_GEMINI_SESSION_ID);

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
    assert.equal(after.result, "Mock Gemini response.");
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

test("gemini review foreground: policy-first, stdin transport, /tmp cwd, scoped include dir", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-cwd-"));
  seedMinimalRepo(cwd);
  const neutralCwd = realpathSync(tmpdir());
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review: x=1"],
    { cwd, env: { GEMINI_MOCK_ASSERT_FILE: "seed.txt", GEMINI_MOCK_ASSERT_CWD: neutralCwd } },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.target, "gemini");
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Mock Gemini response.");
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
    assert.match(result.disclosure_note, /not spawned/i);
    assert.match(result.disclosure_note, /external provider/i);
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
    assert.equal(record.result, "spawned after corrupting index");
    assert.ok(record.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must be surfaced, got ${JSON.stringify(record.mutations)}`);
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

test("gemini status default hides inactive jobs and --all includes every state", async () => {
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
    assert.deepEqual(
      parsed.jobs.map((job) => job.status).sort(),
      ["completed", "failed", "running"],
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

test("gemini ping returns ok with the mock gemini binary", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-ping-cwd-"));
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["ping", "--model", "gemini-3-flash-preview"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.model, "gemini-3-flash-preview");
    assert.equal(parsed.session_id, GEMINI_SESSION_ID);
  } finally {
    rmTree(dataDir);
    rmTree(cwd);
  }
});
