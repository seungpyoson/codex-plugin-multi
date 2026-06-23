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

// The guard is an allowlist: it accepts only a non-empty, relative, forward-slash
// target that resolves inside the repo, and rejects everything else. The next
// three tests pin the three rejection sub-classes; each row is a whole class, not
// a single enumerated syntax.

test("findForeignSymlinks: rejects any backslash target (Windows sep / UNC / drive+backslash / \\-escape)", () => {
  // ONE rule (`includes("\\")`) subsumes all of these — they are non-portable on
  // every clone, so the guard never has to enumerate the individual forms.
  const offenders = findForeignSymlinks([
    { path: "a", target: "C:\\Windows\\system32" }, // drive + backslash
    { path: "b", target: "\\\\server\\share" }, // UNC
    { path: "c", target: "\\Windows\\System32" }, // single-backslash current-drive root
    { path: "toplink", target: "..\\outside" }, // backslash escape from root
    { path: "sub/nestlink", target: "..\\..\\outside" }, // nested backslash escape
    { path: "z", target: "sub\\file" }, // diverges across OSes (sub/file on Win, literal on POSIX)
  ]);
  assert.equal(offenders.length, 6);
  for (const o of offenders) assert.match(o.reason, /non-portable/);
});

test("findForeignSymlinks: rejects forward-slash absolute and drive-qualified targets", () => {
  const offenders = findForeignSymlinks([
    { path: "n", target: "/Users/x/relay/node_modules" }, // POSIX absolute (the #247 bug)
    { path: "b", target: "C:/Windows" }, // drive + forward slash
    { path: "e", target: "C:foo" }, // drive-relative (binds to C:'s cwd)
    { path: "f", target: "C:" }, // bare drive
  ]);
  assert.equal(offenders.length, 4);
  for (const o of offenders) assert.match(o.reason, /machine-specific/);
});

test("findForeignSymlinks: rejects empty target and forward-slash escapes above the repo root", () => {
  const offenders = findForeignSymlinks([
    { path: "x", target: "" }, // empty — fail closed
    { path: "link", target: "../outside" },
    { path: "a/b/link", target: "../../../etc/passwd" },
  ]);
  assert.equal(offenders.length, 3);
  assert.match(offenders[0].reason, /empty/);
  assert.match(offenders[1].reason, /escapes repo root/);
  assert.match(offenders[2].reason, /escapes repo root/);
});

test("findForeignSymlinks: allows safe relative forward-slash targets resolving inside the repo", () => {
  const offenders = findForeignSymlinks([
    { path: "relay/relay-api-reviewers", target: "../plugins/api-reviewers" },
    { path: "tests/smoke/claude", target: "claude-mock.mjs" },
    { path: "a/b/c", target: "../d" }, // -> a/d, still inside
    { path: "x", target: "./y" }, // -> y, inside
  ]);
  assert.deepEqual(offenders, []);
});

test("parseLsFilesStage: parses NUL-delimited (-z) records; tolerates spaces in paths", () => {
  const out =
    "120000 be9723c077bfb81c7747f25dfa964da1f3134e24 0\tnode_modules\0" +
    "100644 def4560000000000000000000000000000000000 0\tdir/some file.txt\0";
  assert.deepEqual(parseLsFilesStage(out), [
    { mode: "120000", sha: "be9723c077bfb81c7747f25dfa964da1f3134e24", path: "node_modules" },
    { mode: "100644", sha: "def4560000000000000000000000000000000000", path: "dir/some file.txt" },
  ]);
});

test("parseLsFilesStage: preserves special bytes in a path (no C-quoting under -z)", () => {
  // A name with a non-ASCII byte and a space — `-z` keeps it verbatim, so the
  // escape check sees the real dirname (the quoting-bypass that motivated -z).
  const out = "120000 abc 0\tsub/né me/link\0";
  assert.deepEqual(parseLsFilesStage(out), [
    { mode: "120000", sha: "abc", path: "sub/né me/link" },
  ]);
});

test("collectTrackedSymlinks: filters to mode 120000 and reads the blob target", () => {
  const lsFiles =
    "100644 aaa 0\treal.txt\0" +
    "120000 bbb 0\tlink-abs\0" +
    "120000 ccc 0\tsub/link-rel\0";
  const blobs = { bbb: "/abs/target\n", ccc: "../inside" };
  const runGit = (args) => {
    if (args[0] === "ls-files") {
      assert.deepEqual(args, ["ls-files", "-s", "-z"]); // NUL-delimited form
      return lsFiles;
    }
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
    assert.match(combined, /machine-specific/);
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

// Forms found by external review (Kimi/GPT) and reproduced as real committable
// blobs from POSIX — CI false-greens on a Windows clone of the #247 class under
// the old POSIX-only guard. End-to-end through git, on POSIX. These cover the two
// rejection mechanisms a forward-slash-only test cannot reach: a backslash byte,
// and a drive qualifier with no backslash and no leading slash.
test("CLI flags a backslash-bearing symlink target (Windows separator / UNC / \\-escape)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "backslash-symlink-"));
  try {
    fixtureGit(dir, ["init"]);
    fixtureGit(dir, ["config", "user.email", "test@example.com"]);
    fixtureGit(dir, ["config", "user.name", "Test User"]);
    // `\Windows\System32`: absolute on Windows, literal filename on POSIX — git
    // stores the bytes verbatim. The backslash alone makes it non-portable.
    symlinkSync("\\Windows\\System32", path.join(dir, "winlink"));
    fixtureGit(dir, ["add", "-A"]);

    let threw = false;
    let combined = "";
    try {
      execFileSync("node", [CHECK], { cwd: dir, encoding: "utf8", env: fixtureGitEnv() });
    } catch (e) {
      threw = true;
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.ok(threw, "expected the check to exit non-zero on a backslash target");
    assert.match(combined, /winlink/);
    assert.match(combined, /non-portable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI flags a Windows drive-relative target with no backslash (C:foo)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "driverel-symlink-"));
  try {
    fixtureGit(dir, ["init"]);
    fixtureGit(dir, ["config", "user.email", "test@example.com"]);
    fixtureGit(dir, ["config", "user.name", "Test User"]);
    // `C:foo`: drive-relative on Windows (binds to drive C:'s cwd), literal name
    // on POSIX. No backslash and not POSIX-absolute, so only the drive rule catches it.
    symlinkSync("C:foo", path.join(dir, "driverel"));
    fixtureGit(dir, ["add", "-A"]);

    let threw = false;
    let combined = "";
    try {
      execFileSync("node", [CHECK], { cwd: dir, encoding: "utf8", env: fixtureGitEnv() });
    } catch (e) {
      threw = true;
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.ok(threw, "expected the check to exit non-zero on a drive-relative target");
    assert.match(combined, /driverel/);
    assert.match(combined, /machine-specific/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
