import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureGitRepository } from "../../plugins/claude/scripts/lib/git.mjs";

function runGit(cwd, args, options = {}) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
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

test("ensureGitRepository detects the repository root", () => {
  const dir = initRepo();
  try {
    const realDir = realpathSync.native(dir);
    assert.equal(ensureGitRepository(dir), realDir);
  } finally {
    cleanup(dir);
  }
});

test("ensureGitRepository fails clearly outside a repository", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "git-lib-empty-"));
  try {
    assert.throws(() => ensureGitRepository(dir), /inside a Git repository/);
  } finally {
    cleanup(dir);
  }
});

test("ensureGitRepository reports when git is missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "git-lib-missing-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    assert.throws(() => ensureGitRepository(dir), /git is not installed/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    cleanup(dir);
  }
});
