// PR #218 round-3 regression — post-spawn git-binary policy ESCAPE finalization.
//
// Confirmed blocker (reproduced under placebo control): when a mid-run RELAY_GIT_BINARY
// topology change makes a POST-spawn git call (consumeCancelMarker / buildAuditManifest /
// persistRecord) throw git_binary_rejected straight out of run(), the pre-fix companion
//   (a) leaked the source-bearing containment worktree into os.tmpdir (never cleaned), and
//   (b) orphaned the durable record as `queued` / `may_be_sent` (foreground said "sent",
//       the persisted record disagreed) — a divergence that aged into stale/unknown.
//
// The fix wraps run()'s containment-holding body in a single finalizer: it always tears the
// worktree down (git-free rmSync) and, for the git-policy class, lands a terminal record
// git-free at the path resolved while git was healthy. Disclosure is governed by the shared
// classifyExecution (pidInfo present ⇒ SENT), so foreground and durable converge to
// failed / agy_error / sent. These tests assert that converged, leak-free terminal state and
// would fail (leak reappears, record stuck queued) if the finalizer were reverted.
//
// The unit test at the end covers writeJobRecordToFile — the git-free shared-state writer the
// finalizer relies on (rules/testing.md: lib functions writing shared state need unit tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fixtureBranchDiffRepo } from "../helpers/fixture-git.mjs";
import { writeJobRecordToFile } from "../../plugins/agy/scripts/lib/state.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/agy/scripts/agy-companion.mjs");
const SECRET = "AGY-ROUND3-LEAK-CANARY-source-body";

function rmTree(target) {
  rmSync(target, { recursive: true, force: true });
}

function writeExecutable(dir, name, source) {
  const bin = path.join(dir, name);
  writeFileSync(bin, source, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

function resolveRealGit() {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" });
  return String(which.stdout ?? "").trim().split(/\r?\n/).filter(Boolean)[0] ?? "";
}

// Minimal brace-matching JSON-stream parser — printJson()/fail() pretty-print multi-line
// objects, so newline splitting is not enough.
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

function agyWorktrees(dir) {
  try { return readdirSync(dir).filter((e) => /^agy-worktree-/.test(e)); } catch { return []; }
}

function treeContains(dir, needle) {
  let found = false;
  const walk = (d) => {
    if (found) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (found) return;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else {
        try { if (readFileSync(full, "utf8").includes(needle)) found = true; } catch { /* skip */ }
      }
    }
  };
  walk(dir);
  return found;
}

test("agy post-spawn git-policy escape: no source-bearing worktree leak + durable record converges to failed/sent", () => {
  const realGit = resolveRealGit();
  assert.ok(realGit, "a real git binary must be resolvable for this test");
  const root = mkdtempSync(path.join(tmpdir(), "agy-escape-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "agy-escape-data-"));
  // Isolated TMPDIR so the companion's containment worktree lands here, not in the shared
  // os.tmpdir — makes leak detection precise and immune to other test files running in
  // parallel under `node --test`.
  const companionTmp = mkdtempSync(path.join(tmpdir(), "agy-escape-tmp-"));
  const cwd = path.join(root, "ws");
  mkdirSync(cwd);
  try {
    const { base } = fixtureBranchDiffRepo(cwd, { changedFileContents: `${SECRET}\n` });
    // Override git OUTSIDE the workspace at spawn time (sibling under root).
    const gitbin = path.join(root, "gitbin");
    mkdirSync(gitbin);
    const override = writeExecutable(gitbin, "git", `#!/bin/sh\nexec ${JSON.stringify(realGit)} "$@"\n`);
    const capturePath = path.join(root, "captured-prompt.txt");
    // Mock target: capture --print (proves the source was delivered to the target), then
    // create root/.git mid-run so root becomes the outermost boundary CONTAINING gitbin —
    // the post-spawn resolveGitBinary cacheKey misses and re-validation rejects the override.
    const mock = writeExecutable(root, "agy-escape-mock", [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'models') { console.log('verified-local-model'); process.exit(0); }",
      "const pi = args.indexOf('--print');",
      `fs.writeFileSync(${JSON.stringify(capturePath)}, pi >= 0 ? args[pi + 1] : '');`,
      `try { fs.mkdirSync(${JSON.stringify(path.join(root, ".git"))}); } catch {}`,
      "console.log('Verdict: APPROVE');",
      "console.log('Blocking findings');",
      "console.log('- None. I inspected the selected source packet and found no blocking issues. I checked source-routing leaks, behavioral regressions, missing tests, and security-sensitive changes against the selected AGY source rather than an unrestricted workspace walk.');",
      "console.log('Non-blocking concerns');",
      "console.log('- None. The selected source packet was reviewed for the requested mode, scope base, and external-review contract.');",
      "console.log('- Residual risk: none after checking the selected source packet.');",
      "",
    ].join("\n"));

    assert.equal(agyWorktrees(companionTmp).length, 0, "isolated tmp must start clean");
    const run = spawnSync(process.execPath, [
      COMPANION, "run", "--mode", "review", "--cwd", cwd, "--scope-base", base,
      "--lifecycle-events", "jsonl", "--timeout-ms", "30000", "please review the change",
    ], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: companionTmp, AGY_PLUGIN_DATA: dataDir, RELAY_GIT_BINARY: override, AGY_BINARY: mock },
    });

    // The source genuinely reached the target (this is a POST-spawn failure).
    assert.equal(existsSync(capturePath), true, run.stderr || run.stdout);

    const objs = parseJsonStream(run.stdout);
    const launch = objs.find((o) => o.event === "external_review_launched");
    assert.ok(launch?.job_id, `launch event missing job_id: ${run.stdout}`);
    const jobId = launch.job_id;
    const terminal = objs.at(-1);

    // (1) Foreground terminal converges to a finalized failed record disclosing SENT.
    assert.equal(terminal.status, "failed", "foreground must be a terminal failed record, not an orphaned queued one");
    assert.equal(terminal.error_code ?? terminal.external_review?.error_code, "agy_error",
      "post-spawn git_binary_rejected (pidInfo present) reclassifies to the content-received agy_error catch-all");
    assert.ok((terminal.error_message ?? "").length > 0, "the git-policy cause must remain in error_message");
    assert.equal(
      terminal.source_content_transmission ?? terminal.external_review?.source_content_transmission,
      "sent",
      "a post-spawn failure after the source was sent must disclose SENT",
    );
    // Record-level parity with the in-band post-run rejection: the post-spawn escape must
    // preserve runtime_diagnostics (source_packet_policy), not drop it to null.
    assert.ok(
      terminal.runtime_diagnostics?.source_packet_policy,
      "escape record must carry runtime_diagnostics.source_packet_policy (parity with in-band terminal records)",
    );

    // (2) The source-bearing containment worktree must NOT leak into tmp.
    const leaked = agyWorktrees(companionTmp);
    assert.equal(leaked.length, 0, `containment worktree leaked: ${JSON.stringify(leaked)}`);
    for (const name of leaked) {
      assert.equal(treeContains(path.join(companionTmp, name), SECRET), false, "leaked worktree carries source content");
    }

    // (3) The durable record converges (read with a HEALTHY git — the override is dropped, so
    //     resolveWorkspaceRoot/reconcile can resolve the inner ws/.git and heal state.json
    //     from the git-free terminal meta). Pre-fix this read returned queued / may_be_sent.
    const statusRun = spawnSync(process.execPath, [COMPANION, "status", "--cwd", cwd, "--job", jobId], {
      cwd, encoding: "utf8", env: { ...process.env, AGY_PLUGIN_DATA: dataDir },
    });
    assert.equal(statusRun.status, 0, statusRun.stderr || statusRun.stdout);
    const statusRecord = JSON.parse(statusRun.stdout);
    assert.equal(statusRecord.status, "failed", "durable record must be terminal failed, not orphaned queued");
    assert.equal(
      statusRecord.external_review?.source_content_transmission,
      "sent",
      "durable disclosure must converge with the foreground (sent), not stay may_be_sent",
    );

    const resultRun = spawnSync(process.execPath, [COMPANION, "result", "--cwd", cwd, "--job", jobId], {
      cwd, encoding: "utf8", env: { ...process.env, AGY_PLUGIN_DATA: dataDir },
    });
    assert.equal(resultRun.status, 0, resultRun.stderr || resultRun.stdout);
    const resultRecord = JSON.parse(resultRun.stdout);
    assert.equal(resultRecord.status, "failed");
    assert.equal(resultRecord.error_code, "agy_error");
    assert.equal(resultRecord.external_review?.source_content_transmission, "sent");
    assert.ok(
      resultRecord.runtime_diagnostics?.source_packet_policy,
      "durable record must carry runtime_diagnostics.source_packet_policy",
    );
  } finally {
    for (const name of agyWorktrees(companionTmp)) { try { rmTree(path.join(companionTmp, name)); } catch { /* ignore */ } }
    rmTree(companionTmp);
    rmTree(dataDir);
    rmTree(root);
  }
});

