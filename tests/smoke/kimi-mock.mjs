#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PING_PROMPT } from "../../plugins/kimi/scripts/lib/companion-common.mjs";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("1.41.0\n");
  process.exit(0);
}

function parseCli(argv) {
  const valueFlags = new Set([
    "-p", "--prompt", "-m", "--model", "--output-format",
    "--input-format", "--session", "--resume", "--add-dir", "--max-steps-per-turn",
  ]);
  const boolFlags = new Set(["--print", "--final-message-only", "--thinking", "--plan", "-y", "--yolo"]);
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (valueFlags.has(tok)) {
      out.flags[tok] = argv[i + 1] ?? "";
      i += 1;
    } else if (boolFlags.has(tok)) {
      out.flags[tok] = true;
    } else {
      if (tok.startsWith("-")) {
        process.stderr.write(`kimi-mock: unknown flag ${tok}\n`);
        process.exit(1);
      }
      out.positional.push(tok);
    }
  }
  return out;
}

const parsed = parseCli(process.argv.slice(2));
const stdin = readFileSync(0, "utf8");
const promptArg = parsed.flags["-p"] ?? parsed.flags["--prompt"] ?? "";
const prompt = `${promptArg}${stdin}`;
const isPingPrompt = prompt.trim() === PING_PROMPT;
const isCompanionPreflight = isPingPrompt && process.env.KIMI_COMPANION_PREFLIGHT === "1";
const includeDirs = String(parsed.flags["--add-dir"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const sessionId = (parsed.flags["--session"] ?? parsed.flags["--resume"])
  ? "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
  : "22222222-3333-4444-9555-666666666666";
const model = parsed.flags["-m"] ?? parsed.flags["--model"] ?? "unknown";

const expectedPromptText = process.env.KIMI_MOCK_ASSERT_PROMPT_INCLUDES;
if (expectedPromptText && !isCompanionPreflight && !prompt.includes(expectedPromptText)) {
  process.stderr.write(`kimi-mock: prompt missing expected text: ${expectedPromptText}\n`);
  process.exit(1);
}

const expectedMaxSteps = process.env.KIMI_MOCK_ASSERT_MAX_STEPS_PER_TURN;
if (expectedMaxSteps && String(parsed.flags["--max-steps-per-turn"] ?? "") !== expectedMaxSteps) {
  process.stderr.write(
    `kimi-mock: --max-steps-per-turn mismatch: expected ${expectedMaxSteps}, got ${parsed.flags["--max-steps-per-turn"] ?? "<missing>"}\n`,
  );
  process.exit(1);
}

const expectedResumeId = process.env.KIMI_MOCK_ASSERT_RESUME_ID;
const actualResumeId = parsed.flags["--session"] ?? parsed.flags["--resume"] ?? "";
if (expectedResumeId && !isCompanionPreflight && actualResumeId !== expectedResumeId) {
  process.stderr.write(
    `kimi-mock: resume id mismatch: expected ${expectedResumeId}, got ${actualResumeId || "<missing>"}\n`,
  );
  process.exit(1);
}

if (process.env.KIMI_MOCK_CAPACITY_MODEL === model) {
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

if (!isCompanionPreflight && process.env.KIMI_MOCK_STEP_LIMIT) {
  const limit = process.env.KIMI_MOCK_STEP_LIMIT;
  if (process.env.KIMI_MOCK_STEP_LIMIT_PREFIX_JSON === "1") {
    process.stdout.write(JSON.stringify({ content: "Partial Kimi response.", session_id: sessionId }) + "\n");
  }
  process.stdout.write(`Max number of steps reached: ${limit}\n`);
  const resumeHint = `To resume this session: kimi -r ${sessionId}\n`;
  if (process.env.KIMI_MOCK_STEP_LIMIT_RESUME_ON_STDOUT === "1") {
    process.stdout.write(resumeHint);
  } else {
    process.stderr.write(resumeHint);
  }
  process.exit(1);
}

const fixture = {
  session_id: sessionId,
  response: [
    "Verdict: APPROVE",
    "Blocking findings",
    "- None. I inspected the selected source made available to the Kimi smoke fixture and found no blocking issue.",
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
    "Mock Kimi response.",
  ].join("\n"),
  stats: {
    models: {
      [model]: {
        tokens: { total: 12 },
      },
    },
  },
  t7_plan: parsed.flags["--plan"] === true,
  t7_yolo: parsed.flags["-y"] === true || parsed.flags["--yolo"] === true,
  t7_print: parsed.flags["--print"] === true,
  t7_output_format: parsed.flags["--output-format"] ?? null,
  t7_prompt_from_stdin: promptArg === "" && stdin.length > 0 && prompt.length > 0,
  t7_resume_id: parsed.flags["--session"] ?? parsed.flags["--resume"] ?? null,
  t7_include_dirs: includeDirs,
};

const assertCwdAbs = process.env.KIMI_MOCK_ASSERT_CWD;
if (assertCwdAbs) {
  fixture.t7_cwd_match = process.cwd() === assertCwdAbs;
  fixture.t7_cwd = process.cwd();
}

const assertCwdNot = process.env.KIMI_MOCK_ASSERT_CWD_NOT;
if (assertCwdNot && process.cwd() === assertCwdNot) {
  process.stderr.write(`kimi-mock: cwd must not be ${assertCwdNot}\n`);
  process.exit(1);
}
if (assertCwdNot) fixture.t7_cwd = process.cwd();

const assertCwdPrefix = process.env.KIMI_MOCK_ASSERT_CWD_PREFIX;
if (assertCwdPrefix && !process.cwd().startsWith(assertCwdPrefix)) {
  process.stderr.write(`kimi-mock: cwd ${process.cwd()} does not start with ${assertCwdPrefix}\n`);
  process.exit(1);
}
if (assertCwdPrefix) fixture.t7_cwd = process.cwd();

const assertFileRel = process.env.KIMI_MOCK_ASSERT_FILE;
if (assertFileRel) {
  fixture.t7_saw_file = includeDirs.some((dir) => existsSync(resolve(dir, assertFileRel)));
}

// Kimi's companion does not pass --session-id to the target CLI, so the
// mock cannot derive the jobId from argv. To inject a finalization conflict
// for #16 follow-up 1 tests, we walk KIMI_PLUGIN_DATA/state/*/jobs and
// pick the most recently modified queued meta file (the one this run wrote
// just before spawning us). That base name is the jobId.
async function findActiveJobIdFromState() {
  const dataDir = process.env.KIMI_PLUGIN_DATA;
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

if (process.env.KIMI_MOCK_SIDECAR_CONFLICT === "1") {
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

if (process.env.KIMI_MOCK_META_CONFLICT === "1") {
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

// Issue #22 sub-task 2 oracle: `KIMI_MOCK_TRAP_SIGTERM=1` makes the mock
// handle SIGTERM cleanly — emits the fixture and exits 0, exactly like a
// well-behaved CLI that traps signals. Without the cancel-marker fix,
// classifyExecution would mis-report this as "completed" even when the
// operator had asked for a cancel.
if (process.env.KIMI_MOCK_TRAP_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    process.stdout.write(JSON.stringify(fixture) + "\n");
    process.exit(0);
  });
}

const delayMs = isCompanionPreflight ? 0 : Number(process.env.KIMI_MOCK_DELAY_MS ?? "0");
if (Number.isFinite(delayMs) && delayMs > 0) {
  setTimeout(() => {
    process.stdout.write(JSON.stringify(fixture) + "\n");
    process.exit(0);
  }, delayMs);
} else {
  process.stdout.write(JSON.stringify(fixture) + "\n");
}
