import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseKimiHelpFlags,
  detectKimiCapabilities,
  missingKimiFlags,
  assertKimiContract,
  KimiContractMismatchError,
  KIMI_CAPABILITY_PROBE_TIMEOUT_MS,
  __resetKimiCapabilityCache,
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

// A non-kimi-code CLI help screen (the older `--print` surface). Used as a
// fixture to prove the contract guard rejects a CLI that does not advertise the
// kimi-code prompt-mode flags relay emits.
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

test("detectKimiCapabilities caches a successful probe per binary (real path, no re-probe)", () => {
  __resetKimiCapabilityCache();
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-cap-cache-ok-"));
  const counter = path.join(dir, "count");
  const bin = path.join(dir, "kimi-ok.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--help")) { appendFileSync(${JSON.stringify(counter)}, "h"); process.stdout.write("Options:\\n  -p, --prompt <p>\\n  --output-format <f>\\n  -h, --help\\n"); process.exit(0); }
if (argv.includes("--version")) { process.stdout.write("0.18.0\\n"); process.exit(0); }
process.exit(1);
`);
  chmodSync(bin, 0o755);
  try {
    assert.equal(detectKimiCapabilities(bin).ok, true);
    assert.equal(detectKimiCapabilities(bin).ok, true);
    assert.equal(readFileSync(counter, "utf8"), "h", "second call must hit the cache, not re-probe the binary");
  } finally {
    __resetKimiCapabilityCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectKimiCapabilities re-probes after an in-place binary upgrade (stat-identity key)", () => {
  __resetKimiCapabilityCache();
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-cap-upgrade-"));
  const counter = path.join(dir, "count");
  const bin = path.join(dir, "kimi-upgrade.mjs");
  const writeBin = (version, pad) => writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--help")) { appendFileSync(${JSON.stringify(counter)}, "h"); process.stdout.write("Options:\\n  -p, --prompt <p>\\n  --output-format <f>\\n  -h, --help\\n"); process.exit(0); }
if (argv.includes("--version")) { process.stdout.write(${JSON.stringify(version)} + "\\n"); process.exit(0); }
process.exit(1); // pad:${pad}
`);
  writeBin("0.18.0", "a");
  chmodSync(bin, 0o755);
  try {
    assert.equal(detectKimiCapabilities(bin).version, "0.18.0");
    // Rewrite the same path with a different build (new size + mtime). The
    // stale-by-path bug would reuse 0.18.0; stat-identity keying must re-probe.
    writeBin("0.19.0", "bb-longer-padding-to-change-size");
    chmodSync(bin, 0o755);
    assert.equal(detectKimiCapabilities(bin).version, "0.19.0",
      "an in-place upgrade must invalidate the cached probe, not reuse stale flags");
    assert.equal(readFileSync(counter, "utf8"), "hh", "the upgraded binary must be re-probed");
  } finally {
    __resetKimiCapabilityCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectKimiCapabilities does not cache a failed probe (stays re-tryable)", () => {
  __resetKimiCapabilityCache();
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-cap-cache-fail-"));
  const counter = path.join(dir, "count");
  const bin = path.join(dir, "kimi-bad.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv.slice(2).includes("--help")) { appendFileSync(${JSON.stringify(counter)}, "f"); process.exit(1); }
process.exit(1);
`);
  chmodSync(bin, 0o755);
  try {
    assert.equal(detectKimiCapabilities(bin).ok, false);
    assert.equal(detectKimiCapabilities(bin).ok, false);
    assert.equal(readFileSync(counter, "utf8"), "ff", "a failed probe must be re-tried, never cached");
  } finally {
    __resetKimiCapabilityCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectKimiCapabilities bounds the --help/--version probe with a positive timeout", () => {
  const seen = [];
  const caps = detectKimiCapabilities("kimi", {
    runImpl: (_binary, args, options) => {
      seen.push({ args: args.join(" "), timeout: options?.timeout });
      if (args[0] === "--help") return { status: 0, stdout: KIMI_CODE_HELP, stderr: "" };
      return { status: 0, stdout: "0.18.0\n", stderr: "" };
    },
  });
  assert.equal(caps.ok, true);
  // Every probe must carry the bounded timeout so a wedged CLI cannot hang the
  // synchronous capability detection that runs on every spawnKimi.
  assert.ok(KIMI_CAPABILITY_PROBE_TIMEOUT_MS > 0);
  for (const call of seen) {
    assert.equal(call.timeout, KIMI_CAPABILITY_PROBE_TIMEOUT_MS, `probe ${call.args} must pass the bounded timeout`);
  }
});

test("detectKimiCapabilities fails open (ok:false) when --help times out (ETIMEDOUT)", () => {
  // spawnSync sets result.error on timeout; detection must treat that like any
  // unprobeable CLI and report ok:false so callers SKIP the contract guard.
  const caps = detectKimiCapabilities("kimi", {
    runImpl: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync kimi ETIMEDOUT"), { code: "ETIMEDOUT" }) }),
  });
  assert.equal(caps.ok, false);
  assert.deepEqual([...caps.supportedFlags], []);
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

test("missingKimiFlags normalizes --flag=value before membership (no false mismatch)", () => {
  const caps = detectKimiCapabilities("kimi", {
    runImpl: fakeRun({
      "--help": { status: 0, stdout: KIMI_CODE_HELP, stderr: "" },
      "--version": { status: 0, stdout: "0.18.0" },
    }),
  });
  // help advertises bare `--output-format`; an attached-value token must not be
  // reported as missing, and assertKimiContract must not throw on it.
  assert.deepEqual(missingKimiFlags(["--output-format=stream-json", "-p", "review this"], caps), []);
  assert.doesNotThrow(() => assertKimiContract(["-p", "review this", "--output-format=stream-json"], caps));
  // a genuinely unsupported flag is still caught, in either syntax.
  assert.deepEqual(missingKimiFlags(["--print=1"], caps), ["--print"]);
});

test("missingKimiFlags never scans the VALUE of a value-taking flag (dash-leading values)", () => {
  const caps = detectKimiCapabilities("kimi", {
    runImpl: fakeRun({
      "--help": { status: 0, stdout: KIMI_CODE_HELP, stderr: "" },
      "--version": { status: 0, stdout: "0.18.0" },
    }),
  });
  // A prompt / model alias / format value that itself starts with "-" must be
  // treated as the value of -p/-m/--output-format, NOT as an unsupported flag.
  // Regression guard: this was a false cli_contract_mismatch (PR #226 review).
  assert.deepEqual(
    missingKimiFlags(["-p", "-v flag handling", "--output-format", "stream-json"], caps),
    [],
  );
  assert.deepEqual(missingKimiFlags(["-m", "-dash-model", "-p", "hi"], caps), []);
  assert.deepEqual(missingKimiFlags(["--output-format", "-json", "-p", "hi"], caps), []);
  assert.deepEqual(missingKimiFlags(["--session", "--weird-id", "-p", "hi"], caps), []);
  assert.doesNotThrow(() =>
    assertKimiContract(["-p", "- fix this file", "--output-format", "stream-json"], caps));
  // a genuinely unsupported flag in a flag position is still caught.
  assert.deepEqual(
    missingKimiFlags(["-p", "ok", "--print", "--output-format", "stream-json"], caps),
    ["--print"],
  );
});
