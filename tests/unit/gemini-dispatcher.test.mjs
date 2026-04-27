import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { resolveProfile } from "../../plugins/gemini/scripts/lib/mode-profiles.mjs";
import { buildGeminiArgs, parseGeminiResult, spawnGemini } from "../../plugins/gemini/scripts/lib/gemini.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = path.join(REPO_ROOT, "plugins/gemini/policies/read-only.toml");

function writeExecutable(dir, name, source) {
  const bin = path.join(dir, name);
  writeFileSync(bin, source, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

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

test("buildGeminiArgs: rejects invalid profile and missing read-only inputs", () => {
  assert.throws(() => buildGeminiArgs(null, {}), /profile object/);
  assert.throws(() => buildGeminiArgs({ name: "review" }, {}), /missing required field/);
  assert.throws(() => buildGeminiArgs(resolveProfile("review"), { policyPath: POLICY }), /model is required/);
  assert.throws(
    () => buildGeminiArgs(resolveProfile("review"), { model: "gemini-3-flash-preview" }),
    /policyPath is required/,
  );
});

test("buildGeminiArgs: omits include dir when profile disables add_dir", () => {
  const args = buildGeminiArgs(resolveProfile("ping"), {
    model: "gemini-3-flash-preview",
    policyPath: POLICY,
    includeDirPath: "/tmp/ignored",
  });

  assert.equal(args.includes("--include-directories"), false);
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

test("parseGeminiResult: covers empty, malformed, and newline-delimited JSON outputs", () => {
  assert.deepEqual(parseGeminiResult(""), { ok: false, reason: "empty_stdout", raw: "" });

  const malformed = parseGeminiResult("{not-json");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "json_parse_error");
  assert.equal(malformed.raw, "{not-json");

  const parsed = parseGeminiResult(`noise line
{"session_id":"abc","result":"fallback result","permission_denials":["Write"],"total_cost_usd":1.25,"structured_output":{"ok":true}}
`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, "abc");
  assert.equal(parsed.result, "fallback result");
  assert.deepEqual(parsed.denials, ["Write"]);
  assert.equal(parsed.costUsd, 1.25);
  assert.deepEqual(parsed.structured, { ok: true });
});

test("parseGeminiResult: summarizes long stderr and object/string error payloads", () => {
  const longError = parseGeminiResult("", "x".repeat(4100));
  assert.equal(longError.ok, false);
  assert.equal(longError.error.length, 4003);
  assert.equal(longError.error.endsWith("..."), true);

  const stringError = parseGeminiResult(JSON.stringify({ error: "plain error" }));
  assert.equal(stringError.ok, false);
  assert.equal(stringError.error, "plain error");

  const objectError = parseGeminiResult(JSON.stringify({ error: { code: 403, message: "denied" } }));
  assert.equal(objectError.ok, false);
  assert.equal(objectError.error, '{"code":403,"message":"denied"}');
});

test("spawnGemini: sends prompt over stdin, captures pidInfo, and reports parsed result", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gemini-spawn-unit-"));
  try {
    const bin = writeExecutable(dir, "gemini-ok.mjs", `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  process.stdout.write(JSON.stringify({
    session_id: "22222222-3333-4444-9555-666666666666",
    response: prompt,
    stats: { tokens: { total: 3 } }
  }) + "\\n");
});
`);
    let spawnedPidInfo = null;
    const execution = await spawnGemini(resolveProfile("rescue"), {
      model: "gemini-3-flash-preview",
      promptText: "hello from stdin",
      includeDirPath: dir,
      cwd: dir,
      binary: bin,
      onSpawn: (pidInfo) => { spawnedPidInfo = pidInfo; },
    });

    assert.equal(execution.exitCode, 0);
    assert.equal(execution.parsed.ok, true);
    assert.equal(execution.geminiSessionId, "22222222-3333-4444-9555-666666666666");
    assert.equal(execution.parsed.result, "hello from stdin");
    assert.equal(Number.isInteger(execution.pidInfo.pid), true);
    assert.equal(spawnedPidInfo.pid, execution.pidInfo.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnGemini: callback failures and process failures stay explicit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gemini-spawn-failure-unit-"));
  try {
    const okBin = writeExecutable(dir, "gemini-ok.mjs", `#!/usr/bin/env node
process.stdin.resume();
process.stdout.write(JSON.stringify({ session_id: "22222222-3333-4444-9555-666666666666", response: "ok" }) + "\\n");
`);
    const callbackResult = await spawnGemini(resolveProfile("rescue"), {
      model: "gemini-3-flash-preview",
      promptText: "callback throws",
      cwd: dir,
      binary: okBin,
      onSpawn: () => { throw new Error("boom"); },
    });
    assert.equal(callbackResult.parsed.ok, true);
    assert.equal(callbackResult.parsed.result, "ok");

    const hangBin = writeExecutable(dir, "gemini-hang.mjs", `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {}, 10000);
`);
    const timedOut = await spawnGemini(resolveProfile("rescue"), {
      model: "gemini-3-flash-preview",
      promptText: "timeout",
      cwd: dir,
      binary: hangBin,
      timeoutMs: 20,
    });
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.parsed.ok, false);

    await assert.rejects(
      () => spawnGemini(resolveProfile("rescue"), {
        model: "gemini-3-flash-preview",
        promptText: "missing binary",
        cwd: dir,
        binary: path.join(dir, "missing-gemini"),
      }),
      /spawn .* failed/,
    );
    await assert.rejects(
      () => spawnGemini(resolveProfile("rescue"), {
        model: "gemini-3-flash-preview",
        promptText: "",
        cwd: dir,
        binary: okBin,
      }),
      /promptText is required/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnGemini: timeout escalation timer does not keep the parent process alive", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gemini-timeout-unref-unit-"));
  try {
    const hangBin = writeExecutable(dir, "gemini-hang.mjs", `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {}, 10000);
`);
    const runner = path.join(dir, "runner.mjs");
    const geminiLib = pathToFileURL(path.join(REPO_ROOT, "plugins/gemini/scripts/lib/gemini.mjs")).href;
    const profileLib = pathToFileURL(path.join(REPO_ROOT, "plugins/gemini/scripts/lib/mode-profiles.mjs")).href;
    writeFileSync(runner, `import { spawnGemini } from ${JSON.stringify(geminiLib)};
import { resolveProfile } from ${JSON.stringify(profileLib)};
const result = await spawnGemini(resolveProfile("rescue"), {
  model: "gemini-3-flash-preview",
  promptText: "timeout",
  cwd: ${JSON.stringify(dir)},
  binary: ${JSON.stringify(hangBin)},
  timeoutMs: 20,
});
if (!result.timedOut) process.exit(2);
`);

    const started = Date.now();
    const result = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 1200 });
    const elapsed = Date.now() - started;

    assert.notEqual(result.error?.code, "ETIMEDOUT",
      `runner stayed alive ${elapsed}ms; stderr=${result.stderr}`);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.ok(elapsed < 1000, `runner took ${elapsed}ms after spawnGemini timeout`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
