import test from "node:test";
import assert from "node:assert/strict";

import {
  parseKimiHelpFlags,
  detectKimiCapabilities,
  missingKimiFlags,
  assertKimiContract,
  KimiContractMismatchError,
} from "../../plugins/kimi/scripts/lib/kimi-capabilities.mjs";

// Abridged real kimi-code 0.18.0 --help (the installed contract).
const KIMI_CODE_HELP = `Usage: kimi [options] [command]

The Starting Point for Next-Gen Agents

Options:
  -V, --version                 output the version number
  -S, --session [id]            Resume a session.
  -y, --yolo                    Automatically approve all actions.
  -m, --model <model>           LLM model alias to use for this invocation.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the response.
  --output-format <format>      Output format for prompt mode. (choices: "text", "stream-json")
  --skills-dir <dir>            Load skills from this directory.
  --plan                        Start in plan mode.
  -h, --help                    Show help.

Commands:
  doctor                        Validate Kimi Code configuration files.
`;

// Legacy kimi-cli help (the surface relay's buildKimiArgs targets).
const LEGACY_HELP = `Usage: kimi [options]

Options:
  --print                       Print mode.
  --final-message-only          Only the final message.
  --input-format <fmt>          Input format.
  --output-format <fmt>         Output format.
  --max-steps-per-turn <n>      Max steps per turn.
  -m, --model <model>           Model.
  --thinking                    Thinking.
  --agent-file <path>           Agent file.
  --mcp-config-file <path>      MCP config file.
  --skills-dir <dir>            Skills dir.
  -h, --help                    Show help.
`;

function fakeRun(map) {
  return (_binary, args) => map[args.join(" ")] ?? { status: 1, stdout: "", stderr: "unknown", error: null };
}

test("parseKimiHelpFlags extracts option tokens from option lines only", () => {
  const flags = parseKimiHelpFlags(KIMI_CODE_HELP);
  assert.ok(flags.has("-p"));
  assert.ok(flags.has("--prompt"));
  assert.ok(flags.has("--output-format"));
  assert.ok(flags.has("--help"));
  assert.ok(!flags.has("--print")); // not advertised by kimi-code
  assert.ok(!flags.has("doctor")); // command/prose lines do not leak tokens
});

test("detectKimiCapabilities reports ok with parsed flags + version on a real help screen", () => {
  const caps = detectKimiCapabilities("kimi", {
    runImpl: fakeRun({
      "--help": { status: 0, stdout: KIMI_CODE_HELP, stderr: "" },
      "--version": { status: 0, stdout: "0.18.0\n", stderr: "" },
    }),
  });
  assert.equal(caps.ok, true);
  assert.equal(caps.version, "0.18.0");
  assert.ok(caps.supportedFlags.has("--prompt"));
});

test("detectKimiCapabilities is fail-open (ok:false) when --help errors", () => {
  const caps = detectKimiCapabilities("kimi", {
    runImpl: fakeRun({ "--help": { status: 1, stdout: "", stderr: "unknown flag --help" } }),
  });
  assert.equal(caps.ok, false);
  assert.equal(caps.supportedFlags.size, 0);
});

test("detectKimiCapabilities is fail-open when --help output is unrecognizable", () => {
  const caps = detectKimiCapabilities("kimi", {
    runImpl: fakeRun({ "--help": { status: 0, stdout: "not a help screen", stderr: "" } }),
  });
  assert.equal(caps.ok, false);
});

test("missingKimiFlags returns the legacy flags kimi-code does not advertise", () => {
  const caps = detectKimiCapabilities("kimi", {
    runImpl: fakeRun({
      "--help": { status: 0, stdout: KIMI_CODE_HELP, stderr: "" },
      "--version": { status: 0, stdout: "0.18.0" },
    }),
  });
  const legacyArgs = ["--print", "--final-message-only", "--output-format", "stream-json",
    "--input-format", "text", "-m", "kimi-x"];
  assert.deepEqual(
    missingKimiFlags(legacyArgs, caps).sort(),
    ["--final-message-only", "--input-format", "--print"].sort(),
  );
});

test("assertKimiContract throws a typed cli_contract_mismatch naming the missing flags", () => {
  const caps = detectKimiCapabilities("kimi", {
    runImpl: fakeRun({
      "--help": { status: 0, stdout: KIMI_CODE_HELP, stderr: "" },
      "--version": { status: 0, stdout: "0.18.0" },
    }),
  });
  assert.throws(
    () => assertKimiContract(["--print", "--output-format", "stream-json"], caps),
    (e) => e instanceof KimiContractMismatchError
      && e.code === "cli_contract_mismatch"
      && e.missingFlags.includes("--print")
      && /#222/.test(e.message),
  );
});

test("assertKimiContract is a no-op when the legacy surface IS supported", () => {
  const caps = detectKimiCapabilities("kimi", {
    runImpl: fakeRun({
      "--help": { status: 0, stdout: LEGACY_HELP, stderr: "" },
      "--version": { status: 0, stdout: "1.41.0" },
    }),
  });
  assert.doesNotThrow(() =>
    assertKimiContract(["--print", "--output-format", "x", "--input-format", "text", "-m", "y"], caps));
});

test("assertKimiContract is fail-open (no-op) when capabilities are unknown", () => {
  assert.doesNotThrow(() => assertKimiContract(["--print"], { ok: false, supportedFlags: new Set() }));
});
