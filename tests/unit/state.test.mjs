import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import {
  configureState,
  getStateConfig,
  saveState,
  resolveStateDir,
  resolveStateFile,
  loadState,
  updateState,
  upsertJob,
  listJobs,
  setConfig,
  getConfig,
  readJobFile,
  readJobFileById,
  resolveJobFile,
  resolveJobLogFile,
  writeJobFile,
  generateJobId,
} from "../../plugins/claude/scripts/lib/state.mjs";
import * as GeminiState from "../../plugins/gemini/scripts/lib/state.mjs";

// Node's test runner executes tests WITHIN a single file serially by default
// (subtests only run concurrently under an explicit `test.describe` with
// `concurrency: true`). These tests do not use that. However, to defend
// against future edits that introduce concurrency, we capture and restore the
// module-level CONFIG between tests.

let INITIAL_CONFIG;
let INITIAL_GEMINI_CONFIG;
before(() => {
  INITIAL_CONFIG = { ...getStateConfig() };
  INITIAL_GEMINI_CONFIG = { ...GeminiState.getStateConfig() };
});
afterEach(() => {
  configureState(INITIAL_CONFIG);
  GeminiState.configureState(INITIAL_GEMINI_CONFIG);
});

function freshStateDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "state-test-"));
  process.env["STATE_TEST_DATA"] = dir;
  configureState({
    pluginDataEnv: "STATE_TEST_DATA",
    fallbackStateRootDir: path.join(dir, "fallback"),
  });
  return dir;
}

function cleanup(dir) {
  delete process.env["STATE_TEST_DATA"];
  rmSync(dir, { recursive: true, force: true });
}

function freshGeminiStateDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "gemini-state-test-"));
  process.env["GEMINI_STATE_TEST_DATA"] = dir;
  GeminiState.configureState({
    pluginDataEnv: "GEMINI_STATE_TEST_DATA",
    fallbackStateRootDir: path.join(dir, "fallback"),
  });
  return dir;
}

function cleanupGemini(dir) {
  delete process.env["GEMINI_STATE_TEST_DATA"];
  rmSync(dir, { recursive: true, force: true });
}

function findDeadPid() {
  for (let pid = 999999; pid < 1009999; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e?.code === "ESRCH") return pid;
    }
  }
  return 99999999;
}

test("configureState: getStateConfig returns set values", () => {
  const scratch = path.join(tmpdir(), "foo-fb");
  configureState({
    pluginDataEnv: "FOO_ENV",
    fallbackStateRootDir: scratch,
    sessionIdEnv: "FOO_SESS",
  });
  const c = getStateConfig();
  assert.equal(c.pluginDataEnv, "FOO_ENV");
  assert.equal(c.fallbackStateRootDir, scratch);
  assert.equal(c.sessionIdEnv, "FOO_SESS");
});

test("resolveStateDir: uses pluginDataEnv when set", () => {
  const dir = freshStateDir();
  try {
    const stateDir = resolveStateDir(dir);
    // Should be under <dir>/state/<slug>-<hash>
    assert.ok(stateDir.startsWith(path.join(dir, "state") + path.sep), `got ${stateDir}`);
  } finally {
    cleanup(dir);
  }
});

