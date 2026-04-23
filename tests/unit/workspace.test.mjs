import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import { resolveWorkspaceRoot } from "../../plugins/claude/scripts/lib/workspace.mjs";

function makeGitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "workspace-test-"));
  execSync("git init -q", { cwd: dir });
  writeFileSync(path.join(dir, "seed"), "");
  execSync("git add seed && git -c user.email=t@t -c user.name=t commit -q -m seed", { cwd: dir });
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
