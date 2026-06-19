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
  kimiCodePromptExceedsArgLimit,
  KIMI_CODE_PROMPT_MAX_BYTES,
  parseKimiResult,
  spawnKimi,
} from "../../plugins/kimi/scripts/lib/kimi.mjs";
import { resolveProfile } from "../../plugins/kimi/scripts/lib/mode-profiles.mjs";
import {
  classifyCompanionExecution,
  buildExternalModelFailureDiagnostic,
} from "../../plugins/kimi/scripts/lib/external-model-failure-core.mjs";
import {
  sourceContentTransmissionForExecution,
  externalReviewDisclosure,
} from "../../plugins/kimi/scripts/lib/external-review.mjs";

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

// The real kimi-code session id shape: an underscore-prefixed UUID. Both the
// legacy [0-9a-fA-F-] resume regex and an un-anchored fallback that excludes "_"
// miss the session_ prefix, so the resume-hint regex must include "_".
const KIMI_CODE_SESSION_ID = "session_eeee19b6-5926-4180-a880-1d7d33dfc227";

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

test("kimiCodeSurfaceEligible: admits ping AND the review-family + rescue (full kimi-code migration)", () => {
  assert.equal(kimiCodeSurfaceEligible(resolveProfile("ping")), true);
  for (const name of ["review", "adversarial-review", "custom-review", "rescue"]) {
    assert.equal(kimiCodeSurfaceEligible(resolveProfile(name)), true, `${name} must now be -p eligible`);
  }
  // Only a null/unknown/malformed profile is rejected.
  assert.equal(kimiCodeSurfaceEligible(null), false);
  assert.equal(kimiCodeSurfaceEligible({}), false);
});

test("buildKimiCodeArgs: emits valid -p argv for review and rescue (no longer throws for non-ping)", () => {
  for (const name of ["review", "adversarial-review", "custom-review", "rescue"]) {
    const args = buildKimiCodeArgs(resolveProfile(name), { model: "kimi-for-coding", promptText: "review this" });
    assert.equal(args[0], "-p");
    assert.equal(args[1], "review this");
    assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
    assert.equal(args[args.indexOf("-m") + 1], "kimi-for-coding");
    for (const forbidden of ["--print", "--final-message-only", "--input-format", "--max-steps-per-turn",
      "--thinking", "--agent-file", "--mcp-config-file", "--add-dir"]) {
      assert.ok(!args.includes(forbidden), `${name} must not emit ${forbidden}`);
    }
  }
});

test("parseKimiResult(kimi-code): a successful reply that mentions quota/billing is NOT misclassified as usage-limited", () => {
  const stdout = `{"role":"assistant","content":"Verdict: PASS. Check quota and billing cycle handling."}\n`;
  const parsed = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true, "successful content must not be scanned for usage-limit wording");
  assert.match(parsed.result, /quota and billing cycle/);
  assert.notEqual(parsed.reason, "usage_limited");
});

test("parseKimiResult(kimi-code): extracts assistant content + session_<uuid> from the meta line", () => {
  const stdout = `{"role":"assistant","content":"pong"}\n`
    + `{"role":"meta","type":"session.resume_hint","session_id":"${KIMI_CODE_SESSION_ID}",`
    + `"command":"kimi -r ${KIMI_CODE_SESSION_ID}","content":"To resume this session: kimi -r ${KIMI_CODE_SESSION_ID}"}\n`;
  const parsed = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "pong");
  assert.equal(parsed.sessionId, KIMI_CODE_SESSION_ID);
  assert.equal(parsed.error, null);
});

