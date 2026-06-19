import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  selectKimiSurface,
  detectKimiCapabilities,
  KimiContractMismatchError,
} from "../../plugins/kimi/scripts/lib/kimi-capabilities.mjs";
import {
  buildKimiCodeArgs,
  kimiCodeSurfaceEligible,
  parseKimiResult,
  spawnKimi,
} from "../../plugins/kimi/scripts/lib/kimi.mjs";
import { resolveProfile } from "../../plugins/kimi/scripts/lib/mode-profiles.mjs";

// Abridged REAL kimi-code 0.18.0 --help (the installed contract: -p/--prompt,
// no --print/--input-format).
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

// Legacy kimi-cli --help (the --print surface relay's buildKimiArgs targets).
const LEGACY_HELP = `Usage: kimi [options]

Options:
  --print                       Print mode.
  --final-message-only          Only the final message.
  --input-format <fmt>          Input format.
  --output-format <fmt>         Output format.
  -m, --model <model>           Model.
  --thinking                    Thinking.
  -h, --help                    Show help.
`;

// A 26-char ULID-like session id (alphanumeric, NOT hex-with-dashes — the shape
// kimi-code actually emits, which the legacy [0-9a-fA-F-] resume regex misses).
const KIMI_CODE_SESSION_ID = "01HZX5K7M9N2P4Q6R8S0T2V4W6";

function fakeRun(map) {
  return (_binary, args) => map[args.join(" ")] ?? { status: 1, stdout: "", stderr: "unknown", error: null };
}

function kimiCodeCaps() {
  return detectKimiCapabilities("kimi", {
    runImpl: fakeRun({
      "--help": { status: 0, stdout: KIMI_CODE_HELP, stderr: "" },
      "--version": { status: 0, stdout: "0.18.0\n", stderr: "" },
    }),
  });
}

test("selectKimiSurface: -p/--prompt without --print is the kimi-code surface", () => {
  assert.equal(selectKimiSurface(kimiCodeCaps()), "kimi-code");
});

test("selectKimiSurface: --print is the legacy surface", () => {
  const caps = detectKimiCapabilities("kimi", {
    runImpl: fakeRun({
      "--help": { status: 0, stdout: LEGACY_HELP, stderr: "" },
      "--version": { status: 0, stdout: "1.41.0\n", stderr: "" },
    }),
  });
  assert.equal(selectKimiSurface(caps), "legacy");
});

test("selectKimiSurface: unknown/unprobed capabilities select no surface (null)", () => {
  assert.equal(selectKimiSurface({ ok: false, supportedFlags: new Set() }), null);
  assert.equal(selectKimiSurface(null), null);
  // ok but neither --print nor --prompt advertised -> still null (do not guess).
  assert.equal(selectKimiSurface({ ok: true, supportedFlags: new Set(["--help"]) }), null);
});

test("buildKimiCodeArgs: native ping uses -p prompt arg + stream-json, no legacy/permission flags", () => {
  const args = buildKimiCodeArgs(resolveProfile("ping"), { model: null, promptText: "say pong" });
  assert.deepEqual(args, ["-p", "say pong", "--output-format", "stream-json"]);
  for (const forbidden of ["--print", "--final-message-only", "--input-format", "--max-steps-per-turn",
    "--thinking", "--plan", "--yolo", "-y", "--auto", "--agent-file", "--mcp-config-file"]) {
    assert.ok(!args.includes(forbidden), `kimi-code prompt mode must not emit ${forbidden}`);
  }
});

test("buildKimiCodeArgs: includes -m when a model is given and --session on resume", () => {
  const args = buildKimiCodeArgs(resolveProfile("ping"), {
    model: "kimi-for-coding",
    promptText: "hi",
    resumeId: KIMI_CODE_SESSION_ID,
  });
  assert.equal(args[args.indexOf("-m") + 1], "kimi-for-coding");
  assert.equal(args[args.indexOf("--session") + 1], KIMI_CODE_SESSION_ID);
  assert.equal(args[0], "-p");
  assert.equal(args[1], "hi");
});

