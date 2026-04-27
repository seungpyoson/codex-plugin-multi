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
  symlinkSync, lstatSync, readdirSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { populateScope } from "../../plugins/claude/scripts/lib/scope.mjs";

const GIT_TEST_TIMEOUT_MS = 15000;

// Spawns `git` synchronously with a clean env (same discipline as the
// production code). Throws on non-zero exit so test failures are loud.
function git(cwd, ...args) {
  const res = spawnSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    timeout: GIT_TEST_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (res.error) {
    throw new Error(`git ${args.join(" ")} failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout;
}

function gitStdin(cwd, input, ...args) {
  const res = spawnSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    input,
    timeout: GIT_TEST_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (res.error) {
    throw new Error(`git ${args.join(" ")} failed: ${res.error.message}`);
  }
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

function shellQuote(s) {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function sourceViaSymlink(src) {
  const aliasParent = mkdtempSync(path.join(tmpdir(), "scope-src-alias-"));
  const alias = path.join(aliasParent, "repo-link");
  symlinkSync(src, alias, "dir");
  return { aliasParent, alias };
}

function sourceSubdirViaSymlink(src, subdir = "sub") {
  const aliasParent = mkdtempSync(path.join(tmpdir(), "scope-src-alias-"));
  const alias = path.join(aliasParent, "sub-link");
  symlinkSync(path.join(src, subdir), alias, "dir");
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

function assertNoGitMetadata(root) {
  function walk(abs) {
    if (!existsSync(abs)) return;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, ent.name);
      assert.notEqual(ent.name.toLowerCase(), ".git", `snapshot preserved git metadata: ${path.relative(root, child)}`);
      if (ent.isDirectory()) walk(child);
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

function assertEmptyOrMissing(abs) {
  if (!existsSync(abs)) return;
  assert.deepEqual(readdirSync(abs).sort(), [], `${abs} should not contain partial snapshot entries`);
}

function writeLargeFile(abs, size = 64 * 1024 * 1024 + 1) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  writeFileSync(abs, buf);
}

function assertSameFileBytes(actual, expected) {
  assert.equal(
    Buffer.compare(readFileSync(actual), readFileSync(expected)),
    0,
    `${actual} bytes differ from ${expected}`,
  );
}

function writeLongPathFiles(root, count = 4000) {
  mkdirSync(path.join(root, "many"), { recursive: true });
  const rels = [];
  for (let i = 0; i < count; i++) {
    const rel = `many/${String(i).padStart(4, "0")}-${"x".repeat(180)}.txt`;
    writeFileSync(path.join(root, rel), `${i}\n`);
    rels.push(rel);
  }
  return rels;
}

function removeGitObject(repo, objectId) {
  rmSync(path.join(repo, ".git", "objects", objectId.slice(0, 2), objectId.slice(2)), {
    force: true,
  });
}

function replaceObjectWithBlob(repo, originalObject, content) {
  const replacement = gitStdin(repo, content, "hash-object", "-w", "--stdin").trim();
  git(repo, "replace", originalObject, replacement);
}

function maliciousDotGitCommit(repo, parent = null, gitDirName = ".git") {
  const blob = gitStdin(repo, "payload\n", "hash-object", "-w", "--stdin").trim();
  const dotGitTree = gitStdin(repo, `100644 blob ${blob}\tconfig\n`, "mktree").trim();
  const rootTree = gitStdin(repo, `040000 tree ${dotGitTree}\t${gitDirName}\n`, "mktree").trim();
  const args = parent ? ["commit-tree", rootTree, "-p", parent] : ["commit-tree", rootTree];
  return gitStdin(repo, "malicious tree\n", ...args).trim();
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

test("populateScope scope=head: scrubs numbered git config env", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const saved = new Map([
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ].map((key) => [key, process.env[key]]));
  try {
    writeFileSync(path.join(src, "A.txt"), "a\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "seed");

    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "bad key";
    process.env.GIT_CONFIG_VALUE_0 = "true";

    populateScope(profile("head"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "A.txt"), "utf8"), "a\n");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
    // the target CLI could see or mutate in the user's tree, including ignored files.
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

test("populateScope scope=working-tree: accepts symlink target named with dotdot prefix inside source root", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "..foo"), "dotdot-name\n");
    symlinkSync("..foo", path.join(src, "link.txt"));

    populateScope(profile("working-tree"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "dotdot-name\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
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

test("populateScope scope=working-tree: materializes non-git in-tree file symlinks", () => {
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
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

test("populateScope scope=working-tree: rejects non-git symlink escaping source root", () => {
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    mkdirSync(path.join(src, "nested"));
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync("../../" + path.basename(outside) + "/secret.txt", path.join(src, "nested", "escape.txt"));

    assert.throws(
      () => populateScope(profile("working-tree"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt, outside);
  }
});

test("populateScope scope=working-tree: fails closed when a directory cannot be read", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return;
  }
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  const unreadable = path.join(src, "unreadable");
  try {
    mkdirSync(unreadable);
    writeFileSync(path.join(unreadable, "hidden.txt"), "hidden\n");
    chmodSync(unreadable, 0o000);

    assert.throws(
      () => populateScope(profile("working-tree"), src, tgt),
      /scope_population_failed/,
    );
  } finally {
    try { chmodSync(unreadable, 0o700); } catch {}
    cleanup(src, tgt);
  }
});

test("populateScope scope=working-tree: fails closed when a file cannot be copied", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return;
  }
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  const unreadable = path.join(src, "unreadable.txt");
  try {
    writeFileSync(unreadable, "hidden\n");
    chmodSync(unreadable, 0o000);

    assert.throws(
      () => populateScope(profile("working-tree"), src, tgt),
      /scope_population_failed/,
    );
  } finally {
    try { chmodSync(unreadable, 0o600); } catch {}
    cleanup(src, tgt);
  }
});

test("populateScope scope=working-tree: fails closed when a symlink target cannot be copied", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return;
  }
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  const unreadable = path.join(src, "unreadable.txt");
  try {
    writeFileSync(unreadable, "hidden\n");
    chmodSync(unreadable, 0o000);
    symlinkSync("unreadable.txt", path.join(src, "link.txt"));

    assert.throws(
      () => populateScope(profile("working-tree"), src, tgt),
      /scope_population_failed/,
    );
  } finally {
    try { chmodSync(unreadable, 0o600); } catch {}
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
      /scope_requires_git/,
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

test("populateScope scope=staged: skips submodule entries", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "seed.txt"), "seed\n");
    git(src, "add", "seed.txt");
    git(src, "commit", "-qm", "seed");
    const commitObject = git(src, "rev-parse", "HEAD").trim();
    git(src, "update-index", "--add", "--cacheinfo", `160000,${commitObject},vendor/submodule`);

    populateScope(profile("staged"), src, tgt);

    assert.equal(existsSync(path.join(tgt, "vendor/submodule")), false,
      "staged scope must not materialize gitlink entries as text files");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: ignores replace refs for regular blobs", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "ORIGINAL\n");
    git(src, "add", "target.txt");
    const object = git(src, "rev-parse", ":target.txt").trim();
    replaceObjectWithBlob(src, object, "REPLACED\n");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "ORIGINAL\n");
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: handles high-cardinality path lists without argv E2BIG", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    const rels = writeLongPathFiles(src);
    git(src, "add", ".");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, rels.at(-1)), "utf8"), `${rels.length - 1}\n`);
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

test("populateScope scope=staged: ignores replace refs for symlink blobs", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));
    git(src, "add", "target.txt", "link.txt");
    const object = git(src, "rev-parse", ":link.txt").trim();
    replaceObjectWithBlob(src, object, "missing.txt");

    populateScope(profile("staged"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "target\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: materializes safe symlink chains from index content", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "staged-chain\n");
    symlinkSync("target.txt", path.join(src, "link2.txt"));
    symlinkSync("link2.txt", path.join(src, "link1.txt"));
    git(src, "add", "target.txt", "link2.txt", "link1.txt");
    writeFileSync(path.join(src, "target.txt"), "dirty-live\n");

    populateScope(profile("staged"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "link1.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link1.txt"), "utf8"), "staged-chain\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: rejects symlink chains exceeding depth limit", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "real.txt"), "real\n");
    for (let i = 0; i <= 40; i++) {
      symlinkSync(i === 40 ? "real.txt" : `a${i + 1}.txt`, path.join(src, `a${i}.txt`));
    }
    git(src, "add", ".");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink: .*exceeds symlink depth limit/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: accepts symlink chain at exact depth limit", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "real.txt"), "real\n");
    for (let i = 0; i < 40; i++) {
      symlinkSync(i === 39 ? "real.txt" : `a${i + 1}.txt`, path.join(src, `a${i}.txt`));
    }
    git(src, "add", ".");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "a0.txt"), "utf8"), "real\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: materializes symlink targets larger than exec buffer", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeLargeFile(path.join(src, "large.bin"));
    symlinkSync("large.bin", path.join(src, "large-link.bin"));
    git(src, "add", "large.bin", "large-link.bin");

    populateScope(profile("staged"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "large-link.bin")).isSymbolicLink(), false);
    assert.equal(lstatSync(path.join(tgt, "large-link.bin")).size, 64 * 1024 * 1024 + 1);
    assertSameFileBytes(path.join(tgt, "large-link.bin"), path.join(src, "large.bin"));
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: preserves executable mode when materializing symlink target", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    const executable = path.join(src, "run.sh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    symlinkSync("run.sh", path.join(src, "run-link.sh"));
    git(src, "add", "run.sh", "run-link.sh");

    populateScope(profile("staged"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "run-link.sh")).mode & 0o777, 0o755);
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: materializes symlink blobs when core.symlinks=false", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "config", "core.symlinks", "false");
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

test("populateScope scope=staged: does not apply checkout attributes to regular files or symlink targets", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, ".gitattributes"), "*.txt text eol=crlf\n");
    writeFileSync(path.join(src, "target.txt"), "one\ntwo\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));
    git(src, "add", ".gitattributes", "target.txt", "link.txt");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "one\ntwo\n");
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "one\ntwo\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: ignores live info and global attributes", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const envRoot = mkdtempSync(path.join(tmpdir(), "scope-git-env-"));
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    writeFileSync(path.join(src, "target.txt"), "one\ntwo\n");
    git(src, "add", "target.txt");
    mkdirSync(path.join(src, ".git", "info"), { recursive: true });
    writeFileSync(path.join(src, ".git", "info", "attributes"), "*.txt text eol=crlf\n");
    const globalAttributes = path.join(envRoot, "attributes");
    writeFileSync(globalAttributes, "*.txt text eol=crlf\n");
    writeFileSync(path.join(envRoot, "config"), `[core]\n\tattributesFile = ${globalAttributes}\n`);
    process.env.GIT_CONFIG_GLOBAL = path.join(envRoot, "config");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "one\ntwo\n");
  } finally {
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
    cleanup(src, tgt, envRoot);
  }
});

test("populateScope scope=staged: ignores inherited git config and object directory env", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const envRoot = mkdtempSync(path.join(tmpdir(), "scope-git-env-"));
  const old = {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
  };
  try {
    writeFileSync(path.join(src, "target.txt"), "INDEX\n");
    git(src, "add", "target.txt");
    process.env.GIT_CONFIG_COUNT = "1";
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
    process.env.GIT_OBJECT_DIRECTORY = path.join(envRoot, "missing-objects");
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(envRoot, "missing-alternates");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "INDEX\n");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(src, tgt, envRoot);
  }
});

test("populateScope scope=staged: does not execute configured filter drivers", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const witnessRoot = mkdtempSync(path.join(tmpdir(), "scope-filter-witness-"));
  const witness = path.join(witnessRoot, "ran");
  try {
    writeFileSync(path.join(src, "smudge.sh"), `#!/bin/sh\nprintf 'SMUDGED\\n'\ntouch ${witness}\n`);
    chmodSync(path.join(src, "smudge.sh"), 0o755);
    git(src, "config", "filter.witness.clean", "cat");
    git(src, "config", "filter.witness.smudge", "sh ./smudge.sh");
    git(src, "config", "filter.witness.required", "true");
    writeFileSync(path.join(src, ".gitattributes"), "target.txt filter=witness\n");
    writeFileSync(path.join(src, "target.txt"), "INDEX\n");
    git(src, "add", ".gitattributes", "target.txt", "smudge.sh");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "INDEX\n");
    assert.equal(existsSync(witness), false);
  } finally {
    cleanup(src, tgt, witnessRoot);
  }
});

