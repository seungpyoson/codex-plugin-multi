// M7 regression matrix — ONE test per M6 cross-model-review finding.
//
// Every defect the M6 jury + Gemini/Claude reviewers surfaced gets exactly one
// named regression here. The naming convention is load-bearing:
//
//   "M6-finding-<id>: <behavior>"  — 1:1 with the finding
//   "M6-mock-gap: <behavior>"      — coverage of a behavior the M6-era mock
//                                    could not exercise (timeoutMs; real-fs
//                                    mutation detection)
//
// The MATRIX_FINDINGS table below is the single source of truth. A completion
// test at the bottom asserts every row is represented by a `t.test()` whose
// name includes the ID — adding a finding without updating MATRIX_FINDINGS
// fails the matrix-completeness check before the test suite reports green.
//
// Policy: if a canonical regression already lives in another smoke file, it
// MOVED here. Finding-scoped tests are not duplicated across files; tests that
// are more nuanced than "does this one defect reproduce" stay in their
// functional home. The six findings moved-in are noted inline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { spawnClaude } from "../../plugins/claude/scripts/lib/claude.mjs";
import { resolveProfile } from "../../plugins/claude/scripts/lib/mode-profiles.mjs";

// ---------------------------------------------------------------------------
// MATRIX_FINDINGS — the contract. Finding ID → test-name fragment.
//
// Adding a new M6 finding is two lines: one row here, one `test(...)` block
// below. The completion assertion enforces the mapping.
export const MATRIX_FINDINGS = Object.freeze([
  { id: "C2",  fragment: "M6-finding-C2: silent Opus billing" },
  { id: "G-HIGH", fragment: "M6-finding-G-HIGH: rescue keeps CLAUDE.md context" },
  { id: "4",   fragment: "M6-finding-4: review sees dirty working tree" },
  { id: "4-containment", fragment: "M6-finding-4-containment: mutation detection catches writes to childCwd" },
  { id: "6",   fragment: "M6-finding-6: continue chain resumes LATEST claude_session_id" },
  { id: "7",   fragment: "M6-finding-7: PID-reuse cancel refused" },
  { id: "7-pipeline", fragment: "M6-finding-7-pipeline: cancel on a real running background job" },
  { id: "1-H1", fragment: "M6-finding-1-H1: background worker persists parsed.result" },
  { id: "9",   fragment: "M6-finding-9: full prompt never persisted" },
  { id: "10",  fragment: "M6-finding-10: every lib is importable and has a consumer" },
  { id: "cwd-inherit", fragment: "M6-finding-cwd-inherit: cmdContinue inherits prior.cwd" },
]);

export const MOCK_GAPS = Object.freeze([
  { id: "timeout",  fragment: "M6-mock-gap: timeoutMs fires SIGTERM when claude hangs" },
  { id: "mutation", fragment: "M6-mock-gap: mutation detected when claude writes a file" },
]);

// ---------------------------------------------------------------------------
// Shared harness — mirrors the pattern used in claude-companion.smoke.test.mjs
// and identity-resume-chain.smoke.test.mjs. Kept local to this file so the
// matrix is self-contained; a reader diagnosing a single failing finding
// doesn't need to cross-reference another file's helpers.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs");
const MOCK = path.join(REPO_ROOT, "tests/smoke/claude-mock.mjs");

function runCompanion(args, { cwd, env = {}, dataDir } = {}) {
  const dd = dataDir ?? mkdtempSync(path.join(tmpdir(), "inv-data-"));
  const res = spawnSync("node", [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_BINARY: MOCK,
      CLAUDE_PLUGIN_DATA: dd,
      ...env,
    },
  });
  return { ...res, dataDir: dd };
}

function seedMinimalRepo(cwd) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
  spawnSync("bash", ["-c",
    "echo seed > seed.txt && git add seed.txt && " +
    "git -c user.email=t@t -c user.name=t commit -q -m seed"], { cwd });
}

function seedDirtyRepo(cwd) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
  spawnSync("bash", ["-c",
    "echo original > seed.txt && git add seed.txt && " +
    "git -c user.email=t@t -c user.name=t commit -q -m seed && " +
    "echo modified > seed.txt"], { cwd });
}

