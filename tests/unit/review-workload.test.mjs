import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROVIDER_WORKLOAD_BLOCKED_CODE,
  acquireProviderWorkloadLease,
  providerWorkloadBlockedExecution,
  releaseProviderWorkloadLease,
} from "../../scripts/lib/review-workload.mjs";

function tempEnv() {
  const root = mkdtempSync(join(tmpdir(), "provider-workload-test-"));
  return {
    root,
    env: {
      CODEX_PLUGIN_MULTI_PROVIDER_WORKLOAD_LOCK_DIR: root,
    },
  };
}

test("provider workload lease blocks concurrent source-bearing launches for the same provider", () => {
  const { root, env } = tempEnv();
  try {
    const first = acquireProviderWorkloadLease({
      provider: "claude",
      jobId: "job-first",
      cwd: "/tmp/work-a",
      sourceBearing: true,
      env,
    });
    assert.equal(first.ok, true);

    const second = acquireProviderWorkloadLease({
      provider: "claude",
      jobId: "job-second",
      cwd: "/tmp/work-b",
      sourceBearing: true,
      env,
    });
    assert.equal(second.ok, false);
    assert.equal(second.error_code, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.equal(second.reason, "active_same_provider_job");
    assert.equal(second.holder.job_id, "job-first");
    assert.equal(second.holder.provider, "claude");

    const blocked = providerWorkloadBlockedExecution(second);
    assert.equal(blocked.preflight, true);
    assert.equal(blocked.parsed.reason, PROVIDER_WORKLOAD_BLOCKED_CODE);
    assert.match(blocked.errorMessage, /^provider_workload_blocked:/);

    assert.equal(releaseProviderWorkloadLease(first.lease), true);
    const third = acquireProviderWorkloadLease({
      provider: "claude",
      jobId: "job-third",
      cwd: "/tmp/work-c",
      sourceBearing: true,
      env,
    });
    assert.equal(third.ok, true);
    releaseProviderWorkloadLease(third.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider workload lease is provider-neutral and ignores source-free probes", () => {
  const { root, env } = tempEnv();
  try {
    const claude = acquireProviderWorkloadLease({
      provider: "claude",
      jobId: "job-claude",
      cwd: "/tmp/work-a",
      sourceBearing: true,
      env,
    });
    assert.equal(claude.ok, true);

    const gemini = acquireProviderWorkloadLease({
      provider: "gemini",
      jobId: "job-gemini",
      cwd: "/tmp/work-b",
      sourceBearing: true,
      env,
    });
    assert.equal(gemini.ok, true);

    const sourceFree = acquireProviderWorkloadLease({
      provider: "claude",
      jobId: "job-ping",
      cwd: "/tmp/work-c",
      sourceBearing: false,
      env,
    });
    assert.equal(sourceFree.ok, true);
    assert.equal(sourceFree.lease, null);

    releaseProviderWorkloadLease(claude.lease);
    releaseProviderWorkloadLease(gemini.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider workload lease reclaims stale lock files whose pid is not alive", () => {
  const { root, env } = tempEnv();
  try {
    writeFileSync(join(root, "kimi.json"), JSON.stringify({
      provider: "kimi",
      job_id: "stale-job",
      pid: 0,
      token: "stale-token",
      cwd: "/tmp/stale",
      started_at: "2000-01-01T00:00:00.000Z",
    }));

    const acquired = acquireProviderWorkloadLease({
      provider: "kimi",
      jobId: "fresh-job",
      cwd: "/tmp/fresh",
      sourceBearing: true,
      env,
    });
    assert.equal(acquired.ok, true);
    assert.equal(JSON.parse(readFileSync(join(root, "kimi.json"), "utf8")).job_id, "fresh-job");
    releaseProviderWorkloadLease(acquired.lease);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
