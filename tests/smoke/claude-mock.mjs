#!/usr/bin/env node
// Deterministic `claude -p` substitute for smoke tests. Accepts the real
// Claude-Code flag surface, routes on (model, sha256(prompt)) to a fixture
// JSON file under tests/smoke/fixtures/claude/. Exit 1 with a readable error
// when no fixture matches.
//
// Usage (put on PATH as `claude`):
//   PATH=tests/smoke:$PATH node claude-companion.mjs run --mode=review ...
//
// The mock writes exactly one JSON line on stdout (matching Claude
// --output-format=json) and exits 0 on a fixture hit.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "fixtures/claude");

// Support --version so setup probes don't need a fixture.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("claude-mock 0.0.1 (codex-plugin-multi test fixture)\n");
  process.exit(0);
}

function parseCli(argv) {
  // Minimal parser covering the flags the companion passes. Values flags are
  // greedy (consume the following token). Boolean flags stand alone.
  const valueFlags = new Set([
    "--model", "--permission-mode", "--session-id", "--output-format",
    "--input-format", "--setting-sources", "--json-schema",
    "--disallowedTools", "--disallowed-tools",
    "--allowedTools", "--allowed-tools",
    "--add-dir", "--append-system-prompt", "--system-prompt",
    "--resume", "--fallback-model", "--max-budget-usd", "--effort",
    "--tools", "--name",
  ]);
  const boolFlags = new Set([
    "--print", "-p", "--bare", "--verbose", "--fork-session", "--continue", "-c",
    "--no-session-persistence", "--include-hook-events", "--include-partial-messages",
  ]);
  const out = { positional: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (valueFlags.has(tok)) {
      const val = argv[i + 1];
      if (val === undefined) {
        // Value flag with no following token — real Claude errors; we match.
        process.stderr.write(`claude-mock: missing value for ${tok}\n`);
        process.exit(1);
      }
      out.flags[tok] = val;
      i += 1;
      continue;
    }
    if (boolFlags.has(tok)) {
      out.flags[tok] = true;
      continue;
    }
    if (tok.startsWith("-")) {
      // Unknown flag — record but don't consume a value.
      out.flags[tok] = true;
      continue;
    }
    out.positional.push(tok);
  }
  return out;
}

const parsed = parseCli(process.argv.slice(2));

// Prompt source: argv positional (`claude -p "..."`) OR stdin (if --input-format stream-json).
let prompt;
if (parsed.positional.length > 0) {
  prompt = parsed.positional.join(" ");
} else if (parsed.flags["--input-format"] === "stream-json") {
  prompt = readFileSync(0, "utf8");
} else {
  // Claude real behavior: errors if -p lacks both positional and stdin.
  process.stderr.write(
    "claude-mock: Input must be provided either through stdin or as a prompt argument.\n"
  );
  process.exit(1);
}

const model = parsed.flags["--model"] ?? "unknown";
const sessionId = parsed.flags["--session-id"] ?? "00000000-0000-4000-8000-000000000000";
const resumeId = parsed.flags["--resume"] ?? null;
const promptSha = createHash("sha256").update(prompt).digest("hex").slice(0, 16);

const expectedPromptText = process.env.CLAUDE_MOCK_ASSERT_PROMPT_INCLUDES;
if (expectedPromptText && !prompt.includes(expectedPromptText)) {
  process.stderr.write(`claude-mock: prompt missing expected text: ${expectedPromptText}\n`);
  process.exit(1);
}

if (process.env.CLAUDE_MOCK_SIDECAR_CONFLICT === "1") {
  const { resolveJobsDir } = await import("../../plugins/claude/scripts/lib/state.mjs");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const jobsDir = resolveJobsDir(process.cwd());
  const conflictPath = resolve(jobsDir, sessionId);
  mkdirSync(dirname(conflictPath), { recursive: true });
  writeFileSync(conflictPath, "sidecar-directory-conflict\n", "utf8");
}

if (process.env.CLAUDE_MOCK_META_CONFLICT === "1") {
  // Replace <jobsDir>/<sessionId>.json (the queued record file from the
  // launcher) with a DIRECTORY so the companion's terminal writeJobFile
  // rename fails (#16 follow-up 1 — meta-write fatal path).
  const { resolveJobsDir } = await import("../../plugins/claude/scripts/lib/state.mjs");
  const { mkdirSync, unlinkSync } = await import("node:fs");
  const jobsDir = resolveJobsDir(process.cwd());
  const conflictDir = resolve(jobsDir, `${sessionId}.json`);
  try { unlinkSync(conflictDir); } catch { /* nothing to remove yet */ }
  mkdirSync(conflictDir, { recursive: true });
}

// T7.3 test oracle: when CLAUDE_MOCK_RECORD_RESUME=1, record the `--resume`
// (or `--session-id` fallback) UUID to a sink path. Smoke tests read it back
// to assert the companion passed the *correct* UUID (§21.1 identity contract,
// guards against finding #6 regression).
if (process.env.CLAUDE_MOCK_RECORD_RESUME === "1") {
  const sink = process.env.CLAUDE_MOCK_RESUME_SINK ?? "/tmp/claude-mock-last-resume-id.txt";
  // Prefer --resume when set (continue path); else --session-id (fresh run).
  // Writing both branches lets tests distinguish.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(sink, (resumeId ?? sessionId) + "\n", "utf8");
}

// Fixture key: "<model>-<promptSha>.json". Fall back to "<model>-default.json".
const candidates = [
  resolve(FIXTURE_DIR, `${model}-${promptSha}.json`),
  resolve(FIXTURE_DIR, `${model}-default.json`),
  resolve(FIXTURE_DIR, `default.json`),
];

