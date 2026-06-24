import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyResolvedSymlink,
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
// Pure core: an already-resolved real path is valid iff it remains inside the
// repo and maps to a tracked file or tracked-directory prefix.
// ---------------------------------------------------------------------------

const ROOT = "/repo";

test("classifyResolvedSymlink: accepts a resolved path that is a tracked file", () => {
  assert.equal(classifyResolvedSymlink("/repo/sub/f.txt", ROOT, tracked(["sub/f.txt"])), null);
});

test("classifyResolvedSymlink: accepts a resolved path that is a tracked directory prefix", () => {
  assert.equal(classifyResolvedSymlink("/repo/sub", ROOT, tracked(["sub/f.txt"])), null);
});

test("classifyResolvedSymlink: accepts a resolution to the repo root itself", () => {
  assert.equal(classifyResolvedSymlink("/repo", ROOT, tracked(["sub/f.txt"])), null);
});

test("classifyResolvedSymlink: rejects a resolved path outside the repo", () => {
  assert.match(classifyResolvedSymlink("/elsewhere/x", ROOT, tracked(["sub/f.txt"])), /outside the repo/);
});

test("classifyResolvedSymlink: rejects a sibling-prefix path outside the repo", () => {
  assert.match(classifyResolvedSymlink("/repo-evil/x", ROOT, tracked([])), /outside the repo/);
});

test("classifyResolvedSymlink: rejects a resolved path inside the repo but untracked", () => {
  assert.match(classifyResolvedSymlink("/repo/nope", ROOT, tracked(["sub/f.txt"])), /untracked/);
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
    symlinkSync(tmpdir(), path.join(dir, "bad-link"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /bad-link ->/);
    assert.match(combined, /(resolves outside the repo|unresolvable)/);
  });
});

test("CLI rejects a relative symlink that resolves outside tracked paths", () => {
  withFixtureRepo("escaping-symlink-", (dir) => {
    symlinkSync("../../outside-the-repo", path.join(dir, "escaper"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /escaper -> \.\.\/\.\.\/outside-the-repo\s+\((unresolvable|resolves outside the repo)/);
  });
});

test("CLI rejects an intermediate-symlink '..' escape (real git repo)", () => {
  withFixtureRepo("intermediate-symlink-", (dir) => {
    writeFileSync(path.join(dir, "safe"), "root safe\n", "utf8");
    mkdirSync(path.join(dir, "sub", "inside"), { recursive: true });
    writeFileSync(path.join(dir, "sub", "inside", "file.txt"), "inside\n", "utf8");
    symlinkSync("sub/inside", path.join(dir, "d"));
    symlinkSync("d/../safe", path.join(dir, "a"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /a -> d\/\.\.\/safe\s+\((unresolvable|resolves outside the repo|resolves to an untracked path)/);
    assert.doesNotMatch(combined, /✗ d ->/);
  });
});

test("CLI rejects file/.. ENOTDIR resolution through a symlink target", () => {
  withFixtureRepo("file-dotdot-symlink-", (dir) => {
    writeFileSync(path.join(dir, "file.txt"), "file\n", "utf8");
    writeFileSync(path.join(dir, "safe"), "safe\n", "utf8");
    symlinkSync("file.txt/../safe", path.join(dir, "link"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /link -> file\.txt\/\.\.\/safe\s+\(unresolvable/);
  });
});

test("CLI accepts a valid symlink chain", () => {
  withFixtureRepo("valid-chain-symlink-", (dir) => {
    writeFileSync(path.join(dir, "real.txt"), "real\n", "utf8");
    symlinkSync("real.txt", path.join(dir, "b"));
    symlinkSync("b", path.join(dir, "a"));
    fixtureGit(dir, ["add", "-A"]);

    const out = execFileSync("node", [CHECK], {
      cwd: dir,
      encoding: "utf8",
      env: fixtureGitEnv(),
    });
    assert.match(out, /✓ All 2 tracked symlink\(s\) resolve inside the repo/);
  });
});

test("CLI accepts a valid symlink to a tracked directory", () => {
  withFixtureRepo("valid-dir-symlink-", (dir) => {
    mkdirSync(path.join(dir, "pkg", "inside"), { recursive: true });
    writeFileSync(path.join(dir, "pkg", "inside", "f.txt"), "inside\n", "utf8");
    symlinkSync("pkg/inside", path.join(dir, "link"));
    fixtureGit(dir, ["add", "-A"]);

    const out = execFileSync("node", [CHECK], {
      cwd: dir,
      encoding: "utf8",
      env: fixtureGitEnv(),
    });
    assert.match(out, /✓ All 1 tracked symlink\(s\) resolve inside the repo/);
  });
});

test("CLI rejects a force-added self-referential node_modules symlink", () => {
  withFixtureRepo("selfloop-symlink-", (dir) => {
    writeFileSync(path.join(dir, ".gitignore"), "node_modules\n", "utf8");
    symlinkSync("node_modules", path.join(dir, "node_modules"));
    fixtureGit(dir, ["add", ".gitignore"]);
    fixtureGit(dir, ["add", "-f", "node_modules"]);

    const combined = checkFails(dir);
    assert.match(combined, /node_modules -> node_modules\s+\(unresolvable/);
  });
});

test("CLI honors a positional path argument (not just process.cwd())", () => {
  withFixtureRepo("argpath-symlink-", (dir) => {
    symlinkSync(tmpdir(), path.join(dir, "bad-link"));
    fixtureGit(dir, ["add", "-A"]);
    let combined = "";
    try {
      execFileSync("node", [CHECK, dir], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: fixtureGitEnv(),
      });
      assert.fail("expected non-zero exit for the arg-dir offender");
    } catch (e) {
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    assert.match(combined, /bad-link ->/);
    assert.match(combined, /(resolves outside the repo|unresolvable)/);
  });
});

test("CLI rejects a nul target as unresolvable", () => {
  withFixtureRepo("nul-symlink-", (dir) => {
    symlinkSync("nul", path.join(dir, "devlink"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /devlink -> nul\s+\(unresolvable/);
  });
});

test("CLI rejects a COM¹ target as unresolvable", () => {
  withFixtureRepo("com-symlink-", (dir) => {
    symlinkSync("COM¹", path.join(dir, "comlink"));
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /comlink -> COM¹\s+\(unresolvable/);
  });
});

test("CLI rejects a trailing control byte preserved in the symlink blob", () => {
  withFixtureRepo("control-symlink-", (dir) => {
    try {
      symlinkSync("safe\n", path.join(dir, "control"));
    } catch {
      assert.match(classifyResolvedSymlink(`${ROOT}/safe\n`, ROOT, tracked(["safe"])), /untracked/);
      return;
    }
    fixtureGit(dir, ["add", "-A"]);

    const combined = checkFails(dir);
    assert.match(combined, /control -> safe\n\s+\(unresolvable/);
  });
});
