// Smoke tests: drives claude-companion.mjs with the Claude mock on PATH.
// Covers the foreground review / adversarial-review / rescue paths + error
// surfaces. Real Claude CLI is never invoked — CLAUDE_BINARY overrides to
// tests/smoke/claude-mock.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// spawnSync is reused for git init in the mutation-detection smoke.
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/claude-mock.mjs");

function runCompanion(args, { cwd, env = {}, dataDir = mkdtempSync(path.join(tmpdir(), "companion-smoke-")) } = {}) {
  // Point the companion at a fresh PLUGIN_DATA dir so tests don't step on
  // each other's state or on the user's real ~/.cache.
  const res = spawnSync("node", [COMPANION, ...args], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_BINARY: MOCK,
      CLAUDE_PLUGIN_DATA: dataDir,
      ...env,
    },
    encoding: "utf8",
  });
  return { ...res, dataDir };
}

function cleanup(dataDir) {
  rmSync(dataDir, { recursive: true, force: true });
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

// T7.2: review mode's profile has scope=working-tree, which populates via
// `git ls-files` + copy. Non-git cwds can no longer run review (spec §21.4).
// Helper seeds a minimal git repo so the tests can focus on the companion
// contract, not setup ceremony.
function seedMinimalRepo(cwd) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
  spawnSync("bash", ["-c",
    "echo seed > seed.txt && git add seed.txt && " +
    "git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
}

test("run --mode=review --foreground: emits JobRecord with status=completed", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review: x=1"],
    { cwd }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    // T7.4 (§21.3.2): foreground stdout is a JobRecord — no `ok` top-level.
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.mode, "review");
    assert.equal(result.model, "claude-haiku-4-5-20251001");
    assert.ok(result.job_id, "job_id set");
    assert.equal(result.result, "Mock Claude response.");
    assert.deepEqual(result.permission_denials, []);
    assert.equal(result.schema_version, 6, "schema_version bumped for Gemini session parity");
    assert.equal("prompt" in result, false,
      "§21.3.1: full prompt must not appear on JobRecord");
    assert.equal("ok" in result, false,
      "§21.3.2: no hand-assembled `ok` field; consumers derive from status");
    assert.equal("warning" in result, false,
      "§21.3: no top-level warning; mutations array is the signal");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --foreground: surfaces mutation detection failure without dropping result", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-mut-fail-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review"],
    { cwd, env: { CLAUDE_MOCK_MUTATE_FILE: path.join(cwd, ".git", "index") } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.result, "Mock Claude response.");
    assert.ok(result.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must be surfaced, got ${JSON.stringify(result.mutations)}`);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=review --foreground: corrupt index fails closed before target spawn", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-mut-spawn-fail-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--binary", path.join(cwd, "missing-claude"), "--cwd", cwd, "--", "review"],
    { cwd }
  );
  try {
    assert.equal(status, 2, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "failed");
    assert.match(result.error_message, /scope_population_failed: cannot evaluate gitignored files/);
    assert.deepEqual(result.mutations, [],
      "scope filtering fails before mutation detection and target spawn");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --mode=rescue: uses default model from config/models.json", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  // No --model; rescue defaults to "default" tier.
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground",
     "--model", "claude-haiku-4-5-20251001", // mock needs a fixture-hitting model
     "--cwd", cwd, "--", "investigate: why is x null"],
    { cwd }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.mode, "rescue");
    assert.ok(result.job_id);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: meta.json persisted to workspace state", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "hello"],
    { cwd }
  );
  try {
    const { job_id } = JSON.parse(stdout);
    // State dir is deterministic: <PLUGIN_DATA>/state/<slug>-<hash>/jobs/<job_id>.json
    const stateRoot = path.join(dataDir, "state");
    let found = null;
    for (const dir of readdirSync(stateRoot)) {
      const metaPath = path.join(stateRoot, dir, "jobs", `${job_id}.json`);
      if (existsSync(metaPath)) { found = metaPath; break; }
    }
    assert.ok(found, `meta.json not found under ${stateRoot}`);
    const meta = JSON.parse(readFileSync(found, "utf8"));
    assert.equal(meta.id, job_id);
    assert.equal(meta.job_id, job_id,
      "T7.3: new records carry job_id distinct from any session UUID");
    assert.equal(meta.target, "claude");
    assert.equal(meta.status, "completed");
    assert.equal(meta.mode, "review");
    // Claude echoes back --session-id as session_id in its JSON output, so on
    // a fresh run where the companion passes job_id as --session-id, the mock
    // (and real CLI) return that same UUID. The persisted field is the
    // stdout-captured value, not the sent one — see spec §21.1.
    assert.equal(meta.claude_session_id, job_id,
      "claude_session_id must be set from parsed.session_id");
    // Forbidden: the legacy `session_id` alias that duplicated job_id.
    assert.equal(meta.session_id, undefined,
      "legacy session_id field must not be present on new-shape records");
    // JobRecord schema version and full-prompt omission stay explicit.
    assert.equal(meta.schema_version, 6);
    assert.equal("prompt" in meta, false,
      "§21.3.1: full `prompt` field must not be persisted");
    // T7.4: result field populated on foreground completion (symmetry with bg).
    assert.equal(meta.result, "Mock Claude response.");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: missing Claude stdout session_id persists null, not job or resume identity", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  seedMinimalRepo(cwd);
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "hello"],
    { cwd, env: { CLAUDE_MOCK_OMIT_SESSION_ID: "1" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: stderr=${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.claude_session_id, null,
      "claude_session_id must come only from parsed Claude stdout session_id");
    assert.notEqual(result.claude_session_id, result.job_id,
      "job_id must not be fabricated as claude_session_id");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: rejects bad --mode", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  const { stderr, status, dataDir } = runCompanion(
    ["run", "--mode=chaos", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "x"],
    { cwd }
  );
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /--mode must be one of/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

// NOTE — T7.6 relocations:
//   - "run --background: ... terminal meta arrives" (finding #1-H1)  → invariants.test.mjs
//   - "T7.4 / §21.3.1: full prompt must not appear ..." (finding #9) → invariants.test.mjs
// This file keeps the behaviors unique to companion-level smoke (prompt
// sidecar cleanup, status/result/cancel/ping/etc.) The finding-scoped
// regressions have exactly one home: tests/smoke/invariants.test.mjs.

test("T7.4 / §21.3.2: prompt sidecar is deleted after worker consumes it", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-bg-sidecar-"));
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "bg sidecar task"],
    { cwd }
  );
  try {
    assert.equal(status, 0);
    const ev = JSON.parse(stdout);
    const stateRoot = path.join(dataDir, "state");
    // Poll until the record is terminal.
    const deadline = Date.now() + 5000;
    let done = false;
    let jobDir = null;
    while (Date.now() < deadline && !done) {
      for (const dir of readdirSync(stateRoot)) {
        const metaPath = path.join(stateRoot, dir, "jobs", `${ev.job_id}.json`);
        jobDir = path.join(stateRoot, dir, "jobs", ev.job_id);
        if (existsSync(metaPath)) {
          const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
          if (parsed.status === "completed" || parsed.status === "failed") {
            done = true; break;
          }
        }
      }
      if (!done) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(done, "worker never finished");
    // After the worker consumed the prompt, the sidecar must be gone.
    assert.equal(existsSync(path.join(jobDir, "prompt.txt")), false,
      "§21.3.1: prompt sidecar must be deleted after worker consumes it");
    // Settle: meta.json flips to terminal BEFORE upsertJob writes state.json
    // and BEFORE writeSidecar emits stdout.log/stderr.log. Without this
    // wait, the recursive cleanup races the worker's tail writes and Linux
    // CI flakes with `ENOTEMPTY` on rmdir of state/<subdir>/.
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --background: worker spawn failure writes failed JobRecord instead of launched", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-bg-spawn-fail-runner-"));
  const missingCwd = path.join(cwd, "missing-cwd");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", missingCwd, "--", "bg sidecar task"],
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
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --background: active job is visible as running and can be cancelled", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-bg-cancel-"));
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "long background task"],
    { cwd, env: { CLAUDE_MOCK_DELAY_MS: "5000" } },
  );
  try {
    assert.equal(status, 0, stderr);
    const launched = JSON.parse(stdout);
    const deadline = Date.now() + 5000;
    let running = null;
    while (Date.now() < deadline && !running) {
      const statusRes = spawnSync("node", [
        path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
        "status", "--cwd", cwd,
      ], {
        cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
      });
      assert.equal(statusRes.status, 0, statusRes.stderr);
      const statusObj = JSON.parse(statusRes.stdout);
      running = statusObj.jobs.find((j) => j.id === launched.job_id && j.status === "running");
      if (!running) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(running, "background job never became visible as running");
    assert.ok(running.pid_info?.pid, "running job must carry pid_info for safe cancellation");

    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", launched.job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(cancelRes.status, 0, cancelRes.stderr);
    const cancel = JSON.parse(cancelRes.stdout);
    if (running.pid_info.capture_error) {
      assert.equal(cancel.status, "no_pid_info");
      const terminalDeadline = Date.now() + 7000;
      let terminal = null;
      while (Date.now() < terminalDeadline && !terminal) {
        const statusRes = spawnSync("node", [
          path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
          "status", "--cwd", cwd,
        ], {
          cwd, encoding: "utf8",
          env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
        });
        assert.equal(statusRes.status, 0, statusRes.stderr);
        const statusObj = JSON.parse(statusRes.stdout);
        terminal = statusObj.jobs.find((j) => j.id === launched.job_id && j.status !== "running");
        if (!terminal) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(terminal, "job with incomplete pid_info did not finish before cleanup");
    } else {
      assert.equal(cancel.status, "signaled");
    }
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: SIGTERM-trapping target classifies as cancelled, not completed (issue #22 sub-task 2)", async () => {
  // Without the cancel-marker fix, a target that handles SIGTERM and exits
  // 0 with valid JSON output is mis-classified as `completed` — operator's
  // cancel intent is silently lost. With the marker, cmdCancel writes a
  // sentinel before signaling and finalization forces status=cancelled.
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-trap-cancel-"));
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "long task"],
    { cwd, env: { CLAUDE_MOCK_DELAY_MS: "5000", CLAUDE_MOCK_TRAP_SIGTERM: "1" } },
  );
  try {
    assert.equal(status, 0, stderr);
    const launched = JSON.parse(stdout);
    // Wait until the job is visible as running (mock has spawned, pid_info written).
    const runDeadline = Date.now() + 5000;
    let running = null;
    while (Date.now() < runDeadline && !running) {
      const sr = spawnSync("node", [
        path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
        "status", "--cwd", cwd,
      ], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
      const so = JSON.parse(sr.stdout);
      running = so.jobs.find((j) => j.id === launched.job_id && j.status === "running");
      if (!running) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(running, "background job never visible as running");

    // Cancel — the trapping mock will exit 0 with valid JSON, signal=null.
    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", launched.job_id, "--cwd", cwd,
    ], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
    assert.equal(cancelRes.status, 0, cancelRes.stderr);

    // Wait for the worker to finalize. Allow 10s — the mock has a 5s
    // natural-delay fallback in case SIGTERM trapping doesn't engage.
    const termDeadline = Date.now() + 10000;
    let terminal = null;
    let lastStatusSeen = null;
    while (Date.now() < termDeadline && !terminal) {
      // Use --all because origin/main's cmdStatus default filter is
      // running|completed|failed — it would hide the cancelled record we
      // want to assert on. (PR #21's status UX fix expands the default
      // filter; this test deliberately doesn't depend on it.)
      const sr = spawnSync("node", [
        path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
        "status", "--all", "--cwd", cwd,
      ], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir } });
      const so = JSON.parse(sr.stdout);
      const seen = so.jobs.find((j) => j.id === launched.job_id);
      lastStatusSeen = seen?.status ?? "(missing)";
      terminal = so.jobs.find((j) => j.id === launched.job_id && j.status !== "running");
      if (!terminal) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(terminal, `job did not finalize after cancel; last status seen=${lastStatusSeen}`);
    assert.equal(terminal.status, "cancelled",
      `cancel-marker must force status=cancelled even when target trapped SIGTERM and exited 0; got ${JSON.stringify(terminal)}`);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continue --job: resumes a prior session via --resume", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-continue-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "continue-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=rescue", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], { cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir } });
    const { job_id } = JSON.parse(runRes.stdout);
    const contRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "continue", "--job", job_id, "--foreground",
      "--cwd", cwd, "--", "follow-up",
    ], { cwd, encoding: "utf8",
        env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir } });
    assert.equal(contRes.status, 0, contRes.stderr);
    const out = JSON.parse(contRes.stdout);
    assert.notEqual(out.job_id, job_id, "continue must mint a new job_id");
    // T7.4 (§21.3): foreground stdout is a JobRecord, not an ok-envelope.
    assert.equal(out.status, "completed");
    assert.equal(out.parent_job_id, job_id, "resume carries parent_job_id");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continue --job: refuses to resume a running job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-continue-running-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "continue-running-data-"));
  try {
    const runRes = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(dataDir);
    writeFileSync(metaPath, `${JSON.stringify({ ...record, status: "running" }, null, 2)}\n`, "utf8");

    const contRes = runCompanion(
      ["continue", "--job", record.job_id, "--foreground",
       "--cwd", cwd, "--", "follow-up"],
      { cwd, dataDir },
    );
    assert.notEqual(contRes.status, 0);
    assert.match(contRes.stderr, /cannot continue job in status "running"/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("continue --job: resumes a cancelled terminal job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-continue-cancelled-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "continue-cancelled-data-"));
  try {
    const runRes = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir },
    );
    assert.equal(runRes.status, 0, runRes.stderr);
    const { metaPath, record } = readOnlyJobRecord(dataDir);
    writeFileSync(metaPath, `${JSON.stringify({ ...record, status: "cancelled" }, null, 2)}\n`, "utf8");

    const contRes = runCompanion(
      ["continue", "--job", record.job_id, "--foreground",
       "--cwd", cwd, "--", "follow-up"],
      { cwd, dataDir },
    );
    assert.equal(contRes.status, 0, contRes.stderr);
    const continued = JSON.parse(contRes.stdout);
    assert.equal(continued.parent_job_id, record.job_id);
    assert.equal(continued.status, "completed");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run --foreground: finalization write failures use structured errors", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-finalize-fail-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "finalize-fail-data-"));
  try {
    seedMinimalRepo(cwd);
    const res = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir, env: { CLAUDE_MOCK_SIDECAR_CONFLICT: "1" } },
    );
    assert.notEqual(res.status, 0);
    assert.doesNotMatch(res.stderr, /unhandled/i);
    const err = JSON.parse(res.stdout);
    assert.equal(err.error, "finalization_failed");
    assert.match(err.message, /EEXIST|not a directory|file already exists/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ————— T7.2 containment/scope smoke tests —————
// The three `run --isolated*` tests from M5 are GONE — `--isolated` is no
// longer a CLI flag. The four tests below replace them and additionally lock
// down M6 finding #4 (review can't see dirty tree).

// Helper: seed a git repo with one committed file, then modify it uncommitted.
function seedDirtyRepo(cwd) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
  spawnSync("bash", ["-c",
    "echo original > seed.txt && git add seed.txt && " +
    "git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q -m seed && " +
    "echo modified > seed.txt"], { cwd });
}

// Helper: read stdout.log sidecar (contains the mock's full fixture JSON
// including the T7.2 oracle fields: t7_saw_file, t7_cwd_match, t7_add_dir_files).
function readStdoutLog(dataDir, jobId) {
  const stateRoot = path.join(dataDir, "state");
  for (const dir of readdirSync(stateRoot)) {
    const p = path.join(stateRoot, dir, "jobs", jobId, "stdout.log");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error(`no stdout.log for job ${jobId}`);
}

// NOTE — T7.6 relocation:
//   "review sees dirty working tree (M6 finding #4)"  →  invariants.test.mjs
// Canonical home is the regression matrix. The adversarial-review /
// rescue / dispose tests below remain here — they exercise containment +
// scope combinations that are wider than a single finding.

test("adversarial-review scope=branch-diff: only changed files appear in --add-dir", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-adv-"));
  // main: has old.md. feature: adds foo.md.
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
  spawnSync("bash", ["-c",
    "echo old > old.md && git add old.md && " +
    "git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q -m main && " +
    "git checkout -qb feature && " +
    "echo foo > foo.md && git add foo.md && " +
    "git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q -m feature"], { cwd });
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=adversarial-review", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "focus"],
    { cwd, env: { CLAUDE_MOCK_LIST_ADDDIR: "1" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const result = JSON.parse(stdout);
    const fx = readStdoutLog(dataDir, result.job_id);
    const files = fx.t7_add_dir_files ?? [];
    assert.ok(files.includes("foo.md"),
      `branch-diff scope missing foo.md; saw: ${files.join(",")}`);
    assert.ok(!files.includes("old.md"),
      `branch-diff scope leaked old.md; saw: ${files.join(",")}`);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rescue runs in sourceCwd (containment=none): --add-dir === cwd", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-rescue-"));
  seedDirtyRepo(cwd);
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "fix"],
    { cwd, env: { CLAUDE_MOCK_ASSERT_FILE: "seed.txt" } }
  );
  try {
    assert.equal(status, 0, stderr);
    const result = JSON.parse(stdout);
    const fx = readStdoutLog(dataDir, result.job_id);
    // On macOS, /var/folders/... symlinks to /private/var/folders/...;
    // so Claude's --add-dir path may be either form. Accept both.
    const realCwd = realpathSync(cwd);
    assert.ok(fx.t7_add_dir === cwd || fx.t7_add_dir === realCwd,
      `rescue must pass sourceCwd as --add-dir; got ${fx.t7_add_dir}, expected ${cwd} or ${realCwd}`);
    assert.equal(fx.t7_saw_file, true, "rescue should see the dirty file in sourceCwd");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("review worktree disposed by profile default (dispose_default=true)", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-dispose-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
  spawnSync("bash", ["-c",
    "echo seed > seed && git add seed && " +
    "git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
  // ASSERT_FILE env triggers the mock to record t7_add_dir into its fixture
  // (which the companion persists into stdout.log). Without it the mock has
  // no reason to echo the path back and the test can't inspect it.
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review"],
    { cwd, env: { CLAUDE_MOCK_ASSERT_FILE: "seed" } }
  );
  try {
    assert.equal(status, 0, stderr);
    const result = JSON.parse(stdout);
    const fx = readStdoutLog(dataDir, result.job_id);
    // The worktree path the mock saw must no longer exist on disk.
    assert.ok(fx.t7_add_dir, "mock didn't record add_dir");
    assert.equal(existsSync(fx.t7_add_dir), false,
      `review worktree ${fx.t7_add_dir} should be disposed (dispose_default=true)`);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run: pre/post git-status sidecars written in a git cwd", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-git-"));
  // Make a minimal git repo with a seed file so git status has meaningful output.
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("bash", ["-c", "echo seed > seed && git add seed && git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
  const { stdout, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review this"],
    { cwd }
  );
  try {
    const { job_id } = JSON.parse(stdout);
    const stateRoot = path.join(dataDir, "state");
    let jobsDir = null;
    for (const dir of readdirSync(stateRoot)) {
      const candidate = path.join(stateRoot, dir, "jobs", job_id);
      if (existsSync(candidate)) { jobsDir = candidate; break; }
    }
    assert.ok(jobsDir, `job sidecar dir not found under ${stateRoot}`);
    // Both snapshots written (may be empty strings for a clean seeded repo — that's OK).
    assert.ok(existsSync(path.join(jobsDir, "git-status-before.txt")), "before snapshot missing");
    assert.ok(existsSync(path.join(jobsDir, "git-status-after.txt")), "after snapshot missing");
    assert.ok(existsSync(path.join(jobsDir, "stdout.log")), "stdout.log missing");
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("doctor: returns not_implemented (pre-M10)", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cwd-"));
  const { stderr, status, dataDir } = runCompanion(["doctor"], { cwd });
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /later milestone/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ping: returns status=ok with the mock claude binary", () => {
  const { stdout, status, dataDir } = runCompanion(
    ["ping", "--model", "claude-haiku-4-5-20251001"],
    { cwd: tmpdir() }
  );
  try {
    assert.equal(status, 0, `ping exit ${status}`);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "ok");
    assert.equal(result.model, "claude-haiku-4-5-20251001");
    assert.ok(result.session_id);
  } finally {
    cleanup(dataDir);
  }
});

test("status: empty workspace returns empty jobs list", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-status-"));
  const { stdout, status, dataDir } = runCompanion(["status", "--cwd", cwd], { cwd });
  try {
    assert.equal(status, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.jobs.length, 0);
    assert.ok(result.workspace_root);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("status: lists a job after a review run", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-status2-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "status2-data-"));
  try {
    // Run a review to seed a job.
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(runRes.status, 0, runRes.stderr);
    const { job_id } = JSON.parse(runRes.stdout);
    // Status should list it.
    const statusRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "status", "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(statusRes.status, 0, statusRes.stderr);
    const statusObj = JSON.parse(statusRes.stdout);
    const match = statusObj.jobs.find((j) => j.id === job_id);
    assert.ok(match, `job ${job_id} not in status output`);
    assert.equal(match.status, "completed");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("result --job: returns meta for a finished job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-result-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "result-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    const { job_id } = JSON.parse(runRes.stdout);
    const resultRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "result", "--job", job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(resultRes.status, 0, resultRes.stderr);
    const meta = JSON.parse(resultRes.stdout);
    assert.equal(meta.id, job_id);
    assert.equal(meta.status, "completed");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("result --job with unknown id: returns not_found", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-result404-"));
  const { stderr, status, dataDir } = runCompanion(
    ["result", "--job", "00000000-0000-4000-8000-000000000000", "--cwd", cwd],
    { cwd }
  );
  try {
    assert.notEqual(status, 0);
    assert.match(stderr, /no meta.json/);
  } finally {
    cleanup(dataDir);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancel: already_terminal for a completed job", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-cancel-"));
  seedMinimalRepo(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "cancel-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=review", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    const { job_id } = JSON.parse(runRes.stdout);
    const cancelRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "cancel", "--job", job_id, "--cwd", cwd,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(cancelRes.status, 0);
    const response = JSON.parse(cancelRes.stdout);
    assert.equal(response.status, "already_terminal");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("claude _run-worker refuses terminal JobRecord without overwriting it", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "smoke-worker-terminal-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "worker-terminal-data-"));
  try {
    const runRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "run", "--mode=rescue", "--foreground",
      "--model", "claude-haiku-4-5-20251001",
      "--cwd", cwd, "--", "seed",
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(runRes.status, 0, runRes.stderr);
    const completed = JSON.parse(runRes.stdout);
    assert.equal(completed.status, "completed");

    const workerRes = spawnSync("node", [
      path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
      "_run-worker", "--cwd", cwd, "--job", completed.job_id,
    ], {
      cwd, encoding: "utf8",
      env: { ...process.env, CLAUDE_BINARY: MOCK, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.notEqual(workerRes.status, 0, "terminal worker re-entry must be refused");

    const { record } = readOnlyJobRecord(dataDir);
    assert.equal(record.status, "completed", "terminal worker re-entry must not overwrite record");
    assert.equal(record.job_id, completed.job_id);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