test("populateScope scope=staged: does not execute configured fsmonitor hooks", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const witnessRoot = mkdtempSync(path.join(tmpdir(), "scope-fsmonitor-witness-"));
  const witness = path.join(witnessRoot, "ran");
  try {
    writeFileSync(path.join(src, "fsmonitor.sh"), `#!/bin/sh\ntouch ${shellQuote(witness)}\nprintf '\\0'\n`);
    chmodSync(path.join(src, "fsmonitor.sh"), 0o755);
    writeFileSync(path.join(src, "target.txt"), "INDEX\n");
    git(src, "add", "target.txt", "fsmonitor.sh");
    git(src, "config", "core.fsmonitor", "./fsmonitor.sh");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "INDEX\n");
    assert.equal(existsSync(witness), false);
  } finally {
    cleanup(src, tgt, witnessRoot);
  }
});

test("populateScope scope=staged: leaves LFS-style pointer blobs un-smudged", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const witnessRoot = mkdtempSync(path.join(tmpdir(), "scope-lfs-witness-"));
  const witness = path.join(witnessRoot, "smudged");
  try {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 123\n";
    writeFileSync(path.join(src, "smudge-lfs.sh"), `#!/bin/sh\ntouch ${shellQuote(witness)}\nprintf HYDRATED\\n\n`);
    chmodSync(path.join(src, "smudge-lfs.sh"), 0o755);
    git(src, "config", "filter.fake-lfs.clean", "cat");
    git(src, "config", "filter.fake-lfs.smudge", "sh ./smudge-lfs.sh");
    git(src, "config", "filter.fake-lfs.required", "true");
    writeFileSync(path.join(src, ".gitattributes"), "asset.bin filter=fake-lfs diff=lfs merge=lfs -text\n");
    writeFileSync(path.join(src, "asset.bin"), pointer);
    git(src, "add", ".gitattributes", "asset.bin", "smudge-lfs.sh");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "asset.bin"), "utf8"), pointer);
    assert.equal(existsSync(witness), false);
  } finally {
    cleanup(src, tgt, witnessRoot);
  }
});

