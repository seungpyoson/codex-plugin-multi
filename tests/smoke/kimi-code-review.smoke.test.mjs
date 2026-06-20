// Companion-level smoke: `run --mode review` and `run --mode rescue` end-to-end
// against a fake kimi-code 0.18.0 CLI (the -p/--prompt surface). Proves the full
// review + rescue paths on the migrated surface without a live binary (#222):
//   - review routes to kimi-code, the verdict-only final turn is reported (interim
//     narration dropped), and source_content_transmission resolves to "sent";
//   - rescue runs tools-on in the working tree, keeps the full transcript, and the
//     model's file edit lands on disk.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureGit, fixtureGitEnv } from "../helpers/fixture-git.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const companion = path.join(repoRoot, "plugins", "kimi", "scripts", "kimi-companion.mjs");

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

// A fake kimi-code ACP CLI. The readiness preflight runs with
// KIMI_COMPANION_PREFLIGHT=1 (a fixed neutral-cwd "pong" probe) — answered simply,
// never mutating. The real run is driven by KC_MOCK_MODE: review streams a narration
// message then a verdict message (finalMessageOnly keeps the verdict); rescue writes
// FIXED.md in the working tree and streams a multi-message transcript (kept whole).
function writeKimiCodeMock(dir) {
  const binary = path.join(dir, "kimi-code-mock.mjs");
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync as wfs } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-V")) { process.stdout.write("0.18.0\\n"); process.exit(0); }
if (argv.includes("--help")) { process.stdout.write(${JSON.stringify(KIMI_CODE_HELP)}); process.exit(0); }
if (argv[0] !== "acp") { process.stderr.write("kimi-code-mock: unsupported invocation\\n"); process.exit(1); }
const VERDICT = ${JSON.stringify([
  "Verdict: APPROVE",
  "",
  "Checklist:",
  "1. Correctness: PASS — the logic matches the stated intent and handles the documented cases.",
  "2. Readability: PASS — names and structure are clear.",
  "3. Tests: PASS — the changed behavior is covered by assertions.",
  "4. Security: PASS — no injection, traversal, or secret-handling concerns in the selected source.",
  "5. Performance: PASS — no obvious hot-path regressions.",
  "6. Docs: PASS — the change is self-explanatory.",
  "",
  "No blocking findings.",
  "Non-blocking concerns: None.",
  "Test gaps: None.",
  "I inspected the selected source file as embedded in the prompt.",
].join("\n"))};
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function msg(id, text) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session_kc-mock-0001", update: { sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text } } } }); }
let buf = "";
process.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(JSON.parse(l)); } });
process.stdin.on("end", () => process.exit(0));
function handle(m) {
  if (m.method === "initialize") { send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "Kimi Code CLI", version: "0.18.0" } } }); return; }
  if (m.method === "session/new") { send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "session_kc-mock-0001", configOptions: [{ type: "select", id: "model", options: [{ value: "kimi-code/kimi-for-coding" }] }] } }); return; }
  if (m.method === "session/set_config_option") { send({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
  if (m.method === "session/prompt") {
    if (process.env.KIMI_COMPANION_PREFLIGHT === "1") { msg("ping", "pong"); send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }); return; }
    const mode = process.env.KC_MOCK_MODE ?? "review";
    if (mode === "rescue") {
      // Tools-on rescue runs in the working tree (containment "none"); prove a real edit lands.
      wfs("FIXED.md", "DONE by kimi-code rescue\\n");
      msg("m1", "Let me inspect the repository before editing.");
      msg("m2", "I created FIXED.md containing DONE. The rescue task is complete.");
    } else {
      // review-family: a narration message then the verdict message; finalMessageOnly
      // keeps only the verdict turn.
      msg("m1", "Let me read the selected source before deciding.");
      msg("m2", VERDICT);
    }
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (m.id != null) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } });
}
`);
  chmodSync(binary, 0o755);
  return binary;
}

function seedRepo(cwd) {
  fixtureGit(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(cwd, "README.md"), "# Kimi Code Review Smoke\n\nA seeded file for the selected-source review.\n");
  fixtureGit(cwd, ["add", "README.md"]);
  fixtureGit(cwd, ["commit", "-q", "-m", "seed"], {
    env: fixtureGitEnv({
      GIT_AUTHOR_EMAIL: "smoke@example.invalid", GIT_AUTHOR_NAME: "smoke",
      GIT_COMMITTER_EMAIL: "smoke@example.invalid", GIT_COMMITTER_NAME: "smoke",
    }),
  });
}

function runCompanion(args, { cwd, binary, dataDir, mode }) {
  const res = spawnSync("node", [companion, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      KIMI_BINARY: binary,
      KIMI_PLUGIN_DATA: dataDir,
      KC_MOCK_MODE: mode,
    },
  });
  const text = res.stdout ?? "";
  const json = text.includes("{")
    ? JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
    : null;
  return { res, json };
}

test("run --mode review on kimi-code reports the verdict-only final turn and marks source sent", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-code-review-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-code-review-data-"));
  const mockDir = mkdtempSync(path.join(tmpdir(), "kimi-code-review-mock-"));
  try {
    seedRepo(cwd);
    const binary = writeKimiCodeMock(mockDir);
    const { res, json } = runCompanion(
      ["run", "--mode", "review", "--foreground", "--cwd", cwd, "--", "Review README.md as the selected source."],
      { cwd, binary, dataDir, mode: "review" },
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(json.target, "kimi");
    assert.equal(json.status, "completed");
    // Final-turn extraction: the verdict is on line 1 and the interim narration
    // turn is dropped from the stored result.
    assert.match(json.result, /^Verdict: APPROVE/);
    assert.doesNotMatch(json.result, /Let me read the selected source/);
    assert.equal(json.external_review.source_content_transmission, "sent");
    const quality = json.review_metadata.audit_manifest.review_quality;
    assert.equal(quality.has_verdict, true);
    assert.equal(quality.failed_review_slot, false);
    assert.equal(quality.looks_shallow, false);
    assert.deepEqual(quality.semantic_failure_reasons, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(mockDir, { recursive: true, force: true });
  }
});

test("run --mode rescue on kimi-code runs tools-on, keeps the full transcript, and edits the working tree", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "kimi-code-rescue-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "kimi-code-rescue-data-"));
  const mockDir = mkdtempSync(path.join(tmpdir(), "kimi-code-rescue-mock-"));
  try {
    seedRepo(cwd);
    const binary = writeKimiCodeMock(mockDir);
    const { res, json } = runCompanion(
      ["run", "--mode", "rescue", "--foreground", "--cwd", cwd, "--", "Create FIXED.md containing DONE."],
      { cwd, binary, dataDir, mode: "rescue" },
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(json.status, "completed");
    // Rescue keeps the full multi-turn transcript (no final-turn truncation).
    assert.match(json.result, /Let me inspect the repository before editing/);
    assert.match(json.result, /created FIXED\.md/);
    // The tools-on edit landed on disk in the working tree.
    assert.ok(existsSync(path.join(cwd, "FIXED.md")), "rescue must edit the working tree");
    assert.match(readFileSync(path.join(cwd, "FIXED.md"), "utf8"), /DONE by kimi-code rescue/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(mockDir, { recursive: true, force: true });
  }
});