test("resolveStateDir: falls back when pluginDataEnv unset", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "state-nfb-"));
  const fallback = path.join(dir, "fb");
  try {
    configureState({
      pluginDataEnv: "UNLIKELY_ENV_NAME_FOR_TEST_" + Date.now(),
      fallbackStateRootDir: fallback,
    });
    const stateDir = resolveStateDir(dir);
    assert.ok(stateDir.startsWith(fallback + path.sep), `got ${stateDir}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadState: returns default when file absent", () => {
  const dir = freshStateDir();
  try {
    const s = loadState(dir);
    assert.equal(s.version, 1);
    assert.deepEqual(s.jobs, []);
    assert.equal(s.config.stopReviewGate, false);
  } finally {
    cleanup(dir);
  }
});

test("upsertJob: adds new job, then updates existing", () => {
  const dir = freshStateDir();
  try {
    upsertJob(dir, { id: "job-1", status: "running" });
    let jobs = listJobs(dir);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "running");
    upsertJob(dir, { id: "job-1", status: "completed" });
    jobs = listJobs(dir);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "completed");
  } finally {
    cleanup(dir);
  }
});

test("setConfig/getConfig: round trip", () => {
  const dir = freshStateDir();
  try {
    setConfig(dir, "stopReviewGate", true);
    assert.equal(getConfig(dir).stopReviewGate, true);
  } finally {
    cleanup(dir);
  }
});

// Security regression: path traversal via unsafe jobId must be rejected
// before any filesystem path is built. Audit gate-1 finding.
test("resolveJobFile: rejects traversal in jobId", () => {
  const dir = freshStateDir();
  try {
    assert.throws(() => resolveJobFile(dir, "../evil"), /Unsafe jobId/);
    assert.throws(() => resolveJobFile(dir, "a/b"), /Unsafe jobId/);
    assert.throws(() => resolveJobFile(dir, ""), /Unsafe jobId/);
  } finally {
    cleanup(dir);
  }
});

test("resolveJobLogFile: rejects traversal in jobId", () => {
  const dir = freshStateDir();
  try {
    assert.throws(() => resolveJobLogFile(dir, "../../etc/passwd"), /Unsafe jobId/);
  } finally {
    cleanup(dir);
  }
});

test("writeJobFile: rejects traversal in jobId", () => {
  const dir = freshStateDir();
  try {
    assert.throws(() => writeJobFile(dir, "..", { x: 1 }), /Unsafe jobId/);
  } finally {
    cleanup(dir);
  }
});

test("writeJobFile: writes through a sibling tmp file then renames", () => {
  const dir = freshStateDir();
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  const writes = [];
  const renames = [];
  try {
    fs.writeFileSync = function patchedWrite(filePath, ...args) {
      writes.push(String(filePath));
      return originalWrite.call(this, filePath, ...args);
    };
    fs.renameSync = function patchedRename(from, to) {
      renames.push({ from: String(from), to: String(to) });
      return originalRename.call(this, from, to);
    };

    const jobFile = writeJobFile(dir, "job-atomic", { ok: true });

    assert.equal(writes.includes(jobFile), false,
      "writeJobFile must not write partial JSON directly to the final job file");
    assert.equal(renames.length, 1, `expected one rename; got ${JSON.stringify(renames)}`);
    assert.equal(renames[0].to, jobFile);
    assert.ok(renames[0].from.startsWith(`${jobFile}.`), `tmp file should be sibling of final file; got ${renames[0].from}`);
    assert.ok(renames[0].from.endsWith(".tmp"), `tmp file should end in .tmp; got ${renames[0].from}`);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.renameSync = originalRename;
    cleanup(dir);
  }
});

test("safe jobIds accepted: UUID v4 and generateJobId shape", () => {
  const dir = freshStateDir();
  try {
    // UUID v4
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    assert.ok(resolveJobFile(dir, uuid));
    // upstream generateJobId shape: job-<base36>-<rand>
    assert.ok(resolveJobFile(dir, "job-abc123-def456"));
  } finally {
    cleanup(dir);
  }
});

test("resolveJobFile: rejects absolute path as jobId", () => {
  const dir = freshStateDir();
  try {
    assert.throws(() => resolveJobFile(dir, "/etc/passwd"), /Unsafe jobId/);
    assert.throws(() => resolveJobFile(dir, "/absolute/path"), /Unsafe jobId/);
  } finally {
    cleanup(dir);
  }
});

test("resolveJobFile: rejects Windows backslash separators", () => {
  const dir = freshStateDir();
  try {
    assert.throws(() => resolveJobFile(dir, "a\\b"), /Unsafe jobId/);
    assert.throws(() => resolveJobFile(dir, "..\\evil"), /Unsafe jobId/);
  } finally {
    cleanup(dir);
  }
});

test("loadState: malformed, non-object, and non-array jobs fall back safely", () => {
  const dir = freshStateDir();
  try {
    fs.mkdirSync(path.dirname(resolveStateFile(dir)), { recursive: true });
    for (const body of ["not json", "null", "[]", "{\"jobs\":\"bad\",\"config\":{\"stopReviewGate\":true}}"]) {
      fs.writeFileSync(resolveStateFile(dir), body, "utf8");
      const state = loadState(dir);
      assert.equal(state.version, 1);
      assert.deepEqual(state.jobs, []);
      assert.equal(typeof state.config.stopReviewGate, "boolean");
    }
  } finally {
    cleanup(dir);
  }
});

test("saveState: prunes newest jobs and removes stale job files/logs inside jobs dir", () => {
  const dir = freshStateDir();
  try {
    const staleLog = resolveJobLogFile(dir, "old-job");
    fs.writeFileSync(staleLog, "old log", "utf8");
    writeJobFile(dir, "old-job", { id: "old-job" });
    saveState(dir, { jobs: [{ id: "old-job", updatedAt: "2000-01-01T00:00:00.000Z", logFile: staleLog }] });

    const manyJobs = Array.from({ length: 55 }, (_, index) => ({
      id: `job-${String(index).padStart(2, "0")}`,
      updatedAt: `2026-04-24T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    saveState(dir, { jobs: manyJobs });

    const jobs = listJobs(dir);
    assert.equal(jobs.length, 50);
    assert.equal(jobs[0].id, "job-54");
    assert.equal(fs.existsSync(resolveJobFile(dir, "old-job")), false);
    assert.equal(fs.existsSync(staleLog), false);
  } finally {
    cleanup(dir);
  }
});

