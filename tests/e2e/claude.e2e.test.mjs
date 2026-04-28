import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs");

// #16 follow-up 9: env scrub so a stale GIT_DIR / GIT_WORK_TREE in the
// parent process cannot hijack fixture commits into the caller checkout.
import { fixtureGit, fixtureGitEnv } from "../helpers/fixture-git.mjs";

function seedRepo(cwd) {
  fixtureGit(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(cwd, "README.md"), "# Claude E2E\n");
  fixtureGit(cwd, ["add", "README.md"]);
  fixtureGit(cwd, ["commit", "-q", "-m", "seed"], {
    env: fixtureGitEnv({
      GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_AUTHOR_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e",
    }),
  });
}

test("live Claude foreground review completes", {
  skip: process.env.CLAUDE_LIVE_E2E === "1"
    ? false
    : "Set CLAUDE_LIVE_E2E=1 after authenticating Claude Code to run live E2E.",
}, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "claude-e2e-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "claude-e2e-data-"));
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
        CLAUDE_PLUGIN_DATA: dataDir,
        CLAUDE_BINARY: process.env.CLAUDE_BINARY ?? "claude",
      },
    });

    assert.equal(res.status, 0, res.stderr);
    const record = JSON.parse(res.stdout);
    assert.equal(record.target, "claude");
    assert.equal(record.status, "completed");
    assert.ok(record.job_id);
    assert.ok("result" in record);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
