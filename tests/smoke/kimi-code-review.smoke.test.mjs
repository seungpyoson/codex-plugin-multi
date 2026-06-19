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
  -S, --session [id]            Resume a session.
  -h, --help                    Show help.
`;

// A fake kimi-code CLI. The readiness preflight runs with KIMI_COMPANION_PREFLIGHT=1
// (a fixed neutral-cwd "pong" probe) — the mock answers that simply and never
// mutates. The real run is driven by KC_MOCK_MODE: review emits narration + a
// tool-call turn + a final verdict turn; rescue writes FIXED.md in the working
// tree and emits a multi-turn transcript.
function writeKimiCodeMock(dir) {
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
const meta = () => JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_kc-mock-0001", command: "kimi -r session_kc-mock-0001" });
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

// Readiness preflight: a fixed neutral probe. Never mutate, just answer pong.
if (process.env.KIMI_COMPANION_PREFLIGHT === "1") {
  emit({ role: "assistant", content: "pong" });
  process.stdout.write(meta() + "\\n");
  process.exit(0);
}

const mode = process.env.KC_MOCK_MODE ?? "review";
if (mode === "rescue") {
  // Tools-on rescue runs in the working tree; prove a real edit lands on disk.
  fs.writeFileSync("FIXED.md", "DONE by kimi-code rescue\\n");
  emit({ role: "assistant", content: "Let me inspect the repository before editing." });
  emit({ role: "assistant", tool_calls: [{ id: "1", name: "Edit" }] });
  emit({ role: "assistant", content: "I created FIXED.md containing DONE. The rescue task is complete." });
  process.stdout.write(meta() + "\\n");
  process.exit(0);
}

// review-family: an interim narration turn, a tool-call turn (no string content),
// then the final verdict turn. Final-turn extraction must report only the verdict.
emit({ role: "assistant", content: "Let me read the selected source before deciding." });
emit({ role: "assistant", tool_calls: [{ id: "1", name: "Read" }] });
const verdict = [
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
].join("\\n");
emit({ role: "assistant", content: verdict });
process.stdout.write(meta() + "\\n");
process.exit(0);
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
