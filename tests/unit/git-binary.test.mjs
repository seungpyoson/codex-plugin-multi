import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_GIT_BINARY,
  GIT_BINARY_ENV,
  GIT_SAFE_PATH,
  gitEnv,
  isGitBinaryPolicyError,
  resolveGitBinary,
} from "../../plugins/claude/scripts/lib/git-binary.mjs";

function captureThrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("Expected function to throw");
}

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeExecutable(file, body = "#!/bin/sh\nexit 0\n") {
  writeFileSync(file, body, "utf8");
  chmodSync(file, 0o700);
}

test("resolveGitBinary defaults to the hardened system git path", () => {
  assert.equal(resolveGitBinary({ env: {} }), DEFAULT_GIT_BINARY);
  assert.equal(gitEnv({ PATH: "/hostile" }).PATH, GIT_SAFE_PATH);
});

test("isGitBinaryPolicyError identifies resolver policy errors", () => {
  assert.equal(isGitBinaryPolicyError(new Error(`${GIT_BINARY_ENV} must not point inside the current workspace.`)), true);
  assert.equal(isGitBinaryPolicyError(new Error("git_failed: not a git repository")), false);
  assert.equal(isGitBinaryPolicyError("CODEX_PLUGIN_MULTI_GIT_BINARY"), false);
});

test("resolveGitBinary rejects relative overrides", () => {
  assert.throws(
    () => resolveGitBinary({ env: { [GIT_BINARY_ENV]: "git" } }),
    /must be an absolute path/,
  );
});

test("resolveGitBinary rejects explicit overrides without a workspace boundary", () => {
  const trusted = tempDir("git-binary-no-cwd-");
  try {
    const trustedGit = path.join(trusted, "git");
    writeExecutable(trustedGit);
    assert.throws(
      () => resolveGitBinary({
        env: { [GIT_BINARY_ENV]: trustedGit },
      }),
      /requires a workspace boundary/,
    );
  } finally {
    rmSync(trusted, { recursive: true, force: true });
  }
});

