#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("0.39.0\n");
  process.exit(0);
}

function parseCli(argv) {
  const valueFlags = new Set([
    "-p", "--prompt", "-m", "--model", "--output-format", "--approval-mode",
    "--policy", "--resume", "--include-directories",
  ]);
  const boolFlags = new Set(["-s", "--sandbox", "-y", "--yolo", "--skip-trust"]);
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (valueFlags.has(tok)) {
      out.flags[tok] = argv[i + 1] ?? "";
      i += 1;
    } else if (boolFlags.has(tok)) {
      out.flags[tok] = true;
    } else {
      out.positional.push(tok);
    }
  }
  return out;
}

const parsed = parseCli(process.argv.slice(2));
const stdin = readFileSync(0, "utf8");
const promptArg = parsed.flags["-p"] ?? parsed.flags["--prompt"] ?? "";
const prompt = `${promptArg}${stdin}`;
const policyPath = parsed.flags["--policy"] ?? null;
const includeDirs = String(parsed.flags["--include-directories"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const sessionId = parsed.flags["--resume"]
  ? "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
  : "22222222-3333-4444-9555-666666666666";
const model = parsed.flags["-m"] ?? parsed.flags["--model"] ?? "unknown";

const expectedPromptText = process.env.GEMINI_MOCK_ASSERT_PROMPT_INCLUDES;
if (expectedPromptText && !prompt.includes(expectedPromptText)) {
  process.stderr.write(`gemini-mock: prompt missing expected text: ${expectedPromptText}\n`);
  process.exit(1);
}

if (process.env.GEMINI_MOCK_CAPACITY_MODEL === model) {
  process.stderr.write(JSON.stringify({
    error: {
      code: 429,
      message: `No capacity available for model ${model} on the server`,
      status: "RESOURCE_EXHAUSTED",
      details: [{
        reason: "MODEL_CAPACITY_EXHAUSTED",
        metadata: { model },
      }],
    },
  }) + "\n");
  process.exit(1);
}

const fixture = {
  session_id: sessionId,
  response: [
    "Verdict: APPROVE",
    "Blocking findings",
    "- None. I inspected the selected source made available to the Gemini smoke fixture and found no blocking issue.",
    "Non-blocking concerns",
    "- None for this fixture.",
    "Test gaps",
    "- Existing smoke fixture coverage is sufficient for this wrapper path.",
    "Inspection status",
    "- The selected source was available and the mock returned a complete review, not a placeholder.",
    "Checklist:",
    "- PASS selected scope was available.",
    "- PASS selected source was inspected before verdict.",
    "- PASS no blocker was invented.",
    "Mock Gemini response.",
  ].join("\n"),
  stats: {
    models: {
      [model]: {
        tokens: { total: 12 },
      },
    },
  },
  t7_policy_loaded: policyPath ? existsSync(policyPath) : false,
  t7_sandbox: parsed.flags["-s"] === true || parsed.flags["--sandbox"] === true,
  t7_skip_trust: parsed.flags["--skip-trust"] === true,
  t7_prompt_from_stdin: promptArg === "" && stdin.length > 0 && prompt.length > 0,
  t7_resume_id: parsed.flags["--resume"] ?? null,
  t7_include_dirs: includeDirs,
};

const assertCwdAbs = process.env.GEMINI_MOCK_ASSERT_CWD;
if (assertCwdAbs) {
  fixture.t7_cwd_match = process.cwd() === assertCwdAbs;
  fixture.t7_cwd = process.cwd();
}

const assertFileRel = process.env.GEMINI_MOCK_ASSERT_FILE;
if (assertFileRel) {
  fixture.t7_saw_file = includeDirs.some((dir) => existsSync(resolve(dir, assertFileRel)));
}

// Gemini's companion does not pass --session-id to the target CLI, so the
// mock cannot derive the jobId from argv. To inject a finalization conflict
// for #16 follow-up 1 tests, we walk GEMINI_PLUGIN_DATA/state/*/jobs and
// pick the most recently modified queued meta file (the one this run wrote
// just before spawning us). That base name is the jobId.
async function findActiveJobIdFromState() {
  const dataDir = process.env.GEMINI_PLUGIN_DATA;
  if (!dataDir) return null;
  const { readdirSync, statSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const stateRoot = join(dataDir, "state");
  if (!existsSync(stateRoot)) return null;
  let pick = null;
  for (const ws of readdirSync(stateRoot)) {
    const jobsDir = join(stateRoot, ws, "jobs");
    if (!existsSync(jobsDir)) continue;
    for (const entry of readdirSync(jobsDir)) {
      if (!entry.endsWith(".json")) continue;
      const full = join(jobsDir, entry);
      const m = statSync(full).mtimeMs;
      if (!pick || m > pick.mtime) {
        pick = { jobsDir, jobId: entry.slice(0, -".json".length), mtime: m };
      }
    }
  }
  return pick;
}

if (process.env.GEMINI_MOCK_SIDECAR_CONFLICT === "1") {
  // Pre-create <jobsDir>/<jobId> as a regular FILE so the companion's
  // writeSidecar mkdir fails with ENOTDIR (#16 follow-up 1).
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const found = await findActiveJobIdFromState();
  if (found) {
    const conflictPath = resolve(found.jobsDir, found.jobId);
    mkdirSync(found.jobsDir, { recursive: true });
    writeFileSync(conflictPath, "sidecar-directory-conflict\n", "utf8");
  }
}

if (process.env.GEMINI_MOCK_META_CONFLICT === "1") {
  // Replace <jobsDir>/<jobId>.json with a directory so the companion's
  // writeJobFile rename fails (#16 follow-up 1 — meta-write fatal path).
  const { unlinkSync, mkdirSync } = await import("node:fs");
  const found = await findActiveJobIdFromState();
  if (found) {
    const target = resolve(found.jobsDir, `${found.jobId}.json`);
    try { unlinkSync(target); } catch { /* nothing to remove yet */ }
    mkdirSync(target, { recursive: true });
  }
}

// Issue #22 sub-task 2 oracle: `GEMINI_MOCK_TRAP_SIGTERM=1` makes the mock
// handle SIGTERM cleanly — emits the fixture and exits 0, exactly like a
// well-behaved CLI that traps signals. Without the cancel-marker fix,
// classifyExecution would mis-report this as "completed" even when the
// operator had asked for a cancel.
if (process.env.GEMINI_MOCK_TRAP_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    process.stdout.write(JSON.stringify(fixture) + "\n");
    process.exit(0);
  });
}

const delayMs = Number(process.env.GEMINI_MOCK_DELAY_MS ?? "0");
if (Number.isFinite(delayMs) && delayMs > 0) {
  setTimeout(() => {
    process.stdout.write(JSON.stringify(fixture) + "\n");
    process.exit(0);
  }, delayMs);
} else {
  process.stdout.write(JSON.stringify(fixture) + "\n");
}
