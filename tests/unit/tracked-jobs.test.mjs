import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as ClaudeTracked from "../../plugins/claude/scripts/lib/tracked-jobs.mjs";
import * as ClaudeState from "../../plugins/claude/scripts/lib/state.mjs";
import * as GeminiTracked from "../../plugins/gemini/scripts/lib/tracked-jobs.mjs";
import * as GeminiState from "../../plugins/gemini/scripts/lib/state.mjs";

const {
  configureTrackedJobs,
  createJobRecord,
  getSessionIdEnv,
} = ClaudeTracked;

let INITIAL_CLAUDE_STATE;
let INITIAL_GEMINI_STATE;
before(() => {
  INITIAL_CLAUDE_STATE = { ...ClaudeState.getStateConfig() };
  INITIAL_GEMINI_STATE = { ...GeminiState.getStateConfig() };
});
afterEach(() => {
  ClaudeState.configureState(INITIAL_CLAUDE_STATE);
  GeminiState.configureState(INITIAL_GEMINI_STATE);
});

function freshTrackedFixture(target, tracked, state) {
  const dir = mkdtempSync(path.join(tmpdir(), `${target}-tracked-test-`));
  const envName = `${target.toUpperCase()}_TRACKED_TEST_DATA`;
  const sessionEnv = `${target.toUpperCase()}_TRACKED_TEST_SESSION`;
  process.env[envName] = dir;
  state.configureState({
    pluginDataEnv: envName,
    fallbackStateRootDir: path.join(dir, "fallback"),
    sessionIdEnv: sessionEnv,
  });
  tracked.configureTrackedJobs({
    stderrPrefix: `[${target}]`,
    sessionIdEnv: sessionEnv,
  });
  return { dir, envName, sessionEnv };
}

function cleanupFixture(fixture) {
  delete process.env[fixture.envName];
  delete process.env[fixture.sessionEnv];
  rmSync(fixture.dir, { recursive: true, force: true });
}

test("configureTrackedJobs: overrides session-id env name", () => {
  configureTrackedJobs({ sessionIdEnv: "CUSTOM_SESSION_ENV" });
  assert.equal(getSessionIdEnv(), "CUSTOM_SESSION_ENV");
});

test("createJobRecord: attaches sessionId from configured env", () => {
  configureTrackedJobs({ sessionIdEnv: "TEST_SESS_ENV" });
  process.env["TEST_SESS_ENV"] = "abc123";
  try {
    const rec = createJobRecord({ id: "job-x" });
    assert.equal(rec.sessionId, "abc123");
    assert.equal(rec.id, "job-x");
    assert.ok(rec.createdAt);
  } finally {
    delete process.env["TEST_SESS_ENV"];
  }
});

test("createJobRecord: omits sessionId when env not set", () => {
  configureTrackedJobs({ sessionIdEnv: "NO_SUCH_ENV_" + Date.now() });
  const rec = createJobRecord({ id: "job-y" });
  assert.equal(rec.sessionId, undefined);
});

test("createJobRecord: per-call sessionIdEnv override wins", () => {
  configureTrackedJobs({ sessionIdEnv: "OUTER_SESS" });
  process.env["INNER_SESS"] = "inner-value";
  try {
    const rec = createJobRecord({ id: "z" }, { sessionIdEnv: "INNER_SESS" });
    assert.equal(rec.sessionId, "inner-value");
  } finally {
    delete process.env["INNER_SESS"];
  }
});

