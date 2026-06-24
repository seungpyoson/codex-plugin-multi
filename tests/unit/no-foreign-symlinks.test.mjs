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

const tracked = (paths) => {
  const set = new Set(paths);
  return (p) => p === "" || p === "." || set.has(p) || [...set].some((f) => f.startsWith(p + "/"));
};

function initFixtureRepo(dir) {
  fixtureGit(dir, ["init"]);
  fixtureGit(dir, ["config", "user.email", "test@example.com"]);
  fixtureGit(dir, ["config", "user.name", "Test User"]);
}

function withFixtureRepo(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    initFixtureRepo(dir);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkFails(dir) {
  try {
    execFileSync("node", [CHECK], { cwd: dir, encoding: "utf8", env: fixtureGitEnv() });
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.fail("expected the check to exit non-zero");
}

// ---------------------------------------------------------------------------
// Pure-function truth table: a tracked symlink is valid iff its resolved target
// is a tracked file or tracked-directory prefix.
// ---------------------------------------------------------------------------

test("findForeignSymlinks: accepts tracked files, tracked directory prefixes, and safe relatives", () => {
  const isTrackedPath = tracked([
    "plugins/api-reviewers/plugin.json",
    "tests/smoke/claude-mock.mjs",
    "a/d",
    "y",
    "console.mjs",
    "command.ts",
    "aux-helper.js",
  ]);

  const offenders = findForeignSymlinks(
    [
      { path: "relay/relay-api-reviewers", target: "../plugins/api-reviewers" },
      { path: "tests/smoke/claude", target: "claude-mock.mjs" },
      { path: "a/b/c", target: "../d" },
      { path: "x", target: "./y" },
      { path: "console-link", target: "console.mjs" },
      { path: "command-link", target: "command.ts" },
      { path: "aux-link", target: "aux-helper.js" },
    ],
    isTrackedPath
  );

  assert.deepEqual(offenders, []);
});

test("findForeignSymlinks: accepts a directory target written with a trailing slash", () => {
  const isTrackedPath = tracked(["pkg/sub/f.txt"]);
  const offenders = findForeignSymlinks(
    [
      { path: "link", target: "pkg/sub/" },
      { path: "root", target: "./" },
    ],
    isTrackedPath
  );

  assert.deepEqual(offenders, []);
});

test("findForeignSymlinks: rejects empty and absolute targets before membership", () => {
  const offenders = findForeignSymlinks(
    [
      { path: "empty", target: "" },
      { path: "node_modules", target: "/Users/x/relay/node_modules" },
      { path: "relay/link", target: "/plugins/api-reviewers" },
    ],
    tracked(["Users/x/relay/node_modules", "plugins/api-reviewers/plugin.json"])
  );

  assert.equal(offenders.length, 3);
  assert.match(offenders[0].reason, /empty/);
  assert.match(offenders[1].reason, /absolute/);
  assert.match(offenders[2].reason, /absolute/);
});

test("findForeignSymlinks: rejects untracked resolved targets by membership", () => {
  const entries = [
    { path: "rootlink", target: "../outside" },
    { path: "devlink", target: "nul" },
    { path: "comlink", target: "COM¹" },
    { path: "node_modules", target: "node_modules" },
    { path: "slash", target: "sub\\file" },
    { path: "driverel", target: "C:foo" },
    { path: "control", target: "safe\n" },
  ];

  const offenders = findForeignSymlinks(entries, tracked(["tracked/file.txt"]));

  assert.equal(offenders.length, entries.length);
  for (const o of offenders) {
    assert.match(o.reason, /does not resolve to a tracked/);
    assert.doesNotMatch(o.reason, /reserved|non-portable|space or dot|escapes repo root/);
  }
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
  const out = "120000 abc 0\tsub/spaced link\0";

  assert.deepEqual(parseLsFilesStage(out), [
    { mode: "120000", sha: "abc", path: "sub/spaced link" },
  ]);
});

test("collectTrackedSymlinks: filters to mode 120000 and preserves blob targets verbatim", () => {
  const calls = [];
  const lsFiles =
    "100644 aaa 0\treal.txt\0" +
    "120000 bbb 0\tlink-control\0" +
    "120000 ccc 0\tsub/link-rel\0";
  const blobs = { bbb: "foo\n", ccc: "../inside" };
  const runGit = (args) => {
    calls.push(args);
    if (args[0] === "ls-files") return lsFiles;
    if (args[0] === "cat-file") return blobs[args[2]];
    throw new Error(`unexpected git ${args.join(" ")}`);
  };

  assert.deepEqual(collectTrackedSymlinks(runGit), [
    { path: "link-control", target: "foo\n" },
    { path: "sub/link-rel", target: "../inside" },
  ]);
  assert.deepEqual(calls, [
    ["ls-files", "-s", "-z"],
    ["cat-file", "blob", "bbb"],
    ["cat-file", "blob", "ccc"],
  ]);
});

// ---------------------------------------------------------------------------
// Integration: the CLI end-to-end against real git repos.
// ---------------------------------------------------------------------------

test("CLI passes on the real repo", () => {
  const out = execFileSync("node", [CHECK], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: fixtureGitEnv(),
  });

  assert.match(out, /✓ All \d+ tracked symlink\(s\) resolve inside the repo/);
});

test("CLI rejects the #247 absolute symlink target and names the offender", () => {
  withFixtureRepo("absolute-symlink-", (dir) => {
    writeFileSync(path.join(dir, "real.txt"), "x\n", "utf8");
    symlinkSync("/Users/someone/elsewhere", path.join(dir, "bad-link"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /bad-link -> \/Users\/someone\/elsewhere\s+\(absolute target/);
  });
});

test("CLI rejects a relative symlink that resolves outside tracked paths", () => {
  withFixtureRepo("escaping-symlink-", (dir) => {
    symlinkSync("../../outside-the-repo", path.join(dir, "escaper"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /escaper -> \.\.\/\.\.\/outside-the-repo\s+\(does not resolve to a tracked/);
  });
});

test("CLI rejects a nul target by membership", () => {
  withFixtureRepo("nul-symlink-", (dir) => {
    symlinkSync("nul", path.join(dir, "devlink"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /devlink -> nul\s+\(does not resolve to a tracked/);
  });
});

test("CLI rejects a COM¹ target by membership", () => {
  withFixtureRepo("com-symlink-", (dir) => {
    symlinkSync("COM¹", path.join(dir, "comlink"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /comlink -> COM¹\s+\(does not resolve to a tracked/);
  });
});

test("CLI rejects a trailing control byte preserved in the symlink blob", () => {
  withFixtureRepo("control-symlink-", (dir) => {
    try {
      symlinkSync("safe\n", path.join(dir, "control"));
    } catch {
      const offenders = findForeignSymlinks(
        [{ path: "control", target: "safe\n" }],
        tracked(["safe"])
      );
      assert.equal(offenders.length, 1);
      assert.match(offenders[0].reason, /does not resolve to a tracked/);
      return;
    }
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /control -> safe\n\s+\(does not resolve to a tracked/);
  });
});
