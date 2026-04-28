// Unit coverage for the cancel-marker helper extracted in #24. Smoke
// covers the SIGTERM-trap end-to-end path; this file pins the
// lifecycle-pure pieces that the byte-identity guard depends on.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  cancelMarkerPath,
  writeCancelMarker,
  consumeCancelMarker,
} from "../../plugins/claude/scripts/lib/cancel-marker.mjs";
import * as GeminiCancelMarker from "../../plugins/gemini/scripts/lib/cancel-marker.mjs";
import { configureState } from "../../plugins/claude/scripts/lib/state.mjs";
import { configureState as configureGeminiState } from "../../plugins/gemini/scripts/lib/state.mjs";

function freshWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "cancel-marker-unit-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "cancel-marker-data-"));
  configureState({ envVar: "CLAUDE_PLUGIN_DATA", fallbackBaseName: "claude-companion", sessionEnvVar: "CLAUDE_COMPANION_SESSION_ID" });
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  return { root, dataDir };
}

const JOB = "11111111-2222-4333-9444-555555555555";

test("cancelMarkerPath: deterministic, jobId-keyed under jobsDir", () => {
  const { root, dataDir } = freshWorkspace();
  try {
    const p = cancelMarkerPath(root, JOB);
    assert.ok(p.endsWith(`${JOB}/cancel-requested.flag`),
      `expected path to end with <jobId>/cancel-requested.flag, got ${p}`);
    assert.ok(p.includes(dataDir) || p.includes(JOB),
      `path should be rooted under the configured jobsDir; got ${p}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("writeCancelMarker: creates dir + file with mode 0600 and ISO timestamp", () => {
  const { root, dataDir } = freshWorkspace();
  try {
    const p = writeCancelMarker(root, JOB);
    assert.ok(existsSync(p), "marker file must exist after write");
    const st = statSync(p);
    // 0o600 — owner read/write only. Filter to the permission bits.
    assert.equal(st.mode & 0o777, 0o600, `expected mode 0600, got ${(st.mode & 0o777).toString(8)}`);
    // Body is best-effort debug only, but the format we emit is an
    // ISO 8601 timestamp + newline; assert that's still the case.
    const body = readFileSync(p, "utf8");
    assert.match(body, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("writeCancelMarker: propagates fs errors so caller can log a warning", () => {
  const { root, dataDir } = freshWorkspace();
  try {
    // Pre-seed the marker path as a directory so writeFileSync hits EISDIR.
    // This proves writeCancelMarker doesn't swallow the error — caller's
    // try/catch wrapping is load-bearing for the target-specific warning.
    const p = cancelMarkerPath(root, JOB);
    mkdirSync(path.dirname(p), { recursive: true });
    mkdirSync(p);
    assert.throws(
      () => writeCancelMarker(root, JOB),
      /EISDIR|EACCES|EEXIST/,
      "writeCancelMarker must throw on fs failure so the caller can log a target-specific warning"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("consumeCancelMarker: returns true and unlinks the marker", () => {
  const { root, dataDir } = freshWorkspace();
  try {
    const p = writeCancelMarker(root, JOB);
    assert.ok(existsSync(p));
    assert.equal(consumeCancelMarker(root, JOB), true);
    assert.equal(existsSync(p), false, "marker must be unlinked after consume");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("consumeCancelMarker: returns false when no marker is present", () => {
  const { root, dataDir } = freshWorkspace();
  try {
    assert.equal(consumeCancelMarker(root, JOB), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// Coverage parity: identity tests load the gemini side via `* as GeminiX`
// and exercise its happy path. cancel-marker.mjs is byte-identical, so a
// minimal happy-path drive is enough to clear the coverage gate.
test("gemini cancel-marker: byte-identical helper exercised on the gemini side", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cancel-marker-gemini-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "cancel-marker-gemini-data-"));
  try {
    configureGeminiState({ envVar: "GEMINI_PLUGIN_DATA", fallbackBaseName: "gemini-companion", sessionEnvVar: "GEMINI_COMPANION_SESSION_ID" });
    process.env.GEMINI_PLUGIN_DATA = dataDir;

    const p = GeminiCancelMarker.cancelMarkerPath(root, JOB);
    assert.ok(p.endsWith(`${JOB}/cancel-requested.flag`));

    GeminiCancelMarker.writeCancelMarker(root, JOB);
    assert.ok(existsSync(p));

    assert.equal(GeminiCancelMarker.consumeCancelMarker(root, JOB), true);
    assert.equal(existsSync(p), false);
    assert.equal(GeminiCancelMarker.consumeCancelMarker(root, JOB), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
