import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  createTempDir,
  ensureAbsolutePath,
  readJsonFile,
  writeJsonFile,
  safeReadFile,
} from "../../plugins/claude/scripts/lib/fs.mjs";

test("createTempDir: uses claude-companion- prefix by default", () => {
  const dir = createTempDir();
  try {
    assert.ok(existsSync(dir));
    assert.ok(statSync(dir).isDirectory());
    assert.ok(path.basename(dir).startsWith("claude-companion-"));
    assert.ok(dir.startsWith(tmpdir()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTempDir: custom prefix works", () => {
  const dir = createTempDir("custom-prefix-");
  try {
    assert.ok(path.basename(dir).startsWith("custom-prefix-"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureAbsolutePath: leaves absolute paths alone", () => {
  assert.equal(ensureAbsolutePath("/cwd", "/abs/x"), "/abs/x");
});

test("ensureAbsolutePath: resolves relative against cwd", () => {
  assert.equal(ensureAbsolutePath("/cwd", "rel/x"), path.resolve("/cwd", "rel/x"));
});

test("read/writeJsonFile: round trip with trailing newline", () => {
  const dir = createTempDir("fs-test-");
  const file = path.join(dir, "a.json");
  try {
    writeJsonFile(file, { a: 1, b: "two" });
    const read = readJsonFile(file);
    assert.deepEqual(read, { a: 1, b: "two" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeReadFile: returns empty string when file absent", () => {
  assert.equal(safeReadFile("/nonexistent/path/to/file"), "");
});
