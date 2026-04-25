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
import {
  mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync,
  symlinkSync, lstatSync, readdirSync,
} from "node:fs";
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

function sourceViaSymlink(src) {
  const aliasParent = mkdtempSync(path.join(tmpdir(), "scope-src-alias-"));
  const alias = path.join(aliasParent, "repo-link");
  symlinkSync(src, alias, "dir");
  return { aliasParent, alias };
}

function assertNoSymlinks(root) {
  function walk(abs) {
    if (!existsSync(abs)) return;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, ent.name);
      const lst = lstatSync(child);
      assert.equal(lst.isSymbolicLink(), false, `snapshot preserved symlink: ${path.relative(root, child)}`);
      if (lst.isDirectory()) walk(child);
    }
  }
  walk(root);
}

function assertNoSymlinkAt(abs) {
  let lst;
  try {
    lst = lstatSync(abs);
  } catch {
    return;
  }
  assert.equal(lst.isSymbolicLink(), false, `target snapshot preserved symlink: ${abs}`);
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

test("populateScope scope=working-tree: materializes in-tree file symlinks as regular files", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));

    populateScope(profile("working-tree"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "target\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=working-tree: rejects symlink to directory", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    symlinkSync("target-dir", path.join(src, "dir-link"));

    assert.throws(
      () => populateScope(profile("working-tree"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=working-tree: rejects dangling symlink", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    symlinkSync("missing.txt", path.join(src, "dangling.txt"));

    assert.throws(
      () => populateScope(profile("working-tree"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=working-tree: rejects symlink loop", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    symlinkSync("loop.txt", path.join(src, "loop.txt"));

    assert.throws(
      () => populateScope(profile("working-tree"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=working-tree: rejects symlink escaping source root", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "escape.txt"));

    assert.throws(
      () => populateScope(profile("working-tree"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt, outside);
  }
});

test("populateScope scope=working-tree: supports non-git folders", () => {
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "A.txt"), "a\n");
    mkdirSync(path.join(src, "nested"));
    writeFileSync(path.join(src, "nested", "B.txt"), "b\n");

    populateScope(profile("working-tree"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "A.txt"), "utf8"), "a\n");
    assert.equal(readFileSync(path.join(tgt, "nested", "B.txt"), "utf8"), "b\n");
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: requires a git worktree", () => {
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "A.txt"), "a\n");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /scope_(requires_git|git_required)/,
    );
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

test("populateScope scope=staged: materializes in-snapshot file symlinks as regular files", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));
    git(src, "add", "target.txt", "link.txt");

    populateScope(profile("staged"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "target\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: rejects symlink to staged directory as unsafe", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    symlinkSync("target-dir", path.join(src, "dir-link"));
    git(src, "add", "target-dir/file.txt", "dir-link");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: removes unsafe git-populated symlink after throw", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    symlinkSync("target-dir", path.join(src, "dir-link"));
    git(src, "add", "target-dir/file.txt", "dir-link");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinkAt(path.join(tgt, "dir-link"));
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: removes later git-populated symlinks after unsafe throw", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync("target-dir", path.join(src, "00-unsafe-dir-link"));
    symlinkSync("target.txt", path.join(src, "99-safe-file-link"));
    git(src, "add", "target-dir/file.txt", "target.txt", "00-unsafe-dir-link", "99-safe-file-link");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: rejects dangling symlink as unsafe", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    symlinkSync("missing.txt", path.join(src, "dangling.txt"));
    git(src, "add", "dangling.txt");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: rejects symlink escaping source root", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "escape.txt"));
    git(src, "add", "escape.txt");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinkAt(path.join(tgt, "escape.txt"));
  } finally {
    cleanup(src, tgt, outside);
  }
});

test("populateScope scope=staged: materializes absolute in-source file symlinks from index content", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "staged-index\n");
    symlinkSync(path.join(src, "target.txt"), path.join(src, "abs-link.txt"));
    git(src, "add", "target.txt", "abs-link.txt");
    writeFileSync(path.join(src, "target.txt"), "dirty-live\n");

    populateScope(profile("staged"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "abs-link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "staged-index\n",
      "staged absolute symlink materialization must use INDEX target content, not dirty working tree content");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: accepts absolute in-source symlink when sourceCwd is a symlinked directory", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const { aliasParent, alias } = sourceViaSymlink(src);
  try {
    writeFileSync(path.join(src, "target.txt"), "staged-through-index\n");
    symlinkSync(path.join(src, "target.txt"), path.join(src, "abs-link.txt"));
    git(src, "add", "target.txt", "abs-link.txt");
    writeFileSync(path.join(src, "target.txt"), "dirty-live\n");

    populateScope(profile("staged"), alias, tgt);

    assert.equal(lstatSync(path.join(tgt, "abs-link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "staged-through-index\n",
      "staged symlink materialization must use INDEX content even through a symlinked sourceCwd");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt, aliasParent);
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

test("populateScope scope=branch-diff: requires a git worktree", () => {
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "A.txt"), "a\n");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt),
      /scope_(requires_git|git_required)/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: materializes symlink target content from HEAD", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "head-content\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync("target.txt", path.join(src, "link.txt"));
    git(src, "add", "link.txt");
    git(src, "commit", "-qm", "add symlink");

    writeFileSync(path.join(src, "target.txt"), "dirty-content\n");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(lstatSync(path.join(tgt, "link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "head-content\n",
      "branch-diff symlink materialization must use HEAD target content, not dirty working tree content");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: rejects symlink to directory as unsafe", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");
    git(src, "checkout", "-qb", "feature");
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    symlinkSync("target-dir", path.join(src, "dir-link"));
    git(src, "add", "target-dir/file.txt", "dir-link");
    git(src, "commit", "-qm", "dir symlink");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: rejects dangling symlink as unsafe", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");
    git(src, "checkout", "-qb", "feature");
    symlinkSync("missing.txt", path.join(src, "dangling.txt"));
    git(src, "add", "dangling.txt");
    git(src, "commit", "-qm", "dangling symlink");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: rejects symlink loop as unsafe", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");
    git(src, "checkout", "-qb", "feature");
    symlinkSync("loop.txt", path.join(src, "loop.txt"));
    git(src, "add", "loop.txt");
    git(src, "commit", "-qm", "symlink loop");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /unsafe_symlink/,
    );
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

test("populateScope scope=branch-diff: rejects symlink escaping source root", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");
    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "escape.txt"));
    git(src, "add", "escape.txt");
    git(src, "commit", "-qm", "symlink");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt, outside);
  }
});