test("parseKimiResult(kimi-code): recovers the session_<uuid> id from a resume-hint line when no meta object", () => {
  const stdout = `{"role":"assistant","content":"done"}\n`;
  const stderr = `• thinking...\nTo resume this session: kimi -r ${KIMI_CODE_SESSION_ID}\n`;
  const parsed = parseKimiResult(stdout, stderr, { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "done");
  assert.equal(parsed.sessionId, KIMI_CODE_SESSION_ID);
});

test("parseKimiResult(kimi-code): the resume-hint regex requires a long id (a short token is not captured)", () => {
  // No meta line, and the only "kimi -r" hint carries a too-short id — the
  // fallback must not capture it (guards against matching arbitrary words).
  const parsed = parseKimiResult(`{"role":"assistant","content":"done"}\n`, "see: kimi -r abc\n",
    { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, null);
});

test("parseKimiResult(kimi-code): joins multiple assistant turns by default (rescue/full-transcript)", () => {
  const stdout = `{"role":"assistant","content":"first"}\n{"role":"assistant","content":"second"}\n`;
  const parsed = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "first\nsecond");
});

test("parseKimiResult(kimi-code): finalMessageOnly takes ONLY the last assistant turn (review verdict contract)", () => {
  // A review run that "thinks out loud" before the verdict: narration turn, then
  // a tool-call turn (no string content, excluded), then the verdict turn.
  const stdout = `{"role":"assistant","content":"Let me look at the diff..."}\n`
    + `{"role":"assistant","tool_calls":[{"id":"1","name":"Read"}]}\n`
    + `{"role":"assistant","content":"Verdict: APPROVE\\nChecklist: all PASS"}\n`;
  const review = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code", finalMessageOnly: true });
  assert.equal(review.ok, true);
  assert.match(review.result, /^Verdict: APPROVE/, "verdict must be on line 1");
  assert.doesNotMatch(review.result, /Let me look at the diff/, "narration must be dropped");
  // Rescue (no finalMessageOnly) keeps the full transcript.
  const rescue = parseKimiResult(stdout, "", { exitCode: 0, surface: "kimi-code" });
  assert.match(rescue.result, /Let me look at the diff/);
  assert.match(rescue.result, /Verdict: APPROVE/);
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

test("parseKimiResult(kimi-code): step exhaustion classifies as kimi_error, never the dead legacy step_limit branch", () => {
  // kimi-code surfaces step exhaustion as an error event / nonzero exit — NOT the
  // legacy "Max number of steps reached: N" plain line (that sentinel is parsed
  // only on the legacy surface). Assert the kimi-code branch never returns
  // step_limit_exceeded, so max_steps_per_turn is correctly inert here.
  const errEvent = parseKimiResult(`{"role":"error","is_error":true,"error":"Max number of steps reached: 16"}\n`,
    "", { exitCode: 1, surface: "kimi-code" });
  assert.equal(errEvent.ok, false);
  assert.notEqual(errEvent.reason, "step_limit_exceeded");
  assert.equal(errEvent.reason, "kimi_error");
  // The legacy sentinel as plain stdout on the kimi-code surface is NOT promoted
  // to step_limit_exceeded (no JSON line -> empty assistant text -> failure).
  const plain = parseKimiResult("Max number of steps reached: 16\n", "", { exitCode: 1, surface: "kimi-code" });
  assert.equal(plain.ok, false);
  assert.notEqual(plain.reason, "step_limit_exceeded");
});

test("kimiCodePromptExceedsArgLimit: byte-accurate, ceiling-bounded, multibyte-aware", () => {
  assert.equal(kimiCodePromptExceedsArgLimit("x".repeat(KIMI_CODE_PROMPT_MAX_BYTES)), false, "exactly at ceiling is OK");
  assert.equal(kimiCodePromptExceedsArgLimit("x".repeat(KIMI_CODE_PROMPT_MAX_BYTES + 1)), true, "one over is too large");
  // A multibyte char counts as its UTF-8 byte length, not .length.
  const halfChars = "✓".repeat(Math.ceil(KIMI_CODE_PROMPT_MAX_BYTES / 3) + 1); // ✓ = 3 bytes
  assert.equal(kimiCodePromptExceedsArgLimit(halfChars), true, "byte length, not char length, governs");
  assert.equal(kimiCodePromptExceedsArgLimit(""), false);
  assert.equal(kimiCodePromptExceedsArgLimit(null), false);
});

test("buildKimiCodeArgs: throws a typed prompt_too_large error for an oversized prompt (backstop)", () => {
  let thrown = null;
  try {
    buildKimiCodeArgs(resolveProfile("review"), { promptText: "x".repeat(KIMI_CODE_PROMPT_MAX_BYTES + 1) });
  } catch (e) { thrown = e; }
  assert.ok(thrown, "must throw for an oversized prompt");
  assert.equal(thrown.code, "prompt_too_large");
  assert.equal(thrown.reason, "prompt_too_large");
});

test("spawnKimi(kimi-code): an oversized prompt fails clean as prompt_too_large with NO child spawned (pidInfo null)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-code-toobig-"));
  const binary = path.join(dir, "kimi-code-fake.mjs");
  // Only --help/--version are needed: the size guard short-circuits before any
  // prompt spawn, so the fake never has to handle -p.
  writeFileSync(binary, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-V")) { process.stdout.write("0.18.0\\n"); process.exit(0); }
if (argv.includes("--help")) { process.stdout.write(${JSON.stringify(KIMI_CODE_HELP)}); process.exit(0); }
process.stderr.write("fake: prompt should never have been spawned\\n"); process.exit(99);
`);
  chmodSync(binary, 0o755);
  try {
    const result = await spawnKimi(resolveProfile("review"), {
      binary,
      model: "kimi-for-coding",
      promptText: "x".repeat(KIMI_CODE_PROMPT_MAX_BYTES + 1),
    });
    assert.equal(result.pidInfo, null, "no child must be spawned");
    assert.equal(result.exitCode, null);
    assert.equal(result.parsed.ok, false);
    assert.equal(result.parsed.reason, "prompt_too_large");
    assert.match(result.parsed.error, /argv ceiling|ARG_MAX/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt_too_large flows to error_code prompt_too_large -> NOT_SENT -> a real diagnostic", () => {
  // The synthetic spawnKimi shape, classified the way executeRun's finalization
  // classifies it.
  const state = classifyCompanionExecution(
    { exitCode: null, signal: null, timedOut: false, pidInfo: null,
      parsed: { ok: false, reason: "prompt_too_large", error: "rendered prompt is 900001 bytes" } },
    { catchallCode: "kimi_error" },
  );
  assert.equal(state.status, "failed");
  assert.equal(state.error_code, "prompt_too_large");
  // Pre-target NOT_SENT regardless of pidInfo.
  assert.equal(
    sourceContentTransmissionForExecution({ status: "failed", errorCode: "prompt_too_large", pidInfo: null }),
    "not_sent",
  );
  // The catalog entry yields a real (non-null) diagnostic.
  const diag = buildExternalModelFailureDiagnostic("prompt_too_large", "Kimi Code CLI");
  assert.ok(diag, "prompt_too_large must have a failure-catalog entry");
  assert.ok(diag.error_summary && diag.error_cause && diag.suggested_action);
  // The NOT_SENT disclosure for this code is the dedicated prompt_too_large line.
  const disclosure = externalReviewDisclosure("Kimi Code CLI", "failed", "not_sent", "prompt_too_large");
  assert.match(disclosure, /rendered prompt exceeded the provider budget/);
});