test("buildKimiCodeArgs: requires a non-empty prompt (prompt is an arg, not stdin)", () => {
  assert.throws(() => buildKimiCodeArgs(resolveProfile("ping"), { promptText: "" }), /promptText is required/);
  assert.throws(() => buildKimiCodeArgs(resolveProfile("ping"), {}), /promptText is required/);
});

test("kimiCodeSurfaceEligible: only the enforcement-free ping profile is eligible for -p", () => {
  assert.equal(kimiCodeSurfaceEligible(resolveProfile("ping")), true);
  for (const name of ["review", "adversarial-review", "custom-review", "rescue"]) {
    assert.equal(kimiCodeSurfaceEligible(resolveProfile(name)), false, `${name} must not be -p eligible`);
  }
  assert.equal(kimiCodeSurfaceEligible(null), false);
});

test("buildKimiCodeArgs: refuses a tool-restricted (review) profile rather than silently dropping tools:[]", () => {
  assert.throws(
    () => buildKimiCodeArgs(resolveProfile("review"), { model: "kimi-for-coding", promptText: "review this" }),
    /not eligible for the kimi-code -p surface|per-invocation tool restriction|#222/,
  );
});

test("parseKimiResult(kimi-code): a successful reply that mentions quota/billing is NOT misclassified as usage-limited", () => {
  const stdout = `{"role":"assistant","content":"Verdict: PASS. Check quota and billing cycle handling."}\n`;
  const parsed = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true, "successful content must not be scanned for usage-limit wording");
  assert.match(parsed.result, /quota and billing cycle/);
  assert.notEqual(parsed.reason, "usage_limited");
});

test("parseKimiResult(kimi-code): extracts assistant content + ULID session from the meta line", () => {
  const stdout = `{"role":"assistant","content":"pong"}\n`
    + `{"role":"meta","type":"session.resume_hint","session_id":"${KIMI_CODE_SESSION_ID}",`
    + `"command":"kimi -r ${KIMI_CODE_SESSION_ID}","content":"To resume this session: kimi -r ${KIMI_CODE_SESSION_ID}"}\n`;
  const parsed = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "pong");
  assert.equal(parsed.sessionId, KIMI_CODE_SESSION_ID);
  assert.equal(parsed.error, null);
});

test("parseKimiResult(kimi-code): recovers the ULID session id from a resume-hint line when no meta object", () => {
  const stdout = `{"role":"assistant","content":"done"}\n`;
  const stderr = `• thinking...\nTo resume this session: kimi -r ${KIMI_CODE_SESSION_ID}\n`;
  const parsed = parseKimiResult(stdout, stderr, { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "done");
  assert.equal(parsed.sessionId, KIMI_CODE_SESSION_ID);
});

test("parseKimiResult(kimi-code): joins multiple assistant turns in order", () => {
  const stdout = `{"role":"assistant","content":"first"}\n{"role":"assistant","content":"second"}\n`;
  const parsed = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "first\nsecond");
});

test("parseKimiResult(kimi-code): empty stdout is a failure, surfacing stderr detail", () => {
  const parsed = parseKimiResult("", "boom: something broke\n", { exitCode: 1, surface: "kimi-code" });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "kimi_stderr");
  assert.match(parsed.error, /boom: something broke/);
});

test("parseKimiResult(kimi-code): content present but nonzero exit is a failure, not a silent pass", () => {
  const stdout = `{"role":"assistant","content":"partial"}\n`;
  const parsed = parseKimiResult(stdout, "", { exitCode: 1, surface: "kimi-code" });
  assert.equal(parsed.ok, false);
});

