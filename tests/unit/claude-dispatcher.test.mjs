import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildClaudeArgs,
  parseClaudeResult,
  spawnClaude,
  _internal,
} from "../../plugins/claude/scripts/lib/claude.mjs";
import { resolveProfile } from "../../plugins/claude/scripts/lib/mode-profiles.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOCK = path.join(REPO_ROOT, "tests/smoke/claude-mock.mjs");

const UUID = "550e8400-e29b-41d4-a716-446655440000";

function writeExecutable(dir, name, source) {
  const bin = path.join(dir, name);
  writeFileSync(bin, source, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

test("buildClaudeArgs: review mode passes --disallowedTools + plan + setting-sources", () => {
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "hi",
    sessionId: UUID,
  });
  assert.ok(args.includes("--permission-mode"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(args.includes("--disallowedTools"));
  const disallowed = args[args.indexOf("--disallowedTools") + 1];
  for (const t of ["Write", "Edit", "Bash", "mcp__*", "Agent"]) {
    assert.ok(disallowed.includes(t), `expected "${t}" in disallowed list; got "${disallowed}"`);
  }
  assert.ok(args.includes("--setting-sources"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
});

test("buildClaudeArgs: rescue mode uses acceptEdits, no disallowedTools", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-opus-4-7",
    promptText: "fix it",
    sessionId: UUID,
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(!args.includes("--disallowedTools"));
});

test("buildClaudeArgs: adversarial-review mirrors review", () => {
  const args = buildClaudeArgs(resolveProfile("adversarial-review"), {
    model: "claude-sonnet-4-6",
    promptText: "challenge",
    sessionId: UUID,
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(args.includes("--disallowedTools"));
});

test("buildClaudeArgs: --json-schema passed for review when supplied", () => {
  const schema = '{"type":"object"}';
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001", promptText: "x",
    sessionId: UUID, jsonSchema: schema,
  });
  assert.ok(args.includes("--json-schema"));
  assert.equal(args[args.indexOf("--json-schema") + 1], schema);
});

test("buildClaudeArgs: --add-dir scoped to provided path", () => {
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001", promptText: "x",
    sessionId: UUID, addDirPath: "/tmp/some/dir",
  });
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/some/dir");
});

test("buildClaudeArgs: rescue profile omits --setting-sources (strip_context=false lives in the profile)", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-opus-4-7", promptText: "hi",
    sessionId: UUID,
  });
  assert.ok(!args.includes("--setting-sources"));
});

test("buildClaudeArgs: rejects non-UUIDv4 session IDs", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("review"), {
      model: "claude-haiku-4-5-20251001",
      promptText: "x", sessionId: "not-a-uuid",
    }),
    /UUID v4/
  );
});

test("buildClaudeArgs: resumeId emits --resume and omits --session-id", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "continue work", sessionId: UUID,
    resumeId: "11111111-2222-4333-8444-555555555555",
  });
  assert.ok(args.includes("--resume"));
  assert.ok(!args.includes("--session-id"));
  const idx = args.indexOf("--resume");
  assert.equal(args[idx + 1], "11111111-2222-4333-8444-555555555555");
});

test("buildClaudeArgs: rejects non-UUIDv4 resumeId", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("rescue"), {
      model: "claude-haiku-4-5-20251001",
      promptText: "x", sessionId: UUID, resumeId: "not-a-uuid",
    }),
    /resumeId must be UUID v4/
  );
});

test("resolveProfile: rejects unknown mode", () => {
  assert.throws(
    () => resolveProfile("chaos"),
    /unknown mode|unknown profile/i,
  );
});

test("buildClaudeArgs: rejects empty prompt", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("review"), {
      model: "claude-haiku-4-5-20251001",
      promptText: "", sessionId: UUID,
    }),
    /promptText is required/
  );
});

test("buildClaudeArgs: requires model (no alias fallback)", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("review"), {
      model: "", promptText: "x", sessionId: UUID,
    }),
    /model is required/
  );
});