function findMetaPath(dataDir, jobId) {
  const stateRoot = path.join(dataDir, "state");
  for (const dir of readdirSync(stateRoot)) {
    const p = path.join(stateRoot, dir, "jobs", `${jobId}.json`);
    if (existsSync(p)) return p;
  }
  throw new Error(`no meta for ${jobId}`);
}

function findStatePath(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  for (const dir of readdirSync(stateRoot)) {
    const p = path.join(stateRoot, dir, "state.json");
    if (existsSync(p)) return p;
  }
  throw new Error("no state.json");
}

function patchJob(dataDir, jobId, patch) {
  const metaPath = findMetaPath(dataDir, jobId);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  writeFileSync(metaPath, JSON.stringify({ ...meta, ...patch }, null, 2));
  const statePath = findStatePath(dataDir);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const idx = state.jobs.findIndex((j) => j.id === jobId);
  if (idx >= 0) {
    state.jobs[idx] = { ...state.jobs[idx], ...patch };
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
}

// Read the mock's stdout.log sidecar — has the fixture incl. t7_ oracle fields.
function readStdoutLog(dataDir, jobId) {
  const stateRoot = path.join(dataDir, "state");
  for (const dir of readdirSync(stateRoot)) {
    const p = path.join(stateRoot, dir, "jobs", jobId, "stdout.log");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error(`no stdout.log for job ${jobId}`);
}

// ---------------------------------------------------------------------------
// FINDING C2 — silent Opus billing. INLINE (approach A).
//
// Root cause: the pre-T7.1 dispatcher used a `mode === "rescue" ? "default"
// : "default"` ternary that billed Opus for every review. T7.1 routes model
// resolution through the profile's `model_tier`. This test runs `review`
// with NO --model flag and asserts the resolved model is the CHEAP tier
// from config/models.json (claude-haiku-4-5-20251001) — i.e., NOT Opus.
//
// Oracle: the mock records what --model it received; we inspect it via the
// stdout.log sidecar which captures the fixture the mock emitted.

test("M6-finding-C2: silent Opus billing — review with no --model uses cheap tier", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "inv-c2-"));
  seedMinimalRepo(cwd);
  // No --model flag. Rely on profile.model_tier=cheap → config.cheap.
  // The mock needs a matching fixture; cheap-tier fixture (default.json)
  // is the only one in tests/smoke/fixtures/claude/, so this also verifies
  // the cheap model ID matches the fixture's routing key.
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--cwd", cwd, "--", "review: x=1"],
    { cwd }
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    // JobRecord captures the resolved model. Cheap tier, never Opus.
    const expected = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "plugins/claude/config/models.json"), "utf8")
    );
    assert.equal(record.model, expected.cheap,
      `review must default to cheap tier ${expected.cheap}; got ${record.model}`);
    assert.notEqual(record.model, expected.default,
      `review must NOT default to Opus (${expected.default}); that's the C2 regression`);
    assert.equal(record.model, "claude-haiku-4-5-20251001",
      "drift check: cheap tier pinned to haiku in config/models.json");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING G-HIGH — rescue strips CLAUDE.md.  INLINE (approach A).
//
// Root cause: a blanket `--setting-sources ""` was applied to all modes,
// silently wiping the user's CLAUDE.md context on rescue — which is the
// ONE mode where CLAUDE.md MUST be inherited (spec §9). T7.1's profile
// table gates `--setting-sources ""` on `profile.strip_context`, false for
// rescue and true for review / adversarial-review / ping.
//
// Oracle: build the argv via buildClaudeArgs directly, then inspect it.
// Calling the companion-shelled path is overkill for an argv-shape assertion
// and adds flake surface.

test("M6-finding-G-HIGH: rescue keeps CLAUDE.md context — no --setting-sources flag", async () => {
  const { buildClaudeArgs } = await import("../../plugins/claude/scripts/lib/claude.mjs");
  const rescue = resolveProfile("rescue");
  const argv = buildClaudeArgs(rescue, {
    model: "claude-opus-4-7",
    promptText: "fix: something",
    sessionId: "00000000-0000-4000-8000-000000000000",
  });
  assert.ok(!argv.includes("--setting-sources"),
    `rescue argv must NOT include --setting-sources; got: ${argv.join(" ")}`);

  // Contrast: review MUST include `--setting-sources ""`.
  const review = resolveProfile("review");
  const revArgv = buildClaudeArgs(review, {
    model: "claude-haiku-4-5-20251001",
    promptText: "review this",
    sessionId: "00000000-0000-4000-8000-000000000000",
  });
  const i = revArgv.indexOf("--setting-sources");
  assert.ok(i >= 0, `review argv must include --setting-sources; got: ${revArgv.join(" ")}`);
  assert.equal(revArgv[i + 1], "",
    `review's --setting-sources value must be "" (empty); got ${JSON.stringify(revArgv[i + 1])}`);
});

