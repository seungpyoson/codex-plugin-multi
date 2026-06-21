#!/usr/bin/env node
// Fake `kimi` binary for spawnKimi-over-ACP integration tests. Dispatches the three
// surfaces relay touches:
//   kimi --help      -> a kimi-code help screen advertising the `acp` command
//                       (or, with FAKE_KIMI_LEGACY=1, a legacy screen WITHOUT acp)
//   kimi --version   -> a version string
//   kimi acp         -> the mock ACP server (tests/smoke/kimi-acp-mock.mjs serveAcp)
// Behaviour of the ACP turn is controlled by the same MOCK_ACP_* env knobs.
import { serveAcp } from "./kimi-acp-mock.mjs";

const argv = process.argv.slice(2);
const env = process.env;

const KIMI_CODE_HELP = `Usage: kimi [options] [command]

The Starting Point for Next-Gen Agents

Options:
  -V, --version                 output the version number
  -p, --prompt <prompt>         Run one prompt non-interactively and print the response.
  --output-format <format>      Output format for prompt mode.
  -h, --help                    Show help.

Commands:
  acp [options]                 Run kimi-code as an Agent Client Protocol (ACP) server over stdio.
  doctor                        Validate Kimi Code configuration files.
`;

const LEGACY_HELP = `Usage: kimi [options]

Options:
  --print                       Print mode.
  --agent-file <path>           Agent file.
  -h, --help                    Show help.
`;

if (argv[0] === "acp") {
  serveAcp(env);
} else if (argv.includes("--help")) {
  process.stdout.write(env.FAKE_KIMI_LEGACY === "1" ? LEGACY_HELP : KIMI_CODE_HELP);
  process.exit(0);
} else if (argv.includes("--version")) {
  process.stdout.write(`${env.FAKE_KIMI_VERSION ?? "0.18.0"}\n`);
  process.exit(0);
} else {
  process.stderr.write(`fake-kimi: unsupported invocation: ${argv.join(" ")}\n`);
  process.exit(1);
}
