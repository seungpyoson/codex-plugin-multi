import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  detectDefaultBranch,
  ensureGitRepository,
  getCurrentBranch,
  getRepoRoot,
  getWorkingTreeState,
} from "../../plugins/claude/scripts/lib/git.mjs";

function runGit(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function initRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "git-lib-test-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["checkout", "-b", "main"]);
  writeFileSync(path.join(dir, "base.txt"), "base\n", "utf8");
  runGit(dir, ["add", "base.txt"]);
  runGit(dir, ["commit", "-m", "base"]);
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("git repository helpers detect repo root, branch, default branch, and dirty state", () => {
  const dir = initRepo();
  try {
    const realDir = realpathSync.native(dir);
    assert.equal(ensureGitRepository(dir), realDir);
    assert.equal(getRepoRoot(dir), realDir);
    assert.equal(getCurrentBranch(dir), "main");
    assert.equal(detectDefaultBranch(dir), "main");

    writeFileSync(path.join(dir, "staged.txt"), "staged\n", "utf8");
    runGit(dir, ["add", "staged.txt"]);
    writeFileSync(path.join(dir, "base.txt"), "changed\n", "utf8");
    writeFileSync(path.join(dir, "untracked.txt"), "untracked\n", "utf8");

    const state = getWorkingTreeState(dir);
    assert.deepEqual(state.staged, ["staged.txt"]);
    assert.deepEqual(state.unstaged, ["base.txt"]);
    assert.deepEqual(state.untracked, ["untracked.txt"]);
    assert.equal(state.isDirty, true);
  } finally {
    cleanup(dir);
  }
});

test("git helpers fail clearly outside a repository or without a detectable base", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "git-lib-empty-"));
  try {
    assert.throws(() => ensureGitRepository(dir), /inside a Git repository/);

    runGit(dir, ["init"]);
    runGit(dir, ["config", "user.email", "test@example.com"]);
    runGit(dir, ["config", "user.name", "Test User"]);
    assert.throws(() => detectDefaultBranch(dir), /Unable to detect/);
  } finally {
    cleanup(dir);
  }
});

test("detectDefaultBranch: supports origin HEAD, remote fallback, and detached HEAD", () => {
  const dir = initRepo();
  try {
    runGit(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    runGit(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    assert.equal(detectDefaultBranch(dir), "main");

    runGit(dir, ["checkout", "--detach", "HEAD"], { stdio: ["ignore", "ignore", "pipe"] });
    assert.equal(getCurrentBranch(dir), "HEAD");
  } finally {
    cleanup(dir);
  }

  const remoteOnly = mkdtempSync(path.join(tmpdir(), "git-lib-remote-only-"));
  try {
    runGit(remoteOnly, ["init"]);
    runGit(remoteOnly, ["config", "user.email", "test@example.com"]);
    runGit(remoteOnly, ["config", "user.name", "Test User"]);
    runGit(remoteOnly, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(remoteOnly, "base.txt"), "base\n", "utf8");
    runGit(remoteOnly, ["add", "base.txt"]);
    runGit(remoteOnly, ["commit", "-m", "base"]);
    runGit(remoteOnly, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    assert.equal(detectDefaultBranch(remoteOnly), "origin/master");
  } finally {
    cleanup(remoteOnly);
  }
});