let fixturePath = null;
for (const p of candidates) {
  if (existsSync(p)) { fixturePath = p; break; }
}
if (!fixturePath) {
  process.stderr.write(
    `claude-mock: no fixture for model=${model} promptSha=${promptSha}\n` +
    `  tried: ${candidates.join(", ")}\n` +
    `  add a fixture or set CLAUDE_MOCK_ALLOW_SYNTHETIC=1 for auto-synthesis.\n`
  );
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

// Stamp session_id so consumers testing round-trip continuation see the exact
// UUID they passed. Real Claude does this too. On --resume, the echoed
// session_id is the resumed one (the fresh --session-id is omitted by the
// companion on resume), so prefer resumeId when set.
const echoedId = resumeId ?? sessionId;
if (process.env.CLAUDE_MOCK_OMIT_SESSION_ID !== "1") {
  fixture.session_id = echoedId;
}
fixture.uuid = fixture.uuid ?? echoedId;

// T7.2 test oracle: when CLAUDE_MOCK_ASSERT_FILE=<relpath> is set, the mock
// checks whether that file exists under --add-dir (the path Claude actually
// sees) and embeds the answer in the fixture's `result`. Smoke tests use this
// to verify that populateScope put the right content in front of Claude.
// CLAUDE_MOCK_ASSERT_CWD=<abspath> checks process.cwd() equality (for
// containment=none verification). Both are deliberately lightweight; they
// exist only so smoke tests can interrogate what the mock received.
const assertFileRel = process.env.CLAUDE_MOCK_ASSERT_FILE;
const assertCwdAbs = process.env.CLAUDE_MOCK_ASSERT_CWD;
const addDir = parsed.flags["--add-dir"] ?? null;
if (assertFileRel) {
  const target = addDir ? resolve(addDir, assertFileRel) : null;
  fixture.t7_saw_file = target ? existsSync(target) : false;
  fixture.t7_add_dir = addDir;
}
if (assertCwdAbs) {
  fixture.t7_cwd_match = process.cwd() === assertCwdAbs;
  fixture.t7_cwd = process.cwd();
}
if (process.env.CLAUDE_MOCK_LIST_ADDDIR && addDir) {
  // Emit a sorted list of entries under addDir, for branch-diff verification.
  // Uses readdirSync recursively, pruning .git.
  const { readdirSync: rd, statSync: st } = await import("node:fs");
  function walk(dir, prefix = "") {
    const out = [];
    for (const name of rd(dir)) {
      if (name === ".git") continue;
      const full = resolve(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (st(full).isDirectory()) out.push(...walk(full, rel));
      else out.push(rel);
    }
    return out.sort();
  }
  fixture.t7_add_dir_files = walk(addDir);
}

// T7.6 test oracle: `CLAUDE_MOCK_MUTATE_FILE=<relpath-or-abspath>` — before
// emitting the result, write a small file to disk so the companion's
// mutation-detection path (tryGit pre/post snapshot) has something to
// observe. Absolute paths are used verbatim; relative paths resolve against
// `process.cwd()` first, with a fallback to `addDir` when they differ
// (worktree containment). Keeps the hook additive: leaving the env unset
// is identical to pre-T7.6 behavior.
const mutateRel = process.env.CLAUDE_MOCK_MUTATE_FILE;
if (mutateRel) {
  const { writeFileSync: wf, mkdirSync: mk } = await import("node:fs");
  const { isAbsolute, dirname: dn } = await import("node:path");
  let target;
  if (isAbsolute(mutateRel)) {
    target = mutateRel;
  } else {
    // Prefer addDir when it differs from cwd (review's worktree containment
    // puts addDir ≠ cwd). When they match (rescue / containment=none), both
    // resolve to the same directory.
    const base = addDir && addDir !== process.cwd() ? addDir : process.cwd();
    target = resolve(base, mutateRel);
  }
  try { mk(dn(target), { recursive: true }); } catch { /* best-effort */ }
  wf(target, "mock-mutation\n", "utf8");
  fixture.t7_mutate_wrote = target;
}

// Issue #22 sub-task 2 oracle: `CLAUDE_MOCK_TRAP_SIGTERM=1` makes the mock
// handle SIGTERM cleanly — it emits the fixture and exits 0, exactly like a
// well-behaved CLI that traps signals to flush partial output. Without the
// cancel-marker fix, classifyExecution would mis-report this as "completed"
// even when the operator had asked for a cancel.
if (process.env.CLAUDE_MOCK_TRAP_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    process.stdout.write(JSON.stringify(fixture) + "\n");
    process.exit(0);
  });
}

// T7.6 test oracle: `CLAUDE_MOCK_DELAY_MS=<n>` — delay N ms before emitting
// stdout + exiting. Exercises the `timeoutMs` branch in `spawnClaude`, which
// has no regression coverage today (M6 reviewer flagged "timeoutMs never
// exercised"). Delay < timeout = normal completion; delay > timeout = SIGTERM.
const delayMs = Number(process.env.CLAUDE_MOCK_DELAY_MS ?? "0");
if (Number.isFinite(delayMs) && delayMs > 0) {
  setTimeout(() => {
    process.stdout.write(JSON.stringify(fixture) + "\n");
    process.exit(0);
  }, delayMs);
} else {
  // Emit the final result event and exit. Matches `--output-format=json`.
  process.stdout.write(JSON.stringify(fixture) + "\n");
  process.exit(0);
}
