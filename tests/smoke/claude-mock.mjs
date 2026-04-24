#!/usr/bin/env node
// Deterministic `claude -p` substitute for smoke tests. Accepts the real
// Claude-Code flag surface, routes on (model, sha256(prompt)) to a fixture
// JSON file under tests/smoke/fixtures/claude/. Exit 1 with a readable error
// when no fixture matches.
//
// Usage (put on PATH as `claude`):
//   PATH=tests/smoke:$PATH node claude-companion.mjs run --mode=review ...
//
// The mock writes exactly one JSON line on stdout (matching Claude
// --output-format=json) and exits 0 on a fixture hit.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "fixtures/claude");

// Support --version so setup probes don't need a fixture.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("claude-mock 0.0.1 (codex-plugin-multi test fixture)\n");
  process.exit(0);
}

function parseCli(argv) {
  // Minimal parser covering the flags the companion passes. Values flags are
  // greedy (consume the following token). Boolean flags stand alone.
  const valueFlags = new Set([
    "--model", "--permission-mode", "--session-id", "--output-format",
    "--input-format", "--setting-sources", "--json-schema",
    "--disallowedTools", "--disallowed-tools",
    "--allowedTools", "--allowed-tools",
    "--add-dir", "--append-system-prompt", "--system-prompt",
    "--resume", "--fallback-model", "--max-budget-usd", "--effort",
    "--tools", "--name",
  ]);
  const boolFlags = new Set([
    "--print", "-p", "--bare", "--verbose", "--fork-session", "--continue", "-c",
    "--no-session-persistence", "--include-hook-events", "--include-partial-messages",
  ]);
  const out = { positional: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (valueFlags.has(tok)) {
      const val = argv[i + 1];
      if (val === undefined) {
        // Value flag with no following token — real Claude errors; we match.
        process.stderr.write(`claude-mock: missing value for ${tok}\n`);
        process.exit(1);
      }
      out.flags[tok] = val;
      i += 1;
      continue;
    }
    if (boolFlags.has(tok)) {
      out.flags[tok] = true;
      continue;
    }
    if (tok.startsWith("-")) {
      // Unknown flag — record but don't consume a value.
      out.flags[tok] = true;
      continue;
    }
    out.positional.push(tok);
  }
  return out;
}

const parsed = parseCli(process.argv.slice(2));

// Prompt source: argv positional (`claude -p "..."`) OR stdin (if --input-format stream-json).
let prompt;
if (parsed.positional.length > 0) {
  prompt = parsed.positional.join(" ");
} else if (parsed.flags["--input-format"] === "stream-json") {
  prompt = readFileSync(0, "utf8");
} else {
  // Claude real behavior: errors if -p lacks both positional and stdin.
  process.stderr.write(
    "claude-mock: Input must be provided either through stdin or as a prompt argument.\n"
  );
  process.exit(1);
}

const model = parsed.flags["--model"] ?? "unknown";
const sessionId = parsed.flags["--session-id"] ?? "00000000-0000-4000-8000-000000000000";
const promptSha = createHash("sha256").update(prompt).digest("hex").slice(0, 16);

// Fixture key: "<model>-<promptSha>.json". Fall back to "<model>-default.json".
const candidates = [
  resolve(FIXTURE_DIR, `${model}-${promptSha}.json`),
  resolve(FIXTURE_DIR, `${model}-default.json`),
  resolve(FIXTURE_DIR, `default.json`),
];

let fixturePath = null;
for (const p of candidates) {
  if (existsSync(p)) { fixturePath = p; break; }
}
if (!fixturePath) {
  process.stderr.write(
    `claude-mock: no fixture for model=${model} promptSha=${promptSha}\n` +
    `  tried: ${candidates.join(", ")}\n` +
    `  add a fixture or set CLAUDE_MOCK_ALLOW_SYNTHETIC=1 for auto-synthesis.\n`
  );
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

// Stamp session_id so consumers testing round-trip continuation see the exact
// UUID they passed. Real Claude does this too.
fixture.session_id = sessionId;
fixture.uuid = fixture.uuid ?? sessionId;

// T7.2 test oracle: when CLAUDE_MOCK_ASSERT_FILE=<relpath> is set, the mock
// checks whether that file exists under --add-dir (the path Claude actually
// sees) and embeds the answer in the fixture's `result`. Smoke tests use this
// to verify that populateScope put the right content in front of Claude.
// CLAUDE_MOCK_ASSERT_CWD=<abspath> checks process.cwd() equality (for
// containment=none verification). Both are deliberately lightweight; they
// exist only so smoke tests can interrogate what the mock received.
const assertFileRel = process.env.CLAUDE_MOCK_ASSERT_FILE;
const assertCwdAbs = process.env.CLAUDE_MOCK_ASSERT_CWD;
const addDir = parsed.flags["--add-dir"] ?? null;
if (assertFileRel) {
  const target = addDir ? resolve(addDir, assertFileRel) : null;
  fixture.t7_saw_file = target ? existsSync(target) : false;
  fixture.t7_add_dir = addDir;
}
if (assertCwdAbs) {
  fixture.t7_cwd_match = process.cwd() === assertCwdAbs;
  fixture.t7_cwd = process.cwd();
}
if (process.env.CLAUDE_MOCK_LIST_ADDDIR && addDir) {
  // Emit a sorted list of entries under addDir, for branch-diff verification.
  // Uses readdirSync recursively, pruning .git.
  const { readdirSync: rd, statSync: st } = await import("node:fs");
  function walk(dir, prefix = "") {
    const out = [];
    for (const name of rd(dir)) {
      if (name === ".git") continue;
      const full = resolve(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (st(full).isDirectory()) out.push(...walk(full, rel));
      else out.push(rel);
    }
    return out.sort();
  }
  fixture.t7_add_dir_files = walk(addDir);
}

// Emit the final result event and exit. Matches `--output-format=json`.
process.stdout.write(JSON.stringify(fixture) + "\n");
process.exit(0);
