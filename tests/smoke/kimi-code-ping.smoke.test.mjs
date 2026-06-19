// Companion-level smoke: the `ping` subcommand against a fake kimi-code 0.18.0
// CLI (the -p/--prompt surface). Locks the kimi-code readiness path into CI
// without a live dependency on the installed binary (#222). The real-binary
// behavior is verified manually; this guards the wiring: surface detection ->
// -p prompt delivery -> stream-json parse -> ULID session capture -> ready.
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
  -S, --session [id]            Resume a session.
  -h, --help                    Show help.
`;

function writeKimiCodeMock(dir, { onPrompt } = {}) {
  const binary = path.join(dir, "kimi-code-mock.mjs");
  writeFileSync(binary, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-V")) { process.stdout.write("0.18.0\\n"); process.exit(0); }
if (argv.includes("--help")) { process.stdout.write(${JSON.stringify(KIMI_CODE_HELP)}); process.exit(0); }
if (argv.includes("--print")) { process.stderr.write("error: unknown option '--print'\\n"); process.exit(1); }
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? (argv[pIdx + 1] ?? "") : "";
const fs = await import("node:fs");
const stdin = fs.readFileSync(0, "utf8");
if (!prompt) { process.stderr.write("mock: missing -p prompt arg\\n"); process.exit(1); }
if (stdin.length > 0) { process.stderr.write("mock: prompt must not be on stdin\\n"); process.exit(1); }
${onPrompt ?? ""}
process.stdout.write(JSON.stringify({ role: "assistant", content: "pong" }) + "\\n");
process.stdout.write(JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: ${JSON.stringify(KIMI_CODE_SESSION_ID)}, command: "kimi -r ${KIMI_CODE_SESSION_ID}" }) + "\\n");
process.exit(0);
`);
  chmodSync(binary, 0o755);
  return binary;
}

function runPing(binary) {
  const res = spawnSync("node", [companion, "ping", "--binary", binary], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
  });
  const text = res.stdout ?? "";
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return { res, json };
}

test("ping: reports ready against a kimi-code CLI, capturing the ULID session id", () => {
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

test("ping: a kimi-code CLI failure is never reported ready", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-code-ping-fail-"));
  try {
    const onPrompt = `process.stderr.write("boom: the model backend is unavailable\\n"); process.exit(1);`;
    const { res, json } = runPing(writeKimiCodeMock(dir, { onPrompt }));
    assert.notEqual(res.status, 0);
    assert.equal(json.ready, false);
    assert.notEqual(json.status, "ok");
    assert.match(json.detail ?? "", /boom: the model backend is unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