test("populateScope scope=head: requires a git worktree", () => {
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeFileSync(path.join(src, "A.txt"), "a\n");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /scope_(requires_git|git_required)/,
    );
  } finally {
    cleanup(src, parent);
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

test("populateScope scope=head: materializes absolute in-source file symlinks from HEAD content", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeFileSync(path.join(src, "target.txt"), "head-index\n");
    symlinkSync(path.join(src, "target.txt"), path.join(src, "abs-link.txt"));
    git(src, "add", "target.txt", "abs-link.txt");
    git(src, "commit", "-qm", "seed");
    writeFileSync(path.join(src, "target.txt"), "dirty-live\n");

    populateScope(profile("head"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "abs-link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "head-index\n",
      "head absolute symlink materialization must use HEAD target content, not dirty working tree content");
    assertNoSymlinks(tgt);
  } finally {
    spawnSync("git", ["-C", src, "worktree", "remove", "--force", tgt]);
    cleanup(src, parent);
  }
});

test("populateScope scope=head: accepts absolute in-source symlink when sourceCwd is a symlinked directory", () => {
  const src = seedRepo();
  const { aliasParent, alias } = sourceViaSymlink(src);
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeFileSync(path.join(src, "target.txt"), "head-through-index\n");
    symlinkSync(path.join(src, "target.txt"), path.join(src, "abs-link.txt"));
    git(src, "add", "target.txt", "abs-link.txt");
    git(src, "commit", "-qm", "seed");
    writeFileSync(path.join(src, "target.txt"), "dirty-live\n");

    populateScope(profile("head"), alias, tgt);

    assert.equal(lstatSync(path.join(tgt, "abs-link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "head-through-index\n",
      "head symlink materialization must use HEAD content even through a symlinked sourceCwd");
    assertNoSymlinks(tgt);
  } finally {
    spawnSync("git", ["-C", src, "worktree", "remove", "--force", tgt]);
    cleanup(src, parent, aliasParent);
  }
});

test("populateScope scope=head: rejects symlink to directory as unsafe", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    symlinkSync("target-dir", path.join(src, "dir-link"));
    git(src, "add", "target-dir/file.txt", "dir-link");
    git(src, "commit", "-qm", "dir symlink");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    spawnSync("git", ["-C", src, "worktree", "remove", "--force", tgt]);
    cleanup(src, parent);
  }
});