test("populateScope scope=staged: streams large gitattributes blobs as raw objects", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    const attrs = Buffer.concat([
      Buffer.from("target.txt text eol=crlf\n"),
      Buffer.alloc(64 * 1024 * 1024 + 1, "#"),
      Buffer.from("\n"),
    ]);
    writeFileSync(path.join(src, ".gitattributes"), attrs);
    writeFileSync(path.join(src, "target.txt"), "one\ntwo\n");
    git(src, "add", ".gitattributes", "target.txt");

    populateScope(profile("staged"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "one\ntwo\n");
    assertSameFileBytes(path.join(tgt, ".gitattributes"), path.join(src, ".gitattributes"));
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: linked-worktree filter config is ignored", () => {
  const src = seedRepo();
  const wtParent = mkdtempSync(path.join(tmpdir(), "scope-linked-parent-"));
  const wt = path.join(wtParent, "linked");
  const tgt = mkTarget();
  try {
    git(src, "commit", "--allow-empty", "-qm", "base");
    git(src, "worktree", "add", "-q", wt, "HEAD");
    git(wt, "config", "extensions.worktreeConfig", "true");
    git(wt, "config", "--worktree", "filter.flip.clean", "cat");
    git(wt, "config", "--worktree", "filter.flip.smudge", "./smudge.sh");
    git(wt, "config", "--worktree", "filter.flip.required", "true");
    writeFileSync(path.join(wt, "smudge.sh"), "#!/bin/sh\nprintf 'SMUDGED\\n'\n");
    chmodSync(path.join(wt, "smudge.sh"), 0o755);
    writeFileSync(path.join(wt, ".gitattributes"), "*.txt filter=flip\n");
    writeFileSync(path.join(wt, "target.txt"), "INDEX\n");
    git(wt, "add", ".gitattributes", "target.txt", "smudge.sh");

    populateScope(profile("staged"), wt, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "INDEX\n");
  } finally {
    cleanup(src, wtParent, tgt);
  }
});

test("populateScope scope=staged: rejects unmerged index entries", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "conflict.txt"), "base\n");
    git(src, "add", "conflict.txt");
    git(src, "commit", "-qm", "base");

    git(src, "checkout", "-qb", "left");
    writeFileSync(path.join(src, "conflict.txt"), "left\n");
    git(src, "add", "conflict.txt");
    git(src, "commit", "-qm", "left");

    git(src, "checkout", "-q", "main");
    git(src, "checkout", "-qb", "right");
    writeFileSync(path.join(src, "conflict.txt"), "right\n");
    git(src, "add", "conflict.txt");
    git(src, "commit", "-qm", "right");

    const merge = spawnSync("git", ["-C", src, "-c", "core.hooksPath=/dev/null", "merge", "left"], {
      encoding: "utf8",
      timeout: GIT_TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    if (merge.error) throw new Error(`git merge left failed: ${merge.error.message}`);
    assert.notEqual(merge.status, 0, "test setup should create an unmerged index");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /scope_population_failed: unmerged index entry conflict\.txt/,
    );
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

test("populateScope scope=staged: removes partial target after unsafe symlink failure", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "regular.txt"), "regular\n");
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    symlinkSync("target-dir", path.join(src, "dir-link"));
    git(src, "add", "regular.txt", "target-dir/file.txt", "dir-link");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
    assertEmptyOrMissing(tgt);
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

test("populateScope scope=staged: rejects symlink into git metadata", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    symlinkSync(".git/config", path.join(src, "metadata-link.txt"));
    git(src, "add", "metadata-link.txt");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: rejects symlink path that traverses through a file", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync("target.txt/child", path.join(src, "file-child-link.txt"));
    git(src, "add", "target.txt", "file-child-link.txt");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: rejects symlink through a missing parent", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    symlinkSync("missing/child.txt", path.join(src, "missing-child-link.txt"));
    git(src, "add", "missing-child-link.txt");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: rejects empty symlink blobs as unsafe", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    const empty = gitStdin(src, "", "hash-object", "-w", "--stdin").trim();
    git(src, "update-index", "--add", "--cacheinfo", `120000,${empty},empty-link.txt`);

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

test("populateScope scope=staged: rejects relative symlink escaping source root", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "nested"));
    symlinkSync("../../secret.txt", path.join(src, "nested", "escape.txt"));
    git(src, "add", "nested/escape.txt");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinkAt(path.join(tgt, "nested", "escape.txt"));
  } finally {
    cleanup(src, tgt);
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

test("populateScope scope=staged: subdirectory sourceCwd snapshots staged paths relative to that subdirectory", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, "sub", "target.txt"), "staged-subdir\n");
    symlinkSync(path.join(src, "sub", "target.txt"), path.join(src, "sub", "abs-link.txt"));
    git(src, "add", "sub/target.txt", "sub/abs-link.txt");
    writeFileSync(path.join(src, "sub", "target.txt"), "dirty-live\n");

    populateScope(profile("staged"), path.join(src, "sub"), tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "staged-subdir\n");
    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "staged-subdir\n");
    assert.equal(existsSync(path.join(tgt, "sub")), false, "subdirectory sourceCwd should not preserve repo-root prefix");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: symlinked subdirectory sourceCwd accepts absolute in-source symlink", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "sub"));
    const { aliasParent, alias } = sourceSubdirViaSymlink(src);
    try {
      writeFileSync(path.join(src, "sub", "target.txt"), "staged-symlinked-subdir\n");
      symlinkSync(path.join(alias, "target.txt"), path.join(src, "sub", "abs-link.txt"));
      git(src, "add", "sub/target.txt", "sub/abs-link.txt");
      writeFileSync(path.join(src, "sub", "target.txt"), "dirty-live\n");

      populateScope(profile("staged"), alias, tgt);

      assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "staged-symlinked-subdir\n");
      assertNoSymlinks(tgt);
    } finally {
      cleanup(aliasParent);
    }
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: subdirectory sourceCwd ignores out-of-scope filter config", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, ".gitattributes"), "bad.txt filter=fail\n");
    writeFileSync(path.join(src, "bad.txt"), "bad\n");
    writeFileSync(path.join(src, "sub", "keep.txt"), "keep\n");
    git(src, "config", "filter.fail.clean", "cat");
    git(src, "config", "filter.fail.smudge", "/bin/false");
    git(src, "config", "filter.fail.required", "true");
    git(src, "add", ".gitattributes", "bad.txt", "sub/keep.txt");

    populateScope(profile("staged"), path.join(src, "sub"), tgt);

    assert.equal(readFileSync(path.join(tgt, "keep.txt"), "utf8"), "keep\n");
    assert.equal(existsSync(path.join(tgt, "bad.txt")), false);
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: subdirectory sourceCwd rejects absolute symlink to repo path outside subdirectory", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, "outside.txt"), "outside\n");
    symlinkSync(path.join(src, "outside.txt"), path.join(src, "sub", "escape.txt"));
    git(src, "add", "outside.txt", "sub/escape.txt");

    assert.throws(
      () => populateScope(profile("staged"), path.join(src, "sub"), tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=staged: safe index absolute symlink chain ignores dirty live unsafe hop", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(src, "target.txt"), "staged-safe\n");
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(src, "link2.txt"), path.join(src, "link1.txt"));
    symlinkSync("target.txt", path.join(src, "link2.txt"));
    git(src, "add", "target.txt", "link1.txt", "link2.txt");
    rmSync(path.join(src, "link2.txt"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "link2.txt"));

    populateScope(profile("staged"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "link1.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link1.txt"), "utf8"), "staged-safe\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt, outside);
  }
});

test("populateScope scope=staged: unsafe index absolute symlink chain ignores dirty live safe hop", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(src, "target.txt"), "live-safe\n");
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(src, "link2.txt"), path.join(src, "link1.txt"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "link2.txt"));
    git(src, "add", "target.txt", "link1.txt", "link2.txt");
    rmSync(path.join(src, "link2.txt"));
    symlinkSync("target.txt", path.join(src, "link2.txt"));

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt, outside);
  }
});

