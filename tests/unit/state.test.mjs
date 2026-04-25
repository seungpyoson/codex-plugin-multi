import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  configureState,
  getStateConfig,
  resolveStateDir,
  loadState,
  upsertJob,
  listJobs,
  setConfig,
  getConfig,
  resolveJobFile,
  resolveJobLogFile,
  writeJobFile,
} from "../../plugins/claude/scripts/lib/state.mjs";

// Node's test runner executes tests WITHIN a single file serially by default
// (subtests only run concurrently under an explicit `test.describe` with
// `concurrency: true`). These tests do not use that. However, to defend
// against future edits that introduce concurrency, we capture and restore the
// module-level CONFIG between tests.

let INITIAL_CONFIG;
before(() => {
  INITIAL_CONFIG = { ...getStateConfig() };
});
afterEach(() => {
  configureState(INITIAL_CONFIG);
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
