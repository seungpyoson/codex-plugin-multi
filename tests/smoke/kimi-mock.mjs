#!/usr/bin/env node
// Fake kimi-code 0.18.0 CLI for the companion smoke suite. Relay drives kimi-code
// through its ACP (Agent Client Protocol) stdio server, so this mock dispatches:
//   kimi --help    -> a kimi-code help screen advertising the `acp` command
//   kimi --version -> 0.18.0
//   kimi acp       -> a JSON-RPC 2.0 NDJSON ACP server over stdin/stdout
// The prompt arrives over stdin in a session/prompt request (NOT as a -p argv arg),
// so there is no OS argv-size limit. The same KIMI_MOCK_* knobs the suite already
// uses are honored at the equivalent ACP lifecycle points.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PING_PROMPT } from "../../plugins/kimi/scripts/lib/companion-common.mjs";

// --help advertises the `acp` command so detectKimiCapabilities reports ok:true and
// assertKimiContract (which now requires `acp`) passes — exercising the guard
// faithfully rather than failing open on an unprobed CLI.
const KIMI_CODE_HELP = `Usage: kimi [options] [command]

Options:
  -V, --version                 output the version number
  -m, --model <model>           LLM model alias to use for this invocation.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the response.
  --output-format <format>      Output format for prompt mode. (choices: "text", "stream-json")
  -h, --help                    Show help.

Commands:
  acp [options]                 Run kimi-code as an Agent Client Protocol (ACP) server over stdio.
  doctor                        Validate Kimi Code configuration files.
`;

if (process.argv.includes("--help")) {
  process.stdout.write(KIMI_CODE_HELP);
  process.exit(0);
}
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  process.stdout.write("0.18.0\n");
  process.exit(0);
}
if (process.argv[2] !== "acp") {
  process.stderr.write(`kimi-mock: unsupported invocation: ${process.argv.slice(2).join(" ")}\n`);
  process.exit(1);
}

// ---- ACP server ----------------------------------------------------------------

const env = process.env;
const FRESH_SESSION = "22222222-3333-4444-9555-666666666666";
const RESUME_SESSION = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";
const mockResponse = env.KIMI_MOCK_RESPONSE ?? [
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

let model = "unknown";
let resumeId = "";

function send(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
function fail(stderrLine) { process.stderr.write(`${stderrLine}\n`); process.exit(1); }

// CWD assertions run at startup — the companion spawns `kimi acp` with the chosen
// cwd, so process.cwd() is the same value the legacy -p mock checked.
if (env.KIMI_MOCK_ASSERT_CWD && process.cwd() !== env.KIMI_MOCK_ASSERT_CWD) {
  fail(`kimi-mock: cwd must be ${env.KIMI_MOCK_ASSERT_CWD}, got ${process.cwd()}`);
}
if (env.KIMI_MOCK_ASSERT_CWD_NOT && process.cwd() === env.KIMI_MOCK_ASSERT_CWD_NOT) {
  fail(`kimi-mock: cwd must not be ${env.KIMI_MOCK_ASSERT_CWD_NOT}`);
}
if (env.KIMI_MOCK_ASSERT_CWD_PREFIX && !process.cwd().startsWith(env.KIMI_MOCK_ASSERT_CWD_PREFIX)) {
  fail(`kimi-mock: cwd ${process.cwd()} does not start with ${env.KIMI_MOCK_ASSERT_CWD_PREFIX}`);
}

async function findActiveJobIdFromState() {
  const dataDir = env.KIMI_PLUGIN_DATA;
  if (!dataDir) return null;
  const { readdirSync, statSync, existsSync: exists } = await import("node:fs");
  const { join } = await import("node:path");
  const stateRoot = join(dataDir, "state");
  if (!exists(stateRoot)) return null;
  let pick = null;
  for (const ws of readdirSync(stateRoot)) {
    const jobsDir = join(stateRoot, ws, "jobs");
    if (!exists(jobsDir)) continue;
    for (const entry of readdirSync(jobsDir)) {
      if (!entry.endsWith(".json")) continue;
      const m = statSync(join(jobsDir, entry)).mtimeMs;
      if (!pick || m > pick.mtime) pick = { jobsDir, jobId: entry.slice(0, -".json".length), mtime: m };
    }
  }
  return pick;
}

// State-conflict oracles (#16 follow-up 1) run at startup, after the companion has
// written the queued meta and spawned us.
async function applyStateConflicts() {
  if (env.KIMI_MOCK_SIDECAR_CONFLICT === "1") {
    const { writeFileSync: w, mkdirSync } = await import("node:fs");
    const found = await findActiveJobIdFromState();
    if (found) { mkdirSync(found.jobsDir, { recursive: true }); w(resolve(found.jobsDir, found.jobId), "sidecar-directory-conflict\n", "utf8"); }
  }
  if (env.KIMI_MOCK_META_CONFLICT === "1") {
    const { unlinkSync, mkdirSync } = await import("node:fs");
    const found = await findActiveJobIdFromState();
    if (found) { const t = resolve(found.jobsDir, `${found.jobId}.json`); try { unlinkSync(t); } catch { /* none yet */ } mkdirSync(t, { recursive: true }); }
  }
}

let promptText = "";
function isPreflight() { return promptText.trim() === PING_PROMPT && env.KIMI_COMPANION_PREFLIGHT === "1"; }

function runPromptAssertions() {
  const preflight = isPreflight();
  if (env.KIMI_MOCK_INVOCATION_COUNT_PATH && !preflight &&
      (!env.KIMI_MOCK_INVOCATION_COUNT_PROMPT_INCLUDES || promptText.includes(env.KIMI_MOCK_INVOCATION_COUNT_PROMPT_INCLUDES))) {
    const p = env.KIMI_MOCK_INVOCATION_COUNT_PATH;
    const prev = existsSync(p) ? Number(readFileSync(p, "utf8")) : 0;
    writeFileSync(p, String((Number.isFinite(prev) ? prev : 0) + 1), "utf8");
  }
  if (env.KIMI_MOCK_ASSERT_PROMPT_INCLUDES && !preflight && !promptText.includes(env.KIMI_MOCK_ASSERT_PROMPT_INCLUDES)) {
    fail(`kimi-mock: prompt missing expected text: ${env.KIMI_MOCK_ASSERT_PROMPT_INCLUDES}`);
  }
  if (env.KIMI_MOCK_ASSERT_PROMPT_EXCLUDES && !preflight && promptText.includes(env.KIMI_MOCK_ASSERT_PROMPT_EXCLUDES)) {
    fail(`kimi-mock: prompt included excluded text: ${env.KIMI_MOCK_ASSERT_PROMPT_EXCLUDES}`);
  }
  if (env.KIMI_MOCK_ASSERT_RESUME_ID && !preflight && resumeId !== env.KIMI_MOCK_ASSERT_RESUME_ID) {
    fail(`kimi-mock: resume id mismatch: expected ${env.KIMI_MOCK_ASSERT_RESUME_ID}, got ${resumeId || "<missing>"}`);
  }
  // Capacity exhaustion for the configured model -> a 429 the usage-limit
  // classifier recognizes (source was sent, so this maps to usage_limited).
  if (env.KIMI_MOCK_CAPACITY_MODEL && env.KIMI_MOCK_CAPACITY_MODEL === model) {
    const payload = JSON.stringify({ error: { code: 429, message: `No capacity available for model ${model} on the server`, status: "RESOURCE_EXHAUSTED", details: [{ reason: "MODEL_CAPACITY_EXHAUSTED", metadata: { model } }] } });
    process.stderr.write(`${payload}\n`);
    return { capacityError: payload };
  }
  if (!preflight && env.KIMI_MOCK_MUTATE_FILE) writeFileSync(env.KIMI_MOCK_MUTATE_FILE, "kimi mock mutation\n", "utf8");
  // Corrupt a path mid-turn (e.g. .git/index) so the companion's post-run mutation
  // scan fails — exercising the "preserve result when mutation detection is
  // unavailable" path.
  if (!preflight && env.KIMI_MOCK_CORRUPT_PATH) writeFileSync(env.KIMI_MOCK_CORRUPT_PATH, "corrupt", "utf8");
  return null;
}

function emitTurn(reqId) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: resumeId ? RESUME_SESSION : FRESH_SESSION, update: { sessionUpdate: "agent_message_chunk", messageId: "msg_0", content: { type: "text", text: mockResponse } } } });
  send({ jsonrpc: "2.0", id: reqId, result: { stopReason: "end_turn" } });
}

