import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectReviewContext,
  detectDefaultBranch,
  ensureGitRepository,
  getCurrentBranch,
  getRepoRoot,
  getWorkingTreeState,
  resolveReviewTarget,
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

    assert.deepEqual(resolveReviewTarget(dir, { scope: "auto" }), {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false,
    });
    assert.deepEqual(resolveReviewTarget(dir, { scope: "working-tree" }), {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    });
    assert.throws(() => resolveReviewTarget(dir, { scope: "unknown" }), /Unsupported review scope/);
  } finally {
    cleanup(dir);
  }
});

test("collectReviewContext: working-tree mode renders inline and self-collect summaries", () => {
  const dir = initRepo();
  try {
    writeFileSync(path.join(dir, "staged.txt"), "staged\n", "utf8");
    runGit(dir, ["add", "staged.txt"]);
    writeFileSync(path.join(dir, "base.txt"), "changed\n", "utf8");
    writeFileSync(path.join(dir, "untracked.txt"), "untracked body\n", "utf8");
    writeFileSync(path.join(dir, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));

    const inline = collectReviewContext(dir, { mode: "working-tree" }, { includeDiff: true });
    assert.equal(inline.mode, "working-tree");
    assert.equal(inline.inputMode, "inline-diff");
    assert.match(inline.content, /## Git Status/);
    assert.match(inline.content, /## Staged Diff/);
    assert.match(inline.content, /untracked body/);
    assert.match(inline.content, /binary\.bin\n\(skipped: binary file\)/);

    const selfCollect = collectReviewContext(dir, { mode: "working-tree" }, {
      includeDiff: false,
      maxInlineFiles: -1,
      maxInlineDiffBytes: "bad",
    });
    assert.equal(selfCollect.inputMode, "self-collect");
    assert.match(selfCollect.content, /## Changed Files/);
    assert.match(selfCollect.collectionGuidance, /lightweight summary/);
  } finally {
    cleanup(dir);
  }
});

test("resolveReviewTarget and collectReviewContext: branch mode uses merge-base context", () => {
  const dir = initRepo();
  try {
    runGit(dir, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(dir, "feature.txt"), "feature\n", "utf8");
    runGit(dir, ["add", "feature.txt"]);
    runGit(dir, ["commit", "-m", "feature"]);

    assert.deepEqual(resolveReviewTarget(dir, { base: "main" }), {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });
    assert.deepEqual(resolveReviewTarget(dir, { scope: "branch" }), {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });

    const summary = collectReviewContext(dir, { mode: "branch", baseRef: "main" }, {
      includeDiff: false,
      maxInlineFiles: 0,
      maxInlineDiffBytes: 1,
    });
    assert.equal(summary.mode, "branch");
    assert.equal(summary.inputMode, "self-collect");
    assert.equal(summary.branch, "feature");
    assert.deepEqual(summary.changedFiles, ["feature.txt"]);
    assert.match(summary.content, /## Commit Log/);
    assert.match(summary.content, /## Changed Files/);
    assert.match(summary.summary, /against main from merge-base/);

    const inline = collectReviewContext(dir, { mode: "branch", baseRef: "main" }, { includeDiff: true });
    assert.equal(inline.inputMode, "inline-diff");
    assert.match(inline.content, /## Branch Diff/);
    assert.match(inline.collectionGuidance, /primary evidence/);
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

test("collectReviewContext: auto mode chooses inline or self-collect by file and byte limits", () => {
  const dir = initRepo();
  try {
    writeFileSync(path.join(dir, "one.txt"), "one\n", "utf8");
    writeFileSync(path.join(dir, "two.txt"), "two\n", "utf8");
    runGit(dir, ["add", "one.txt", "two.txt"]);

    const byFileLimit = collectReviewContext(dir, { mode: "working-tree" }, {
      maxInlineFiles: 1,
      maxInlineDiffBytes: 1024 * 1024,
    });
    assert.equal(byFileLimit.inputMode, "self-collect");

    const byByteLimit = collectReviewContext(dir, { mode: "working-tree" }, {
      maxInlineFiles: 10,
      maxInlineDiffBytes: 1,
    });
    assert.equal(byByteLimit.inputMode, "self-collect");

    const inline = collectReviewContext(dir, { mode: "working-tree" }, {
      maxInlineFiles: 10,
      maxInlineDiffBytes: 1024 * 1024,
    });
    assert.equal(inline.inputMode, "inline-diff");
  } finally {
    cleanup(dir);
  }
});

test("collectReviewContext: large untracked files and broken symlinks are summarized safely", () => {
  const dir = initRepo();
  try {
    writeFileSync(path.join(dir, "large.txt"), "x".repeat(24 * 1024 + 1), "utf8");
    symlinkSync("missing-target", path.join(dir, "broken-link"));

    const context = collectReviewContext(dir, { mode: "working-tree" }, { includeDiff: true });
    assert.match(context.content, /large\.txt\n\(skipped: 24577 bytes exceeds 24576 byte limit\)/);
    assert.match(context.content, /broken-link\n\(skipped: broken symlink or unreadable file\)/);
  } finally {
    cleanup(dir);
  }
});