test("populateScope scope=staged: rejects absolute symlink through unrelated live alias", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const { aliasParent, alias } = sourceViaSymlink(src);
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync(path.join(alias, "target.txt"), path.join(src, "abs-link.txt"));
    git(src, "add", "target.txt", "abs-link.txt");

    assert.throws(
      () => populateScope(profile("staged"), src, tgt),
      /unsafe_symlink/,
    );
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

test("populateScope scope=branch-diff: clears stale target content when diff is empty", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "A.txt"), "a\n");
    git(src, "add", "A.txt");
    git(src, "commit", "-qm", "main");
    writeFileSync(path.join(tgt, "stale.txt"), "stale\n");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.deepEqual(readdirSync(tgt).sort(), []);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: skips files deleted in HEAD", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "deleted.txt"), "base\n");
    git(src, "add", "deleted.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    rmSync(path.join(src, "deleted.txt"));
    git(src, "add", "deleted.txt");
    git(src, "commit", "-qm", "delete file");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(existsSync(path.join(tgt, "deleted.txt")), false,
      "branch-diff must not materialize files deleted from HEAD");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: ignores replace refs for regular blobs", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");
    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "target.txt"), "ORIGINAL\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "feature");
    const object = git(src, "rev-parse", "HEAD:target.txt").trim();
    replaceObjectWithBlob(src, object, "REPLACED\n");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "ORIGINAL\n");
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: handles high-cardinality path lists without argv E2BIG", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");
    git(src, "checkout", "-qb", "feature");
    const rels = writeLongPathFiles(src);
    git(src, "add", ".");
    git(src, "commit", "-qm", "many files");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, rels.at(-1)), "utf8"), `${rels.length - 1}\n`);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: subdirectory sourceCwd snapshots changed HEAD paths relative to that subdirectory", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "sub"));
    mkdirSync(path.join(src, "outside"));
    writeFileSync(path.join(src, "outside", "main.txt"), "main\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "sub", "changed.txt"), "head-subdir\n");
    writeFileSync(path.join(src, "outside", "changed.txt"), "outside\n");
    git(src, "add", "sub/changed.txt", "outside/changed.txt");
    git(src, "commit", "-qm", "feature");

    populateScope(profile("branch-diff"), path.join(src, "sub"), tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "changed.txt"), "utf8"), "head-subdir\n");
    assert.equal(existsSync(path.join(tgt, "sub")), false, "subdirectory sourceCwd should not preserve repo-root prefix");
    assert.equal(existsSync(path.join(tgt, "outside")), false, "branch-diff must not include changes outside sourceCwd");
    assertNoSymlinks(tgt);
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
      /scope_requires_git/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: requires a committed HEAD", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /scope_requires_head/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: rejects malicious HEAD .git path components", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "base.txt"), "base\n");
    git(src, "add", "base.txt");
    git(src, "commit", "-qm", "base");
    const base = git(src, "rev-parse", "HEAD").trim();
    git(src, "checkout", "-qb", "feature");
    const malicious = maliciousDotGitCommit(src, base);
    git(src, "update-ref", "HEAD", malicious);

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /scope_population_failed/,
    );
    assertEmptyOrMissing(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: rejects malicious HEAD .git path components case-insensitively", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "base.txt"), "base\n");
    git(src, "add", "base.txt");
    git(src, "commit", "-qm", "base");
    const base = git(src, "rev-parse", "HEAD").trim();
    git(src, "checkout", "-qb", "feature");
    const malicious = maliciousDotGitCommit(src, base, ".Git");
    git(src, "update-ref", "HEAD", malicious);

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /scope_population_failed/,
    );
    assertEmptyOrMissing(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: clears stale target after unsafe diff path", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "base.txt"), "base\n");
    git(src, "add", "base.txt");
    git(src, "commit", "-qm", "base");
    const base = git(src, "rev-parse", "HEAD").trim();
    git(src, "checkout", "-qb", "feature");
    const malicious = maliciousDotGitCommit(src, base, ".Git");
    git(src, "update-ref", "HEAD", malicious);
    writeFileSync(path.join(tgt, "stale.txt"), "stale\n");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /scope_population_failed/,
    );
    assertEmptyOrMissing(tgt);
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

test("populateScope scope=branch-diff: ignores replace refs for symlink blobs", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync("target.txt", path.join(src, "link.txt"));
    git(src, "add", "link.txt");
    git(src, "commit", "-qm", "add symlink");
    const object = git(src, "rev-parse", "HEAD:link.txt").trim();
    replaceObjectWithBlob(src, object, "missing.txt");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(lstatSync(path.join(tgt, "link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "target\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: materializes symlink target through HEAD directory", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "dir"));
    writeFileSync(path.join(src, "dir", "target.txt"), "head-dir\n");
    git(src, "add", "dir/target.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync("dir/target.txt", path.join(src, "link.txt"));
    git(src, "add", "link.txt");
    git(src, "commit", "-qm", "add dir symlink");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "head-dir\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: materializes safe symlink chains from HEAD content", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "head-chain\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync("target.txt", path.join(src, "link2.txt"));
    symlinkSync("link2.txt", path.join(src, "link1.txt"));
    git(src, "add", "link2.txt", "link1.txt");
    git(src, "commit", "-qm", "add symlink chain");
    writeFileSync(path.join(src, "target.txt"), "dirty-live\n");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(lstatSync(path.join(tgt, "link1.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link1.txt"), "utf8"), "head-chain\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: copies regular files larger than exec buffer", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");

    git(src, "checkout", "-qb", "feature");
    writeLargeFile(path.join(src, "large.bin"));
    git(src, "add", "large.bin");
    git(src, "commit", "-qm", "large");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(lstatSync(path.join(tgt, "large.bin")).size, 64 * 1024 * 1024 + 1);
    assertSameFileBytes(path.join(tgt, "large.bin"), path.join(src, "large.bin"));
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: preserves executable mode for regular git blobs", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");
    git(src, "checkout", "-qb", "feature");
    const executable = path.join(src, "run.sh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    git(src, "add", "run.sh");
    git(src, "commit", "-qm", "add executable");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(lstatSync(path.join(tgt, "run.sh")).mode & 0o777, 0o755);
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: does not execute HEAD filter drivers", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const witnessRoot = mkdtempSync(path.join(tmpdir(), "scope-filter-witness-"));
  const witness = path.join(witnessRoot, "ran");
  try {
    writeFileSync(path.join(src, "smudge.sh"), `#!/bin/sh\nprintf 'HEAD-SMUDGED\\n'\ntouch ${witness}\n`);
    chmodSync(path.join(src, "smudge.sh"), 0o755);
    git(src, "config", "filter.rel.clean", "cat");
    git(src, "config", "filter.rel.smudge", "sh ./smudge.sh");
    git(src, "config", "filter.rel.required", "true");
    writeFileSync(path.join(src, ".gitattributes"), "*.txt filter=rel\n");
    writeFileSync(path.join(src, "target.txt"), "base\n");
    git(src, "add", ".gitattributes", "target.txt", "smudge.sh");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "target.txt"), "feature\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "feature");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "feature\n");
    assert.equal(existsSync(witness), false);
  } finally {
    cleanup(src, tgt, witnessRoot);
  }
});

test("populateScope scope=branch-diff: ignores global attributes", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const envRoot = mkdtempSync(path.join(tmpdir(), "scope-git-env-"));
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    writeFileSync(path.join(envRoot, "attrs"), "*.txt filter=leak\n");
    writeFileSync(path.join(envRoot, "smudge.sh"), "#!/bin/sh\nprintf 'GLOBAL-LEAK\\n'\n");
    chmodSync(path.join(envRoot, "smudge.sh"), 0o755);
    writeFileSync(path.join(envRoot, "config"), `[core]\n\tattributesFile = ${path.join(envRoot, "attrs")}\n[filter "leak"]\n\tclean = cat\n\tsmudge = sh ${path.join(envRoot, "smudge.sh")}\n\trequired = true\n`);
    process.env.GIT_CONFIG_GLOBAL = path.join(envRoot, "config");

    writeFileSync(path.join(src, "target.txt"), "base\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "target.txt"), "feature\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "feature");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "feature\n");
  } finally {
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
    cleanup(src, tgt, envRoot);
  }
});

