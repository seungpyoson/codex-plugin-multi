import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/kimi/scripts/kimi-companion.mjs");

// #16 follow-up 9: env scrub so a stale GIT_DIR / GIT_WORK_TREE in the
// parent process cannot hijack fixture commits into the caller checkout.
import { fixtureGit, fixtureGitEnv } from "../helpers/fixture-git.mjs";

function seedRepo(cwd) {
  fixtureGit(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(cwd, "README.md"), "# Kimi E2E\n");
  fixtureGit(cwd, ["add", "README.md"]);
  fixtureGit(cwd, ["commit", "-q", "-m", "seed"], {
    env: fixtureGitEnv({
      GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_AUTHOR_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e",
    }),
  });
}

test("live Kimi foreground review completes", {
  skip: process.env.KIMI_LIVE_E2E === "1"
    ? false
    : "Set KIMI_LIVE_E2E=1 after authenticating Kimi CLI to run live E2E.",
}, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-e2e-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-e2e-data-"));
  try {
    seedRepo(cwd);
    const res = spawnSync("node", [
      COMPANION,
      "run",
      "--mode=review",
      "--foreground",
      "--cwd", cwd,
      "--",
      "Live E2E smoke: summarize README.md in one sentence and do not edit files.",
    ], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        KIMI_PLUGIN_DATA: dataDir,
        KIMI_BINARY: process.env.KIMI_BINARY ?? "kimi",
      },
    });

    assert.equal(res.status, 0, res.stderr);
    const record = JSON.parse(res.stdout);
    assert.equal(record.target, "kimi");
    assert.equal(record.status, "completed");
    assert.ok(record.job_id);
    assert.ok("result" in record);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
