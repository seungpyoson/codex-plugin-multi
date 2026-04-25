import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProfile } from "../../plugins/gemini/scripts/lib/mode-profiles.mjs";
import { buildGeminiArgs, parseGeminiResult } from "../../plugins/gemini/scripts/lib/gemini.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = path.join(REPO_ROOT, "plugins/gemini/policies/read-only.toml");

test("buildGeminiArgs: review uses policy, plan mode, sandbox, include-directories, and stdin prompt", () => {
  const args = buildGeminiArgs(resolveProfile("review"), {
    model: "gemini-3-flash-preview",
    policyPath: POLICY,
    includeDirPath: "/tmp/scoped-worktree",
  });

  assert.deepEqual(args.slice(0, 6), ["-p", "", "-m", "gemini-3-flash-preview", "--output-format", "json"]);
  assert.ok(args.includes("--policy"), `missing --policy in ${args.join(" ")}`);
  assert.equal(args[args.indexOf("--policy") + 1], POLICY);
  assert.equal(args[args.indexOf("--approval-mode") + 1], "plan");
  assert.ok(args.includes("--skip-trust"), "review must prevent Gemini trust downgrade from overriding plan mode");
  assert.ok(args.includes("-s"), "review must enable Gemini sandbox flag");
  assert.equal(args[args.indexOf("--include-directories") + 1], "/tmp/scoped-worktree");
  assert.equal(args.includes("review this"), false, "Gemini prompt must not be placed in argv");
});

test("buildGeminiArgs: rescue uses auto_edit and no read-only policy", () => {
  const args = buildGeminiArgs(resolveProfile("rescue"), {
    model: "gemini-3.1-pro-preview",
    policyPath: POLICY,
    includeDirPath: "/workspace",
  });

  assert.equal(args[args.indexOf("--approval-mode") + 1], "auto_edit");
  assert.equal(args.includes("--policy"), false);
  assert.ok(args.includes("--skip-trust"), "rescue is headless too; Gemini must not downgrade/fail on untrusted cwd");
  assert.equal(args.includes("-s"), false);
  assert.equal(args[args.indexOf("--include-directories") + 1], "/workspace");
});

test("buildGeminiArgs: continue passes captured session UUID via --resume", () => {
  const args = buildGeminiArgs(resolveProfile("review"), {
    model: "gemini-3-flash-preview",
    policyPath: POLICY,
    includeDirPath: "/tmp/scoped-worktree",
    resumeId: "22222222-3333-4444-9555-666666666666",
  });

  assert.equal(args[args.indexOf("--resume") + 1], "22222222-3333-4444-9555-666666666666");
});

test("parseGeminiResult: extracts response, session_id, and stats", () => {
  const parsed = parseGeminiResult(JSON.stringify({
    session_id: "22222222-3333-4444-9555-666666666666",
    response: "Mock Gemini response.",
    stats: { models: { "gemini-3-flash-preview": { tokens: { total: 12 } } } },
  }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, "22222222-3333-4444-9555-666666666666");
  assert.equal(parsed.result, "Mock Gemini response.");
  assert.deepEqual(parsed.usage, { models: { "gemini-3-flash-preview": { tokens: { total: 12 } } } });
});

test("parseGeminiResult: accepts pretty-printed JSON from live Gemini OAuth runs", () => {
  const parsed = parseGeminiResult(`{
  "session_id": "86355b3f-48d9-4524-8b8f-7b0f134f830f",
  "response": "GEMINI_LIVE_E2E_OK",
  "stats": {
    "models": {
      "gemini-3.1-pro-preview": {
        "api": {
          "totalRequests": 2,
          "totalErrors": 0
        }
      }
    }
  }
}
`);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, "86355b3f-48d9-4524-8b8f-7b0f134f830f");
  assert.equal(parsed.result, "GEMINI_LIVE_E2E_OK");
  assert.deepEqual(parsed.usage.models["gemini-3.1-pro-preview"].api, {
    totalRequests: 2,
    totalErrors: 0,
  });
});

test("parseGeminiResult: preserves stderr-only Gemini API failures as Gemini errors", () => {
  const parsed = parseGeminiResult("", `Error when talking to Gemini API
{
  "session_id": "78560fb1-770b-4755-94ba-58d990389f15",
  "error": {
    "message": "PERMISSION_DENIED",
    "code": 403
  }
}
`);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "gemini_stderr");
  assert.equal(parsed.error.includes("PERMISSION_DENIED"), true);
  assert.equal(parsed.raw, "");
});