test("saveState: ignores unsafe stale ids and out-of-scope or directory logs", () => {
  const dir = freshStateDir();
  try {
    const outsideLog = path.join(dir, "outside.log");
    const directoryLog = resolveJobLogFile(dir, "dir-log");
    fs.mkdirSync(directoryLog);
    fs.writeFileSync(outsideLog, "outside", "utf8");
    saveState(dir, {
      jobs: [
        { id: "../unsafe", updatedAt: "2000-01-01T00:00:00.000Z", logFile: outsideLog },
        { id: "dir-log", updatedAt: "2000-01-01T00:00:01.000Z", logFile: directoryLog },
      ],
    });
    saveState(dir, { jobs: [] });

    assert.equal(fs.existsSync(outsideLog), true);
    assert.equal(fs.existsSync(directoryLog), true);
  } finally {
    cleanup(dir);
  }
});

test("writeJobFile: removes sibling tmp file when final rename fails", () => {
  const dir = freshStateDir();
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = function patchedRename() {
      throw new Error("rename failed");
    };
    assert.throws(() => writeJobFile(dir, "job-rename-fail", { ok: true }), /rename failed/);
    const jobsDir = path.dirname(resolveJobFile(dir, "job-rename-fail"));
    const leftovers = fs.readdirSync(jobsDir).filter((name) => name.includes("job-rename-fail") && name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.renameSync = originalRename;
    cleanup(dir);
  }
});

test("updateState: rejects async mutators before saving", () => {
  const dir = freshStateDir();
  try {
    assert.throws(
      () => updateState(dir, () => Promise.resolve()),
      /synchronous/,
    );
    assert.deepEqual(listJobs(dir), []);
  } finally {
    cleanup(dir);
  }
});

test("readJobFile: validates raw paths and readJobFileById round trips safely", () => {
  const dir = freshStateDir();
  try {
    writeJobFile(dir, "job-read", { id: "job-read", ok: true });
    assert.deepEqual(readJobFileById(dir, "job-read"), { id: "job-read", ok: true });
    assert.deepEqual(readJobFile(resolveJobFile(dir, "job-read")), { id: "job-read", ok: true });
    assert.throws(() => readJobFile(path.join(tmpdir(), "outside-job.json")), /outside known state roots/);
    assert.throws(() => readJobFile(""), /non-empty string/);
  } finally {
    cleanup(dir);
  }
});

test("generateJobId: emits safe prefixed IDs", () => {
  const id = generateJobId("custom");
  assert.match(id, /^custom-[a-z0-9]+-[a-z0-9]+$/);
});

test("gemini state: plugin data, config, jobs, and job files round trip", () => {
  const dir = freshGeminiStateDir();
  try {
    const stateDir = GeminiState.resolveStateDir(dir);
    assert.ok(stateDir.startsWith(path.join(dir, "state") + path.sep), `got ${stateDir}`);
    GeminiState.setConfig(dir, "stopReviewGate", true);
    GeminiState.upsertJob(dir, { id: "gemini-job", status: "running" });
    const jobFile = GeminiState.writeJobFile(dir, "gemini-job", { id: "gemini-job", target: "gemini" });

    assert.equal(GeminiState.getConfig(dir).stopReviewGate, true);
    assert.equal(GeminiState.listJobs(dir)[0].status, "running");
    assert.deepEqual(GeminiState.readJobFile(jobFile), { id: "gemini-job", target: "gemini" });
    assert.deepEqual(GeminiState.readJobFileById(dir, "gemini-job"), { id: "gemini-job", target: "gemini" });
    assert.throws(() => GeminiState.resolveJobFile(dir, "../bad"), /Unsafe jobId/);
  } finally {
    cleanupGemini(dir);
  }
});

