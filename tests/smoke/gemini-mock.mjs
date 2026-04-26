#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("0.39.0\n");
  process.exit(0);
}

function parseCli(argv) {
  const valueFlags = new Set([
    "-p", "--prompt", "-m", "--model", "--output-format", "--approval-mode",
    "--policy", "--resume", "--include-directories",
  ]);
  const boolFlags = new Set(["-s", "--sandbox", "-y", "--yolo", "--skip-trust"]);
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (valueFlags.has(tok)) {
      out.flags[tok] = argv[i + 1] ?? "";
      i += 1;
    } else if (boolFlags.has(tok)) {
      out.flags[tok] = true;
    } else {
      out.positional.push(tok);
    }
  }
  return out;
}

const parsed = parseCli(process.argv.slice(2));
const stdin = readFileSync(0, "utf8");
const promptArg = parsed.flags["-p"] ?? parsed.flags["--prompt"] ?? "";
const prompt = `${promptArg}${stdin}`;
const policyPath = parsed.flags["--policy"] ?? null;
const includeDirs = String(parsed.flags["--include-directories"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const fixture = {
  session_id: "22222222-3333-4444-9555-666666666666",
  response: "Mock Gemini response.",
  stats: {
    models: {
      [parsed.flags["-m"] ?? parsed.flags["--model"] ?? "unknown"]: {
        tokens: { total: 12 },
      },
    },
  },
  t7_policy_loaded: policyPath ? existsSync(policyPath) : false,
  t7_sandbox: parsed.flags["-s"] === true || parsed.flags["--sandbox"] === true,
  t7_skip_trust: parsed.flags["--skip-trust"] === true,
  t7_prompt_from_stdin: promptArg === "" && stdin.length > 0 && prompt.length > 0,
  t7_resume_id: parsed.flags["--resume"] ?? null,
  t7_include_dirs: includeDirs,
};

const assertCwdAbs = process.env.GEMINI_MOCK_ASSERT_CWD;
if (assertCwdAbs) {
  fixture.t7_cwd_match = process.cwd() === assertCwdAbs;
  fixture.t7_cwd = process.cwd();
}

const assertFileRel = process.env.GEMINI_MOCK_ASSERT_FILE;
if (assertFileRel) {
  fixture.t7_saw_file = includeDirs.some((dir) => existsSync(resolve(dir, assertFileRel)));
}

process.stdout.write(JSON.stringify(fixture) + "\n");