test("buildClaudeArgs: rejects invalid profile shapes and ignores disabled optional inputs", () => {
  assert.throws(() => buildClaudeArgs(null, {}), /mode profile object/);
  assert.throws(
    () => buildClaudeArgs({ name: "bad" }, { promptText: "x", model: "m", sessionId: UUID }),
    /missing required field/,
  );

  const pingArgs = buildClaudeArgs(resolveProfile("ping"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "ping",
    sessionId: UUID,
    addDirPath: "/tmp/ignored",
    jsonSchema: '{"type":"object"}',
  });
  assert.ok(!pingArgs.includes("--add-dir"));
  assert.ok(!pingArgs.includes("--json-schema"));
});

test("buildClaudeArgs: ping can use the native CLI default model", () => {
  const args = buildClaudeArgs(resolveProfile("ping"), {
    model: null,
    promptText: "ping",
    sessionId: UUID,
  });

  assert.equal(args.includes("--model"), false);
});

test("parseClaudeResult: empty stdout returns error", () => {
  const r = parseClaudeResult("");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_stdout");
});

test("parseClaudeResult: malformed JSON returns error", () => {
  const r = parseClaudeResult("not json");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "json_parse_error");
});

test("parseClaudeResult: prefers structured_output when present", () => {
  const payload = JSON.stringify({
    type: "result", is_error: false,
    result: "",
    structured_output: { verdict: "approve", summary: "ok", findings: [] },
    session_id: UUID,
    permission_denials: [],
  });
  const r = parseClaudeResult(payload);
  assert.equal(r.ok, true);
  assert.deepEqual(r.structured, { verdict: "approve", summary: "ok", findings: [] });
});

test("parseClaudeResult: surfaces permission_denials", () => {
  const payload = JSON.stringify({
    type: "result", is_error: false,
    result: "refused",
    session_id: UUID,
    permission_denials: [{ tool: "Bash", reason: "blocked" }],
  });
  const r = parseClaudeResult(payload);
  assert.equal(r.denials.length, 1);
  assert.equal(r.denials[0].tool, "Bash");
});

test("parseClaudeResult: covers non-string result, newline JSON, and optional metadata defaults", () => {
  const r = parseClaudeResult([
    "debug line",
    JSON.stringify({
      type: "result",
      is_error: true,
      result: { not: "text" },
      session_id: null,
      permission_denials: "not-array",
      apiKeySource: "oauth",
      usage: { input_tokens: 1 },
      total_cost_usd: 0.25,
    }),
  ].join("\n"));

  assert.equal(r.ok, false);
  assert.equal(r.result, null);
  assert.deepEqual(r.denials, []);
  assert.equal(r.apiKeySource, "oauth");
  assert.deepEqual(r.usage, { input_tokens: 1 });
  assert.equal(r.costUsd, 0.25);
});

test("spawnClaude: returns claudeSessionId from stdout and pidInfo tuple", async () => {
  const result = await spawnClaude(resolveProfile("rescue"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "hello",
    sessionId: UUID,
    binary: MOCK,
  });
  assert.equal(result.exitCode, 0, `mock exited ${result.exitCode}: ${result.stderr}`);
  // Claude echoes back --session-id as session_id; mock does the same.
  assert.equal(result.claudeSessionId, UUID,
    "claudeSessionId must come from parsed.session_id, not what we sent");
  // sessionIdSent preserves what we passed (legacy name was `sessionId`).
  assert.equal(result.sessionIdSent, UUID);
  // pidInfo tuple captured at spawn.
  assert.ok(result.pidInfo, "pidInfo must be present");
  assert.equal(typeof result.pidInfo.pid, "number");
  // pidInfo.starttime / argv0 may be null if the child exited too fast to
  // capture (normal for this tiny mock) — we accept a `capture_error` record
  // but the pid itself is always present.
  assert.ok(
    "starttime" in result.pidInfo && "argv0" in result.pidInfo,
    "pidInfo always has starttime/argv0 keys (may be null)"
  );
});

