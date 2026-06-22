import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

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

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPidExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    await sleep(25);
  }
  return !pidExists(pid);
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
      "printf '%s\\n' \"$@\" > \"$RELAY_TEST_ARGS_OUT\"",
      "printf 'AGY_API_KEY=%s\\nAGY_COMPANION_SESSION_ID=%s\\nAGY_SOURCE_PACKET_MAX_BYTES=%s\\nAGY_BINARY=%s\\nGOOGLE_API_KEY=%s\\nRELAY_RUNTIME_DIR=%s\\nRELAY_TEST_KEEP=%s\\nPWD=%s\\n' \"${AGY_API_KEY:-}\" \"${AGY_COMPANION_SESSION_ID:-}\" \"${AGY_SOURCE_PACKET_MAX_BYTES:-}\" \"${AGY_BINARY:-}\" \"${GOOGLE_API_KEY:-}\" \"${RELAY_RUNTIME_DIR:-}\" \"${RELAY_TEST_KEEP:-}\" \"$PWD\" > \"$RELAY_TEST_ENV_OUT\"",
      "printf 'AGY review complete\\n'",
      "",
    ].join("\n"));

    const execution = await spawnAgy(REVIEW_PROFILE, {
      binary,
      cwd: dir,
      env: {
        ...process.env,
        RELAY_TEST_ARGS_OUT: argsPath,
        RELAY_TEST_ENV_OUT: envPath,
        AGY_API_KEY: "secret",
        AGY_COMPANION_SESSION_ID: "companion-session",
        AGY_SOURCE_PACKET_MAX_BYTES: "12345",
        AGY_BINARY: "/tmp/internal-agy",
        GOOGLE_API_KEY: "google-secret",
        RELAY_RUNTIME_DIR: "/should/not/leak",
        RELAY_TEST_KEEP: "keep-me",
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
      "AGY_COMPANION_SESSION_ID=",
      "AGY_SOURCE_PACKET_MAX_BYTES=",
      "AGY_BINARY=",
      "GOOGLE_API_KEY=",
      "RELAY_RUNTIME_DIR=",
      "RELAY_TEST_KEEP=keep-me",
      `PWD=${realpathSync.native(dir)}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnAgy: caps stdout capture, marks truncation, and terminates a runaway producer", async () => {
  const { spawnAgy } = await loadAgy();
  const dir = mkdtempSync(path.join(tmpdir(), "agy-stdout-cap-unit-"));
  try {
    const binary = writeExecutable(dir, "agy-noisy-stdout", [
      `#!${process.execPath}`,
      `process.stdout.write("o".repeat(256));`,
      `setInterval(() => {}, 1000);`,
      "",
    ].join("\n"));

    const execution = await spawnAgy(REVIEW_PROFILE, {
      binary,
      cwd: dir,
      env: { ...process.env, AGY_MAX_CAPTURE_BYTES: "64" },
      promptText: "source-bearing prompt",
      timeoutMs: 1000,
    });

    assert.equal(execution.timedOut, false, "stdout cap should terminate before the wall-clock timeout");
    assert.equal(execution.truncated?.stdout, true);
    assert.equal(execution.truncated?.stderr, false);
    assert.equal(execution.parsed.truncated?.stdout, true);
    assert.match(execution.stdout, /\[relay: AGY stdout truncated after 64 bytes\]/);
    assert.match(execution.parsed.result, /\[relay: AGY stdout truncated after 64 bytes\]/);
    assert.equal(execution.parsed.raw, execution.parsed.result);
    assert.ok(execution.stdout.length <= 160, `stdout should stay bounded, got ${execution.stdout.length}`);
    assert.ok(execution.parsed.result.length <= 160, `result should stay bounded, got ${execution.parsed.result.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnAgy: caps stderr capture and marks truncation", async () => {
  const { spawnAgy } = await loadAgy();
  const dir = mkdtempSync(path.join(tmpdir(), "agy-stderr-cap-unit-"));
  try {
    const binary = writeExecutable(dir, "agy-noisy-stderr", [
      `#!${process.execPath}`,
      `process.stderr.write("e".repeat(256));`,
      "",
    ].join("\n"));

    const execution = await spawnAgy(REVIEW_PROFILE, {
      binary,
      cwd: dir,
      env: { ...process.env, AGY_MAX_CAPTURE_BYTES: "64" },
      promptText: "source-bearing prompt",
      timeoutMs: 5000,
    });

    assert.equal(execution.truncated?.stdout, false);
    assert.equal(execution.truncated?.stderr, true);
    assert.equal(execution.parsed.truncated?.stderr, true);
    assert.match(execution.stderr, /\[relay: AGY stderr truncated after 64 bytes\]/);
    assert.match(execution.parsed.stderr, /\[relay: AGY stderr truncated after 64 bytes\]/);
    assert.ok(execution.stderr.length <= 160, `stderr should stay bounded, got ${execution.stderr.length}`);
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
      "printf 'spawned\\n' >> \"$RELAY_TEST_COUNT_OUT\"",
      "exec sleep 5",
      "",
    ].join("\n"));

    const execution = await spawnAgy(REVIEW_PROFILE, {
      binary,
      cwd: dir,
      env: { ...process.env, RELAY_TEST_COUNT_OUT: countPath },
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

test("spawnAgy: clears SIGKILL fallback when timeout child exits after SIGTERM", async () => {
  const { spawnAgy } = await loadAgy();
  const dir = mkdtempSync(path.join(tmpdir(), "agy-timeout-cleanup-unit-"));
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const fallbackTimers = [];
  const clearedFallbackTimers = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = realSetTimeout(callback, delay, ...args);
    if (delay === 2000) fallbackTimers.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (fallbackTimers.includes(handle)) clearedFallbackTimers.add(handle);
    return realClearTimeout(handle);
  };

  try {
    // A Node child that registers its SIGTERM handler synchronously as its first statement,
    // before any I/O. The previous /bin/sh child installed its trap AFTER a printf, so a
    // SIGTERM landing before the `trap` line was reached killed it on the default disposition
    // (no graceful exit) — a real race the 500ms budget only masked on a fast host (a 0ms
    // window mismatched 40/40). The handler is installed once the Node interpreter reaches
    // its first statement (~hundreds of ms cold start at worst); the 1000ms timeout budget
    // clears that by a wide margin (and stays distinct from the 2000ms SIGKILL-fallback delay
    // that the fallbackTimers assertion below keys on). Critically the residual is a LOUD
    // failure mode, never a
    // false pass: graceful exit is asserted parent-side via exitCode===0 && signal===null,
    // which neither a SIGKILL fallback (signal "SIGKILL") nor a default-disposition SIGTERM
    // kill (signal "SIGTERM") can ever satisfy — an over-budget cold start fails the test
    // visibly rather than passing it wrongly. No timing-dependent file side-channel remains.
    const binary = writeExecutable(dir, "agy-term-trap", [
      `#!${process.execPath}`,
      `process.on("SIGTERM", () => { process.exit(0); });`,
      `setInterval(() => {}, 1000);`,
      "",
    ].join("\n"));

    const execution = await spawnAgy(REVIEW_PROFILE, {
      binary,
      cwd: dir,
      env: process.env,
      promptText: "source-bearing prompt",
      timeoutMs: 1000,
    });

    assert.equal(execution.timedOut, true);
    // exitCode 0 + signal null proves the child caught SIGTERM and exited gracefully BEFORE
    // the 2000ms SIGKILL fallback fired (a SIGKILL would surface as signal "SIGKILL",
    // exitCode null). Deterministic — no dependence on signal-vs-handler-install timing.
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.signal, null);
    assert.equal(fallbackTimers.length, 1);
    assert.equal(clearedFallbackTimers.has(fallbackTimers[0]), true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    for (const handle of fallbackTimers) realClearTimeout(handle);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnAgy: timeout terminates the target process tree", async () => {
  const { spawnAgy } = await loadAgy();
  const dir = mkdtempSync(path.join(tmpdir(), "agy-timeout-tree-unit-"));
  const pidFile = path.join(dir, "grandchild.pid");
  let grandchildPid = null;
  try {
    const binary = writeExecutable(dir, "agy-grandchild", [
      `#!${process.execPath}`,
      `const { spawn } = require("node:child_process");`,
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const { writeFileSync } = require("node:fs"); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), "utf8"); setInterval(() => {}, 1000);`)}], { stdio: "ignore" });`,
      `console.log(child.pid);`,
      `setInterval(() => {}, 1000);`,
      "",
    ].join("\n"));

    const execution = await spawnAgy(REVIEW_PROFILE, {
      binary,
      cwd: dir,
      env: process.env,
      promptText: "source-bearing prompt",
      timeoutMs: 3000,
    });

    const pidText = existsSync(pidFile)
      ? readFileSync(pidFile, "utf8").trim()
      : execution.stdout.trim();
    assert.notEqual(
      pidText,
      "",
      `test setup did not establish the grandchild before AGY timeout; stdout=${JSON.stringify(execution.stdout)} pidFile=${pidFile}`,
    );
    grandchildPid = Number.parseInt(pidText, 10);
    assert.equal(Number.isInteger(grandchildPid), true, `expected numeric grandchild pid, got ${JSON.stringify(pidText)}`);
    assert.equal(execution.timedOut, true);
    assert.equal(await waitForPidExit(grandchildPid), true, `grandchild pid ${grandchildPid} survived timeout`);
  } finally {
    if (grandchildPid && pidExists(grandchildPid)) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch { /* cleanup best-effort */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
