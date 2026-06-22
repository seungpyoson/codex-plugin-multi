// PR #218 follow-up #240 — single-source-of-truth for AGY's error/output disclosure surface.
//
// Round-2 review (Kimi) flagged that, although resolveErrorSinkDisclosure centralizes the generic
// error-sink decision (fail() / main().catch), three other envelope paths hard-coded
// source_content_transmission directly, bypassing the central decision — and fail() spread
// ...errorSinkDisclosure() BEFORE ...details, so a detail could override the latch-driven decision
// (defeating the "a sent source is ALWAYS disclosed" safety net).
//
// Resolution:
//   - run() bad_mode (a generic-sink-SHAPED envelope) now routes through errorSinkDisclosure().
//   - preflight bad_args no longer carries the field in fail() details (errorSinkDisclosure owns it),
//     and fail() spreads ...errorSinkDisclosure() LAST so details can never override it.
//   - doctor / preflight (non-transmitting diagnostic commands) disclose via a single named constant
//     NON_TRANSMITTING_DISCLOSURE — their not_sent is a structural invariant, not the latch decision.
//
// These tests lock (a) the observable contract on every changed path and (b) the single-source
// invariant itself: no bare source_content_transmission literal may reappear in the companion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/agy/scripts/agy-companion.mjs");
const MISSING_JOB = "00000000-0000-0000-0000-000000000000";

function gitRepo(cwd) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (args) => spawnSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(cwd, "a.md"), "x\n"); git(["add", "."]); git(["commit", "-q", "-m", "m"]);
}

// printJson pretty-prints a single multi-line object per envelope; grab the last balanced object.
function lastEnvelope(run) {
  const raw = String(run.stdout ?? "");
  let depth = 0, start = -1, inStr = false, esc = false, last = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth += 1; }
    else if (c === "}") { depth -= 1; if (depth === 0 && start >= 0) { try { last = JSON.parse(raw.slice(start, i + 1)); } catch { /* skip */ } start = -1; } }
  }
  return last ?? {};
}

function companion(args, cwd, env = {}) {
  return lastEnvelope(spawnSync(process.execPath, [COMPANION, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } }));
}

test("doctor error envelope discloses not_sent (NON_TRANSMITTING_DISCLOSURE)", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-cds-doctor-"));
  try {
    gitRepo(cwd);
    const env = { AGY_PLUGIN_DATA: path.join(cwd, "data") };
    const env1 = companion(["doctor", "--binary", "/nonexistent/agy", "--cwd", cwd], cwd, env);
    assert.equal(env1.ready, false, `doctor should report not ready: ${JSON.stringify(env1)}`);
    assert.equal(env1.source_content_transmission, "not_sent", "doctor never transmits source");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("preflight bad_args discloses not_sent AND keeps its disclosure_note contract", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-cds-preflight-"));
  try {
    gitRepo(cwd);
    const env = { AGY_PLUGIN_DATA: path.join(cwd, "data") };
    const out = companion(["preflight", "--mode", "invalid", "--cwd", cwd], cwd, env);
    assert.equal(out.error_code, "bad_args", `expected bad_args: ${JSON.stringify(out)}`);
    // Field is now provided by errorSinkDisclosure (preflight is not a read/query command and is
    // pre-spawn), not a hard-coded detail — so it must still be present and honest.
    assert.equal(out.source_content_transmission, "not_sent", "preflight transmits no source");
    assert.ok(out.disclosure_note, "preflight's deliberate disclosure_note contract must survive");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run bad_mode (generic-sink-shaped) discloses not_sent via the central decision", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-cds-badmode-"));
  try {
    gitRepo(cwd);
    const env = { AGY_PLUGIN_DATA: path.join(cwd, "data") };
    const out = companion(["run", "--mode", "invalid", "--cwd", cwd], cwd, env);
    assert.equal(out.error_code, "bad_mode", `expected bad_mode: ${JSON.stringify(out)}`);
    assert.equal(out.status, "failed");
    // Pre-spawn run error: run is not a read/query command and the latch is unset -> not_sent.
    assert.equal(out.source_content_transmission, "not_sent", "pre-spawn run bad_mode honestly discloses not_sent");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("single-source invariant: no bare source_content_transmission literal in the companion", () => {
  // Every disclosure must flow from resolveErrorSinkDisclosure (lib) or NON_TRANSMITTING_DISCLOSURE.
  // A hard-coded `source_content_transmission: "sent"|"not_sent"` reappearing anywhere else is the
  // exact class of bypass this round closed. Comments are ignored; the lone allowed value literal is
  // the NON_TRANSMITTING_DISCLOSURE definition.
  const src = readFileSync(COMPANION, "utf8").split(/\r?\n/);
  const offenders = [];
  for (let i = 0; i < src.length; i += 1) {
    const line = src[i];
    const code = line.replace(/\/\/.*$/, ""); // strip line comments
    if (!/source_content_transmission\s*:\s*"(sent|not_sent)"/.test(code)) continue;
    if (/const NON_TRANSMITTING_DISCLOSURE\s*=\s*Object\.freeze/.test(code)) continue; // the one home
    offenders.push(`${i + 1}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], `bare source_content_transmission literals must not bypass the single source:\n${offenders.join("\n")}`);
});