test("spawnClaude: onSpawn fires asynchronously via 'spawn' event, not synchronously (issue #25)", async () => {
  // Regression for the argv0_mismatch flake: capturePidInfo must run
  // AFTER the child's execve completes, otherwise /proc/<pid>/cmdline
  // (Linux) or `ps -o comm=` (Darwin) may still reflect the parent's
  // argv. onSpawn MUST NOT fire during the synchronous executor turn
  // that calls spawn(), and attachPidCapture adds a short post-spawn
  // delay so shebang wrappers can exec the real target.
  let onSpawnFired = false;
  const promise = spawnClaude(resolveProfile("rescue"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "hello",
    sessionId: UUID,
    binary: MOCK,
    onSpawn: () => { onSpawnFired = true; },
  });
  // Synchronous check: spawnClaude returned a Promise; if onSpawn fired
  // here, capture happened pre-execve (the bug).
  assert.equal(onSpawnFired, false,
    "onSpawn fired synchronously — capturePidInfo will read pre-execve cmdline (issue #25)");
  const result = await promise;
  // Once the spawn settles, onSpawn must have fired.
  assert.equal(onSpawnFired, true, "onSpawn must fire by the time spawnClaude resolves");
  assert.ok(result.pidInfo, "pidInfo must be present after a successful spawn");
});

