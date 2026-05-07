import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "../../plugins/claude/scripts/lib/workspace.mjs";
import { GIT_BINARY_ENV } from "../../plugins/claude/scripts/lib/git-binary.mjs";
// PR #21 review HIGH 5: this file used to call execSync("git ...") with raw
// process.env so a parent GIT_DIR override would hijack the fixture init
// into the caller checkout. Route every fixture git through the scrubbed
// helper.
import { fixtureSeedRepo } from "../helpers/fixture-git.mjs";

function makeGitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "workspace-test-"));
  fixtureSeedRepo(dir, { fileName: "seed", fileContents: "" });
  return dir;
}

test("resolveWorkspaceRoot: returns git root when called from repo root", () => {
  const repo = makeGitRepo();
  try {
    const root = resolveWorkspaceRoot(repo);
    // `git init` on macOS sometimes resolves via /private/var -> /var symlink.
    assert.ok(
      root === repo || root.endsWith(path.basename(repo)),
      `expected root to match ${repo}, got ${root}`
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveWorkspaceRoot: returns git root when called from subdir", () => {
  const repo = makeGitRepo();
  try {
    const sub = path.join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    const root = resolveWorkspaceRoot(sub);
    assert.ok(
      root === repo || root.endsWith(path.basename(repo)),
      `expected root to match ${repo}, got ${root}`
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveWorkspaceRoot: falls back to cwd when not in git repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workspace-nogit-"));
  try {
    const root = resolveWorkspaceRoot(dir);
    // Same macOS-symlink tolerance as the git-repo tests (/private/var → /var).
    assert.ok(
      root === dir || root.endsWith(path.basename(dir)),
      `expected fallback to cwd ${dir}, got ${root}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorkspaceRoot: preserves Git binary policy errors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-git-policy-"));
  const previous = process.env[GIT_BINARY_ENV];
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const git = path.join(workspace, "git");
    writeFileSync(git, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(git, 0o700);
    process.env[GIT_BINARY_ENV] = git;
    assert.throws(
      () => resolveWorkspaceRoot(outside),
      /requires a workspace boundary/,
    );
  } finally {
    if (previous === undefined) delete process.env[GIT_BINARY_ENV];
    else process.env[GIT_BINARY_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkspaceRoot: rejects symlinked cwd before executing workspace-local override", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-git-symlink-policy-"));
  const previous = process.env[GIT_BINARY_ENV];
  try {
    const workspace = path.join(root, "workspace");
    const linkedRepo = path.join(root, "linked-repo");
    mkdirSync(path.join(workspace, ".git"), { recursive: true });
    mkdirSync(path.join(linkedRepo, ".git"), { recursive: true });
    const marker = path.join(root, "executed");
    const git = path.join(workspace, "git");
    writeFileSync(git, `#!/bin/sh\necho executed > ${JSON.stringify(marker)}\necho ${JSON.stringify(linkedRepo)}\nexit 0\n`, "utf8");
    chmodSync(git, 0o700);
    symlinkSync(linkedRepo, path.join(workspace, "link"));
    process.env[GIT_BINARY_ENV] = git;

    assert.throws(
      () => resolveWorkspaceRoot(path.join(workspace, "link")),
      /must not point inside the current workspace/,
    );
    assert.equal(existsSync(marker), false, "rejected git override must not execute");
  } finally {
    if (previous === undefined) delete process.env[GIT_BINARY_ENV];
    else process.env[GIT_BINARY_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
