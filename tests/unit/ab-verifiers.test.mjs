import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
