import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