function configOptions() {
  return [
    { type: "select", id: "model", name: "Model", category: "model", currentValue: "kimi-code/kimi-for-coding",
      options: [
        { value: "kimi-code/kimi-for-coding", name: "K2.7 Code High Speed" },
        { value: "kimi-code/primary-capacity-limited", name: "Primary (capacity limited)" },
        { value: "kimi-code/fallback-review", name: "Fallback Review" },
      ] },
    { type: "select", id: "mode", name: "Mode", category: "mode", currentValue: "default",
      options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }, { value: "auto", name: "Auto" }, { value: "yolo", name: "YOLO" }] },
  ];
}

if (env.KIMI_MOCK_TRAP_SIGTERM === "1") {
  // A well-behaved CLI that traps SIGTERM: finish the in-flight turn and exit 0.
  process.on("SIGTERM", () => { if (lastPromptId != null) emitTurn(lastPromptId); process.exit(0); });
}

let lastPromptId = null;
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

async function handle(msg) {
  if (msg.method === "initialize") {
    await applyStateConflicts();
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }, authMethods: [{ id: "login", type: "terminal", name: "Login with Kimi account" }], agentInfo: { name: "Kimi Code CLI", version: "0.18.0" } } });
    return;
  }
  if (msg.method === "session/load") {
    resumeId = String(msg.params?.sessionId ?? "");
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: RESUME_SESSION, configOptions: configOptions() } });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: FRESH_SESSION, configOptions: configOptions() } });
    return;
  }
  if (msg.method === "session/set_config_option") {
    if (msg.params?.configId === "model" && typeof msg.params?.value === "string") model = msg.params.value;
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    lastPromptId = msg.id;
    promptText = (msg.params?.prompt ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
    if (env.KIMI_MOCK_STATE_LOCK_CONFLICT === "1") await applyStateLockConflict();
    const cap = runPromptAssertions();
    if (cap) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32010, message: cap.capacityError } }); return; }
    const delayMs = isPreflight() ? 0 : Number(env.KIMI_MOCK_DELAY_MS ?? "0");
    if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(() => emitTurn(msg.id), delayMs);
    else emitTurn(msg.id);
    return;
  }
  if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `mock: unknown method ${msg.method}` } });
}

async function applyStateLockConflict() {
  if (isPreflight()) return;
  const { mkdirSync, writeFileSync: w } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { hostname } = await import("node:os");
  const found = await findActiveJobIdFromState();
  if (!found) return;
  const lockDir = join(dirname(found.jobsDir), ".state.lock");
  mkdirSync(lockDir, { recursive: true });
  w(join(lockDir, "owner.json"), `${JSON.stringify({ pid: process.ppid, hostname: hostname(), startedAt: new Date().toISOString(), token: "kimi-mock-state-lock-conflict" })}\n`, "utf8");
}