test("resolveGitBinary rejects workspace-local overrides", () => {
  const workspace = tempDir("git-binary-workspace-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const localGit = path.join(workspace, "git");
    writeExecutable(localGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: localGit },
      }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("resolveGitBinary rejects overrides in a parent git workspace when cwd is a subdirectory", () => {
  const workspace = tempDir("git-binary-workspace-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const subdir = path.join(workspace, "nested", "cwd");
    mkdirSync(subdir, { recursive: true });
    const localGit = path.join(workspace, "git");
    writeExecutable(localGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: subdir,
        env: { [GIT_BINARY_ENV]: localGit },
      }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("resolveGitBinary does not let nested .git shrink the protected workspace", () => {
  const workspace = tempDir("git-binary-workspace-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const subdir = path.join(workspace, "nested", "cwd");
    mkdirSync(path.join(subdir, ".git"), { recursive: true });
    const localGit = path.join(workspace, "git");
    writeExecutable(localGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: subdir,
        env: { [GIT_BINARY_ENV]: localGit },
      }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("resolveGitBinary treats .git files as workspace boundaries", () => {
  const workspace = tempDir("git-binary-worktree-");
  try {
    writeFileSync(path.join(workspace, ".git"), "gitdir: /tmp/git-binary-worktree-gitdir\n", "utf8");
    const localGit = path.join(workspace, "git");
    writeExecutable(localGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: localGit },
      }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("resolveGitBinary requires a real workspace boundary before override validation", () => {
  const workspace = tempDir("git-binary-cache-boundary-");
  try {
    const cwd = path.join(workspace, "nested");
    mkdirSync(cwd);
    const localGit = path.join(workspace, "git");
    writeExecutable(localGit);
    assert.throws(
      () => resolveGitBinary({
        cwd,
        env: { [GIT_BINARY_ENV]: localGit },
      }),
      /requires a workspace boundary/,
    );
    mkdirSync(path.join(workspace, ".git"));
    assert.throws(
      () => resolveGitBinary({
        cwd,
        env: { [GIT_BINARY_ENV]: localGit },
      }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("resolveGitBinary returns cached executable paths for the same resolved context", () => {
  const workspace = tempDir("git-binary-cache-hit-workspace-");
  const trusted = tempDir("git-binary-cache-hit-trusted-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const trustedGit = path.join(trusted, "git");
    writeExecutable(trustedGit);
    const expected = realpathSync.native(trustedGit);
    const env = { [GIT_BINARY_ENV]: trustedGit };
    assert.equal(resolveGitBinary({ cwd: workspace, env }), expected);
    rmSync(trustedGit);
    assert.equal(resolveGitBinary({ cwd: workspace, env }), expected);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
  }
});

test("resolveGitBinary honors an explicit workspaceRoot option", () => {
  const workspace = tempDir("git-binary-explicit-root-");
  const cwd = tempDir("git-binary-explicit-cwd-");
  try {
    const localGit = path.join(workspace, "git");
    writeExecutable(localGit);
    assert.throws(
      () => resolveGitBinary({
        cwd,
        workspaceRoot: workspace,
        env: { [GIT_BINARY_ENV]: localGit },
      }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveGitBinary rechecks explicit workspaceRoot after an outside-cwd cache entry", () => {
  const workspace = tempDir("git-binary-explicit-cache-root-");
  const cwd = tempDir("git-binary-explicit-cache-cwd-");
  try {
    mkdirSync(path.join(cwd, ".git"));
    const localGit = path.join(workspace, "git");
    writeExecutable(localGit);
    const env = { [GIT_BINARY_ENV]: localGit };
    assert.equal(
      resolveGitBinary({ cwd, env }),
      realpathSync.native(localGit),
    );
    assert.throws(
      () => resolveGitBinary({ cwd, workspaceRoot: workspace, env }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveGitBinary rejects node_modules bin overrides", () => {
  const root = tempDir("git-binary-node-modules-");
  const workspace = tempDir("git-binary-workspace-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const binDir = path.join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const localGit = path.join(binDir, "git");
    writeExecutable(localGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: localGit },
      }),
      /must not point inside node_modules\/\.bin/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveGitBinary rejects directory overrides without leaking the path", () => {
  const workspace = tempDir("git-binary-workspace-");
  const trusted = tempDir("git-binary-directory-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const error = captureThrown(() =>
      resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: trusted },
      }),
    );
    assert.match(error.message, /must point to an executable regular file/);
    assert.doesNotMatch(error.message, new RegExp(trusted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
  }
});

test("resolveGitBinary rejects non-executable file overrides without leaking the path", () => {
  const workspace = tempDir("git-binary-workspace-");
  const trusted = tempDir("git-binary-non-exec-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const trustedGit = path.join(trusted, "git");
    writeFileSync(trustedGit, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(trustedGit, 0o600);
    const error = captureThrown(() =>
      resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: trustedGit },
      }),
    );
    assert.match(error.message, /must point to an executable regular file/);
    assert.doesNotMatch(error.message, new RegExp(trustedGit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
  }
});

test("resolveGitBinary rejects symlinked overrides that resolve inside the workspace", () => {
  const workspace = tempDir("git-binary-workspace-");
  const outside = tempDir("git-binary-outside-link-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const localGit = path.join(workspace, "git");
    writeExecutable(localGit);
    const linkGit = path.join(outside, "git");
    symlinkSync(localGit, linkGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: linkGit },
      }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveGitBinary rejects literal workspace-local symlink overrides even when target is outside", () => {
  const workspace = tempDir("git-binary-workspace-");
  const trusted = tempDir("git-binary-trusted-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    mkdirSync(path.join(workspace, "scripts"));
    const trustedGit = path.join(trusted, "git");
    writeExecutable(trustedGit);
    const linkGit = path.join(workspace, "scripts", "git");
    symlinkSync(trustedGit, linkGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: linkGit },
      }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
  }
});

test("resolveGitBinary rejects workspace-local overrides when cwd is a workspace symlink", () => {
  const workspace = tempDir("git-binary-workspace-");
  const linkedRepo = tempDir("git-binary-linked-repo-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    mkdirSync(path.join(linkedRepo, ".git"));
    const linkedCwd = path.join(workspace, "linked");
    symlinkSync(linkedRepo, linkedCwd);
    const localGit = path.join(workspace, "git");
    writeExecutable(localGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: linkedCwd,
        env: { [GIT_BINARY_ENV]: localGit },
      }),
      /must not point inside the current workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(linkedRepo, { recursive: true, force: true });
  }
});

test("resolveGitBinary rejects mixed-case node_modules bin overrides", () => {
  const workspace = tempDir("git-binary-workspace-");
  const packageRoot = tempDir("git-binary-package-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const binDir = path.join(packageRoot, "Node_Modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const packageGit = path.join(binDir, "git");
    writeExecutable(packageGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: packageGit },
      }),
      /must not point inside node_modules\/\.bin/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("resolveGitBinary accepts explicit executable overrides outside the workspace", () => {
  const workspace = tempDir("git-binary-workspace-");
  const trusted = tempDir("git-binary-trusted-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const trustedGit = path.join(trusted, "git");
    writeExecutable(trustedGit);
    assert.equal(
      resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: trustedGit },
      }),
      realpathSync.native(trustedGit),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
  }
});

test("resolveGitBinary accepts symlinked overrides that resolve outside the workspace", () => {
  const workspace = tempDir("git-binary-workspace-");
  const trusted = tempDir("git-binary-trusted-");
  const links = tempDir("git-binary-links-");
  try {
    mkdirSync(path.join(workspace, ".git"));
    const trustedGit = path.join(trusted, "git");
    writeExecutable(trustedGit);
    const linkGit = path.join(links, "git");
    symlinkSync(trustedGit, linkGit);
    assert.equal(
      resolveGitBinary({
        cwd: workspace,
        env: { [GIT_BINARY_ENV]: linkGit },
      }),
      realpathSync.native(trustedGit),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(trusted, { recursive: true, force: true });
    rmSync(links, { recursive: true, force: true });
  }
});

test("resolveGitBinary does not treat filesystem root as the current workspace", () => {
  const trusted = tempDir("git-binary-root-cwd-");
  try {
    const trustedGit = path.join(trusted, "git");
    writeExecutable(trustedGit);
    assert.throws(
      () => resolveGitBinary({
        cwd: path.parse(trusted).root,
        env: { [GIT_BINARY_ENV]: trustedGit },
      }),
      /requires a workspace boundary/,
    );
  } finally {
    rmSync(trusted, { recursive: true, force: true });
  }
});
