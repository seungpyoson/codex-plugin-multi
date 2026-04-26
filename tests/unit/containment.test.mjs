// Unit tests for lib/containment.mjs (spec §21.4). Containment answers
// "where does Claude write" — independent from scope ("what Claude sees").
//
// containment="none"   → {path: sourceCwd, cleanup: noop, disposed: false}
// containment="worktree" → {path: <fresh tempdir>, cleanup: removes it}
//
// Note: setupContainment does NOT populate. Populate is scope.mjs's job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setupContainment } from "../../plugins/claude/scripts/lib/containment.mjs";
import { setupContainment as setupGeminiContainment } from "../../plugins/gemini/scripts/lib/containment.mjs";

const profile = (containment, scope = "head") => Object.freeze({
  name: "test", containment, scope, dispose_default: true,
});

test("setupContainment containment=none: returns sourceCwd verbatim, no-op cleanup", () => {
  const src = mkdtempSync(path.join(tmpdir(), "contain-none-"));
  try {
    const result = setupContainment(profile("none"), src);
    assert.equal(result.path, src, "path must be sourceCwd");
    assert.equal(typeof result.cleanup, "function");
    // cleanup() must NOT remove the source directory.
    result.cleanup();
    assert.ok(existsSync(src), "containment=none cleanup wrongly removed sourceCwd");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("setupContainment containment=worktree: returns fresh tempdir under os.tmpdir()", () => {
  const src = mkdtempSync(path.join(tmpdir(), "contain-src-"));
  try {
    const result = setupContainment(profile("worktree"), src);
    try {
      assert.notEqual(result.path, src, "worktree path must differ from source");
      assert.ok(existsSync(result.path), "worktree path must exist on disk");
      assert.ok(statSync(result.path).isDirectory(), "worktree path must be a directory");
      // Must live under the OS tempdir (no stray dirs under user's home).
      assert.ok(result.path.startsWith(tmpdir()),
        `worktree path ${result.path} not under ${tmpdir()}`);
      assert.equal("_scopeHeadOf" in result, false,
        "legacy scope=head worktree cleanup hook should not be exposed");
    } finally {
      result.cleanup();
    }
    assert.equal(existsSync(result.path), false,
      "worktree cleanup failed to remove the directory");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("setupContainment containment=worktree: cleanup is idempotent (no throw on double-call)", () => {
  const src = mkdtempSync(path.join(tmpdir(), "contain-idem-"));
  try {
    const result = setupContainment(profile("worktree"), src);
    result.cleanup();
    // Second call should be a no-op, not a crash.
    result.cleanup();
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("setupContainment: rejects profile missing containment field", () => {
  const bad = Object.freeze({ name: "bad", scope: "head" });
  assert.throws(
    () => setupContainment(bad, tmpdir()),
    /invalid_profile|containment/,
  );
});

test("setupContainment: rejects unknown containment value", () => {
  const bad = Object.freeze({ name: "bad", containment: "docker", scope: "head" });
  assert.throws(
    () => setupContainment(bad, tmpdir()),
    /invalid_profile|docker|containment/,
  );
});

test("setupContainment: does NOT populate — caller must run populateScope separately", () => {
  // This is a contract test: setupContainment('worktree') returns an EMPTY
  // directory. It's populateScope's job to fill it.
  const src = mkdtempSync(path.join(tmpdir(), "contain-empty-"));
  try {
    const result = setupContainment(profile("worktree"), src);
    try {
      const entries = readdirSync(result.path);
      assert.equal(entries.length, 0,
        `setupContainment must not populate; found: ${entries.join(",")}`);
    } finally {
      result.cleanup();
    }
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("gemini setupContainment mirrors behavior with gemini worktree prefix", () => {
  const src = mkdtempSync(path.join(tmpdir(), "gemini-contain-src-"));
  try {
    const none = setupGeminiContainment(profile("none"), src);
    assert.equal(none.path, src);
    assert.equal(none.disposed, false);
    none.cleanup();
    assert.ok(existsSync(src));

    const worktree = setupGeminiContainment(profile("worktree"), src);
    try {
      assert.notEqual(worktree.path, src);
      assert.ok(path.basename(worktree.path).startsWith("gemini-worktree-"));
      assert.ok(existsSync(worktree.path));
      assert.equal(worktree.disposed, true);
    } finally {
      worktree.cleanup();
      worktree.cleanup();
    }
    assert.equal(existsSync(worktree.path), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("gemini setupContainment rejects invalid profiles", () => {
  assert.throws(() => setupGeminiContainment(null, tmpdir()), /invalid_profile/);
  assert.throws(() => setupGeminiContainment({ containment: "bad" }, tmpdir()), /unknown containment/);
});
