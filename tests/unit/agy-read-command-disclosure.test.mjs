// PR #218 follow-up #240 (item 1) — read-command error envelopes must not carry a bare
// top-level source_content_transmission.
//
// The AGY top-level error sinks (fail() / main().catch) used to stamp
//   source_content_transmission: sourceSentToTarget ? "sent" : "not_sent"
// on EVERY command's error envelope. For the read commands (status / result / cancel) — which
// spawn no target and transmit no source — the latch is always false, so they emitted a bare
// top-level "not_sent". That is misleading: a consumer keying on the top-level field could read
// it as "the job's source was not sent", when the job's real disclosure lives nested at
// external_review.source_content_transmission on the persisted record (and stays correct).
//
// The fix gates the field behind errorSinkDisclosure(): only source-bearing commands (run — the
// only command that spawns the AGY target) disclose, and the latch overrides so a genuinely-sent
// source is ALWAYS disclosed (never the dangerous under-warning direction). Read commands omit
// the field. These tests fail if the gate is reverted (read-command fail() re-emits "not_sent").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/agy/scripts/agy-companion.mjs");
const MISSING_JOB = "00000000-0000-0000-0000-000000000000";

function rmTree(target) {
  rmSync(target, { recursive: true, force: true });
}

function resolveRealGit() {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" });
  return String(which.stdout ?? "").trim().split(/\r?\n/).filter(Boolean)[0] ?? "";
}

// Minimal brace-matching JSON-stream parser — printJson()/fail() pretty-print multi-line objects.
function parseJsonStream(raw) {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth += 1; }
    else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) { try { objs.push(JSON.parse(raw.slice(start, i + 1))); } catch { /* skip */ } start = -1; }
    }
  }
  return objs;
}

function gitRepo(cwd) {
  const real = resolveRealGit();
  assert.ok(real, "a real git binary must be resolvable for this test");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (args) => spawnSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(cwd, "old.md"), "old\n"); git(["add", "old.md"]); git(["commit", "-q", "-m", "main"]);
  const base = git(["rev-parse", "HEAD"]).stdout.trim();
  git(["checkout", "-qb", "feature"]);
  writeFileSync(path.join(cwd, "foo.md"), "body\n"); git(["add", "foo.md"]); git(["commit", "-q", "-m", "feature"]);
  return { real, base };
}

function lastEnvelope(run) {
  const objs = parseJsonStream(run.stdout);
  return objs.at(-1) ?? {};
}

function companion(args, cwd, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

test("agy read-command error envelopes omit the top-level source_content_transmission (#240)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agy-readdisc-"));
  const cwd = path.join(root, "ws");
  mkdirSync(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "agy-readdisc-data-"));
  try {
    gitRepo(cwd);
    const env = { AGY_PLUGIN_DATA: dataDir };
    // status / result / cancel for a non-existent job all route through fail("not_found").
    for (const cmd of ["status", "result", "cancel"]) {
      const envelope = lastEnvelope(companion([cmd, "--cwd", cwd, "--job", MISSING_JOB], cwd, env));
      assert.equal(envelope.ok, false, `${cmd}: expected an error envelope, got ${JSON.stringify(envelope)}`);
      assert.equal(envelope.error_code, "not_found", `${cmd}: expected not_found`);
      assert.equal(
        "source_content_transmission" in envelope,
        false,
        `${cmd} read-command error envelope must omit the top-level source_content_transmission (#240); got keys ${JSON.stringify(Object.keys(envelope))}`,
      );
    }

    // continue/resume is NOT a read command: it fail-closes with "not_sent" to assert that no
    // source was resent, so it MUST keep disclosing (contrast with the read commands above).
    // (Smoke covers this too, but smoke is CI-skipped — this always-run guard locks the contract.)
    const continueEnvelope = lastEnvelope(companion(["continue", "--cwd", cwd], cwd, env));
    assert.equal(continueEnvelope.ok, false, "continue must fail-close");
    assert.equal(
      continueEnvelope.source_content_transmission,
      "not_sent",
      "continue (resume) error must keep disclosing not_sent (fail-closed: no source resent), not omit (#240)",
    );
  } finally {
    rmTree(root);
    rmTree(dataDir);
  }
});

test("agy git-policy error: read command omits disclosure, run (source-bearing) keeps it (#240)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agy-readdisc-wedge-"));
  const cwd = path.join(root, "ws");
  mkdirSync(cwd);
  const dataDir = mkdtempSync(path.join(tmpdir(), "agy-readdisc-wedge-data-"));
  try {
    const { real, base } = gitRepo(cwd);
    // A RELAY_GIT_BINARY override INSIDE the workspace trips the git-policy guard at
    // resolveWorkspaceRoot — pre-spawn, on any command — so the failure reaches the top-level
    // error sinks (fail / main().catch). This is the exact shape of the #240 wedged-read case.
    const gitbin = path.join(cwd, "insidegit");
    mkdirSync(gitbin);
    const override = path.join(gitbin, "git");
    writeFileSync(override, `#!/bin/sh\nexec ${real} "$@"\n`);
    chmodSync(override, 0o755);
    const env = { AGY_PLUGIN_DATA: dataDir, RELAY_GIT_BINARY: override };

    // Read command (status): git_binary_rejected, but NO top-level disclosure.
    const statusEnvelope = lastEnvelope(companion(["status", "--cwd", cwd, "--job", MISSING_JOB], cwd, env));
    assert.equal(statusEnvelope.ok, false, `status: expected an error envelope, got ${JSON.stringify(statusEnvelope)}`);
    assert.equal(statusEnvelope.error_code, "git_binary_rejected", "status: expected the git-policy rejection");
    assert.equal(
      "source_content_transmission" in statusEnvelope,
      false,
      `wedged read-command (status) error must omit the top-level source_content_transmission (#240); got keys ${JSON.stringify(Object.keys(statusEnvelope))}`,
    );

    // Run command (source-bearing): same git-policy rejection, but it MUST still disclose
    // (here "not_sent" — honest, the failure is pre-spawn). The gate must not strip run-path
    // disclosure, preserving the round-2 latch / round-3 finalizer invariants.
    const runEnvelope = lastEnvelope(companion(
      ["run", "--mode", "review", "--cwd", cwd, "--scope-base", base, "--timeout-ms", "5000", "please review"],
      cwd,
      env,
    ));
    assert.equal(runEnvelope.ok, false, `run: expected an error envelope, got ${JSON.stringify(runEnvelope)}`);
    assert.equal(runEnvelope.error_code, "git_binary_rejected", "run: expected the git-policy rejection");
    assert.equal(
      "source_content_transmission" in runEnvelope,
      true,
      "run-path (source-bearing) error must STILL disclose source_content_transmission (#240 no-regression)",
    );
    assert.equal(runEnvelope.source_content_transmission, "not_sent", "pre-spawn run failure honestly discloses not_sent");
  } finally {
    rmTree(root);
    rmTree(dataDir);
  }
});
