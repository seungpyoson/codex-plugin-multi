import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  createTempDir,
  ensureAbsolutePath,
  readJsonFile,
  writeJsonFile,
  safeReadFile,
  isProbablyText,
  readStdinIfPiped,
} from "../../plugins/claude/scripts/lib/fs.mjs";
import * as GeminiFs from "../../plugins/gemini/scripts/lib/fs.mjs";

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

test("safeReadFile: reads existing files and rethrows non-ENOENT errors", () => {
  const dir = createTempDir("fs-test-");
  const file = path.join(dir, "text.txt");
  try {
    writeFileSync(file, "hello", "utf8");
    assert.equal(safeReadFile(file), "hello");
    assert.throws(() => safeReadFile(dir), /EISDIR|illegal operation|is a directory/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isProbablyText: detects NUL bytes as binary", () => {
  assert.equal(isProbablyText(Buffer.from("plain text")), true);
  assert.equal(isProbablyText(Buffer.alloc(0)), true);
  assert.equal(isProbablyText(Buffer.from([0x61, 0x00, 0x62])), false);
});

test("gemini fs helpers use gemini defaults and preserve shared behavior", () => {
  const dir = GeminiFs.createTempDir();
  try {
    assert.ok(path.basename(dir).startsWith("gemini-companion-"));
    assert.equal(GeminiFs.ensureAbsolutePath("/cwd", "rel/x"), path.resolve("/cwd", "rel/x"));
    const nested = path.join(dir, "nested");
    mkdirSync(nested);
    const jsonFile = path.join(nested, "data.json");
    GeminiFs.writeJsonFile(jsonFile, { target: "gemini" });
    assert.deepEqual(GeminiFs.readJsonFile(jsonFile), { target: "gemini" });
    assert.equal(GeminiFs.safeReadFile(jsonFile).includes('"target": "gemini"'), true);
    assert.equal(GeminiFs.isProbablyText(Buffer.from([1, 2, 3])), true);
    assert.equal(GeminiFs.isProbablyText(Buffer.from([1, 0, 3])), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gemini fs helpers cover path, JSON, safe read, and tempdir branches", () => {
  const dir = GeminiFs.createTempDir("gemini-custom-");
  try {
    assert.ok(path.basename(dir).startsWith("gemini-custom-"));
    assert.equal(GeminiFs.ensureAbsolutePath("/cwd", "/already/abs"), "/already/abs");
    assert.equal(GeminiFs.safeReadFile(path.join(dir, "missing.txt")), "");
    assert.throws(() => GeminiFs.safeReadFile(dir), /EISDIR|illegal operation|is a directory/i);

    const jsonFile = path.join(dir, "round-trip.json");
    GeminiFs.writeJsonFile(jsonFile, { ok: true, nested: { target: "gemini" } });
    assert.deepEqual(GeminiFs.readJsonFile(jsonFile), {
      ok: true,
      nested: { target: "gemini" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readStdinIfPiped: returns empty for TTY and reads fd 0 when piped", () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalRead = fs.readFileSync;
  try {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    assert.equal(readStdinIfPiped(), "");
    assert.equal(GeminiFs.readStdinIfPiped(), "");

    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    fs.readFileSync = function patchedReadFileSync(file, encoding) {
      assert.equal(file, 0);
      assert.equal(encoding, "utf8");
      return "stdin body";
    };
    assert.equal(readStdinIfPiped(), "stdin body");
    assert.equal(GeminiFs.readStdinIfPiped(), "stdin body");
  } finally {
    fs.readFileSync = originalRead;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTTY });
  }
});
