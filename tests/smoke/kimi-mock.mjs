#!/usr/bin/env node
// Fake kimi-code 0.18.0 CLI for the companion smoke suite. It speaks the
// migrated prompt-mode surface only: `-p <prompt> --output-format stream-json
// [-m model] [-S/--session id]`. The prompt arrives as the `-p` argv arg (never
// stdin), and the response is emitted as NDJSON stream-json: an assistant turn
// plus a `role:"meta"` session.resume_hint line. There is no legacy `--print`,
// `--input-format`, `--agent-file`, `--add-dir`, or `--max-steps-per-turn`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PING_PROMPT } from "../../plugins/kimi/scripts/lib/companion-common.mjs";

// kimi-code --help screen: advertises exactly the prompt-mode flag surface the
// adapter emits, so detectKimiCapabilities reports ok:true and assertKimiContract
// is exercised faithfully (rather than failing open on an unprobed CLI).
const KIMI_CODE_HELP = `Usage: kimi [options] [command]

Options:
  -V, --version                 output the version number
  -m, --model <model>           LLM model alias to use for this invocation.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the response.
  --output-format <format>      Output format for prompt mode. (choices: "text", "stream-json")
  -S, --session [id]            Resume a session.
  -y, --yolo                    Automatically approve all actions.
  --plan                        Start in plan mode.
  -h, --help                    Show help.
`;

if (process.argv.includes("--help")) {
  process.stdout.write(KIMI_CODE_HELP);
  process.exit(0);
}
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  process.stdout.write("0.18.0\n");
  process.exit(0);
}

function parseCli(argv) {
  const valueFlags = new Set(["-p", "--prompt", "-m", "--model", "--output-format", "-S", "--session"]);
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (valueFlags.has(tok)) {
      out.flags[tok] = argv[i + 1] ?? "";
      i += 1;
    } else if (tok.startsWith("-")) {
      process.stderr.write(`kimi-mock: unknown flag ${tok}\n`);
      process.exit(1);
    } else {
      out.positional.push(tok);
    }
  }
  return out;
}

const parsed = parseCli(process.argv.slice(2));
const prompt = parsed.flags["-p"] ?? parsed.flags["--prompt"] ?? "";
const isPingPrompt = prompt.trim() === PING_PROMPT;
const isCompanionPreflight = isPingPrompt && process.env.KIMI_COMPANION_PREFLIGHT === "1";
const resumeId = parsed.flags["-S"] ?? parsed.flags["--session"] ?? "";
const sessionId = resumeId
  ? "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
  : "22222222-3333-4444-9555-666666666666";
const model = parsed.flags["-m"] ?? parsed.flags["--model"] ?? "unknown";
const mockResponse = process.env.KIMI_MOCK_RESPONSE ?? [
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
].join("\n");

const expectedPromptText = process.env.KIMI_MOCK_ASSERT_PROMPT_INCLUDES;
const invocationCountPath = process.env.KIMI_MOCK_INVOCATION_COUNT_PATH;
const invocationCountPromptIncludes = process.env.KIMI_MOCK_INVOCATION_COUNT_PROMPT_INCLUDES;
if (
  invocationCountPath &&
  !isCompanionPreflight &&
  (!invocationCountPromptIncludes || prompt.includes(invocationCountPromptIncludes))
) {
  const previous = existsSync(invocationCountPath) ? Number(readFileSync(invocationCountPath, "utf8")) : 0;
  writeFileSync(invocationCountPath, String((Number.isFinite(previous) ? previous : 0) + 1), "utf8");
}
if (expectedPromptText && !isCompanionPreflight && !prompt.includes(expectedPromptText)) {
  process.stderr.write(`kimi-mock: prompt missing expected text: ${expectedPromptText}\n`);
  process.exit(1);
}

const excludedPromptText = process.env.KIMI_MOCK_ASSERT_PROMPT_EXCLUDES;
if (excludedPromptText && !isCompanionPreflight && prompt.includes(excludedPromptText)) {
  process.stderr.write(`kimi-mock: prompt included excluded text: ${excludedPromptText}\n`);
  process.exit(1);
}

const expectedResumeId = process.env.KIMI_MOCK_ASSERT_RESUME_ID;
if (expectedResumeId && !isCompanionPreflight && resumeId !== expectedResumeId) {
  process.stderr.write(
    `kimi-mock: resume id mismatch: expected ${expectedResumeId}, got ${resumeId || "<missing>"}\n`,
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

if (!isCompanionPreflight && process.env.KIMI_MOCK_MUTATE_FILE) {
  writeFileSync(process.env.KIMI_MOCK_MUTATE_FILE, "kimi mock mutation\n", "utf8");
}

// stream-json transcript: a single assistant verdict turn followed by the
// session resume-hint meta line. parseKimiCodeStreamJson takes the last
// assistant turn for review modes and the meta session_id verbatim.
const assistantLine = () => JSON.stringify({ role: "assistant", content: mockResponse });
const metaLine = () => JSON.stringify({
  role: "meta",
  type: "session.resume_hint",
  session_id: sessionId,
  command: `kimi -r ${sessionId}`,
  content: `To resume this session: kimi -r ${sessionId}`,
});
function emitTranscript() {
  process.stdout.write(`${assistantLine()}\n`);
  process.stdout.write(`${metaLine()}\n`);
}

const assertCwdAbs = process.env.KIMI_MOCK_ASSERT_CWD;
if (assertCwdAbs && process.cwd() !== assertCwdAbs) {
  process.stderr.write(`kimi-mock: cwd must be ${assertCwdAbs}, got ${process.cwd()}\n`);
  process.exit(1);
}

const assertCwdNot = process.env.KIMI_MOCK_ASSERT_CWD_NOT;
if (assertCwdNot && process.cwd() === assertCwdNot) {
  process.stderr.write(`kimi-mock: cwd must not be ${assertCwdNot}\n`);
  process.exit(1);
}

const assertCwdPrefix = process.env.KIMI_MOCK_ASSERT_CWD_PREFIX;
if (assertCwdPrefix && !process.cwd().startsWith(assertCwdPrefix)) {
  process.stderr.write(`kimi-mock: cwd ${process.cwd()} does not start with ${assertCwdPrefix}\n`);
  process.exit(1);
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

if (process.env.KIMI_MOCK_STATE_LOCK_CONFLICT === "1" && !isCompanionPreflight) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { hostname } = await import("node:os");
  const found = await findActiveJobIdFromState();
  if (found) {
    const lockDir = join(dirname(found.jobsDir), ".state.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({
      pid: process.ppid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      token: "kimi-mock-state-lock-conflict",
    })}\n`, "utf8");
  }
}

// Issue #22 sub-task 2 oracle: `KIMI_MOCK_TRAP_SIGTERM=1` makes the mock
// handle SIGTERM cleanly — emits the transcript and exits 0, exactly like a
// well-behaved CLI that traps signals. Without the cancel-marker fix,
// classifyExecution would mis-report this as "completed" even when the
// operator had asked for a cancel.
if (process.env.KIMI_MOCK_TRAP_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    emitTranscript();
    process.exit(0);
  });
}

const delayMs = isCompanionPreflight ? 0 : Number(process.env.KIMI_MOCK_DELAY_MS ?? "0");
if (Number.isFinite(delayMs) && delayMs > 0) {
  setTimeout(() => {
    emitTranscript();
    process.exit(0);
  }, delayMs);
} else {
  emitTranscript();
}