test("spawnClaude: strips provider creds and routing env before launching target CLI", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-env-sanitize-unit-"));
  try {
    const bin = writeExecutable(dir, "claude-env-check.mjs", `#!/usr/bin/env node
const forbidden = [
  // *_API_KEY suffix
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  // ANTHROPIC_* prefix
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  // CLAUDE_CODE_USE_* prefix
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // OPENAI_* prefix
  "OPENAI_BASE_URL",
  "OPENAI_PROJECT",
  "OPENAI_ORG_ID",
  // AWS_* prefix
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  // AZURE_* prefix
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  // VERTEX_* prefix
  "VERTEX_PROJECT",
  "VERTEX_LOCATION",
  // GOOGLE_CLOUD_* prefix and explicit Google selectors
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "CLOUD_ML_REGION",
  // Router / proxy ecosystems (#16 follow-up 7)
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "OLLAMA_HOST",
  "OLLAMA_BASE_URL",
];
const leaked = forbidden.filter((key) => process.env[key]);
if (leaked.length > 0) {
  process.stderr.write("leaked env: " + leaked.join(",") + "\\n");
  process.exit(42);
}
if (process.env.CLAUDE_CONFIG_DIR !== "kept-config") {
  process.stderr.write("missing kept oauth/config env\\n");
  process.exit(43);
}
if (process.env.HTTPS_PROXY !== "http://corp-proxy.invalid:3128" || process.env.NO_PROXY !== "localhost,.internal") {
  process.stderr.write("proxy env must pass through unchanged\\n");
  process.exit(45);
}
if (process.env.PATH !== ${JSON.stringify(process.env.PATH ?? "")} || process.env.HOME !== ${JSON.stringify(process.env.HOME ?? "")}) {
  process.stderr.write("PATH/HOME must pass through unchanged\\n");
  process.exit(44);
}
const sessionIdx = process.argv.indexOf("--session-id");
const sessionId = sessionIdx >= 0 ? process.argv[sessionIdx + 1] : null;
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: sessionId }) + "\\n");
`);
    const result = await spawnClaude(resolveProfile("rescue"), {
      model: "claude-haiku-4-5-20251001",
      promptText: "hello",
      sessionId: UUID,
      binary: bin,
      env: {
        // Pass-through environment (must remain visible).
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLAUDE_CONFIG_DIR: "kept-config",
        // *_API_KEY suffix.
        ANTHROPIC_API_KEY: "must-not-leak",
        CLAUDE_API_KEY: "must-not-leak",
        OPENAI_API_KEY: "must-not-leak",
        GEMINI_API_KEY: "must-not-leak",
        GOOGLE_API_KEY: "must-not-leak",
        // ANTHROPIC_* prefix.
        ANTHROPIC_AUTH_TOKEN: "must-not-leak",
        ANTHROPIC_BASE_URL: "https://example.invalid",
        ANTHROPIC_API_URL: "https://example.invalid",
        ANTHROPIC_VERTEX_PROJECT_ID: "must-not-leak",
        // CLAUDE_CODE_USE_* prefix.
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        // OPENAI_* prefix.
        OPENAI_BASE_URL: "https://example.invalid",
        OPENAI_PROJECT: "must-not-leak",
        OPENAI_ORG_ID: "must-not-leak",
        // AWS_* prefix.
        AWS_ACCESS_KEY_ID: "must-not-leak",
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
        AWS_SESSION_TOKEN: "must-not-leak",
        AWS_PROFILE: "must-not-leak",
        AWS_REGION: "us-east-1",
        // AZURE_* prefix.
        AZURE_CLIENT_SECRET: "must-not-leak",
        AZURE_TENANT_ID: "must-not-leak",
        AZURE_CLIENT_ID: "must-not-leak",
        // VERTEX_* prefix.
        VERTEX_PROJECT: "must-not-leak",
        VERTEX_LOCATION: "us-central1",
        // GOOGLE_CLOUD_* prefix and explicit Google selectors.
        GOOGLE_CLOUD_PROJECT: "must-not-leak",
        GOOGLE_CLOUD_REGION: "us-central1",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/must-not-leak.json",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        CLOUD_ML_REGION: "us-central1",
        // LITELLM_* / OLLAMA_* router prefixes — must be stripped (#16 follow-up 7).
        LITELLM_BASE_URL: "https://router.invalid",
        LITELLM_API_KEY: "must-not-leak",
        OLLAMA_HOST: "router.invalid",
        OLLAMA_BASE_URL: "http://router.invalid",
        // Proxy vars are intentionally NOT scrubbed — corporate networks use
        // these to reach the public internet at all (#16 follow-up 7).
        HTTPS_PROXY: "http://corp-proxy.invalid:3128",
        NO_PROXY: "localhost,.internal",
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.parsed.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnClaude: opt-in strict mode strips proxy env", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-proxy-strip-unit-"));
  try {
    const bin = writeExecutable(dir, "claude-proxy-check.mjs", `#!/usr/bin/env node
const forbidden = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "Http_Proxy", "CODEX_PLUGIN_STRIP_PROXY_ENV"
];
const leaked = forbidden.filter((key) => process.env[key]);
if (leaked.length > 0) {
  process.stderr.write("leaked proxy/control env: " + leaked.join(",") + "\\n");
  process.exit(45);
}
const sessionIdx = process.argv.indexOf("--session-id");
const sessionId = sessionIdx >= 0 ? process.argv[sessionIdx + 1] : null;
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: sessionId }) + "\\n");
`);
    const result = await spawnClaude(resolveProfile("rescue"), {
      model: "claude-haiku-4-5-20251001",
      promptText: "hello",
      sessionId: UUID,
      binary: bin,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CODEX_PLUGIN_STRIP_PROXY_ENV: "1",
        HTTP_PROXY: "http://corp-proxy.invalid:3128",
        HTTPS_PROXY: "http://corp-proxy.invalid:3128",
        NO_PROXY: "localhost,.internal",
        ALL_PROXY: "socks://corp-proxy.invalid:1080",
        http_proxy: "http://lower-proxy.invalid:3128",
        https_proxy: "http://lower-proxy.invalid:3128",
        no_proxy: "localhost,.lower",
        all_proxy: "socks://lower-proxy.invalid:1080",
        Http_Proxy: "http://mixed-proxy.invalid:3128",
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.parsed.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnClaude: timeout escalation timer does not keep the parent process alive", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-timeout-unref-unit-"));
  try {
    const hangBin = writeExecutable(dir, "claude-hang.mjs", `#!/usr/bin/env node
setTimeout(() => {}, 10000);
`);
    const runner = path.join(dir, "runner.mjs");
    const claudeLib = pathToFileURL(path.join(REPO_ROOT, "plugins/claude/scripts/lib/claude.mjs")).href;
    const profileLib = pathToFileURL(path.join(REPO_ROOT, "plugins/claude/scripts/lib/mode-profiles.mjs")).href;
    writeFileSync(runner, `import { spawnClaude } from ${JSON.stringify(claudeLib)};
import { resolveProfile } from ${JSON.stringify(profileLib)};
const result = await spawnClaude(resolveProfile("rescue"), {
  model: "claude-haiku-4-5-20251001",
  promptText: "timeout",
  sessionId: ${JSON.stringify(UUID)},
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
    assert.ok(elapsed < 1000, `runner took ${elapsed}ms after spawnClaude timeout`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("_internal.isUuidV4: accepts/rejects expected cases", () => {
  assert.equal(_internal.isUuidV4(UUID), true);
  assert.equal(_internal.isUuidV4("not-a-uuid"), false);
  // v1 UUID (time-based) should be rejected — Claude requires v4.
  assert.equal(_internal.isUuidV4("550e8400-e29b-11d4-a716-446655440000"), false);
});