test("gemini state: malformed state, prune, and async guards mirror Claude", () => {
  const dir = freshGeminiStateDir();
  try {
    fs.mkdirSync(path.dirname(GeminiState.resolveStateFile(dir)), { recursive: true });
    fs.writeFileSync(GeminiState.resolveStateFile(dir), "[]", "utf8");
    assert.deepEqual(GeminiState.loadState(dir).jobs, []);

    assert.throws(() => GeminiState.updateState(dir, () => Promise.resolve()), /synchronous/);

    const staleLog = GeminiState.resolveJobLogFile(dir, "old-gemini");
    fs.writeFileSync(staleLog, "log", "utf8");
    GeminiState.writeJobFile(dir, "old-gemini", { id: "old-gemini" });
    GeminiState.saveState(dir, { jobs: [{ id: "old-gemini", updatedAt: "2000-01-01T00:00:00.000Z", logFile: staleLog }] });
    GeminiState.saveState(dir, { jobs: [] });
    assert.equal(fs.existsSync(staleLog), false);
    assert.equal(fs.existsSync(GeminiState.resolveJobFile(dir, "old-gemini")), false);
  } finally {
    cleanupGemini(dir);
  }
});

test("gemini state: fallback root, malformed variants, and config defaults", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gemini-state-fallback-"));
  const fallback = path.join(dir, "fb");
  try {
    GeminiState.configureState({
      pluginDataEnv: "UNLIKELY_GEMINI_ENV_" + Date.now(),
      fallbackStateRootDir: fallback,
    });
    assert.ok(GeminiState.resolveStateDir(dir).startsWith(fallback + path.sep));
    assert.equal(GeminiState.loadState(dir).config.stopReviewGate, false);

    fs.mkdirSync(path.dirname(GeminiState.resolveStateFile(dir)), { recursive: true });
    for (const body of ["not json", "null", "[]", "{\"jobs\":\"bad\",\"config\":{\"stopReviewGate\":true}}"]) {
      fs.writeFileSync(GeminiState.resolveStateFile(dir), body, "utf8");
      const state = GeminiState.loadState(dir);
      assert.equal(state.version, 1);
      assert.deepEqual(state.jobs, []);
      assert.equal(typeof state.config.stopReviewGate, "boolean");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gemini state: job id validation, raw read validation, and generated ids", () => {
  const dir = freshGeminiStateDir();
  try {
    assert.throws(() => GeminiState.resolveJobFile(dir, "/etc/passwd"), /Unsafe jobId/);
    assert.throws(() => GeminiState.resolveJobFile(dir, "a\\b"), /Unsafe jobId/);
    assert.throws(() => GeminiState.resolveJobLogFile(dir, "../../bad"), /Unsafe jobId/);
    assert.throws(() => GeminiState.writeJobFile(dir, "..", { ok: true }), /Unsafe jobId/);

    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    assert.ok(GeminiState.resolveJobFile(dir, uuid));
    const generated = GeminiState.generateJobId("gemini");
    assert.match(generated, /^gemini-[a-z0-9]+-[a-z0-9]+$/);
    assert.ok(GeminiState.resolveJobFile(dir, generated));

    GeminiState.writeJobFile(dir, "gemini-read", { id: "gemini-read", ok: true });
    assert.deepEqual(GeminiState.readJobFileById(dir, "gemini-read"), { id: "gemini-read", ok: true });
    assert.throws(() => GeminiState.readJobFile(path.join(tmpdir(), "outside-gemini-job.json")), /outside known state roots/);
    assert.throws(() => GeminiState.readJobFile(""), /non-empty string/);
  } finally {
    cleanupGemini(dir);
  }
});

test("gemini state: unsafe stale ids, directory logs, and rename cleanup are guarded", () => {
  const dir = freshGeminiStateDir();
  const originalRename = fs.renameSync;
  try {
    const outsideLog = path.join(dir, "outside.log");
    const directoryLog = GeminiState.resolveJobLogFile(dir, "gemini-dir-log");
    fs.writeFileSync(outsideLog, "outside", "utf8");
    fs.mkdirSync(directoryLog);
    GeminiState.saveState(dir, {
      jobs: [
        { id: "../unsafe", updatedAt: "2000-01-01T00:00:00.000Z", logFile: outsideLog },
        { id: "gemini-dir-log", updatedAt: "2000-01-01T00:00:01.000Z", logFile: directoryLog },
      ],
    });
    GeminiState.saveState(dir, { jobs: [] });
    assert.equal(fs.existsSync(outsideLog), true);
    assert.equal(fs.existsSync(directoryLog), true);

    fs.renameSync = function patchedRename() {
      throw new Error("gemini rename failed");
    };
    assert.throws(
      () => GeminiState.writeJobFile(dir, "gemini-rename-fail", { ok: true }),
      /gemini rename failed/,
    );
    fs.renameSync = originalRename;
    const jobsDir = path.dirname(GeminiState.resolveJobFile(dir, "gemini-rename-fail"));
    const leftovers = fs.readdirSync(jobsDir).filter((name) => (
      name.includes("gemini-rename-fail") && name.endsWith(".tmp")
    ));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.renameSync = originalRename;
    cleanupGemini(dir);
  }
});

for (const [target, state, fresh, cleanupTarget] of [
  ["claude", {
    configureState,
    saveState,
    updateState,
    upsertJob,
    loadState,
    listJobs,
    resolveStateDir,
    resolveStateFile,
    resolveJobFile,
    resolveJobLogFile,
    writeJobFile,
    readJobFile,
    readJobFileById,
  }, freshStateDir, cleanup],
  ["gemini", GeminiState, freshGeminiStateDir, cleanupGemini],
]) {
  test(`${target} state: retained jobs, same timestamps, missing stale files, and null jobs`, () => {
    const dir = fresh();
    try {
      state.writeJobFile(dir, "keep-job", { id: "keep-job" });
      state.writeJobFile(dir, "drop-job", { id: "drop-job" });
      const missingLog = state.resolveJobLogFile(dir, "missing-log");
      state.saveState(dir, {
        config: null,
        jobs: [
          { id: "keep-job", updatedAt: "2026-04-24T00:00:00.000Z", logFile: null },
          { id: "drop-job", updatedAt: "2026-04-24T00:00:00.000Z", logFile: missingLog },
        ],
      });
      state.saveState(dir, {
        jobs: [
          { id: "keep-job", updatedAt: "2026-04-24T00:00:00.000Z", logFile: null },
        ],
      });
      assert.equal(fs.existsSync(state.resolveJobFile(dir, "keep-job")), true);
      assert.equal(fs.existsSync(state.resolveJobFile(dir, "drop-job")), false);
      assert.deepEqual(state.listJobs(dir).map((job) => job.id), ["keep-job"]);

      state.saveState(dir, { jobs: null });
      assert.deepEqual(state.listJobs(dir), []);
    } finally {
      cleanupTarget(dir);
    }
  });

  test(`${target} state: stale saves preserve active jobs from latest state`, () => {
    const dir = fresh();
    try {
      state.writeJobFile(dir, "stale-job", { id: "stale-job" });
      state.saveState(dir, {
        jobs: [
          { id: "stale-job", status: "completed", updatedAt: "2026-04-24T00:00:00.000Z" },
        ],
      });
      const staleSnapshot = state.loadState(dir);

      state.writeJobFile(dir, "active-job", { id: "active-job", status: "running" });
      state.upsertJob(dir, {
        id: "active-job",
        status: "running",
        updatedAt: "2026-04-24T00:00:01.000Z",
      });

      state.saveState(dir, staleSnapshot);

      assert.equal(fs.existsSync(state.resolveJobFile(dir, "active-job")), true);
      assert.equal(state.listJobs(dir).some((job) => job.id === "active-job"), true);
    } finally {
      cleanupTarget(dir);
    }
  });

  test(`${target} state: pruning never evicts queued or running jobs`, () => {
    const dir = fresh();
    try {
      const terminalJobs = Array.from({ length: 55 }, (_, index) => ({
        id: `terminal-${String(index).padStart(2, "0")}`,
        status: "completed",
        updatedAt: `2026-04-24T00:00:${String(index).padStart(2, "0")}.000Z`,
      }));
      state.saveState(dir, {
        jobs: [
          ...terminalJobs,
          { id: "queued-job", status: "queued", updatedAt: "2000-01-01T00:00:00.000Z" },
          { id: "running-job", status: "running", updatedAt: "2000-01-01T00:00:01.000Z" },
        ],
      });

      const ids = state.listJobs(dir).map((job) => job.id);
      assert.equal(ids.includes("queued-job"), true);
      assert.equal(ids.includes("running-job"), true);
      assert.equal(ids.length, 52);
    } finally {
      cleanupTarget(dir);
    }
  });

  test(`${target} state: stale lock directories are reclaimed`, () => {
    const dir = fresh();
    try {
      state.writeJobFile(dir, "seed-job", { id: "seed-job" });
      const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
      fs.mkdirSync(lockDir);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lockDir, old, old);

      state.upsertJob(dir, { id: "after-stale-lock", status: "completed" });

      assert.equal(state.listJobs(dir).some((job) => job.id === "after-stale-lock"), true);
      assert.equal(fs.existsSync(lockDir), false);
    } finally {
      cleanupTarget(dir);
    }
  });

  test(`${target} state: lock directories owned by dead same-host processes are reclaimed`, () => {
    const dir = fresh();
    try {
      state.writeJobFile(dir, "seed-job", { id: "seed-job" });
      const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
        pid: findDeadPid(),
        hostname: hostname(),
        startedAt: new Date().toISOString(),
      })}\n`, "utf8");

      state.upsertJob(dir, { id: "after-dead-lock", status: "completed" });

      assert.equal(state.listJobs(dir).some((job) => job.id === "after-dead-lock"), true);
      assert.equal(fs.existsSync(lockDir), false);
    } finally {
      cleanupTarget(dir);
    }
  });

  test(`${target} state: live locks time out without stale reclaim`, () => {
    const dir = fresh();
    const realNow = Date.now;
    try {
      state.writeJobFile(dir, "seed-job", { id: "seed-job" });
      const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date(realNow() + 600_000).toISOString(),
      })}\n`, "utf8");

      let calls = 0;
      Date.now = () => {
        calls += 1;
        return realNow() + (calls >= 4 ? 6000 : 0);
      };

      assert.throws(
        () => state.upsertJob(dir, { id: "blocked-by-live-lock", status: "completed" }),
        /state_lock_timeout/,
      );
      assert.equal(fs.existsSync(lockDir), true);
    } finally {
      Date.now = realNow;
      cleanupTarget(dir);
    }
  });

  test(`${target} state: live old same-host lock is not reclaimed by age`, () => {
    // Regression: tryReclaimStaleLock used to steal a same-host lock as long
    // as it was older than STATE_LOCK_STALE_MS, even when the owning pid was
    // still alive. That allowed two writers to "hold" the lock simultaneously
    // and the slower one's write to overwrite the other's. Reclaim must now
    // refuse a live same-host owner regardless of age.
    const dir = fresh();
    try {
      state.configureState({ lockTimeoutMs: 200, lockStaleMs: 100 });
      state.writeJobFile(dir, "seed-job", { id: "seed-job" });
      const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        token: "live-owner-token",
      })}\n`, "utf8");

      assert.throws(
        () => state.upsertJob(dir, { id: "writer-b", status: "completed" }),
        /state_lock_timeout/,
      );
      assert.equal(fs.existsSync(lockDir), true,
        "live same-host lock must remain intact even when older than the stale window");
      assert.equal(
        state.listJobs(dir).some((job) => job.id === "writer-b"), false,
        "writer B must not be able to commit while writer A's live lock is still held",
      );
    } finally {
      cleanupTarget(dir);
    }
  });

  test(`${target} state: stale reclaim aborts if lock owner changes before rename`, () => {
    // Regression: two reclaimers can both inspect the same stale lock. If one
    // reclaims and recreates a live lock before the other reaches renameSync,
    // the second must not delete the live lock and enter its own critical
    // section. Re-validate owner.json after rename before deleting the orphan.
    const dir = fresh();
    const originalRename = fs.renameSync;
    try {
      state.configureState({ lockTimeoutMs: 200, lockStaleMs: 100 });
      state.writeJobFile(dir, "seed-job", { id: "seed-job" });
      const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
        pid: findDeadPid(),
        hostname: hostname(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        token: "dead-owner-token",
      })}\n`, "utf8");

      let injected = false;
      fs.renameSync = function patchedRename(from, to) {
        if (!injected && from === lockDir && String(to).includes(".orphaned-")) {
          injected = true;
          fs.rmSync(lockDir, { recursive: true, force: true });
          fs.mkdirSync(lockDir);
          fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            startedAt: new Date().toISOString(),
            token: "live-replacement-token",
          })}\n`, "utf8");
        }
        return originalRename.apply(this, arguments);
      };

      assert.throws(
        () => state.upsertJob(dir, { id: "writer-b", status: "completed" }),
        /state_lock_timeout/,
      );
      fs.renameSync = originalRename;

      const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
      assert.equal(owner.token, "live-replacement-token",
        "reclaim must restore the live lock it found at rename time");
      assert.equal(
        state.listJobs(dir).some((job) => job.id === "writer-b"), false,
        "writer B must not commit after racing with a replacement live lock",
      );
    } finally {
      fs.renameSync = originalRename;
      cleanupTarget(dir);
    }
  });

  test(`${target} state: third writer cannot acquire while reclaim restores a changed owner`, () => {
    // Regression for the residual restore window: after a reclaimer moves a
    // live replacement lock to an orphan and detects owner mismatch, lockDir
    // is momentarily absent while it renames the orphan back. A third writer
    // must not be able to acquire in that gap.
    const dir = fresh();
    const originalRename = fs.renameSync;
    try {
      state.configureState({ lockTimeoutMs: 200, lockStaleMs: 100 });
      state.writeJobFile(dir, "seed-job", { id: "seed-job" });
      const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
        pid: findDeadPid(),
        hostname: hostname(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        token: "dead-owner-token",
      })}\n`, "utf8");

      let injectedReplacement = false;
      let restoreFrom = null;
      let thirdWriterAttempted = false;
      let thirdWriterEntered = false;
      fs.renameSync = function patchedRename(from, to) {
        if (!injectedReplacement && from === lockDir && String(to).includes(".orphaned-")) {
          injectedReplacement = true;
          fs.rmSync(lockDir, { recursive: true, force: true });
          fs.mkdirSync(lockDir);
          fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            startedAt: new Date().toISOString(),
            token: "live-replacement-token",
          })}\n`, "utf8");
          const result = originalRename.apply(this, arguments);
          restoreFrom = to;
          return result;
        }
        if (injectedReplacement && from === restoreFrom && to === lockDir) {
          thirdWriterAttempted = true;
          try {
            state.upsertJob(dir, { id: "writer-c", status: "completed" });
            thirdWriterEntered = true;
          } catch (e) {
            assert.match(e.message, /state_lock_timeout/);
          }
        }
        return originalRename.apply(this, arguments);
      };

      assert.throws(
        () => state.upsertJob(dir, { id: "writer-b", status: "completed" }),
        /state_lock_timeout/,
      );
      assert.equal(thirdWriterAttempted, true,
        "test must exercise the restore window");
      assert.equal(thirdWriterEntered, false,
        "writer C must not acquire while a changed live lock is being restored");
      assert.equal(
        state.listJobs(dir).some((job) => job.id === "writer-c"),
        false,
        "writer C must not commit during the restore window",
      );
    } finally {
      fs.renameSync = originalRename;
      cleanupTarget(dir);
    }
  });

  test(`${target} state: lock owner read errors fail closed`, () => {
    const dir = fresh();
    const originalReadFile = fs.readFileSync;
    try {
      state.configureState({ lockTimeoutMs: 200, lockStaleMs: 100 });
      state.writeJobFile(dir, "seed-job", { id: "seed-job" });
      const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
      const ownerPath = path.join(lockDir, "owner.json");
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, `${JSON.stringify({
        pid: findDeadPid(),
        hostname: hostname(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        token: "unreadable-owner-token",
      })}\n`, "utf8");

      fs.readFileSync = function patchedReadFile(file, ...args) {
        if (path.resolve(String(file)) === ownerPath) {
          const err = new Error("owner read denied");
          err.code = "EACCES";
          throw err;
        }
        return originalReadFile.apply(this, [file, ...args]);
      };

      assert.throws(
        () => state.upsertJob(dir, { id: "blocked-by-owner-read-error", status: "completed" }),
        /state_lock_timeout/,
      );
    } finally {
      fs.readFileSync = originalReadFile;
      cleanupTarget(dir);
    }
  });

  test(`${target} state: release closure preserves a lock owned by a different token`, () => {
    // Regression: the release closure used to fs.rmSync(lockDir, ...) without
    // proving ownership. If a recovery path ever (mistakenly) reclaimed our
    // lock and a new writer took it, our release would silently delete the
    // new writer's lock, opening a second race window. Release must now
    // verify the on-disk owner token still matches before deleting.
    const dir = fresh();
    try {
      state.updateState(dir, (currentState) => {
        const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
        // Simulate another writer stealing the lock (this should never happen
        // with the live-owner guard above, but the release closure must still
        // not blindly delete what it doesn't own).
        fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
          token: "different-writer-token",
        })}\n`, "utf8");
        currentState.jobs.push({ id: "race-test", status: "completed" });
      });

      const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
      assert.equal(fs.existsSync(lockDir), true,
        "release closure must leave a lock owned by a different token in place");
    } finally {
      cleanupTarget(dir);
    }
  });

  test(`${target} state: missing/corrupt owner metadata is reclaimed only when too old`, () => {
    const dir = fresh();
    try {
      // Tight timeout, conservative stale window: a young corrupt-owner lock
      // must time out (no reclaim) within ~250ms even though the stale window
      // is much higher than the timeout.
      state.configureState({ lockTimeoutMs: 250, lockStaleMs: 60_000 });
      state.writeJobFile(dir, "seed-job", { id: "seed-job" });
      const lockDir = path.join(state.resolveStateDir(dir), ".state.lock");
      fs.mkdirSync(lockDir);
      // Corrupt owner.json with no parseable pid/hostname. Without an owner
      // we fall through to age-based reclaim, which must keep its hands off
      // a young dir (mtime ≈ now).
      fs.writeFileSync(path.join(lockDir, "owner.json"), "not json", "utf8");
      assert.throws(
        () => state.upsertJob(dir, { id: "blocked-by-corrupt-owner", status: "completed" }),
        /state_lock_timeout/,
      );
      assert.equal(fs.existsSync(lockDir), true,
        "corrupt-owner lock that is still young must not be reclaimed");

      // Backdate the dir well past the stale window; reclaim must succeed.
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lockDir, old, old);
      state.upsertJob(dir, { id: "after-corrupt-owner-stale", status: "completed" });
      assert.equal(
        state.listJobs(dir).some((job) => job.id === "after-corrupt-owner-stale"), true,
        "missing/corrupt owner metadata must remain age-reclaimable when too old",
      );
    } finally {
      cleanupTarget(dir);
    }
  });

  test(`${target} state: reentrant lock attempts fail fast`, () => {
    const dir = fresh();
    try {
      const started = Date.now();
      assert.throws(
        () => state.updateState(dir, () => {
          state.saveState(dir, { jobs: [] });
        }),
        /state_lock_reentrant/,
      );
      assert.ok(Date.now() - started < 1000, "reentrant calls must not spin until lock timeout");
    } finally {
      cleanupTarget(dir);
    }
  });

  test(`${target} state: fallback raw reads and saveState tmp cleanup on rename failure`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), `${target}-state-branch-`));
    const fallback = path.join(dir, "fallback");
    const originalRename = fs.renameSync;
    try {
      state.configureState({
        pluginDataEnv: `NO_${target.toUpperCase()}_PLUGIN_DATA_${Date.now()}`,
        fallbackStateRootDir: fallback,
      });
      state.writeJobFile(dir, "fallback-read", { id: "fallback-read", ok: true });
      assert.deepEqual(state.readJobFileById(dir, "fallback-read"), { id: "fallback-read", ok: true });
      assert.deepEqual(
        state.readJobFile(state.resolveJobFile(dir, "fallback-read")),
        { id: "fallback-read", ok: true },
      );

      fs.renameSync = function patchedRename() {
        throw new Error(`${target} state rename failed`);
      };
      assert.throws(
        () => state.saveState(dir, { jobs: [{ id: "rename-state" }] }),
        new RegExp(`${target} state rename failed`),
      );
      fs.renameSync = originalRename;
      const stateDir = path.dirname(state.resolveStateFile(dir));
      const leftovers = fs.existsSync(stateDir)
        ? fs.readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))
        : [];
      assert.deepEqual(leftovers, []);
    } finally {
      fs.renameSync = originalRename;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${target} state: resolve fallbacks, missing config, untimestamped jobs, and tmp cleanup failures`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), `${target}-state-fallbacks-`));
    const special = path.join(dir, "!!!");
    const fallback = path.join(dir, "fallback");
    const originalRename = fs.renameSync;
    const originalUnlink = fs.unlinkSync;
    try {
      fs.mkdirSync(special);
      state.configureState({
        pluginDataEnv: `NO_${target.toUpperCase()}_PLUGIN_DATA_FALLBACK_${Date.now()}`,
        fallbackStateRootDir: fallback,
      });
      assert.match(state.resolveStateDir(path.join(dir, "missing-workspace")), /missing-workspace-/);
      assert.match(state.resolveStateDir(special), /workspace-/);
      assert.match(state.resolveStateDir(path.parse(special).root), /workspace-/);

      fs.mkdirSync(path.dirname(state.resolveStateFile(special)), { recursive: true });
      fs.writeFileSync(state.resolveStateFile(special), "{\"jobs\":[]}", "utf8");
      assert.equal(state.loadState(special).config.stopReviewGate, false);

      state.saveState(special, {
        jobs: [
          { id: "first-no-updated" },
          { id: "second-no-updated" },
        ],
      });
      assert.deepEqual(state.listJobs(special).map((job) => job.id), [
        "first-no-updated",
        "second-no-updated",
      ]);

      fs.renameSync = function patchedRename() {
        throw new Error(`${target} forced rename failure`);
      };
      fs.unlinkSync = function patchedUnlink() {
        throw new Error(`${target} forced unlink failure`);
      };
      assert.throws(
        () => state.saveState(special, { jobs: [] }),
        new RegExp(`${target} forced rename failure`),
      );
      assert.throws(
        () => state.writeJobFile(special, "tmp-cleanup-fail", { ok: true }),
        new RegExp(`${target} forced rename failure`),
      );
    } finally {
      fs.renameSync = originalRename;
      fs.unlinkSync = originalUnlink;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