test("populateScope scope=branch-diff: does not apply checkout attributes to regular files or symlink targets", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, ".gitattributes"), "*.txt text eol=crlf\n");
    writeFileSync(path.join(src, "target.txt"), "base\n");
    git(src, "add", ".gitattributes", "target.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "target.txt"), "one\ntwo\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));
    git(src, "add", "target.txt", "link.txt");
    git(src, "commit", "-qm", "feature");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "one\ntwo\n");
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "one\ntwo\n");
    assertNoSymlinks(tgt);
    assertNoGitMetadata(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: ignores out-of-diff filter failures", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, ".gitattributes"), "bad.txt filter=fail\n");
    writeFileSync(path.join(src, "bad.txt"), "bad\n");
    writeFileSync(path.join(src, "keep.txt"), "base\n");
    git(src, "config", "filter.fail.clean", "cat");
    git(src, "config", "filter.fail.smudge", "/bin/false");
    git(src, "config", "filter.fail.required", "true");
    git(src, "add", ".gitattributes", "bad.txt", "keep.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "keep.txt"), "feature\n");
    git(src, "add", "keep.txt");
    git(src, "commit", "-qm", "feature");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "keep.txt"), "utf8"), "feature\n");
    assert.equal(existsSync(path.join(tgt, "bad.txt")), false);
    assertNoSymlinks(tgt);
    assertNoGitMetadata(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: does not leave destination file when HEAD blob copy fails", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");

    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "broken.txt"), "broken\n");
    git(src, "add", "broken.txt");
    git(src, "commit", "-qm", "broken blob");
    const raw = git(src, "ls-tree", "HEAD", "--", "broken.txt").trim();
    const objectId = raw.split(/\s+/)[2];
    removeGitObject(src, objectId);

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /scope_population_failed/,
    );
    assert.equal(existsSync(path.join(tgt, "broken.txt")), false,
      "failed HEAD blob copy must not leave a partial destination file");
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: does not create checkout temp directories on HEAD blob failure", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const parent = path.dirname(tgt);
  const prefix = `${path.basename(tgt)}-head-`;
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");

    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "broken.txt"), "broken\n");
    git(src, "add", "broken.txt");
    git(src, "commit", "-qm", "broken blob");
    const raw = git(src, "ls-tree", "HEAD", "--", "broken.txt").trim();
    const objectId = raw.split(/\s+/)[2];
    removeGitObject(src, objectId);

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /scope_population_failed/,
    );
    assert.deepEqual(
      readdirSync(parent).filter((name) => name.startsWith(prefix)),
      [],
      "object-pure branch-diff must not create checkout temp directories",
    );
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

test("populateScope scope=branch-diff: skips submodule entries", () => {
  const src = seedRepo();
  const submoduleRepo = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "seed.txt"), "seed\n");
    git(src, "add", "seed.txt");
    git(src, "commit", "-qm", "main");
    writeFileSync(path.join(submoduleRepo, "sub.txt"), "sub\n");
    git(submoduleRepo, "add", "sub.txt");
    git(submoduleRepo, "commit", "-qm", "sub");

    git(src, "checkout", "-qb", "feature");
    git(src, "-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleRepo, "sub");
    git(src, "commit", "-qm", "add submodule");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(existsSync(path.join(tgt, "sub")), false,
      "branch-diff must not materialize gitlink entries as text files");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, submoduleRepo, tgt);
  }
});

test("populateScope scope=branch-diff: rejects symlink to submodule entry", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "seed.txt"), "seed\n");
    git(src, "add", "seed.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    const commitObject = git(src, "rev-parse", "HEAD").trim();
    git(src, "update-index", "--add", "--cacheinfo", `160000,${commitObject},submodule`);
    symlinkSync("submodule", path.join(src, "submodule-link.txt"));
    git(src, "add", "submodule-link.txt");
    git(src, "commit", "-qm", "symlink to gitlink");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: rejects relative symlink escaping source root", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "main", "--allow-empty");
    git(src, "checkout", "-qb", "feature");
    mkdirSync(path.join(src, "nested"));
    symlinkSync("../../secret.txt", path.join(src, "nested", "escape.txt"));
    git(src, "add", "nested/escape.txt");
    git(src, "commit", "-qm", "relative escape symlink");

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
      /scope_base_missing/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: throws scope_base_missing when base has no merge-base with HEAD", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "main.txt"), "main\n");
    git(src, "add", "main.txt");
    git(src, "commit", "-qm", "main");
    git(src, "checkout", "--orphan", "feature");
    rmSync(path.join(src, "main.txt"), { force: true });
    writeFileSync(path.join(src, "feature.txt"), "feature\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "feature");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /scope_base_missing/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: ignores grafts that connect unrelated histories", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "main.txt"), "main\n");
    git(src, "add", "main.txt");
    git(src, "commit", "-qm", "main");
    const mainCommit = git(src, "rev-parse", "main").trim();

    git(src, "checkout", "--orphan", "feature");
    rmSync(path.join(src, "main.txt"), { force: true });
    writeFileSync(path.join(src, "feature.txt"), "FEATURE\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "feature");
    const featureCommit = git(src, "rev-parse", "HEAD").trim();

    mkdirSync(path.join(src, ".git", "info"), { recursive: true });
    writeFileSync(path.join(src, ".git", "info", "grafts"), `${featureCommit} ${mainCommit}\n`);

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /scope_base_missing/,
    );
    assertEmptyOrMissing(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: ignores inherited namespace, shallow, and discovery env", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const envRoot = mkdtempSync(path.join(tmpdir(), "scope-branch-env-"));
  const old = {
    GIT_NAMESPACE: process.env.GIT_NAMESPACE,
    GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM,
    GIT_SHALLOW_FILE: process.env.GIT_SHALLOW_FILE,
  };
  try {
    writeFileSync(path.join(src, "target.txt"), "BASE\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    writeFileSync(path.join(src, "target.txt"), "HEAD\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "feature");

    process.env.GIT_NAMESPACE = "evil";
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(src);
    process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = "false";
    process.env.GIT_SHALLOW_FILE = path.join(envRoot, "shallow");
    writeFileSync(process.env.GIT_SHALLOW_FILE, `${git(src, "rev-parse", "HEAD").trim()}\n`);

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "HEAD\n");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(src, tgt, envRoot);
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

test("populateScope scope=branch-diff: safe HEAD absolute symlink chain ignores dirty live unsafe hop", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(src, "target.txt"), "head-safe\n");
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync("target.txt", path.join(src, "link2.txt"));
    git(src, "add", "target.txt", "link2.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync(path.join(src, "link2.txt"), path.join(src, "link1.txt"));
    git(src, "add", "link1.txt");
    git(src, "commit", "-qm", "add link1");
    rmSync(path.join(src, "link2.txt"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "link2.txt"));

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(lstatSync(path.join(tgt, "link1.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link1.txt"), "utf8"), "head-safe\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt, outside);
  }
});

