import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("P8 cross-host workload lease verifier exits cleanly", () => {
  const result = spawnSync(process.execPath, ["scripts/ab/verify/P8-wl1-cross-host-lease.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(
    result.status,
    0,
    `verifier should exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /PINNED .*: true/);
});

test("P8 cross-host workload lease verifier exits nonzero when refuted", () => {
  const result = spawnSync(process.execPath, ["scripts/ab/verify/P8-wl1-cross-host-lease.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, P8_WL1_FOREIGN_HOST: hostname() },
    timeout: 10_000,
  });

  assert.notEqual(result.status, 0, `verifier should fail when refuted\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /PINNED .*: false/);
  assert.match(result.stdout, /REFUTED:/);
});
