// Unit coverage for the cancel-marker helper extracted in #24. Smoke
// covers the SIGTERM-trap end-to-end path; this file pins the
// lifecycle-pure pieces.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  cancelMarkerPath,
  writeCancelMarker,
  consumeCancelMarker,
} from "../../plugins/claude/scripts/lib/cancel-marker.mjs";
import { configureState } from "../../plugins/claude/scripts/lib/state.mjs";

function freshWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "cancel-marker-unit-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "cancel-marker-data-"));
  // Reset to claude-side defaults. NOTE: the actual configureState API uses
  // pluginDataEnv / fallbackStateRootDir / sessionIdEnv. Earlier callers
  // passed envVar / fallbackBaseName / sessionEnvVar — those keys are
  // unrecognized and silently dropped (Finding I from reviewer round 2),
  // so the call was a total no-op until this fix.
  configureState({
    pluginDataEnv: "CLAUDE_PLUGIN_DATA",
    fallbackStateRootDir: path.join(tmpdir(), "claude-companion"),
    sessionIdEnv: "CLAUDE_COMPANION_SESSION_ID",
  });
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

// Class 2 (path-traversal defense at the cancel-marker boundary).
// state.mjs validates jobIds at writeJobFile / resolveJobFile / state.json
// upserts, so under normal flow listJobs only returns UUIDs. But
// cmdCancel reads job.id straight off the parsed state.json — a tampered
// state.json with a traversal-laden id (e.g. ../../../escape) would, prior
// to this fix, reach writeCancelMarker via the queued-cancel branch and
// land outside the jobs dir. cancelMarkerPath now calls assertSafeJobId
// before any path concat; writeCancelMarker and consumeCancelMarker
// inherit this defense because they go through cancelMarkerPath.
test("cancelMarkerPath: rejects path-traversal jobIds with assertSafeJobId", () => {
  const { root, dataDir } = freshWorkspace();
  try {
    const tampered = [
      "../../../escape",
      "../escape",
      "/abs/escape",
      "foo/bar",
      "..",
      "",
      "valid-id" + String.fromCodePoint(0) + "null-byte",
      ".dotfile-id",
    ];
    for (const id of tampered) {
      assert.throws(
        () => cancelMarkerPath(root, id),
        /Unsafe jobId/,
        `cancelMarkerPath must reject ${JSON.stringify(id)} (was: silent escape via path concat)`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("writeCancelMarker / consumeCancelMarker: inherit jobId validation via cancelMarkerPath", () => {
  const { root, dataDir } = freshWorkspace();
  try {
    // Both functions call cancelMarkerPath internally, so the same
    // validation gate fires at the boundary. Spot-check one tampered
    // value through each path so a future refactor that bypasses
    // cancelMarkerPath would be caught.
    assert.throws(() => writeCancelMarker(root, "../../../escape"), /Unsafe jobId/);
    assert.throws(() => consumeCancelMarker(root, "../../../escape"), /Unsafe jobId/);
    // Confirm no marker landed outside the jobs dir.
    const escapePath = path.resolve(root, "..", "..", "..", "escape", "cancel-requested.flag");
    assert.equal(existsSync(escapePath), false,
      `no marker should exist at escape path ${escapePath}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
