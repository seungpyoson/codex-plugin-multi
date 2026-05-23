import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { scrubGitEnv, matchGlob, diffSourceFiles } from "../../scripts/lib/diff-source.mjs";
import { GIT_SAFE_PATH } from "../../scripts/lib/git-binary.mjs";

// ─── Finding #6 (A9): scrubGitEnv must be an allowlist (HOME, PATH only) ───

describe("scrubGitEnv", () => {
  test("strips GIT_ prefixed vars", () => {
    const env = { GIT_DIR: "/foo", GIT_CONFIG: "/bar", HOME: "/home", PATH: "/usr/bin" };
    const clean = scrubGitEnv(env);
    assert.equal(clean.GIT_DIR, undefined);
    assert.equal(clean.GIT_CONFIG, undefined);
  });

  test("preserves HOME and replaces caller PATH with the safe Git PATH", () => {
    const env = { HOME: "/home/test", PATH: "/tmp/fake-git-bin", GIT_DIR: "/x" };
    const clean = scrubGitEnv(env);
    assert.equal(clean.HOME, "/home/test");
    assert.equal(clean.PATH, GIT_SAFE_PATH);
  });

  test("strips non-GIT secrets (AWS_*, OPENAI_*, etc.)", () => {
    const env = {
      AWS_SECRET_ACCESS_KEY: "ak-xxx",
      OPENAI_API_KEY: "sk-xxx",
      LD_PRELOAD: "/evil.so",
      HOME: "/home",
      PATH: "/usr/bin",
    };
    const clean = scrubGitEnv(env);
    assert.equal(clean.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(clean.OPENAI_API_KEY, undefined);
    assert.equal(clean.LD_PRELOAD, undefined);
  });

  test("returns only HOME and PATH when present", () => {
    const env = {
      HOME: "/home",
      PATH: "/usr/bin",
      EXTRA_VAR: "leaked",
      ANOTHER: "also leaked",
    };
    const clean = scrubGitEnv(env);
    assert.deepEqual(Object.keys(clean).sort(), ["HOME", "PATH"]);
  });
});

describe("diffSourceFiles git execution policy", () => {
  test("does not resolve git through caller PATH", async () => {
    const { chmodSync, mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const tmpdir = mkdtempSync("/tmp/diff-source-safe-git-");
    const fakeBin = join(tmpdir, "bin");
    mkdirSync(fakeBin);
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, "#!/bin/sh\necho fake git should not run >&2\nexit 99\n");
    chmodSync(fakeGit, 0o755);

    const git = (args) => execFileSync("git", args, { cwd: tmpdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init"]);
    git(["config", "user.email", "test@test.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(tmpdir, "review.js"), "const value = 1;\n");
    git(["add", "review.js"]);
    git(["commit", "-m", "base"]);
    writeFileSync(join(tmpdir, "review.js"), "const value = 2;\n");
    git(["add", "review.js"]);
    git(["commit", "-m", "feature"]);

    const previousPath = process.env.PATH;
    try {
      process.env.PATH = fakeBin;
      const files = diffSourceFiles(tmpdir, "HEAD~1");
      assert.equal(files.length, 1);
      assert.equal(files[0].path, "review.js");
      assert.match(files[0].content.toString("utf8"), /const value = 2/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

// ─── Finding #1 (A8): matchGlob ** must respect directory boundaries ───

describe("matchGlob", () => {
  test("**/foo does not match barfoo (requires directory boundary)", () => {
    assert.equal(matchGlob("barfoo", "**/foo"), false);
  });

  test("**/foo matches foo (at root)", () => {
    assert.equal(matchGlob("foo", "**/foo"), true);
  });

  test("**/foo matches dir/foo", () => {
    assert.equal(matchGlob("dir/foo", "**/foo"), true);
  });

  test("**/foo matches a/b/c/foo", () => {
    assert.equal(matchGlob("a/b/c/foo", "**/foo"), true);
  });

  test("**/*.mjs matches src/foo.mjs", () => {
    assert.equal(matchGlob("src/foo.mjs", "**/*.mjs"), true);
  });

  test("src/** matches src/foo.mjs", () => {
    assert.equal(matchGlob("src/foo.mjs", "src/**"), true);
  });

  test("src/** matches src/sub/bar.mjs", () => {
    assert.equal(matchGlob("src/sub/bar.mjs", "src/**"), true);
  });

  test("* does not match across directories", () => {
    assert.equal(matchGlob("src/foo.mjs", "*.mjs"), false);
  });

  test("? matches a single non-slash character", () => {
    assert.equal(matchGlob("foo.mjs", "foo?.mjs"), false);
    assert.equal(matchGlob("foox.mjs", "foo?.mjs"), true);
  });

  test("literal dots are escaped", () => {
    assert.equal(matchGlob("fooXmjs", "foo.mjs"), false);
    assert.equal(matchGlob("foo.mjs", "foo.mjs"), true);
  });
});

// ─── Finding #5 (A6): statForFile returns per-file stat line ───

describe("statForFile", () => {
  test("returns the per-file stat line (not the summary)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const tmpdir = mkdtempSync("/tmp/diff-source-test-");
    const git = (args) => execFileSync("git", args, { cwd: tmpdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init"]);
    git(["config", "user.email", "test@test.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(tmpdir, "foo.mjs"), "line1\n");
    git(["add", "foo.mjs"]);
    git(["commit", "-m", "initial"]);
    writeFileSync(join(tmpdir, "foo.mjs"), "line1\nline2\nline3\n");
    git(["add", "foo.mjs"]);
    git(["commit", "-m", "add lines"]);

    const files = diffSourceFiles(tmpdir, "HEAD~1");
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "foo.mjs");
    const header = files[0].content.toString("utf8").split("\n")[0];
    assert.ok(header.includes("foo.mjs"), `stat header should mention file: got "${header}"`);
  });
});

// ─── Finding #8 (A5): truncation preserves leading diff content ───

describe("diffSourceFiles truncation", () => {
  test("large diff keeps first 256 KiB with truncation marker", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const tmpdir = mkdtempSync("/tmp/diff-source-trunc-");
    const git = (args) => execFileSync("git", args, { cwd: tmpdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    git(["init"]);
    git(["config", "user.email", "test@test.com"]);
    git(["config", "user.name", "Test"]);

    writeFileSync(join(tmpdir, "big.txt"), "initial\n");
    git(["add", "big.txt"]);
    git(["commit", "-m", "initial"]);

    const bigContent = "x".repeat(600 * 1024) + "\n";
    writeFileSync(join(tmpdir, "big.txt"), bigContent);
    git(["add", "big.txt"]);
    git(["commit", "-m", "huge change"]);

    const files = diffSourceFiles(tmpdir, "HEAD~1");
    assert.equal(files.length, 1);
    const content = files[0].content.toString("utf8");
    assert.ok(content.includes("[Diff truncated"), "should have truncation marker");
    assert.ok(content.includes("@@"), "should keep at least the first hunk header");
  });
});

// ─── Integration: non-git dir, scope filter ───

describe("diffSourceFiles integration", () => {
  test("returns empty array for non-git directory", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = mkdtempSync("/tmp/diff-source-nongit-");
    assert.deepEqual(diffSourceFiles(tmpdir, "main"), []);
  });

  test("returns empty array when scopePaths filters out all files", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const tmpdir = mkdtempSync("/tmp/diff-source-scope-");
    const git = (args) => execFileSync("git", args, { cwd: tmpdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init"]);
    git(["config", "user.email", "test@test.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(tmpdir, "other.txt"), "hello\n");
    git(["add", "other.txt"]);
    git(["commit", "-m", "initial"]);
    writeFileSync(join(tmpdir, "other.txt"), "changed\n");
    git(["add", "other.txt"]);
    git(["commit", "-m", "change"]);

    const files = diffSourceFiles(tmpdir, "HEAD~1", { scopePaths: ["*.mjs"] });
    assert.equal(files.length, 0);
  });
});

// ─── Fallback: scope_base null returns empty array ───

describe("diffSourceFiles fallback", () => {
  test("returns empty array when baseRef is null", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const tmpdir = mkdtempSync("/tmp/diff-source-null-");
    const git = (args) => execFileSync("git", args, { cwd: tmpdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init"]);
    git(["config", "user.email", "test@test.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(tmpdir, "foo.mjs"), "hello\n");
    git(["add", "foo.mjs"]);
    git(["commit", "-m", "init"]);

    // null baseRef → no merge base → returns []
    assert.deepEqual(diffSourceFiles(tmpdir, null), []);
  });

  test("returns empty array when baseRef is undefined", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const tmpdir = mkdtempSync("/tmp/diff-source-undef-");
    const git = (args) => execFileSync("git", args, { cwd: tmpdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init"]);
    git(["config", "user.email", "test@test.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(tmpdir, "foo.mjs"), "hello\n");
    git(["add", "foo.mjs"]);
    git(["commit", "-m", "init"]);

    assert.deepEqual(diffSourceFiles(tmpdir, undefined), []);
  });
});