test("populateScope scope=branch-diff: subdirectory sourceCwd resolves absolute HEAD symlinks within that subdirectory", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, "sub", "target.txt"), "head-subdir-link\n");
    git(src, "add", "sub/target.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync(path.join(src, "sub", "target.txt"), path.join(src, "sub", "abs-link.txt"));
    git(src, "add", "sub/abs-link.txt");
    git(src, "commit", "-qm", "add subdir symlink");
    writeFileSync(path.join(src, "sub", "target.txt"), "dirty-live\n");

    populateScope(profile("branch-diff"), path.join(src, "sub"), tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "head-subdir-link\n");
    assert.equal(existsSync(path.join(tgt, "sub")), false, "subdirectory sourceCwd should not preserve repo-root prefix");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: symlinked subdirectory sourceCwd resolves absolute HEAD symlinks", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "sub"));
    const { aliasParent, alias } = sourceSubdirViaSymlink(src);
    try {
      writeFileSync(path.join(src, "sub", "target.txt"), "branch-symlinked-subdir\n");
      git(src, "add", "sub/target.txt");
      git(src, "commit", "-qm", "main");

      git(src, "checkout", "-qb", "feature");
      symlinkSync(path.join(alias, "target.txt"), path.join(src, "sub", "abs-link.txt"));
      git(src, "add", "sub/abs-link.txt");
      git(src, "commit", "-qm", "add symlink");
      writeFileSync(path.join(src, "sub", "target.txt"), "dirty-live\n");

      populateScope(profile("branch-diff"), alias, tgt, { scopeBase: "main" });

      assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "branch-symlinked-subdir\n");
      assertNoSymlinks(tgt);
      assertNoGitMetadata(tgt);
    } finally {
      cleanup(aliasParent);
    }
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: subdirectory sourceCwd rejects absolute HEAD symlink to repo path outside subdirectory", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, "outside.txt"), "outside\n");
    git(src, "add", "outside.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync(path.join(src, "outside.txt"), path.join(src, "sub", "escape.txt"));
    git(src, "add", "sub/escape.txt");
    git(src, "commit", "-qm", "add escaping symlink");

    assert.throws(
      () => populateScope(profile("branch-diff"), path.join(src, "sub"), tgt, { scopeBase: "main" }),
      /unsafe_symlink/,
    );
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: absolute symlink target resolves unchanged HEAD symlink parent", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "through-head-parent\n");
    symlinkSync(".", path.join(src, "mid"));
    git(src, "add", "target.txt", "mid");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync(path.join(src, "mid", "target.txt"), path.join(src, "abs-link.txt"));
    git(src, "add", "abs-link.txt");
    git(src, "commit", "-qm", "add abs link");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "through-head-parent\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: absolute symlink target resolves unchanged HEAD symlink parent to directory", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "dir"));
    writeFileSync(path.join(src, "dir", "target.txt"), "through-head-dir-parent\n");
    symlinkSync("dir", path.join(src, "mid"));
    git(src, "add", "dir/target.txt", "mid");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync(path.join(src, "mid", "target.txt"), path.join(src, "abs-link.txt"));
    git(src, "add", "abs-link.txt");
    git(src, "commit", "-qm", "add abs link");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "through-head-dir-parent\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: absolute symlink dotdot resolves after HEAD symlink parent", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    mkdirSync(path.join(src, "dir"));
    mkdirSync(path.join(src, "dir", "sub"));
    writeFileSync(path.join(src, "dir", "sub", "keep.txt"), "keep\n");
    writeFileSync(path.join(src, "dir", "target.txt"), "dir-target\n");
    writeFileSync(path.join(src, "target.txt"), "root-target\n");
    symlinkSync("dir/sub", path.join(src, "mid"));
    git(src, "add", "dir/sub/keep.txt", "dir/target.txt", "target.txt", "mid");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync(`${src}${path.sep}mid${path.sep}..${path.sep}target.txt`, path.join(src, "abs-link.txt"));
    git(src, "add", "abs-link.txt");
    git(src, "commit", "-qm", "add abs link");

    populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" });

    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "dir-target\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=branch-diff: rejects absolute symlink through unrelated live alias", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const { aliasParent, alias } = sourceViaSymlink(src);
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync(path.join(alias, "target.txt"), path.join(src, "abs-link.txt"));
    git(src, "add", "abs-link.txt");
    git(src, "commit", "-qm", "add alias link");

    assert.throws(
      () => populateScope(profile("branch-diff"), src, tgt, { scopeBase: "main" }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt, aliasParent);
  }
});

test("populateScope scope=branch-diff: unsafe HEAD absolute symlink chain ignores dirty live safe hop", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(src, "target.txt"), "live-safe\n");
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "link2.txt"));
    git(src, "add", "target.txt", "link2.txt");
    git(src, "commit", "-qm", "main");

    git(src, "checkout", "-qb", "feature");
    symlinkSync(path.join(src, "link2.txt"), path.join(src, "link1.txt"));
    git(src, "add", "link1.txt");
    git(src, "commit", "-qm", "add link1");
    rmSync(path.join(src, "link2.txt"));
    symlinkSync("target.txt", path.join(src, "link2.txt"));

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
      /scope_requires_git/,
    );
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: requires a committed HEAD", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /scope_requires_head/,
    );
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: rejects malicious HEAD .git path components", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    const malicious = maliciousDotGitCommit(src);
    git(src, "update-ref", "HEAD", malicious);

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /scope_population_failed/,
    );
    assertEmptyOrMissing(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: rejects malicious HEAD .git path components case-insensitively", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    const malicious = maliciousDotGitCommit(src, null, ".Git");
    git(src, "update-ref", "HEAD", malicious);

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /scope_population_failed/,
    );
    assertEmptyOrMissing(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: cannot construct regular tree entries from non-blob objects", () => {
  const src = seedRepo();
  try {
    writeFileSync(path.join(src, "seed.txt"), "seed\n");
    git(src, "add", "seed.txt");
    git(src, "commit", "-qm", "seed");
    const commitObject = git(src, "rev-parse", "HEAD").trim();

    assert.throws(
      () => gitStdin(src, `100644 blob ${commitObject}\tbad.txt\n`, "mktree"),
      /object .* is a commit but specified type was \(blob\)|object type \(commit\) doesn't match mode type \(blob\)/,
    );
  } finally {
    cleanup(src);
  }
});