test("populateScope scope=head: removes unsafe git-populated symlink after throw", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    symlinkSync("target-dir", path.join(src, "dir-link"));
    git(src, "add", "target-dir/file.txt", "dir-link");
    git(src, "commit", "-qm", "dir symlink");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinkAt(path.join(tgt, "dir-link"));
  } finally {
    spawnSync("git", ["-C", src, "worktree", "remove", "--force", tgt]);
    cleanup(src, parent);
  }
});

test("populateScope scope=head: removes later git-populated symlinks after unsafe throw", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync("target-dir", path.join(src, "00-unsafe-dir-link"));
    symlinkSync("target.txt", path.join(src, "99-safe-file-link"));
    git(src, "add", "target-dir/file.txt", "target.txt", "00-unsafe-dir-link", "99-safe-file-link");
    git(src, "commit", "-qm", "mixed symlinks");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinks(tgt);
  } finally {
    spawnSync("git", ["-C", src, "worktree", "remove", "--force", tgt]);
    cleanup(src, parent);
  }
});

test("populateScope scope=head: rejects dangling symlink as unsafe", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    symlinkSync("missing.txt", path.join(src, "dangling.txt"));
    git(src, "add", "dangling.txt");
    git(src, "commit", "-qm", "dangling symlink");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    spawnSync("git", ["-C", src, "worktree", "remove", "--force", tgt]);
    cleanup(src, parent);
  }
});

test("populateScope scope=head: rejects symlink escaping source root", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "escape.txt"));
    git(src, "add", "escape.txt");
    git(src, "commit", "-qm", "outside symlink");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinkAt(path.join(tgt, "escape.txt"));
  } finally {
    spawnSync("git", ["-C", src, "worktree", "remove", "--force", tgt]);
    cleanup(src, parent, outside);
  }
});

test("populateScope scope=head: rejects symlink loop as unsafe", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    symlinkSync("loop.txt", path.join(src, "loop.txt"));
    git(src, "add", "loop.txt");
    git(src, "commit", "-qm", "symlink loop");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    spawnSync("git", ["-C", src, "worktree", "remove", "--force", tgt]);
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
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=custom: materializes in-source file symlinks as regular files", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));

    populateScope(profile("custom"), src, tgt, { scopePaths: ["link.txt"] });

    assert.equal(lstatSync(path.join(tgt, "link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "target\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=custom: rejects symlink to directory as unsafe", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    symlinkSync("target-dir", path.join(src, "dir-link"));

    assert.throws(
      () => populateScope(profile("custom"), src, tgt, { scopePaths: ["dir-link"] }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=custom: rejects dangling symlink as unsafe", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    symlinkSync("missing.txt", path.join(src, "dangling.txt"));

    assert.throws(
      () => populateScope(profile("custom"), src, tgt, { scopePaths: ["dangling.txt"] }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=custom: rejects symlink loop as unsafe", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    symlinkSync("loop.txt", path.join(src, "loop.txt"));

    assert.throws(
      () => populateScope(profile("custom"), src, tgt, { scopePaths: ["loop.txt"] }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=custom: rejects symlink escaping source root", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "escape.txt"));

    assert.throws(
      () => populateScope(profile("custom"), src, tgt, { scopePaths: ["escape.txt"] }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt, outside);
  }
});

test("populateScope scope=custom: includes ignored files matched by glob", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, ".gitignore"), "ignored.log\n");
    git(src, "add", ".gitignore");
    git(src, "commit", "-qm", "seed");
    writeFileSync(path.join(src, "ignored.log"), "ignored\n");

    populateScope(profile("custom"), src, tgt, {
      scopePaths: ["ignored.log"],
    });

    assert.equal(readFileSync(path.join(tgt, "ignored.log"), "utf8"), "ignored\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=custom: works in non-git folders", () => {
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "keep.md"), "yes\n");
    writeFileSync(path.join(src, "drop.log"), "no\n");

    populateScope(profile("custom"), src, tgt, {
      scopePaths: ["*.md"],
    });

    assert.equal(readFileSync(path.join(tgt, "keep.md"), "utf8"), "yes\n");
    assert.equal(existsSync(path.join(tgt, "drop.log")), false);
    assertNoSymlinks(tgt);
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