for (const [target, tracked, state] of [
  ["claude", ClaudeTracked, ClaudeState],
  ["gemini", GeminiTracked, GeminiState],
]) {
  test(`${target} tracked jobs: log helpers write lines and blocks`, () => {
    const fixture = freshTrackedFixture(target, tracked, state);
    try {
      const logFile = tracked.createJobLogFile(fixture.dir, "job-log", "demo");
      tracked.appendLogLine(logFile, "  next step  ");
      tracked.appendLogLine(logFile, "   ");
      tracked.appendLogBlock(logFile, null, "body only\n");
      tracked.appendLogBlock(logFile, "Title", "block body\n");
      tracked.appendLogBlock(logFile, "Ignored", "");

      const log = readFileSync(logFile, "utf8");
      assert.match(log, /Starting demo\./);
      assert.match(log, /next step/);
      assert.match(log, /\]\nbody only\n/);
      assert.match(log, /Title\nblock body\n/);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test(`${target} tracked jobs: progress reporter emits stderr, logs, and events`, () => {
    const fixture = freshTrackedFixture(target, tracked, state);
    const originalWrite = process.stderr.write;
    const stderr = [];
    const events = [];
    try {
      const logFile = tracked.createJobLogFile(fixture.dir, "job-progress-log");
      process.stderr.write = function patchedWrite(chunk) {
        stderr.push(String(chunk));
        return true;
      };
      const reporter = tracked.createProgressReporter({
        stderr: true,
        logFile,
        onEvent(event) {
          events.push(event);
        },
      });

      reporter({
        message: "phase message",
        stderrMessage: "stderr only",
        phase: "running",
        threadId: "thread-1",
        turnId: "turn-1",
        logTitle: "Details",
        logBody: "detail body\n",
      });

      assert.match(stderr.join(""), new RegExp(`\\[${target}\\] stderr only`));
      assert.equal(events[0].phase, "running");
      const log = readFileSync(logFile, "utf8");
      assert.match(log, /phase message/);
      assert.match(log, /Details\n detail body|Details\ndetail body/);
    } finally {
      process.stderr.write = originalWrite;
      cleanupFixture(fixture);
    }
  });

  test(`${target} tracked jobs: empty reporters and no-op log inputs are safe`, () => {
    const fixture = freshTrackedFixture(target, tracked, state);
    try {
      assert.equal(tracked.createProgressReporter(), null);
      tracked.appendLogLine(null, "ignored");
      tracked.appendLogLine(path.join(fixture.dir, "missing.log"), "   ");
      tracked.appendLogBlock(null, "title", "body");
      tracked.appendLogBlock(path.join(fixture.dir, "missing.log"), "title", "");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test(`${target} tracked jobs: progress updater patches state and terminal job file`, () => {
    const fixture = freshTrackedFixture(target, tracked, state);
    try {
      state.writeJobFile(fixture.dir, "job-progress", { id: "job-progress", status: "running" });
      const update = tracked.createJobProgressUpdater(fixture.dir, "job-progress");
      update({ phase: "reading", threadId: "thread-a", turnId: "turn-a" });
      update({ phase: "reading", threadId: "thread-a", turnId: "turn-a" });

      const listed = state.listJobs(fixture.dir)[0];
      assert.equal(listed.phase, "reading");
      assert.equal(listed.threadId, "thread-a");
      assert.equal(listed.turnId, "turn-a");
      assert.equal(state.readJobFileById(fixture.dir, "job-progress").phase, "reading");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test(`${target} tracked jobs: progress updater tolerates missing terminal job file`, () => {
    const fixture = freshTrackedFixture(target, tracked, state);
    try {
      const update = tracked.createJobProgressUpdater(fixture.dir, "job-no-file");
      update("plain progress message");
      update({ phase: "queued" });
      assert.equal(state.listJobs(fixture.dir)[0].phase, "queued");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test(`${target} tracked jobs: runTrackedJob persists completed and failed records`, async () => {
    const fixture = freshTrackedFixture(target, tracked, state);
    try {
      const logFile = tracked.createJobLogFile(fixture.dir, "job-run", "run");
      const execution = await tracked.runTrackedJob({
        id: "job-run",
        workspaceRoot: fixture.dir,
        status: "queued",
        logFile,
      }, async () => ({
        exitStatus: 0,
        threadId: "thread-ok",
        turnId: "turn-ok",
        payload: { ok: true },
        rendered: "rendered output",
        summary: "summary",
      }));

      assert.deepEqual(execution.payload, { ok: true });
      const completed = state.readJobFileById(fixture.dir, "job-run");
      assert.equal(completed.status, "completed");
      assert.equal(completed.phase, "done");
      assert.equal(completed.pid, null);
      assert.deepEqual(completed.result, { ok: true });
      assert.match(readFileSync(logFile, "utf8"), /Final output\nrendered output/);

      await assert.rejects(
        () => tracked.runTrackedJob({ id: "job-fail", workspaceRoot: fixture.dir, status: "queued" }, async () => {
          throw new Error("runner exploded");
        }),
        /runner exploded/,
      );
      const failed = state.readJobFileById(fixture.dir, "job-fail");
      assert.equal(failed.status, "failed");
      assert.equal(failed.phase, "failed");
      assert.equal(failed.errorMessage, "runner exploded");
      assert.equal(failed.pid, null);
      assert.equal(existsSync(state.resolveJobFile(fixture.dir, "job-fail")), true);
    } finally {
      cleanupFixture(fixture);
    }
  });
}
