import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureGitEnv } from "../helpers/fixture-git.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const COMPANIONS = Object.freeze([
  {
    target: "claude",
    script: path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"),
    dataEnv: "CLAUDE_PLUGIN_DATA",
  },
  {
    target: "gemini",
    script: path.join(REPO_ROOT, "plugins/gemini/scripts/gemini-companion.mjs"),
    dataEnv: "GEMINI_PLUGIN_DATA",
  },
  {
    target: "kimi",
    script: path.join(REPO_ROOT, "plugins/kimi/scripts/kimi-companion.mjs"),
    dataEnv: "KIMI_PLUGIN_DATA",
  },
]);

function cleanup(...paths) {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
}

function git(cwd, ...args) {
  const res = spawnSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: fixtureGitEnv(),
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function seedBranchDiffRepo() {
  const cwd = mkdtempSync(path.join(tmpdir(), "external-review-default-ux-"));
  git(cwd, "init", "-q", "-b", "main");
  writeFileSync(path.join(cwd, ".gitignore"), ".claude/\n");
  writeFileSync(path.join(cwd, "feature.md"), "base\n");
  writeFileSync(path.join(cwd, "old.md"), "base old\n");
  git(cwd, "add", ".gitignore", "feature.md", "old.md");
  git(cwd, "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  writeFileSync(path.join(cwd, "feature.md"), "head\n");
  git(cwd, "add", "feature.md");
  git(cwd, "commit", "-qm", "head");
  return { cwd, base };
}

function addDirtyWorkingTreeAndIgnoredClaudeSymlink(cwd) {
  writeFileSync(path.join(cwd, "old.md"), "dirty old\n");
  const embeddedWorktree = path.join(cwd, ".claude/worktrees/agent-a");
  mkdirSync(embeddedWorktree, { recursive: true });
  git(embeddedWorktree, "init", "-q", "-b", "main");
  writeFileSync(path.join(embeddedWorktree, "README.md"), "nested ignored repo\n");
  git(embeddedWorktree, "add", "README.md");
  git(embeddedWorktree, "commit", "-qm", "nested ignored repo");
  const ignoredDir = path.join(embeddedWorktree, "node_modules/@codex-plugin-multi");
  mkdirSync(ignoredDir, { recursive: true });
  symlinkSync(cwd, path.join(ignoredDir, "api-reviewers-plugin"), "dir");
}

function runPreflight(companion, cwd, args) {
  const dataDir = mkdtempSync(path.join(tmpdir(), `${companion.target}-preflight-data-`));
  const res = spawnSync("node", [companion.script, "preflight", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...fixtureGitEnv(),
      [companion.dataEnv]: dataDir,
    },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch (error) {
    throw new Error(`${companion.target} preflight did not emit JSON: ${error.message}\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  } finally {
    cleanup(dataDir);
  }
  return { ...res, json };
}

function workspaceStateDir(dataDir, cwd) {
  const workspaceRoot = realpathSync(cwd);
  const slug = (path.basename(workspaceRoot) || "workspace")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return path.join(dataDir, "state", `${slug}-${hash}`);
}

function writeRunningJobState(dataDir, cwd, job) {
  const stateDir = workspaceStateDir(dataDir, cwd);
  mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({
    version: 1,
    config: { stopReviewGate: false },
    jobs: [job],
  }, null, 2)}\n`);
}

function runCancel(companion, cwd, dataDir, jobId) {
  const res = spawnSync("node", [companion.script, "cancel", "--job", jobId, "--cwd", cwd], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      [companion.dataEnv]: dataDir,
    },
  });
  return { ...res, json: JSON.parse(res.stdout) };
}

test("Claude/Gemini/Kimi review --scope-base selects branch-diff, not dirty working-tree scope", () => {
  for (const companion of COMPANIONS) {
    const { cwd, base } = seedBranchDiffRepo();
    try {
      writeFileSync(path.join(cwd, "old.md"), "dirty old\n");

      const res = runPreflight(companion, cwd, [
        "--mode=review",
        "--cwd", cwd,
        "--scope-base", base,
      ]);

      assert.equal(res.status, 0, `${companion.target}: ${res.stderr}`);
      assert.equal(res.json.ok, true, companion.target);
      assert.equal(res.json.scope, "branch-diff", companion.target);
      assert.deepEqual(res.json.files, ["feature.md"], companion.target);
      assert.equal(res.json.selected_scope_sent_to_provider, false, companion.target);
    } finally {
      cleanup(cwd);
    }
  }
});

test("Claude/Gemini/Kimi review with empty --scope-base preserves plain working-tree scope", () => {
  for (const companion of COMPANIONS) {
    const { cwd } = seedBranchDiffRepo();
    try {
      writeFileSync(path.join(cwd, "old.md"), "dirty old\n");

      const res = runPreflight(companion, cwd, [
        "--mode=review",
        "--cwd", cwd,
        "--scope-base", "",
      ]);

      assert.equal(res.status, 0, `${companion.target}: ${res.stderr}`);
      assert.equal(res.json.ok, true, companion.target);
      assert.equal(res.json.scope, "working-tree", companion.target);
      assert.ok(res.json.files.includes("old.md"), companion.target);
      assert.equal(res.json.selected_scope_sent_to_provider, false, companion.target);
    } finally {
      cleanup(cwd);
    }
  }
});

test("Claude/Gemini/Kimi plain review keeps working-tree scope and ignores .claude worktree debris", () => {
  for (const companion of COMPANIONS) {
    const { cwd } = seedBranchDiffRepo();
    try {
      addDirtyWorkingTreeAndIgnoredClaudeSymlink(cwd);

      const res = runPreflight(companion, cwd, [
        "--mode=review",
        "--cwd", cwd,
      ]);

      assert.equal(res.status, 0, `${companion.target}: ${res.stderr}`);
      assert.equal(res.json.ok, true, companion.target);
      assert.equal(res.json.scope, "working-tree", companion.target);
      assert.equal(res.json.selected_scope_sent_to_provider, false, companion.target);
      assert.ok(res.json.files.includes("feature.md"), companion.target);
      assert.ok(res.json.files.includes("old.md"), companion.target);
      assert.equal(
        res.json.files.some((file) => file.startsWith(".claude/")),
        false,
        `${companion.target}: ignored Claude worktree debris leaked into scope`,
      );
      assert.equal(existsSync(path.join(cwd, ".claude/worktrees/agent-a")), true);
    } finally {
      cleanup(cwd);
    }
  }
});

test("Claude/Gemini/Kimi preflight scope failure is explicit and source-free", () => {
  for (const companion of COMPANIONS) {
    const { cwd } = seedBranchDiffRepo();
    try {
      const res = runPreflight(companion, cwd, [
        "--mode=custom-review",
        "--cwd", cwd,
        "--scope-paths", "missing.md",
      ]);

      assert.equal(res.status, 2, companion.target);
      assert.equal(res.json.ok, false, companion.target);
      assert.equal(res.json.error, "scope_failed", companion.target);
      assert.equal(res.json.target_spawned, false, companion.target);
      assert.equal(res.json.selected_scope_sent_to_provider, false, companion.target);
      assert.match(res.json.disclosure_note, /was not spawned/i, companion.target);
      assert.match(res.json.disclosure_note, /no selected scope content was sent/i, companion.target);
    } finally {
      cleanup(cwd);
    }
  }
});

test("all foreground external review providers wire lifecycle heartbeats after launch", () => {
  for (const rel of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
  ]) {
    const source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.match(source, /externalReviewLaunchedEvent|external_review_launched/, rel);
    assert.match(source, /startExternalReviewHeartbeat|startLifecycleHeartbeat/, rel);
  }
});

test("Claude/Gemini/Kimi cancel surfaces process-inspection denial as unverifiable with next step", () => {
  for (const companion of COMPANIONS) {
    const cwd = mkdtempSync(path.join(tmpdir(), `${companion.target}-cancel-cwd-`));
    const dataDir = mkdtempSync(path.join(tmpdir(), `${companion.target}-cancel-data-`));
    const jobId = "11111111-2222-4333-8444-555555555555";
    try {
      writeRunningJobState(dataDir, cwd, {
        id: jobId,
        job_id: jobId,
        status: "running",
        updatedAt: new Date().toISOString(),
        pid_info: {
          pid: process.pid,
          starttime: null,
          argv0: null,
          capture_error: "capture_error: spawnSync /bin/ps EPERM",
        },
      });

      const res = runCancel(companion, cwd, dataDir, jobId);

      assert.equal(res.status, 2, companion.target);
      assert.equal(res.json.ok, false, companion.target);
      assert.equal(res.json.status, "unverifiable", companion.target);
      assert.equal(res.json.pid, process.pid, companion.target);
      assert.match(res.json.capture_error, /EPERM/, companion.target);
      assert.match(res.json.suggested_action, /less restricted shell|outside the sandbox/i, companion.target);
      assert.match(res.json.suggested_action, /ownership/i, companion.target);
    } finally {
      cleanup(cwd, dataDir);
    }
  }
});