test("populateScope scope=head: materializes raw HEAD snapshot", () => {
  const src = seedRepo();
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
    assertNoGitMetadata(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: skips submodule entries", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeFileSync(path.join(src, "seed.txt"), "seed\n");
    git(src, "add", "seed.txt");
    git(src, "commit", "-qm", "seed");
    const commitObject = git(src, "rev-parse", "HEAD").trim();
    git(src, "update-index", "--add", "--cacheinfo", `160000,${commitObject},vendor/submodule`);
    git(src, "commit", "-qm", "add gitlink");

    populateScope(profile("head"), src, tgt);

    assert.equal(existsSync(path.join(tgt, "vendor/submodule")), false,
      "head scope must not materialize gitlink entries as text files");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: ignores replace refs for regular blobs", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeFileSync(path.join(src, "target.txt"), "ORIGINAL\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "seed");
    const object = git(src, "rev-parse", "HEAD:target.txt").trim();
    replaceObjectWithBlob(src, object, "REPLACED\n");

    populateScope(profile("head"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "ORIGINAL\n");
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: handles high-cardinality path lists without argv E2BIG", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    const rels = writeLongPathFiles(src);
    git(src, "add", ".");
    git(src, "commit", "-qm", "many files");

    populateScope(profile("head"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, rels.at(-1)), "utf8"), `${rels.length - 1}\n`);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: preserves executable mode for regular files", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    const executable = path.join(src, "run.sh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    git(src, "add", "run.sh");
    git(src, "commit", "-qm", "head executable");

    populateScope(profile("head"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "run.sh")).mode & 0o777, 0o755);
    assertNoSymlinks(tgt);
    assertNoGitMetadata(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: materializes safe symlink chains from HEAD content", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeFileSync(path.join(src, "target.txt"), "head-chain\n");
    symlinkSync("target.txt", path.join(src, "link2.txt"));
    symlinkSync("link2.txt", path.join(src, "link1.txt"));
    git(src, "add", "target.txt", "link2.txt", "link1.txt");
    git(src, "commit", "-qm", "symlink chain");
    writeFileSync(path.join(src, "target.txt"), "dirty-live\n");

    populateScope(profile("head"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "link1.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link1.txt"), "utf8"), "head-chain\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: ignores replace refs for symlink blobs", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));
    git(src, "add", "target.txt", "link.txt");
    git(src, "commit", "-qm", "seed");
    const object = git(src, "rev-parse", "HEAD:link.txt").trim();
    replaceObjectWithBlob(src, object, "missing.txt");

    populateScope(profile("head"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "target\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: materializes symlink blobs when core.symlinks=false", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    git(src, "config", "core.symlinks", "false");
    writeFileSync(path.join(src, "target.txt"), "head-target\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));
    git(src, "add", "target.txt", "link.txt");
    git(src, "commit", "-qm", "core symlinks false");

    populateScope(profile("head"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "head-target\n");
    assertNoSymlinks(tgt);
    assertNoGitMetadata(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: materializes symlink target through HEAD directory", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "dir"));
    writeFileSync(path.join(src, "dir", "target.txt"), "head-dir\n");
    symlinkSync("dir/target.txt", path.join(src, "link.txt"));
    git(src, "add", "dir/target.txt", "link.txt");
    git(src, "commit", "-qm", "dir symlink");

    populateScope(profile("head"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "head-dir\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: materializes symlink targets larger than exec buffer", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeLargeFile(path.join(src, "large.bin"));
    symlinkSync("large.bin", path.join(src, "large-link.bin"));
    git(src, "add", "large.bin", "large-link.bin");
    git(src, "commit", "-qm", "large symlink");

    populateScope(profile("head"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "large-link.bin")).isSymbolicLink(), false);
    assert.equal(lstatSync(path.join(tgt, "large-link.bin")).size, 64 * 1024 * 1024 + 1);
    assertSameFileBytes(path.join(tgt, "large-link.bin"), path.join(src, "large.bin"));
    assertNoSymlinks(tgt);
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
    cleanup(src, parent);
  }
});

test("populateScope scope=head: does not apply checkout attributes to regular files or symlink targets", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    writeFileSync(path.join(src, ".gitattributes"), "*.txt text eol=crlf\n");
    writeFileSync(path.join(src, "target.txt"), "one\ntwo\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));
    git(src, "add", ".gitattributes", "target.txt", "link.txt");
    git(src, "commit", "-qm", "object-pure attributes");

    populateScope(profile("head"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "one\ntwo\n");
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "one\ntwo\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: does not execute HEAD filter drivers", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  const witnessRoot = mkdtempSync(path.join(tmpdir(), "scope-filter-witness-"));
  const witness = path.join(witnessRoot, "ran");
  try {
    writeFileSync(path.join(src, "smudge.sh"), `#!/bin/sh\nprintf 'HEAD-SMUDGED\\n'\ntouch ${witness}\n`);
    chmodSync(path.join(src, "smudge.sh"), 0o755);
    git(src, "config", "filter.rel.clean", "cat");
    git(src, "config", "filter.rel.smudge", "sh ./smudge.sh");
    git(src, "config", "filter.rel.required", "true");
    writeFileSync(path.join(src, ".gitattributes"), "*.txt filter=rel\n");
    writeFileSync(path.join(src, "target.txt"), "head\n");
    git(src, "add", ".gitattributes", "target.txt", "smudge.sh");
    git(src, "commit", "-qm", "head filter");
    writeFileSync(path.join(src, "smudge.sh"), "#!/bin/sh\nprintf 'DIRTY-LIVE\\n'\n");

    populateScope(profile("head"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "head\n");
    assert.equal(existsSync(witness), false);
  } finally {
    cleanup(src, parent, witnessRoot);
  }
});

test("populateScope scope=head: ignores global attributes", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  const envRoot = mkdtempSync(path.join(tmpdir(), "scope-git-env-"));
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    writeFileSync(path.join(envRoot, "attrs"), "*.txt filter=leak\n");
    writeFileSync(path.join(envRoot, "smudge.sh"), "#!/bin/sh\nprintf 'GLOBAL-LEAK\\n'\n");
    chmodSync(path.join(envRoot, "smudge.sh"), 0o755);
    writeFileSync(path.join(envRoot, "config"), `[core]\n\tattributesFile = ${path.join(envRoot, "attrs")}\n[filter "leak"]\n\tclean = cat\n\tsmudge = sh ${path.join(envRoot, "smudge.sh")}\n\trequired = true\n`);
    process.env.GIT_CONFIG_GLOBAL = path.join(envRoot, "config");

    writeFileSync(path.join(src, "target.txt"), "head\n");
    git(src, "add", "target.txt");
    git(src, "commit", "-qm", "head");

    populateScope(profile("head"), src, tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "head\n");
  } finally {
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
    cleanup(src, parent, envRoot);
  }
});

test("populateScope scope=head: subdirectory sourceCwd snapshots HEAD paths relative to that subdirectory", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, "sub", "target.txt"), "head-subdir\n");
    symlinkSync(path.join(src, "sub", "target.txt"), path.join(src, "sub", "abs-link.txt"));
    writeFileSync(path.join(src, "outside.txt"), "outside\n");
    git(src, "add", "sub/target.txt", "sub/abs-link.txt", "outside.txt");
    git(src, "commit", "-qm", "subdir head");
    writeFileSync(path.join(src, "sub", "target.txt"), "dirty-live\n");

    populateScope(profile("head"), path.join(src, "sub"), tgt);

    assert.equal(readFileSync(path.join(tgt, "target.txt"), "utf8"), "head-subdir\n");
    assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "head-subdir\n");
    assert.equal(existsSync(path.join(tgt, "sub")), false, "subdirectory sourceCwd should not preserve repo-root prefix");
    assert.equal(existsSync(path.join(tgt, "outside.txt")), false, "head scope must not include files outside sourceCwd");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: symlinked subdirectory sourceCwd accepts absolute in-source symlink", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "sub"));
    const { aliasParent, alias } = sourceSubdirViaSymlink(src);
    try {
      writeFileSync(path.join(src, "sub", "target.txt"), "head-symlinked-subdir\n");
      symlinkSync(path.join(alias, "target.txt"), path.join(src, "sub", "abs-link.txt"));
      git(src, "add", "sub/target.txt", "sub/abs-link.txt");
      git(src, "commit", "-qm", "symlinked subdir head");
      writeFileSync(path.join(src, "sub", "target.txt"), "dirty-live\n");

      populateScope(profile("head"), alias, tgt);

      assert.equal(readFileSync(path.join(tgt, "abs-link.txt"), "utf8"), "head-symlinked-subdir\n");
      assertNoSymlinks(tgt);
      assertNoGitMetadata(tgt);
    } finally {
      cleanup(aliasParent);
    }
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: subdirectory sourceCwd ignores out-of-scope filter config", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, ".gitattributes"), "bad.txt filter=fail\n");
    writeFileSync(path.join(src, "bad.txt"), "bad\n");
    writeFileSync(path.join(src, "sub", "keep.txt"), "keep\n");
    git(src, "config", "filter.fail.clean", "cat");
    git(src, "config", "filter.fail.smudge", "/bin/false");
    git(src, "config", "filter.fail.required", "true");
    git(src, "add", ".gitattributes", "bad.txt", "sub/keep.txt");
    git(src, "commit", "-qm", "filter outside subdir");

    populateScope(profile("head"), path.join(src, "sub"), tgt);

    assert.equal(readFileSync(path.join(tgt, "keep.txt"), "utf8"), "keep\n");
    assert.equal(existsSync(path.join(tgt, "bad.txt")), false);
    assertNoSymlinks(tgt);
    assertNoGitMetadata(tgt);
  } finally {
    cleanup(src, parent);
  }
});

