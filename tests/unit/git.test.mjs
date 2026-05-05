import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureGitRepository } from "../../plugins/claude/scripts/lib/git.mjs";
import { GIT_BINARY_ENV } from "../../plugins/claude/scripts/lib/git-binary.mjs";
// PR #21 review HIGH 5: this file used to call execFileSync("git", ...) with
// raw process.env, so a parent shell exporting GIT_DIR=/bad would hijack
// every fixture git into the wrong repo. Use the scrubbed fixture helper.
import { fixtureGit } from "../helpers/fixture-git.mjs";

function runGit(cwd, args) {
  const res = fixtureGit(cwd, args);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr ?? ""}`);
  }
  return res.stdout;
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

function writeGitWrapper(dir) {
  const marker = path.join(dir, "git-wrapper-used");
  const wrapper = path.join(dir, "git");
  writeFileSync(wrapper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexec /usr/bin/git "$@"\n`, "utf8");
  chmodSync(wrapper, 0o700);
  return { marker, wrapper };
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

test("ensureGitRepository reports invalid explicit git overrides", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "git-lib-missing-"));
  const originalOverride = process.env[GIT_BINARY_ENV];
  try {
    process.env[GIT_BINARY_ENV] = path.join(dir, "missing-git");
    assert.throws(() => ensureGitRepository(dir), /CODEX_PLUGIN_MULTI_GIT_BINARY/);
  } finally {
    if (originalOverride === undefined) delete process.env[GIT_BINARY_ENV];
    else process.env[GIT_BINARY_ENV] = originalOverride;
    cleanup(dir);
  }
});

test("ensureGitRepository uses explicit absolute git override outside the workspace", () => {
  const dir = initRepo();
  const trusted = mkdtempSync(path.join(tmpdir(), "git-lib-trusted-"));
  const originalOverride = process.env[GIT_BINARY_ENV];
  try {
    const { marker, wrapper } = writeGitWrapper(trusted);
    process.env[GIT_BINARY_ENV] = wrapper;
    const realDir = realpathSync.native(dir);
    assert.equal(ensureGitRepository(dir), realDir);
    assert.equal(existsSync(marker), true);
  } finally {
    if (originalOverride === undefined) delete process.env[GIT_BINARY_ENV];
    else process.env[GIT_BINARY_ENV] = originalOverride;
    cleanup(dir);
    cleanup(trusted);
  }
});

test("ensureGitRepository reports cached override binaries that disappear as missing git", () => {
  const dir = initRepo();
  const trusted = mkdtempSync(path.join(tmpdir(), "git-lib-disappearing-"));
  const originalOverride = process.env[GIT_BINARY_ENV];
  try {
    const { wrapper } = writeGitWrapper(trusted);
    process.env[GIT_BINARY_ENV] = wrapper;
    ensureGitRepository(dir);
    rmSync(wrapper, { force: true });
    assert.throws(() => ensureGitRepository(dir), /git is not installed/);
  } finally {
    if (originalOverride === undefined) delete process.env[GIT_BINARY_ENV];
    else process.env[GIT_BINARY_ENV] = originalOverride;
    cleanup(dir);
    cleanup(trusted);
  }
});
