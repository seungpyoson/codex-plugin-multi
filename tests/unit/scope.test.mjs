// Unit tests for lib/scope.mjs (spec §21.4). Covers all five scope values:
// working-tree | staged | branch-diff | head | custom. Each sets up a
// transient git repo in $TMPDIR, invokes populateScope against it, and
// asserts the target directory contains exactly the expected files.
//
// Scope and containment are orthogonal: these tests call populateScope
// directly on a pre-made empty tempdir (simulating the "containment=worktree
// + populated afterwards" pipeline). When containment=none, populateScope
// is a no-op and the caller passes sourceCwd as targetPath.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { populateScope } from "../../plugins/claude/scripts/lib/scope.mjs";

// Spawns `git` synchronously with a clean env (same discipline as the
// production code). Throws on non-zero exit so test failures are loud.
function git(cwd, ...args) {
  const res = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout;
}

function seedRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "scope-src-"));
  git(repo, "init", "-q", "-b", "main");
  return repo;
}

function mkTarget() {
  return mkdtempSync(path.join(tmpdir(), "scope-tgt-"));
}

function cleanup(...paths) {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
}

const profile = (scope) => Object.freeze({
  name: "test", containment: "worktree", scope, dispose_default: true,
});

test("populateScope scope=working-tree: copies modified + untracked files", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    // Commit an initial version of A.
    writeFileSync(path.join(src, "A.txt"), "original\n");
    git(src, "add", "A.txt");
    git(src, "commit", "-qm", "seed");
    // Dirty: modify A (uncommitted), add untracked B.
    writeFileSync(path.join(src, "A.txt"), "modified\n");
    writeFileSync(path.join(src, "B.txt"), "untracked\n");

    populateScope(profile("working-tree"), src, tgt);

    assert.ok(existsSync(path.join(tgt, "A.txt")), "A.txt missing");
    assert.ok(existsSync(path.join(tgt, "B.txt")), "B.txt (untracked) missing");
    assert.equal(readFileSync(path.join(tgt, "A.txt"), "utf8"), "modified\n",
      "A.txt should be the dirty working-tree content, not HEAD");
    assert.equal(readFileSync(path.join(tgt, "B.txt"), "utf8"), "untracked\n");
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=working-tree: includes ignored untracked files", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, ".gitignore"), "ignored.log\n");
    writeFileSync(path.join(src, "A.txt"), "a\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "seed");
    // Drop an ignored file. Spec §21.4 says working-tree means everything
    // Claude could see or mutate in the user's tree, including ignored files.
    writeFileSync(path.join(src, "ignored.log"), "garbage\n");

    populateScope(profile("working-tree"), src, tgt);

    assert.ok(existsSync(path.join(tgt, "A.txt")));
    assert.equal(readFileSync(path.join(tgt, "ignored.log"), "utf8"), "garbage\n",
      ".gitignored files are still part of working-tree scope");
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=working-tree: skips nested .git directories", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "vendor/pkg/.git"), { recursive: true });
    writeFileSync(path.join(src, "vendor/pkg/.git/config"), "[core]\n");
    writeFileSync(path.join(src, "vendor/pkg/data.txt"), "data\n");

    populateScope(profile("working-tree"), src, tgt);

    assert.equal(existsSync(path.join(tgt, "vendor/pkg/data.txt")), true);
    assert.equal(existsSync(path.join(tgt, "vendor/pkg/.git/config")), false,
      "nested .git metadata must not be copied into scoped working-tree snapshots");
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: copies staged index only, not untracked", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "A.txt"), "original\n");
    git(src, "add", "A.txt");
    git(src, "commit", "-qm", "seed");
    // Stage a modification to A. Untracked B is NOT staged.
    writeFileSync(path.join(src, "A.txt"), "staged-version\n");
    git(src, "add", "A.txt");
    writeFileSync(path.join(src, "B.txt"), "untracked\n");

    populateScope(profile("staged"), src, tgt);

    assert.ok(existsSync(path.join(tgt, "A.txt")), "A.txt missing (staged)");
    assert.equal(readFileSync(path.join(tgt, "A.txt"), "utf8"), "staged-version\n",
      "A.txt should reflect the INDEX, not working tree");
    assert.equal(existsSync(path.join(tgt, "B.txt")), false,
      "untracked file leaked into staged scope");
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: copies files changed vs base, not unrelated files", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    // Main: A and unrelated/file exist.
    writeFileSync(path.join(src, "A.txt"), "a\n");
    mkdirSync(path.join(src, "unrelated"));
    writeFileSync(path.join(src, "unrelated", "file"), "unrelated\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "main");
    // Feature branch touches only X.md, Y.md.
    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "X.md"), "x\n");
    writeFileSync(path.join(src, "Y.md"), "y\n");
    git(src, "add", "X.md", "Y.md");
    git(src, "commit", "-qm", "feature");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.ok(existsSync(path.join(tgt, "X.md")), "X.md missing");
    assert.ok(existsSync(path.join(tgt, "Y.md")), "Y.md missing");
    // A.txt and unrelated/file are NOT in the branch diff — must be absent.
    assert.equal(existsSync(path.join(tgt, "A.txt")), false,
      "A.txt (only on main) leaked into branch-diff scope");
    assert.equal(existsSync(path.join(tgt, "unrelated", "file")), false,
      "unrelated/ leaked into branch-diff scope");
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: throws scope_base_missing when base ref is absent", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "A.txt"), "a\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "seed");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "nonexistent" }),
      /scope_base_missing|nonexistent/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=head: faithful HEAD checkout via git worktree", () => {
  const src = seedRepo();
  // HEAD scope uses `git worktree add`, so the target dir must NOT pre-exist
  // as a real directory — git creates it. mkdtempSync the *parent* instead.
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeFileSync(path.join(src, "A.txt"), "committed\n");
    git(src, "add", "A.txt");
    git(src, "commit", "-qm", "seed");
    // Dirty the working tree — scope=head must ignore this.
    writeFileSync(path.join(src, "A.txt"), "dirty\n");
    writeFileSync(path.join(src, "untracked.txt"), "no\n");

    populateScope(profile("head"), src, tgt);

    assert.ok(existsSync(path.join(tgt, "A.txt")));
    assert.equal(readFileSync(path.join(tgt, "A.txt"), "utf8"), "committed\n",
      "scope=head must reflect HEAD, not the dirty working tree");
    assert.equal(existsSync(path.join(tgt, "untracked.txt")), false);
    // Clean up the worktree registration so the src removal succeeds.
    spawnSync("git", ["-C", src, "worktree", "remove", "--force", tgt]);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=custom: copies only matching glob paths", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "keep.md"), "yes\n");
    writeFileSync(path.join(src, "drop.log"), "no\n");
    mkdirSync(path.join(src, "docs"));
    writeFileSync(path.join(src, "docs", "spec.md"), "spec\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "seed");

    populateScope(profile("custom"), src, tgt, {
      scopePaths: ["keep.md", "docs/*.md"],
    });

    assert.ok(existsSync(path.join(tgt, "keep.md")));
    assert.ok(existsSync(path.join(tgt, "docs", "spec.md")));
    assert.equal(existsSync(path.join(tgt, "drop.log")), false);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=custom: throws scope_paths_required when glob list absent", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "empty", "--allow-empty");
    assert.throws(
      () => populateScope(profile("custom"), src, tgt, {}),
      /scope_paths_required/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope containment=none: no-op (target === source is caller's convention)", () => {
  const src = seedRepo();
  try {
    writeFileSync(path.join(src, "A.txt"), "a\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "seed");
    // When containment=none the caller passes sourceCwd as targetPath; the
    // function must detect this and do nothing (no copy-onto-self crash).
    const profileNone = Object.freeze({
      name: "rescue", containment: "none", scope: "working-tree", dispose_default: false,
    });
    // Should not throw.
    populateScope(profileNone, src, src);
  } finally {
    cleanup(src);
  }
});

test("populateScope: unknown scope value throws", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "empty", "--allow-empty");
    assert.throws(
      () => populateScope(profile("nonsense"), src, tgt),
      /invalid_profile|unknown scope|nonsense/,
    );
  } finally {
    cleanup(src, tgt);
  }
});
