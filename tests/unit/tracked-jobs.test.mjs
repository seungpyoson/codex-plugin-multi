import { test } from "node:test";
import assert from "node:assert/strict";

import {
  configureTrackedJobs,
  createJobRecord,
  getSessionIdEnv,
} from "../../plugins/claude/scripts/lib/tracked-jobs.mjs";

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