test("parseKimiResult(kimi-code): classifies usage-limit failures and redacts account artifacts", () => {
  const stderr = "Error code: 403\nYou've reached your usage limit for user@example.com plan_id=pro+stripe-sub-abc/123.\n";
  const parsed = parseKimiResult("", stderr, { exitCode: 1, surface: "kimi-code" });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "usage_limited");
  assert.match(parsed.error, /quota|usage-tier|billing|credit/i);
  assert.doesNotMatch(parsed.error, /user@example\.com|stripe-sub|plan_id/);
});

test("parseKimiResult(kimi-code): surfaces an explicit error event as a failure", () => {
  const stdout = `{"role":"error","is_error":true,"error":"model backend exploded"}\n`;
  const parsed = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "kimi_error");
  assert.match(parsed.error, /model backend exploded/);
});

test("parseKimiResult(kimi-code): passes through usage and cost when a usage event is present", () => {
  const stdout = `{"role":"assistant","content":"ok"}\n`
    + `{"role":"usage","usage":{"input_tokens":7,"output_tokens":2},"total_cost_usd":0.0013}\n`;
  const parsed = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.usage, { input_tokens: 7, output_tokens: 2 });
  assert.equal(parsed.costUsd, 0.0013);
});

test("spawnKimi: routes the ping profile to the kimi-code surface, delivering the prompt via -p (not stdin)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-code-spawn-"));
  const binary = path.join(dir, "kimi-code-fake.mjs");
  writeFileSync(binary, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-V")) { process.stdout.write("0.18.0\\n"); process.exit(0); }
if (argv.includes("--help")) {
  process.stdout.write(${JSON.stringify(KIMI_CODE_HELP)});
  process.exit(0);
}
// kimi-code rejects the legacy --print surface.
if (argv.includes("--print")) { process.stderr.write("error: unknown option '--print'\\n"); process.exit(1); }
const pIdx = argv.indexOf("-p");
const prompt = pIdx >= 0 ? (argv[pIdx + 1] ?? "") : "";
const fs = await import("node:fs");
const stdin = fs.readFileSync(0, "utf8");
// Assert prompt arrived as the -p arg and stdin was NOT used for the prompt.
if (!prompt) { process.stderr.write("fake: missing -p prompt arg\\n"); process.exit(1); }
if (stdin.length > 0) { process.stderr.write("fake: prompt must not be sent on stdin\\n"); process.exit(1); }
process.stdout.write(JSON.stringify({ role: "assistant", content: "pong" }) + "\\n");
process.stdout.write(JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: ${JSON.stringify(KIMI_CODE_SESSION_ID)}, command: "kimi -r ${KIMI_CODE_SESSION_ID}" }) + "\\n");
process.exit(0);
`);
  chmodSync(binary, 0o755);
  try {
    const result = await spawnKimi(resolveProfile("ping"), {
      binary,
      model: null,
      promptText: "say pong",
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.parsed.ok, true);
    assert.equal(result.parsed.result, "pong");
    assert.equal(result.kimiSessionId, KIMI_CODE_SESSION_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnKimi: a kimi-code-ish CLI that advertises -p but not --output-format fails as cli_contract_mismatch, not raw", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-code-partial-"));
  const binary = path.join(dir, "kimi-partial.mjs");
  // --help advertises the -p surface (so selectKimiSurface => kimi-code) but is
  // missing --output-format, which buildKimiCodeArgs emits.
  const partialHelp = `Usage: kimi [options]

Options:
  -V, --version                 output the version number
  -p, --prompt <prompt>         Run one prompt non-interactively.
  -h, --help                    Show help.
`;
  writeFileSync(binary, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-V")) { process.stdout.write("0.99.0\\n"); process.exit(0); }
if (argv.includes("--help")) { process.stdout.write(${JSON.stringify(partialHelp)}); process.exit(0); }
process.stderr.write("should not reach prompt mode\\n"); process.exit(3);
`);
  chmodSync(binary, 0o755);
  try {
    await assert.rejects(
      () => spawnKimi(resolveProfile("ping"), { binary, model: null, promptText: "say pong" }),
      (e) => e instanceof KimiContractMismatchError && e.missingFlags.includes("--output-format"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
