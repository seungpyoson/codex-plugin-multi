import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGY_LIB = path.join(REPO_ROOT, "plugins/agy/scripts/lib/agy.mjs");

const REVIEW_PROFILE = Object.freeze({
  name: "review",
  sandbox: true,
  add_dir: true,
});

async function loadAgy() {
  assert.equal(existsSync(AGY_LIB), true, "AGY dispatcher implementation must exist");
  return import(pathToFileURL(AGY_LIB).href);
}

function writeExecutable(dir, name, source) {
  const bin = path.join(dir, name);
  writeFileSync(bin, source, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

test("buildAgyArgs: review uses print mode, timeout, sandbox, model, add-dir, and conversation id", async () => {
  const { buildAgyArgs } = await loadAgy();
  const args = buildAgyArgs(REVIEW_PROFILE, {
    model: "gemini-3.1-pro",
    promptText: "Review this diff",
    timeoutMs: 20000,
    includeDirPath: "/tmp/scoped-worktree",
    resumeId: "agy-conversation-123",
  });

  assert.deepEqual(args.slice(0, 2), ["--print-timeout", "20s"]);
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.1-pro");
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/scoped-worktree");
  assert.equal(args[args.indexOf("--conversation") + 1], "agy-conversation-123");
  assert.ok(args.includes("--sandbox"));
  assert.equal(args[args.indexOf("--print") + 1], "Review this diff");
  assert.equal(args.includes("Review this diff\nsource body"), false);
});

test("buildAgyArgs: source-free doctor can omit model and sandbox", async () => {
  const { buildAgyArgs } = await loadAgy();
  const args = buildAgyArgs({ name: "doctor", sandbox: false, add_dir: false }, {
    promptText: "Reply with ok",
    timeoutMs: 5000,
  });

  assert.deepEqual(args, ["--print-timeout", "5s", "--print", "Reply with ok"]);
});

test("parseAgyResult: treats plain stdout as review text and classifies failures", async () => {
  const { parseAgyResult } = await loadAgy();

  assert.deepEqual(parseAgyResult("Verdict: APPROVE\n", "warning: using default model\n"), {
    ok: true,
    result: "Verdict: APPROVE\n",
    sessionId: null,
    structured: null,
    denials: [],
    usage: null,
    costUsd: null,
    error: null,
    raw: "Verdict: APPROVE\n",
    stderr: "warning: using default model",
  });
  assert.equal(parseAgyResult("", "login required").reason, "not_authed");
  assert.equal(parseAgyResult("", "daily quota exceeded").reason, "usage_limited");
  assert.equal(parseAgyResult("", "", { timedOut: true }).reason, "timeout");
  assert.equal(parseAgyResult("", "").reason, "empty_stdout");
});

test("spawnAgy: delivers prompt via --print, sanitizes env, captures pid info, and does not retry", async () => {
  const { spawnAgy } = await loadAgy();
  const dir = mkdtempSync(path.join(tmpdir(), "agy-spawn-unit-"));
  try {
    const argsPath = path.join(dir, "args.txt");
    const envPath = path.join(dir, "env.txt");
    const binary = writeExecutable(dir, "agy-mock", [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$AGY_ARGS_OUT\"",
      "printf 'AGY_API_KEY=%s\\nGOOGLE_API_KEY=%s\\nRELAY_RUNTIME_DIR=%s\\nPWD=%s\\n' \"${AGY_API_KEY:-}\" \"${GOOGLE_API_KEY:-}\" \"${RELAY_RUNTIME_DIR:-}\" \"$PWD\" > \"$AGY_ENV_OUT\"",
      "printf 'AGY review complete\\n'",
      "",
    ].join("\n"));

    const execution = await spawnAgy(REVIEW_PROFILE, {
      binary,
      cwd: dir,
      env: {
        ...process.env,
        AGY_ARGS_OUT: argsPath,
        AGY_ENV_OUT: envPath,
        AGY_API_KEY: "secret",
        GOOGLE_API_KEY: "google-secret",
        RELAY_RUNTIME_DIR: "/should/not/leak",
      },
      model: "gemini-3.1-pro",
      promptText: "Review this selected source",
      timeoutMs: 5000,
    });

    assert.equal(execution.exitCode, 0);
    assert.equal(execution.parsed.ok, true);
    assert.equal(execution.parsed.result, "AGY review complete\n");
    assert.equal(Number.isInteger(execution.pidInfo.pid), true);
    assert.equal(execution.timedOut, false);
    assert.equal(execution.retryCount, 0);
    assert.deepEqual(readFileSync(argsPath, "utf8").trim().split("\n").slice(-2), [
      "--print",
      "Review this selected source",
    ]);
    assert.deepEqual(readFileSync(envPath, "utf8").trim().split("\n"), [
      "AGY_API_KEY=",
      "GOOGLE_API_KEY=",
      "RELAY_RUNTIME_DIR=",
      `PWD=${realpathSync.native(dir)}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnAgy: timeout is terminal and does not retry the source-bearing prompt", async () => {
  const { spawnAgy } = await loadAgy();
  const dir = mkdtempSync(path.join(tmpdir(), "agy-timeout-unit-"));
  try {
    const countPath = path.join(dir, "count.txt");
    const binary = writeExecutable(dir, "agy-slow", [
      "#!/bin/sh",
      "printf 'spawned\\n' >> \"$AGY_COUNT_OUT\"",
      "exec sleep 5",
      "",
    ].join("\n"));

    const execution = await spawnAgy(REVIEW_PROFILE, {
      binary,
      cwd: dir,
      env: { ...process.env, AGY_COUNT_OUT: countPath },
      promptText: "source-bearing prompt",
      timeoutMs: process.env.CODEX_PLUGIN_COVERAGE === "1" ? 2000 : 1000,
    });

    assert.equal(execution.timedOut, true);
    assert.equal(execution.parsed.reason, "timeout");
    assert.equal(execution.retryCount, 0);
    assert.equal(readFileSync(countPath, "utf8"), "spawned\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