// ---------------------------------------------------------------------------
// FINDING 4 — review can't see dirty working tree.  MOVED from
// claude-companion.smoke.test.mjs ("review sees dirty working tree (M6
// finding #4)"). Canonical regression now lives here.

test("M6-finding-4: review sees dirty working tree — worktree contains uncommitted changes", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "inv-dirty-"));
  seedDirtyRepo(cwd);
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "focus"],
    { cwd, env: { CLAUDE_MOCK_ASSERT_FILE: "seed.txt" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const result = JSON.parse(stdout);
    const fx = readStdoutLog(dataDir, result.job_id);
    assert.equal(fx.t7_saw_file, true,
      `review should see dirty seed.txt under --add-dir; add_dir=${fx.t7_add_dir}`);
    assert.notEqual(fx.t7_add_dir, cwd,
      "review's containment=worktree should NOT pass sourceCwd as --add-dir");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING 6 — continue session chain.  MOVED from
// identity-resume-chain.smoke.test.mjs ("continue chain: resume arg is LATEST
// claude_session_id, not an intermediate job_id"). Canonical home is here.

test("M6-finding-6: continue chain resumes LATEST claude_session_id, not an intermediate job_id", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "inv-chain-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "inv-chain-data-"));
  const resumeSink = path.join(dataDir, "last-resume.txt");
  try {
    seedMinimalRepo(cwd);
    // Run 1 — fresh rescue; companion passes --session-id=job_1.
    const r1 = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "seed"],
      { cwd, dataDir,
        env: { CLAUDE_MOCK_RECORD_RESUME: "1", CLAUDE_MOCK_RESUME_SINK: resumeSink } });
    assert.equal(r1.status, 0, r1.stderr);
    const job1 = JSON.parse(r1.stdout).job_id;
    const meta1 = JSON.parse(readFileSync(findMetaPath(dataDir, job1), "utf8"));
    assert.ok(meta1.claude_session_id, "run 1 must capture claude_session_id");
    const claudeSid1 = meta1.claude_session_id;
    assert.deepEqual(meta1.resume_chain, [], "fresh run has empty resume_chain");
    assert.equal(meta1.session_id, undefined,
      "legacy session_id field must not be present on new-shape records");

    // Run 2 — continue from job1. Companion mints job_2, passes --resume=<claudeSid1>.
    // T7.7 B4: continue inherits prior.cwd by default; no --cwd flag.
    const r2 = runCompanion(
      ["continue", "--job", job1, "--foreground", "--", "followup"],
      { cwd, dataDir,
        env: { CLAUDE_MOCK_RECORD_RESUME: "1", CLAUDE_MOCK_RESUME_SINK: resumeSink } });
    assert.equal(r2.status, 0, r2.stderr);
    const job2 = JSON.parse(r2.stdout).job_id;
    assert.notEqual(job2, job1, "continue must mint a new job_id");
    const meta2 = JSON.parse(readFileSync(findMetaPath(dataDir, job2), "utf8"));
    assert.deepEqual(meta2.resume_chain, [claudeSid1],
      "resume_chain on continue should be [priorClaudeSessionId]");
    assert.equal(meta2.parent_job_id, job1);
    const resumeRecv1 = readFileSync(resumeSink, "utf8").trim();
    assert.equal(resumeRecv1, claudeSid1,
      `first --resume must be claudeSid1=${claudeSid1}; got ${resumeRecv1}`);

    // Run 3 — continue from job2. Resume arg MUST be job2's claude_session_id,
    // i.e., the fresh UUID Claude minted on run 2 — NOT job2 (companion UUID)
    // nor claudeSid1 (a dead earlier session). This is the exact regression.
    const claudeSid2 = meta2.claude_session_id;
    assert.ok(claudeSid2, "run 2 must have captured claude_session_id");
    const r3 = runCompanion(
      ["continue", "--job", job2, "--foreground", "--", "third"],
      { cwd, dataDir,
        env: { CLAUDE_MOCK_RECORD_RESUME: "1", CLAUDE_MOCK_RESUME_SINK: resumeSink } });
    assert.equal(r3.status, 0, r3.stderr);
    const job3 = JSON.parse(r3.stdout).job_id;
    const meta3 = JSON.parse(readFileSync(findMetaPath(dataDir, job3), "utf8"));
    assert.deepEqual(meta3.resume_chain, [claudeSid1, claudeSid2],
      "chained continue must accumulate resume_chain newest-last");
    const resumeRecv2 = readFileSync(resumeSink, "utf8").trim();
    assert.equal(resumeRecv2, claudeSid2,
      `chained --resume must be claudeSid2=${claudeSid2}; got ${resumeRecv2} ` +
      `(legacy bug would have used job2=${job2})`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING 7 — PID-reuse cancel.  MOVED from identity-resume-chain.smoke.test.mjs
// ("cancel: refuses with stale_pid when pid_info.starttime mismatches").

test("M6-finding-7: PID-reuse cancel refused — tampered starttime halts signaling", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "inv-stale-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "inv-stale-data-"));
  try {
    seedMinimalRepo(cwd);
    const r1 = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "stale-test"],
      { cwd, dataDir });
    assert.equal(r1.status, 0, r1.stderr);
    const jobId = JSON.parse(r1.stdout).job_id;
    const meta0 = JSON.parse(readFileSync(findMetaPath(dataDir, jobId), "utf8"));
    assert.ok(meta0.pid_info, "new record must carry pid_info");

    // Flip to `running` and point pid_info at the CURRENT process with a
    // bogus starttime. kill(pid,0) would succeed — verifyPidInfo is the guard.
    patchJob(dataDir, jobId, {
      status: "running",
      pid_info: {
        pid: process.pid,
        starttime: "Jan 1 00:00:00 1970",
        argv0: meta0.pid_info.argv0 ?? "node",
      },
    });

    const cancelRes = runCompanion(
      ["cancel", "--job", jobId, "--cwd", cwd],
      { cwd, dataDir });
    assert.notEqual(cancelRes.status, 0,
      `cancel must fail on stale_pid; got exit ${cancelRes.status}`);
    assert.match(cancelRes.stderr, /stale_pid/,
      `stderr must mention stale_pid; got: ${cancelRes.stderr}`);
    assert.equal(process.killed ?? false, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING 1 / H1 — background result lost.  MOVED from
// claude-companion.smoke.test.mjs ("run --background: emits launched event
// and terminal meta arrives"). The bg-sidecar test stays put (different
// behavior). Canonical terminal-meta-has-result regression lives here.

test("M6-finding-1-H1: background worker persists parsed.result on terminal JobRecord", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "inv-bg-"));
  const { stdout, status, dataDir } = runCompanion(
    ["run", "--mode=rescue", "--background", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "bg task"],
    { cwd }
  );
  try {
    assert.equal(status, 0);
    const ev = JSON.parse(stdout);
    assert.equal(ev.event, "launched");
    const stateRoot = path.join(dataDir, "state");
    const deadline = Date.now() + 5000;
    let meta = null;
    while (Date.now() < deadline) {
      for (const dir of readdirSync(stateRoot)) {
        const metaPath = path.join(stateRoot, dir, "jobs", `${ev.job_id}.json`);
        if (existsSync(metaPath)) {
          const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
          if (parsed.status === "completed" || parsed.status === "failed") {
            meta = parsed; break;
          }
        }
      }
      if (meta) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(meta, "worker never wrote terminal meta");
    // The exact regression: pre-T7.4 the bg worker dropped parsed.result onto
    // the floor between the foreground→worker split. cmdResult then returned
    // meta without `result`.
    assert.equal(meta.result, "Mock Claude response.",
      "background worker must persist parsed.result on the JobRecord");
    assert.deepEqual(meta.permission_denials, []);
    assert.ok("mutations" in meta, "background JobRecord carries mutations array");
    assert.ok("cost_usd" in meta, "background JobRecord carries cost_usd");
    assert.equal(meta.schema_version, 5);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING 9 — full prompt persisted.  MOVED from claude-companion.smoke.test.mjs
// ("T7.4 / §21.3.1: full prompt must not appear on any persisted record").

test("M6-finding-9: full prompt never persisted — only prompt_head ≤200 chars", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "inv-prompt-"));
  seedMinimalRepo(cwd);
  const LONG_PROMPT = "review this code: " + "x".repeat(300);
  const { stdout, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground", "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", LONG_PROMPT],
    { cwd }
  );
  try {
    const { job_id } = JSON.parse(stdout);
    const metaPath = findMetaPath(dataDir, job_id);
    const raw = readFileSync(metaPath, "utf8");
    const meta = JSON.parse(raw);
    assert.equal("prompt" in meta, false,
      "§21.3.1: persisted record MUST NOT carry a full `prompt` field");
    assert.equal(meta.prompt_head.length <= 200, true,
      "prompt_head must be ≤200 chars");
    const tail = "x".repeat(250);
    assert.equal(raw.includes(tail), false,
      "§21.3.1: full prompt text must not appear anywhere in persisted JSON");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINDING 10 — broken lib module shipped.  REFERENCES tests/unit/lib-imports.test.mjs.
//
// The per-lib parameterised suite lives in lib-imports.test.mjs (44+ tests,
// one per lib file × assertion kind). Duplicating that here would be a
// test-anti-pattern. Instead: name a single regression that exercises the
// SAME contract — importability + production-consumer-exists — against a
// representative lib, and reference the authoritative suite in the docstring.
//
// If the authoritative suite is deleted, this smoke still catches a broken
// lib on its own.

test("M6-finding-10: every lib is importable and has a consumer (authoritative suite: tests/unit/lib-imports.test.mjs)", async () => {
  const libDir = path.join(REPO_ROOT, "plugins/claude/scripts/lib");
  const libFiles = readdirSync(libDir).filter((n) => n.endsWith(".mjs"));
  assert.ok(libFiles.length > 0, "claude plugin has at least one lib file");
  // Import every lib — this is the class-of-problem check. A broken lib
  // (missing import target, syntax error, wrong path) throws here.
  for (const name of libFiles) {
    const mod = await import(pathToFileURL(path.join(libDir, name)).href);
    assert.ok(mod && typeof mod === "object",
      `lib/${name}: import returned no module namespace`);
  }
  // Consumer check: the authoritative lib-imports test parameterises this
  // across every lib. Here we spot-check one well-known production consumer
  // wires at least one lib, so the matrix has something to fail on if the
  // companion entry is replaced with a stub.
  const companion = readFileSync(
    path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"), "utf8");
  assert.match(companion, /\.\/lib\//,
    "claude-companion.mjs must import at least one lib — §21.5 consumer check");
});

// ---------------------------------------------------------------------------
// Gap-coverage: behaviors the M6 mock couldn't exercise
// ---------------------------------------------------------------------------

// timeoutMs in spawnClaude was added but never regression-tested (no mock hook
// to hang the child). T7.6 adds CLAUDE_MOCK_DELAY_MS. Companion wires
// timeoutMs=0 today, so this test drives spawnClaude DIRECTLY.

test("M6-mock-gap: timeoutMs fires SIGTERM when claude hangs (no coverage pre-T7.6)", async () => {
  // spawnClaude's `binary` is passed directly to child_process.spawn. The mock
  // is chmod 0755 with a `#!/usr/bin/env node` shebang, so spawning it by
  // path invokes node + the mock — exactly what CLAUDE_BINARY=MOCK does in
  // the companion-level smokes. Here we bypass the companion so we can drive
  // timeoutMs > 0 (the companion wires timeoutMs=0; M6 reviewer's gap).
  const profile = resolveProfile("rescue");
  const result = await spawnClaude(profile, {
    model: "claude-haiku-4-5-20251001",
    promptText: "hang please",
    sessionId: "00000000-0000-4000-8000-000000000000",
    binary: MOCK,
    cwd: tmpdir(),
    timeoutMs: 500,
    env: { ...process.env, CLAUDE_MOCK_DELAY_MS: "5000" },
  });
  // Under timeout: spawnClaude's setTimeout fires → SIGTERM → SIGKILL 2s later.
  // `timedOut` is the load-bearing signal; exitCode may be null if killed by signal.
  assert.equal(result.timedOut, true,
    `spawnClaude should report timedOut=true; got timedOut=${result.timedOut} exitCode=${result.exitCode} signal=${result.signal}`);
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL" || result.exitCode !== 0,
    `expected timeout-killed child; got signal=${result.signal} exitCode=${result.exitCode}`);
});

// Mutation-detection gap: rescue mode does not run mutation-detection (plan
// modes only). Review mode runs mutation-detection against childCwd (T7.7 C2),
// so a relative CLAUDE_MOCK_MUTATE_FILE lands inside the worktree and is
// caught by the tryGit(childCwd) pre/post snapshot. This gap test exercises
// the "mock can drive a mutation at all" contract; "4-containment" above
// exercises the specific childCwd invariant.

test("M6-mock-gap: mutation detected when claude writes a file (no coverage pre-T7.6)", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "inv-mut-"));
  seedMinimalRepo(cwd);
  // Relative — mock resolves into addDir (childCwd) under containment=worktree.
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review"],
    { cwd, env: { CLAUDE_MOCK_MUTATE_FILE: "foo.md" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.ok(Array.isArray(record.mutations),
      "JobRecord must carry a mutations array");
    // git status -s --untracked-files=all prints "?? foo.md" for a new file.
    const saw = record.mutations.some((l) => l.includes("foo.md"));
    assert.ok(saw,
      `mutations[] must mention foo.md; got ${JSON.stringify(record.mutations)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T7.7 C2 / B2 — mutation detection runs against childCwd, not sourceCwd.
//
// Under containment=worktree (review / adversarial-review), Claude writes to
// `childCwd = containment.path` — the copied worktree, NOT the user's sourceCwd.
// Pre-T7.7, `tryGit` was called with sourceCwd on both pre/post snapshots, so
// any file Claude created inside the worktree was invisible to the diff. The
// fix is one-line: pass childCwd to both tryGit calls.
//
// Oracle: pass a RELATIVE CLAUDE_MOCK_MUTATE_FILE so the mock writes into addDir
// (the worktree, since addDir!=cwd under review). Assert mutations[] non-empty.
//
// Contrast with "M6-mock-gap: mutation detected ..." above, which uses an
// ABSOLUTE target to write directly into sourceCwd — that exercises the old
// (broken) detection path. This test exercises the containment-aware path.

test("M6-finding-4-containment: mutation detection catches writes to childCwd under containment=worktree", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "inv-mut-child-"));
  seedMinimalRepo(cwd);
  // Relative path — the mock resolves against addDir (childCwd) when
  // addDir != process.cwd(), which is true under containment=worktree.
  const { stdout, status, stderr, dataDir } = runCompanion(
    ["run", "--mode=review", "--foreground",
     "--model", "claude-haiku-4-5-20251001",
     "--cwd", cwd, "--", "review"],
    { cwd, env: { CLAUDE_MOCK_MUTATE_FILE: "child-only.md" } }
  );
  try {
    assert.equal(status, 0, `exit ${status}: ${stderr}`);
    const record = JSON.parse(stdout);
    assert.ok(Array.isArray(record.mutations),
      "JobRecord must carry a mutations array");
    const saw = record.mutations.some((l) => l.includes("child-only.md"));
    assert.ok(saw,
      `mutations[] must detect writes into childCwd (containment=worktree); ` +
      `got ${JSON.stringify(record.mutations)}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T7.7 C2 / B4 — cmdContinue inherits prior.cwd.
//
// Pre-T7.7, cmdContinue read `options.cwd ?? process.cwd()`, ignoring the
// directory the prior job was anchored to. Claude's session memory is keyed
// to that cwd; a continue from an unrelated shell cwd resumed the session
// against the wrong tree. The fix is two-part:
//   - default: cwd = prior.cwd
//   - explicit override: --override-cwd <path>
//   - --cwd on continue: reject, point to --override-cwd
//
// Three tests cover the class: default inheritance, explicit override accepted,
// --cwd rejected.

test("M6-finding-cwd-inherit: cmdContinue inherits prior.cwd when --cwd/--override-cwd omitted", () => {
  const cwd1 = mkdtempSync(path.join(tmpdir(), "inv-cont-prior-"));
  const cwd2 = mkdtempSync(path.join(tmpdir(), "inv-cont-caller-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "inv-cont-data-"));
  try {
    seedMinimalRepo(cwd1);
    seedMinimalRepo(cwd2);
    // Prior job anchored to cwd1.
    const r1 = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd1, "--", "seed"],
      { cwd: cwd1, dataDir });
    assert.equal(r1.status, 0, r1.stderr);
    const job1 = JSON.parse(r1.stdout).job_id;
    // Continue from cwd2 (no --cwd, no --override-cwd).
    const r2 = runCompanion(
      ["continue", "--job", job1, "--foreground", "--", "followup"],
      { cwd: cwd2, dataDir });
    assert.equal(r2.status, 0, r2.stderr);
    const job2 = JSON.parse(r2.stdout).job_id;
    const meta2 = JSON.parse(readFileSync(findMetaPath(dataDir, job2), "utf8"));
    assert.equal(meta2.cwd, cwd1,
      `continue must inherit prior.cwd=${cwd1}; got ${meta2.cwd}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd1, { recursive: true, force: true });
    rmSync(cwd2, { recursive: true, force: true });
  }
});

test("T7.7 B4: cmdContinue rejects --cwd with pointer to --override-cwd", () => {
  const cwd1 = mkdtempSync(path.join(tmpdir(), "inv-cont-rej-prior-"));
  const cwd2 = mkdtempSync(path.join(tmpdir(), "inv-cont-rej-caller-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "inv-cont-rej-data-"));
  try {
    seedMinimalRepo(cwd1);
    const r1 = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd1, "--", "seed"],
      { cwd: cwd1, dataDir });
    assert.equal(r1.status, 0, r1.stderr);
    const job1 = JSON.parse(r1.stdout).job_id;
    const r2 = runCompanion(
      ["continue", "--job", job1, "--foreground",
       "--cwd", cwd2, "--", "followup"],
      { cwd: cwd2, dataDir });
    assert.notEqual(r2.status, 0,
      `continue with --cwd must fail; got exit ${r2.status}`);
    assert.match(r2.stderr, /--override-cwd/,
      `stderr must reference --override-cwd; got: ${r2.stderr}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd1, { recursive: true, force: true });
    rmSync(cwd2, { recursive: true, force: true });
  }
});

test("T7.7 B4: cmdContinue accepts --override-cwd to resume against a different directory", () => {
  const cwd1 = mkdtempSync(path.join(tmpdir(), "inv-cont-ov-prior-"));
  const cwd2 = mkdtempSync(path.join(tmpdir(), "inv-cont-ov-new-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "inv-cont-ov-data-"));
  try {
    seedMinimalRepo(cwd1);
    seedMinimalRepo(cwd2);
    const r1 = runCompanion(
      ["run", "--mode=rescue", "--foreground",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd1, "--", "seed"],
      { cwd: cwd1, dataDir });
    assert.equal(r1.status, 0, r1.stderr);
    const job1 = JSON.parse(r1.stdout).job_id;
    const r2 = runCompanion(
      ["continue", "--job", job1, "--foreground",
       "--override-cwd", cwd2, "--", "followup"],
      { cwd: cwd1, dataDir });
    assert.equal(r2.status, 0, r2.stderr);
    const job2 = JSON.parse(r2.stdout).job_id;
    const meta2 = JSON.parse(readFileSync(findMetaPath(dataDir, job2), "utf8"));
    assert.equal(meta2.cwd, cwd2,
      `--override-cwd must set cwd to ${cwd2}; got ${meta2.cwd}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd1, { recursive: true, force: true });
    rmSync(cwd2, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T7.7 C3 / B3 — cancel on a real running background job.
//
// Pre-T7.7, `cmdCancel` gated on `job.status !== "running"` and returned
// `already_terminal` otherwise. But nothing ever wrote `status: "running"`
// — `buildJobRecord(invocation, null)` writes `queued`, post-run records
// are terminal. So cancel always short-circuited to `already_terminal`,
// regardless of whether a worker was actually alive.
//
// The fix: the background worker writes an intermediate `status: "running"`
// record between the queued-meta read and `executeRun`. Classification of
// execution.signal=SIGTERM/SIGKILL is `"cancelled"` (not `"failed"`) so
// the terminal meta reflects reality. This end-to-end test drives a real
// running background job (delayed via CLAUDE_MOCK_DELAY_MS), observes the
// running state in meta, cancels, and verifies the cancelled status.
//
// Contrast with "M6-finding-7: PID-reuse cancel refused" above which
// manually patches running state to test the stale_pid guard in isolation.
// Both regressions matter — they exercise different parts of the pipeline.

test("M6-finding-7-pipeline: cancel on a real running background job transitions to cancelled", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "inv-cancel-pipe-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "inv-cancel-pipe-data-"));
  try {
    seedMinimalRepo(cwd);
    // Launch background job with a delayed mock so we have time to observe
    // running state and issue a cancel before the worker naturally exits.
    const launchRes = runCompanion(
      ["run", "--mode=rescue", "--background",
       "--model", "claude-haiku-4-5-20251001",
       "--cwd", cwd, "--", "long-running task"],
      { cwd, dataDir, env: { CLAUDE_MOCK_DELAY_MS: "10000" } });
    assert.equal(launchRes.status, 0, launchRes.stderr);
    const ev = JSON.parse(launchRes.stdout);
    assert.equal(ev.event, "launched");
    const jobId = ev.job_id;

    // Poll for `status: "running"` up to 3s. If this times out with status
    // still `queued`, the pipeline never writes running — the B3 bug.
    const runningDeadline = Date.now() + 3000;
    let observedRunning = false;
    while (Date.now() < runningDeadline) {
      try {
        const metaPath = findMetaPath(dataDir, jobId);
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        if (meta.status === "running") { observedRunning = true; break; }
        if (meta.status === "completed" || meta.status === "failed" || meta.status === "cancelled") {
          break; // finished before we saw running — unexpected
        }
      } catch { /* meta not written yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(observedRunning,
      "B3: meta never reached status=running — worker must write running record before executeRun");

    // Cancel. Must succeed, not return `already_terminal`.
    const cancelRes = runCompanion(
      ["cancel", "--job", jobId], { cwd, dataDir });
    const cancelOut = JSON.parse(cancelRes.stdout);
    assert.notEqual(cancelOut.status, "already_terminal",
      "B3: cancel on a running job must not short-circuit to already_terminal");
    assert.equal(cancelRes.status, 0,
      `cancel should succeed; got exit ${cancelRes.status}: ${cancelRes.stderr}`);

    // Poll for terminal `cancelled` status up to 2s.
    const terminalDeadline = Date.now() + 2000;
    let finalMeta = null;
    while (Date.now() < terminalDeadline) {
      try {
        const metaPath = findMetaPath(dataDir, jobId);
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        if (meta.status === "cancelled") { finalMeta = meta; break; }
      } catch { /* meta not written yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(finalMeta,
      `B3: terminal status must become "cancelled" after SIGTERM; last status was different`);
    assert.equal(finalMeta.status, "cancelled");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Completion assertion — every row in MATRIX_FINDINGS + MOCK_GAPS must have
// a t.test() whose name contains the fragment. Parses this file's own text.
//
// Design: fragment-in-name rather than test-registry callback. node:test does
// not expose a registry of queued tests at module level, so the mechanical
// check reads the file, extracts test-name literals, and asserts every
// MATRIX_FINDINGS fragment appears in at least one. Adding a finding means
// adding a MATRIX_FINDINGS row AND a `test("...fragment...")` block — the
// completion check fails otherwise.

test("M6-matrix: every MATRIX_FINDINGS + MOCK_GAPS row is covered in this file", () => {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  // Extract every `test("name", ...)` literal. We only care about the first
  // string arg, which by convention here is a double-quoted literal.
  const testNames = [];
  const re = /^test(?:\.skip|\.todo)?\(\s*"([^"]+)"/gm;
  let m;
  while ((m = re.exec(src)) !== null) testNames.push(m[1]);
  assert.ok(testNames.length >= MATRIX_FINDINGS.length + MOCK_GAPS.length,
    `expected ≥${MATRIX_FINDINGS.length + MOCK_GAPS.length} tests in this file; got ${testNames.length}`);
  for (const row of MATRIX_FINDINGS) {
    const hit = testNames.some((n) => n.includes(row.fragment));
    assert.ok(hit,
      `MATRIX_FINDINGS row "${row.id}" has no test whose name contains "${row.fragment}".\n` +
      `If you added the finding but not the test, add a test("...${row.fragment}...") block.\n` +
      `If you renamed the test, update MATRIX_FINDINGS to match.`);
  }
  for (const row of MOCK_GAPS) {
    const hit = testNames.some((n) => n.includes(row.fragment));
    assert.ok(hit, `MOCK_GAPS row "${row.id}" has no test with fragment "${row.fragment}"`);
  }
});