test("writeJobRecordToFile: atomic git-free write to a pre-resolved path round-trips and leaves no tmp residue", () => {
  const readBack = (file) => JSON.parse(readFileSync(file, "utf8"));
  const root = mkdtempSync(path.join(tmpdir(), "agy-wjr-"));
  try {
    // Deliberately point at a not-yet-existent nested dir to exercise mkdirSync(recursive)
    // — the finalizer resolves this path while git is healthy, the dir may not exist yet.
    const jobFile = path.join(root, "state", "ws-hash", "jobs", "job-abc", "meta.json");
    const payload = { job_id: "job-abc", status: "failed", error_code: "agy_error" };
    const returned = writeJobRecordToFile(jobFile, payload);
    assert.equal(returned, jobFile, "returns the written path");
    assert.deepEqual(readBack(jobFile), payload, "round-trips the payload");
    assert.equal(readFileSync(jobFile, "utf8").endsWith("\n"), true, "writes a trailing newline like writeJobFile");
    // No .tmp residue from the atomic tmp+rename.
    assert.equal(readdirSync(path.dirname(jobFile)).filter((e) => e.includes(".tmp")).length, 0);

    // Overwrites in place (atomic replace).
    const updated = { job_id: "job-abc", status: "completed", error_code: null };
    writeJobRecordToFile(jobFile, updated);
    assert.deepEqual(readBack(jobFile), updated, "overwrites the prior record");
    assert.equal(readdirSync(path.dirname(jobFile)).filter((e) => e.includes(".tmp")).length, 0);

    // Input validation: a missing/empty path is a programming error, not a silent no-op.
    assert.throws(() => writeJobRecordToFile("", { a: 1 }), /non-empty string/);
    assert.throws(() => writeJobRecordToFile(null, { a: 1 }), /non-empty string/);
  } finally {
    rmTree(root);
  }
});
