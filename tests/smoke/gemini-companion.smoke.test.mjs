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
    "git -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
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
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(first.dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(first.dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini review foreground: policy-first, stdin transport, /tmp cwd, scoped include dir", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-review-cwd-"));
  seedMinimalRepo(cwd);
  const neutralCwd = realpathSync("/tmp");
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
    assert.notEqual(fx.t7_cwd, neutralCwd, "Gemini review must not use /tmp itself as the workspace root");
    assert.equal(fx.t7_cwd.startsWith(neutralCwd), true, `Gemini review must run from a neutral temp cwd under ${neutralCwd}; got ${fx.t7_cwd}`);
    assert.equal(existsSync(fx.t7_cwd), false, `neutral Gemini cwd must be cleaned after the run: ${fx.t7_cwd}`);
    assert.equal(fx.t7_include_dirs.includes(fx.t7_cwd), false, "neutral cwd must not be the scoped include directory");
    assert.equal(fx.t7_saw_file, true, `Gemini must receive scoped include dir containing seed.txt; got ${fx.t7_include_dirs}`);
    assert.equal(fx.t7_policy_loaded, true, "Gemini review must pass bundled read-only policy");
    assert.equal(fx.t7_sandbox, true, "Gemini review must pass the sandbox flag");
    assert.equal(fx.t7_skip_trust, true, "Gemini review must pass --skip-trust so plan approval is not downgraded");
    assert.equal(fx.t7_prompt_from_stdin, true, "Gemini prompt must arrive on stdin, not argv");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini review preserves result when pre-run mutation detection is unavailable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "gemini-mut-pre-cwd-"));
  seedMinimalRepo(cwd);
  writeFileSync(path.join(cwd, ".git", "index"), "corrupt index");
  const { stdout, stderr, status, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review"],
    { cwd },
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Mock Gemini response.");
    assert.ok(record.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must be surfaced, got ${JSON.stringify(record.mutations)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini review preserves pre-run mutation detection failure when target spawn fails", () => {
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
    assert.ok(record.mutations.some((m) => m.startsWith("mutation_detection_failed:")),
      `mutation detection failure must survive spawn failure, got ${JSON.stringify(record.mutations)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
    assert.equal(existsSync(marker), false, "target CLI marker proves Gemini binary was spawned");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("gemini status default includes queued, cancelled, stale, running, completed, and failed jobs", async () => {
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
      ["cancelled", "completed", "failed", "queued", "running", "stale"],
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