test("populateScope scope=head: subdirectory sourceCwd rejects absolute HEAD symlink to repo path outside subdirectory", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "sub"));
    writeFileSync(path.join(src, "outside.txt"), "outside\n");
    symlinkSync(path.join(src, "outside.txt"), path.join(src, "sub", "escape.txt"));
    git(src, "add", "outside.txt", "sub/escape.txt");
    git(src, "commit", "-qm", "escaping head symlink");

    assert.throws(
      () => populateScope(profile("head"), path.join(src, "sub"), tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinks(tgt);
  } finally {
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
    cleanup(src, parent, aliasParent);
  }
});

test("populateScope scope=head: safe HEAD absolute symlink chain ignores dirty live unsafe hop", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(src, "target.txt"), "head-safe\n");
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(src, "link2.txt"), path.join(src, "link1.txt"));
    symlinkSync("target.txt", path.join(src, "link2.txt"));
    git(src, "add", "target.txt", "link1.txt", "link2.txt");
    git(src, "commit", "-qm", "safe head");
    rmSync(path.join(src, "link2.txt"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "link2.txt"));

    populateScope(profile("head"), src, tgt);

    assert.equal(lstatSync(path.join(tgt, "link1.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link1.txt"), "utf8"), "head-safe\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, parent, outside);
  }
});

test("populateScope scope=head: unsafe HEAD absolute symlink chain ignores dirty live safe hop", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    writeFileSync(path.join(src, "target.txt"), "live-safe\n");
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync(path.join(src, "link2.txt"), path.join(src, "link1.txt"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(src, "link2.txt"));
    git(src, "add", "target.txt", "link1.txt", "link2.txt");
    git(src, "commit", "-qm", "unsafe head");
    rmSync(path.join(src, "link2.txt"));
    symlinkSync("target.txt", path.join(src, "link2.txt"));

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, parent, outside);
  }
});

test("populateScope scope=head: rejects absolute symlink through unrelated live alias", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  const { aliasParent, alias } = sourceViaSymlink(src);
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync(path.join(alias, "target.txt"), path.join(src, "abs-link.txt"));
    git(src, "add", "target.txt", "abs-link.txt");
    git(src, "commit", "-qm", "alias link");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
  } finally {
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
    cleanup(src, parent);
  }
});

test("populateScope scope=head: removes partial target after unsafe symlink failure", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "target-dir"));
    writeFileSync(path.join(src, "regular.txt"), "regular\n");
    writeFileSync(path.join(src, "target-dir/file.txt"), "nested\n");
    symlinkSync("target-dir", path.join(src, "dir-link"));
    git(src, "add", "regular.txt", "target-dir/file.txt", "dir-link");
    git(src, "commit", "-qm", "dir symlink");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
    assertEmptyOrMissing(tgt);
  } finally {
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
    cleanup(src, parent, outside);
  }
});

test("populateScope scope=head: rejects relative symlink escaping source root", () => {
  const src = seedRepo();
  const parent = mkdtempSync(path.join(tmpdir(), "scope-head-parent-"));
  const tgt = path.join(parent, "wt");
  try {
    mkdirSync(path.join(src, "nested"));
    symlinkSync("../../secret.txt", path.join(src, "nested", "escape.txt"));
    git(src, "add", "nested/escape.txt");
    git(src, "commit", "-qm", "relative escape symlink");

    assert.throws(
      () => populateScope(profile("head"), src, tgt),
      /unsafe_symlink/,
    );
    assertNoSymlinkAt(path.join(tgt, "nested", "escape.txt"));
  } finally {
    cleanup(src, parent);
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

test("populateScope scope=custom: treats glob brackets as literals", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "[abc].md"), "literal\n");
    writeFileSync(path.join(src, "a.md"), "class\n");

    populateScope(profile("custom"), src, tgt, {
      scopePaths: ["[abc].md"],
    });

    assert.equal(readFileSync(path.join(tgt, "[abc].md"), "utf8"), "literal\n");
    assert.equal(existsSync(path.join(tgt, "a.md")), false);
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

test("populateScope scope=custom: supports question mark and globstar-root patterns", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "file1.txt"), "one\n");
    writeFileSync(path.join(src, "file-long.txt"), "long\n");
    writeFileSync(path.join(src, "root.js"), "root\n");
    mkdirSync(path.join(src, "nested"));
    writeFileSync(path.join(src, "nested", "deep.js"), "deep\n");
    git(src, "add", ".");
    git(src, "commit", "-qm", "seed");

    populateScope(profile("custom"), src, tgt, {
      scopePaths: ["file?.txt", "**/*.js"],
    });

    assert.equal(readFileSync(path.join(tgt, "file1.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(path.join(tgt, "root.js"), "utf8"), "root\n");
    assert.equal(readFileSync(path.join(tgt, "nested", "deep.js"), "utf8"), "deep\n");
    assert.equal(existsSync(path.join(tgt, "file-long.txt")), false);
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

test("populateScope scope=custom: materializes non-git in-tree file symlinks", () => {
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  try {
    writeFileSync(path.join(src, "target.txt"), "target\n");
    symlinkSync("target.txt", path.join(src, "link.txt"));

    populateScope(profile("custom"), src, tgt, {
      scopePaths: ["link.txt"],
    });

    assert.equal(lstatSync(path.join(tgt, "link.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(tgt, "link.txt"), "utf8"), "target\n");
    assertNoSymlinks(tgt);
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope scope=custom: rejects non-git symlink escaping source root", () => {
  const src = mkdtempSync(path.join(tmpdir(), "scope-src-nongit-"));
  const tgt = mkTarget();
  const outside = mkdtempSync(path.join(tmpdir(), "scope-outside-"));
  try {
    mkdirSync(path.join(src, "nested"));
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    symlinkSync("../../" + path.basename(outside) + "/secret.txt", path.join(src, "nested", "escape.txt"));

    assert.throws(
      () => populateScope(profile("custom"), src, tgt, { scopePaths: ["nested/escape.txt"] }),
      /unsafe_symlink/,
    );
  } finally {
    cleanup(src, tgt, outside);
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

test("populateScope scope=custom: throws scope_paths_required when glob list is empty", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    git(src, "commit", "-qm", "empty", "--allow-empty");
    assert.throws(
      () => populateScope(profile("custom"), src, tgt, { scopePaths: [] }),
      /scope_paths_required/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope containment=none: no-op for equivalent source and target paths", () => {
  const src = seedRepo();
  try {
    writeFileSync(path.join(src, "A.txt"), "a\n");
    mkdirSync(path.join(src, "dir-target"));
    symlinkSync("dir-target", path.join(src, "dir-link"));
    git(src, "add", ".");
    git(src, "commit", "-qm", "seed");
    // When containment=none the caller passes sourceCwd as targetPath. The
    // function must detect path-equivalent forms and do nothing.
    const profileNone = Object.freeze({
      name: "rescue", containment: "none", scope: "working-tree", dispose_default: false,
    });
    // Should not throw.
    populateScope(profileNone, src, src + path.sep);
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
      /invalid_profile: unknown scope/,
    );
  } finally {
    cleanup(src, tgt);
  }
});

test("populateScope: missing profile throws", () => {
  const src = seedRepo();
  const tgt = mkTarget();
  try {
    assert.throws(
      () => populateScope(null, src, tgt),
      /invalid_profile: profile.scope is required/,
    );
  } finally {
    cleanup(src, tgt);
  }
});
