// Companion-level smoke: the `ping` subcommand against a fake kimi-code 0.18.0
// CLI driven through its ACP stdio server (#222). Locks the kimi-code readiness
// path into CI without a live dependency on the installed binary. The real-binary
// behavior is verified manually; this guards the wiring: surface detection ->
// `kimi acp` -> session/new session capture -> session/prompt -> ready.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const companion = path.join(repoRoot, "plugins", "kimi", "scripts", "kimi-companion.mjs");

const KIMI_CODE_SESSION_ID = "01HZX5K7M9N2P4Q6R8S0T2V4W6";

const KIMI_CODE_HELP = `Usage: kimi [options] [command]

Options:
  -V, --version                 output the version number
  -m, --model <model>           LLM model alias to use for this invocation.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the response.
  --output-format <format>      Output format for prompt mode. (choices: "text", "stream-json")
  -h, --help                    Show help.

Commands:
  acp [options]                 Run kimi-code as an Agent Client Protocol (ACP) server over stdio.
`;

function writeKimiCodeMock(dir) {
  const binary = path.join(dir, "kimi-code-mock.mjs");
  writeFileSync(binary, `#!/usr/bin/env node
const argv = process.argv.slice(2);
const SID = ${JSON.stringify(KIMI_CODE_SESSION_ID)};
const FAIL = process.env.KIMI_CODE_MOCK_FAIL_DETAIL;
if (argv.includes("--version") || argv.includes("-V")) { process.stdout.write("0.18.0\\n"); process.exit(0); }
if (argv.includes("--help")) { process.stdout.write(${JSON.stringify(KIMI_CODE_HELP)}); process.exit(0); }
if (argv[0] !== "acp") { process.stderr.write("kimi-code-mock: unsupported invocation\\n"); process.exit(1); }
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
let buf = "";
process.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(JSON.parse(l)); } });
process.stdin.on("end", () => process.exit(0));
function handle(m) {
  if (m.method === "initialize") { send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "Kimi Code CLI", version: "0.18.0" } } }); return; }
  if (m.method === "session/new") { send({ jsonrpc: "2.0", id: m.id, result: { sessionId: SID, configOptions: [{ type: "select", id: "model", options: [{ value: "kimi-code/kimi-for-coding" }] }] } }); return; }
  if (m.method === "session/set_config_option") { send({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
  if (m.method === "session/prompt") {
    if (FAIL) { process.stderr.write(FAIL + "\\n"); send({ jsonrpc: "2.0", id: m.id, error: { code: -32010, message: FAIL } }); return; }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } } } });
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (m.id != null) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } });
}
`);
  chmodSync(binary, 0o755);
  return binary;
}

// A legacy CLI whose --help parses cleanly but advertises NO `acp` command — the
// realistic kimi-cli generation relay must reject with cli_contract_mismatch.
const LEGACY_HELP = `Usage: kimi [options]

Options:
  --print                       Print mode.
  --agent-file <path>           Agent file.
  -h, --help                    Show help.
`;

function writeLegacyKimiMock(dir) {
  const binary = path.join(dir, "kimi-legacy-mock.mjs");
  writeFileSync(binary, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-V")) { process.stdout.write("legacy-1.0\\n"); process.exit(0); }
if (argv.includes("--help")) { process.stdout.write(${JSON.stringify(LEGACY_HELP)}); process.exit(0); }
process.stderr.write("kimi-legacy-mock: unsupported invocation\\n"); process.exit(1);
`);
  chmodSync(binary, 0o755);
  return binary;
}

function runPing(binary, env = {}) {
  const res = spawnSync("node", [companion, "ping", "--binary", binary], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  const text = res.stdout ?? "";
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return { res, json };
}

test("ping: reports ready against a kimi-code ACP CLI, capturing the session id", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-code-ping-ok-"));
  try {
    const { res, json } = runPing(writeKimiCodeMock(dir));
    assert.equal(res.status, 0, res.stderr);
    assert.equal(json.status, "ok");
    assert.equal(json.ready, true);
    assert.equal(json.selected_auth_path, "subscription_oauth");
    assert.equal(json.session_id, KIMI_CODE_SESSION_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ping: a kimi-code ACP CLI failure is never reported ready", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-code-ping-fail-"));
  try {
    const { res, json } = runPing(writeKimiCodeMock(dir), {
      KIMI_CODE_MOCK_FAIL_DETAIL: "boom: the model backend is unavailable",
    });
    assert.notEqual(res.status, 0);
    assert.equal(json.ready, false);
    assert.notEqual(json.status, "ok");
    assert.match(json.detail ?? "", /boom: the model backend is unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ping: a legacy CLI lacking the acp command reports cli_contract_mismatch (missing ['acp']), never ready", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-code-ping-legacy-"));
  try {
    const { res, json } = runPing(writeLegacyKimiMock(dir));
    assert.equal(res.status, 2, res.stderr);
    assert.equal(json.status, "cli_contract_mismatch");
    assert.equal(json.ready, false);
    assert.deepEqual(json.missing_commands, ["acp"]);
    assert.match(json.next_action ?? "", /\bacp\b/, "next_action must name the acp command");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
