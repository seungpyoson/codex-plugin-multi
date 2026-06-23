import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findForeignSymlinks,
  parseLsFilesStage,
  collectTrackedSymlinks,
} from "../../scripts/ci/check-no-foreign-symlinks.mjs";
import { fixtureGit, fixtureGitEnv } from "../helpers/fixture-git.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK = path.join(REPO_ROOT, "scripts/ci/check-no-foreign-symlinks.mjs");

// ---------------------------------------------------------------------------
// Pure-function truth table — the recurrence-prevention logic for #247.
// ---------------------------------------------------------------------------

test("findForeignSymlinks: flags an absolute (machine-specific) target — the #247 bug", () => {
  const offenders = findForeignSymlinks([
    { path: "node_modules", target: "/Users/x/relay/node_modules" },
  ]);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].path, "node_modules");
  assert.match(offenders[0].reason, /absolute/);
});

test("findForeignSymlinks: flags Windows-drive and UNC absolute targets", () => {
  const offenders = findForeignSymlinks([
    { path: "a", target: "C:\\Windows\\system32" },
    { path: "b", target: "C:/Windows" },
    { path: "c", target: "\\\\server\\share" },
  ]);
  assert.equal(offenders.length, 3);
  for (const o of offenders) assert.match(o.reason, /absolute/);
});

test("findForeignSymlinks: flags relative targets that escape the repo root", () => {
  const offenders = findForeignSymlinks([
    { path: "link", target: "../outside" },
    { path: "a/b/link", target: "../../../etc/passwd" },
  ]);
  assert.equal(offenders.length, 2);
  for (const o of offenders) assert.match(o.reason, /escapes repo root/);
});

test("findForeignSymlinks: allows relative targets resolving inside the repo (the 2 legit links)", () => {
  const offenders = findForeignSymlinks([
    { path: "relay/relay-api-reviewers", target: "../plugins/api-reviewers" },
    { path: "tests/smoke/claude", target: "claude-mock.mjs" },
    { path: "a/b/c", target: "../d" }, // -> a/d, still inside
    { path: "x", target: "./y" }, // -> y, inside
  ]);
  assert.deepEqual(offenders, []);
});

test("parseLsFilesStage: parses mode/sha/path and tolerates spaces in paths", () => {
  const out =
    "120000 be9723c077bfb81c7747f25dfa964da1f3134e24 0\tnode_modules\n" +
    "100644 def4560000000000000000000000000000000000 0\tdir/some file.txt\n";
  assert.deepEqual(parseLsFilesStage(out), [
    { mode: "120000", sha: "be9723c077bfb81c7747f25dfa964da1f3134e24", path: "node_modules" },
    { mode: "100644", sha: "def4560000000000000000000000000000000000", path: "dir/some file.txt" },
  ]);
});

test("collectTrackedSymlinks: filters to mode 120000 and reads the blob target", () => {
  const lsFiles =
    "100644 aaa 0\treal.txt\n" +
    "120000 bbb 0\tlink-abs\n" +
    "120000 ccc 0\tsub/link-rel\n";
  const blobs = { bbb: "/abs/target\n", ccc: "../inside" };
  const runGit = (args) => {
    if (args[0] === "ls-files") return lsFiles;
    if (args[0] === "cat-file") return blobs[args[2]];
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  assert.deepEqual(collectTrackedSymlinks(runGit), [
    { path: "link-abs", target: "/abs/target" }, // trailing newline stripped
    { path: "sub/link-rel", target: "../inside" },
  ]);
});

// ---------------------------------------------------------------------------
// Integration — the CLI end-to-end against real git repos.
// ---------------------------------------------------------------------------

test("CLI passes on the real repo (the 2 legit relative symlinks resolve inside)", () => {
  const out = execFileSync("node", [CHECK], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: fixtureGitEnv(),
  });
  assert.match(out, /✓ All \d+ tracked symlink\(s\) resolve inside the repo/);
});

test("CLI exits non-zero and names the offender when a foreign symlink is committed (fail-on-revert)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foreign-symlink-"));
  try {
    fixtureGit(dir, ["init"]);
    fixtureGit(dir, ["config", "user.email", "test@example.com"]);
    fixtureGit(dir, ["config", "user.name", "Test User"]);
    writeFileSync(path.join(dir, "real.txt"), "x\n", "utf8");
    // Absolute target need not exist; git records the symlink as mode 120000.
    symlinkSync("/Users/someone/elsewhere", path.join(dir, "bad-link"));
    fixtureGit(dir, ["add", "-A"]);

    let threw = false;
    let combined = "";
    try {
      execFileSync("node", [CHECK], { cwd: dir, encoding: "utf8", env: fixtureGitEnv() });
    } catch (e) {
      threw = true;
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.ok(threw, "expected the check to exit non-zero on a foreign symlink");
    assert.match(combined, /FAILED/);
    assert.match(combined, /bad-link/);
    assert.match(combined, /absolute target/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI flags a relative symlink that escapes the repo root", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "escaping-symlink-"));
  try {
    fixtureGit(dir, ["init"]);
    fixtureGit(dir, ["config", "user.email", "test@example.com"]);
    fixtureGit(dir, ["config", "user.name", "Test User"]);
    symlinkSync("../../outside-the-repo", path.join(dir, "escaper"));
    fixtureGit(dir, ["add", "-A"]);

    let threw = false;
    let combined = "";
    try {
      execFileSync("node", [CHECK], { cwd: dir, encoding: "utf8", env: fixtureGitEnv() });
    } catch (e) {
      threw = true;
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.ok(threw, "expected the check to exit non-zero on an escaping symlink");
    assert.match(combined, /escaper/);
    assert.match(combined, /escapes repo root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
