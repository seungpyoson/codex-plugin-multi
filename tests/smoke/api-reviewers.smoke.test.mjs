import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/api-reviewers/scripts/api-reviewer.mjs");
const API_REVIEWER_EXPECTED_KEYS = Object.freeze([
  "id",
  "job_id",
  "target",
  "provider",
  "parent_job_id",
  "claude_session_id",
  "gemini_session_id",
  "kimi_session_id",
  "resume_chain",
  "pid_info",
  "mode",
  "mode_profile_name",
  "model",
  "cwd",
  "workspace_root",
  "containment",
  "scope",
  "dispose_effective",
  "scope_base",
  "scope_paths",
  "prompt_head",
  "schema_spec",
  "binary",
  "status",
  "started_at",
  "ended_at",
  "exit_code",
  "error_code",
  "error_message",
  "error_summary",
  "error_cause",
  "suggested_action",
  "external_review",
  "disclosure_note",
  "result",
  "structured_output",
  "permission_denials",
  "mutations",
  "cost_usd",
  "usage",
  "auth_mode",
  "credential_ref",
  "endpoint",
  "http_status",
  "raw_model",
  "schema_version",
]);

function run(args, { cwd = REPO_ROOT, env = {}, companion = COMPANION } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [companion, ...args], {
      cwd,
      env: { ...process.env, ...env },
      timeout: 10000,
    }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, status: error?.code ?? 0 });
    });
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function mockResponse(model, id = "chatcmpl-test", content = `Verdict: APPROVE\nProvider model: ${model}`) {
  return JSON.stringify({
    id,
    object: "chat.completion",
    model,
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content,
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function assertDirectApiNotSent(record, displayName) {
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(
    record.external_review.disclosure,
    `Selected source content was not sent to ${displayName} through direct API auth.`,
  );
  assert.equal(record.disclosure_note, record.external_review.disclosure);
}

function makeWorkspace() {
  const cwd = mkdtempSync(path.join(tmpdir(), "api-reviewers-smoke-"));
  writeFileSync(path.join(cwd, "seed.txt"), "hello from selected scope\n");
  return cwd;
}

function makeInstalledApiReviewersRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "api-reviewers-installed-"));
  const pluginRoot = path.join(root, "api-reviewers", "0.1.0");
  mkdirSync(path.dirname(pluginRoot), { recursive: true });
  cpSync(path.join(REPO_ROOT, "plugins", "api-reviewers"), pluginRoot, { recursive: true });
  return pluginRoot;
}

function writeDeepSeekProviderConfig(pluginRoot, baseUrl) {
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), JSON.stringify({
    deepseek: {
      display_name: "DeepSeek",
      auth_mode: "api_key",
      env_keys: ["DEEPSEEK_API_KEY"],
      base_url: baseUrl,
      model: "deepseek-v4-flash",
    },
  }, null, 2));
}

function startChatServer(handler) {
  const server = createServer((req, res) => {
    if (req.url === "/chat/completions") {
      return handler(req, res);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function startHangingChatServer() {
  return startChatServer((req) => {
    req.resume();
  });
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeBranchDiffWorkspace() {
  const cwd = makeWorkspace();
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  git(cwd, ["add", "seed.txt"]);
  git(cwd, ["commit", "-m", "seed"]);
  git(cwd, ["checkout", "-b", "feature"]);
  writeFileSync(path.join(cwd, "feature.txt"), "committed feature change\n");
  git(cwd, ["add", "feature.txt"]);
  git(cwd, ["commit", "-m", "feature"]);
  return cwd;
}

test("doctor reports DeepSeek API-key readiness by key name only", async () => {
  const result = await run(["doctor", "--provider", "deepseek"], {
    env: { DEEPSEEK_API_KEY: "secret-test-value" },
  });
  assert.equal(result.status, 0);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.provider, "deepseek");
  assert.equal(parsed.ready, true);
  assert.equal(parsed.credential_ref, "DEEPSEEK_API_KEY");
  assert.equal(parsed.auth_mode, "api_key");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("doctor reports GLM compatibility alias without leaking value", async () => {
  const result = await run(["doctor", "--provider", "glm"], {
    env: { ZAI_API_KEY: "", ZAI_GLM_API_KEY: "secret-test-value" },
  });
  assert.equal(result.status, 0);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.provider, "glm");
  assert.equal(parsed.ready, true);
  assert.equal(parsed.credential_ref, "ZAI_GLM_API_KEY");
  assert.equal(parsed.endpoint, "https://api.z.ai/api/coding/paas/v4");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("doctor malformed providers config returns structured diagnostic", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), "{not json\n");
  const result = await run(["doctor", "--provider", "glm"], {
    companion,
    env: { ZAI_API_KEY: "secret-test-value" },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.provider, "glm");
  assert.equal(parsed.status, "config_error");
  assert.equal(parsed.ready, false);
  assert.match(parsed.error_message, /providers config unreadable/);
  assert.match(parsed.next_action, /providers\.json/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
  assert.doesNotMatch(result.stdout, /^\{\s*"ok": false,\s*"error"/m);
});

test("help malformed providers config returns structured diagnostic", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), "{not json\n");
  const result = await run(["help"], {
    companion,
    env: { DEEPSEEK_API_KEY: "secret-test-value" },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "config_error");
  assert.deepEqual(parsed.commands, ["doctor", "ping", "run"]);
  assert.deepEqual(parsed.providers, []);
  assert.match(parsed.error_message, /providers config unreadable/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
  assert.doesNotMatch(result.stdout, /^\{\s*"ok": false,\s*"error"/m);
});

test("high-capability provider defaults preserve large review output budgets", () => {
  const providers = parseJson(
    execFileSync(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(require(process.argv[1])))",
      path.join(REPO_ROOT, "plugins/api-reviewers/config/providers.json"),
    ], { encoding: "utf8" })
  );

  assert.equal(providers.deepseek.model, "deepseek-v4-pro");
  assert.equal(providers.deepseek.request_defaults.thinking.type, "enabled");
  assert.equal(providers.deepseek.request_defaults.reasoning_effort, "max");
  assert.ok(providers.deepseek.request_defaults.max_tokens >= 65536);
  assert.equal(providers.glm.request_defaults.thinking.type, "enabled");
  assert.ok(providers.glm.request_defaults.max_tokens >= 131072);
});

test("API_REVIEWERS_MAX_TOKENS overrides provider request defaults", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "glm",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MAX_TOKENS: "2048",
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1"),
      API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY: JSON.stringify({
        max_tokens: 2048,
        thinking: { type: "enabled" },
      }),
      ZAI_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.provider, "glm");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("mock request-body assertion failures are marked not sent", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "glm",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1"),
      API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY: JSON.stringify({
        model: "wrong-model",
      }),
      ZAI_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.provider, "glm");
  assert.equal(record.error_code, "mock_assertion_failed");
  assert.match(record.error_message, /request body field model expected/);
  assertDirectApiNotSent(record, "GLM");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

for (const value of ["abc", "Infinity", "1.5", "0", "-1", "9007199254740992"]) {
  test(`API_REVIEWERS_MAX_TOKENS rejects invalid override ${value}`, async () => {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
    const result = await run([
      "run",
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MAX_TOKENS: value,
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1"),
        API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY: JSON.stringify({
          max_tokens: Number(value),
        }),
        ZAI_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.provider, "glm");
    assert.equal(record.error_code, "bad_args");
    assert.match(record.error_message, /API_REVIEWERS_MAX_TOKENS must be a positive integer number of tokens/);
    assertDirectApiNotSent(record, "GLM");
    assert.doesNotMatch(record.error_message, /mock_assertion_failed/);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  });
}

for (const value of ["abc", "Infinity", "1.5", "0", "-1", "9007199254740992"]) {
  test(`API_REVIEWERS_TIMEOUT_MS rejects invalid override ${value}`, async () => {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
    const result = await run([
      "run",
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_TIMEOUT_MS: value,
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1"),
        ZAI_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.provider, "glm");
    assert.equal(record.error_code, "bad_args");
    assert.match(record.error_message, /API_REVIEWERS_TIMEOUT_MS must be a positive integer number of milliseconds/);
    assertDirectApiNotSent(record, "GLM");
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  });
}

for (const scenario of [
  {
    name: "missing provider",
    args: ["run", "--mode", "review", "--foreground", "--prompt", "Check this."],
    provider: "api-reviewers",
    message: /--provider is required/,
  },
  {
    name: "unknown provider",
    args: ["run", "--provider", "missing-provider", "--mode", "review", "--foreground", "--prompt", "Check this."],
    provider: "missing-provider",
    message: /unknown_provider:missing-provider/,
  },
  {
    name: "invalid mode",
    args: ["run", "--provider", "glm", "--mode", "rescue", "--foreground", "--prompt", "Check this."],
    provider: "glm",
    message: /unsupported --mode rescue/,
  },
]) {
  test(`run ${scenario.name} returns structured JobRecord`, async () => {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
    const result = await run(scenario.args, {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        ZAI_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.provider, scenario.provider);
    assert.equal(record.error_code, "bad_args");
    assert.match(record.error_message, scenario.message);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  });
}

test("run malformed providers config returns structured JobRecord", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), "{not json\n");
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "glm",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    companion,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      ZAI_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.provider, "glm");
  assert.equal(record.error_code, "config_error");
  assert.equal(record.error_cause, "provider_config");
  assert.match(record.suggested_action, /providers\.json/);
  assert.match(record.error_message, /providers config unreadable/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
  assert.doesNotMatch(result.stdout, /^\{\s*"ok": false/m);
});

test("branch-diff git revision failure returns stderr in structured JobRecord", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "review",
    "--scope-base", "missing-base",
    "--foreground",
    "--prompt", "Check this branch.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /git_failed:/);
  assert.match(record.error_message, /missing-base/);
  assert.doesNotMatch(record.error_message, /scope_empty/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("branch-diff git revision failure redacts API key values from stderr", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "review",
    "--scope-base", "secret-test-value",
    "--foreground",
    "--prompt", "Check this branch.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /git_failed:/);
  assert.match(record.error_message, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("provider request defaults cannot override canonical request fields", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const providersPath = path.join(pluginRoot, "config", "providers.json");
  const providers = parseJson(execFileSync(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(require(process.argv[1])))",
    path.join(REPO_ROOT, "plugins/api-reviewers/config/providers.json"),
  ], { encoding: "utf8" }));
  providers.glm.request_defaults.model = "attacker-model";
  writeFileSync(providersPath, `${JSON.stringify(providers, null, 2)}\n`);

  const result = await run([
    "run",
    "--provider", "glm",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1"),
      ZAI_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "bad_args");
  assert.match(record.error_message, /disallowed_request_default:model/);
  assertDirectApiNotSent(record, "GLM");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("persist failure still prints structured JobRecord", async () => {
  const cwd = makeWorkspace();
  const dataRoot = path.join(tmpdir(), `api-reviewers-data-file-${Date.now()}-${process.pid}-secret-test-value`);
  writeFileSync(dataRoot, "not a directory\n");
  const result = await run([
    "run",
    "--provider", "glm",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataRoot,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1"),
      ZAI_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.provider, "glm");
  assert.match(record.disclosure_note, /JobRecord persistence failed:/);
  assert.match(record.disclosure_note, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

for (const scenario of [
  {
    provider: "deepseek",
    env: { DEEPSEEK_API_KEY: "secret-test-value" },
    credentialRef: "DEEPSEEK_API_KEY",
    endpoint: "https://api.deepseek.com",
  },
  {
    provider: "glm",
    env: { ZAI_API_KEY: "secret-test-value", ZAI_GLM_API_KEY: "" },
    credentialRef: "ZAI_API_KEY",
    endpoint: "https://api.z.ai/api/coding/paas/v4",
  },
]) {
  test(`installed api-reviewers package layout is self-contained for ${scenario.provider} doctor`, async () => {
    const pluginRoot = makeInstalledApiReviewersRoot();
    const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
    const result = await run(["doctor", "--provider", scenario.provider], {
      companion,
      env: scenario.env,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.provider, scenario.provider);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.credential_ref, scenario.credentialRef);
    assert.equal(parsed.endpoint, scenario.endpoint);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  });
}

test("installed api-reviewers package layout is self-contained for branch-diff run", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "glm",
    "--mode", "review",
    "--scope-base", "main",
    "--prompt", "review installed package branch diff",
  ], {
    cwd,
    companion,
    env: {
      ZAI_API_KEY: "secret-test-value",
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "feature.txt",
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      GIT_DIR: path.join(cwd, ".git", "missing"),
      GIT_CONFIG_GLOBAL: path.join(cwd, "evil.gitconfig"),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.status, "completed");
  assert.deepEqual(parsed.scope_paths, ["feature.txt"]);
  assert.equal(parsed.credential_ref, "ZAI_API_KEY");
  assert.match(parsed.result, /Provider model: glm-5\.1/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("DeepSeek direct API custom-review completes and persists JobRecord", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "Live verification context",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.deepEqual(Object.keys(record), [...API_REVIEWER_EXPECTED_KEYS]);
  assert.equal(record.status, "completed");
  assert.equal(record.provider, "deepseek");
  assert.equal(record.model, "deepseek-v4-pro");
  assert.equal(record.credential_ref, "DEEPSEEK_API_KEY");
  assert.equal(record.schema_version, 9);
  assert.equal(record.kimi_session_id, null);
  assert.deepEqual(record.external_review, {
    marker: "EXTERNAL REVIEW",
    provider: "DeepSeek",
    run_kind: "foreground",
    job_id: record.job_id,
    session_id: "chatcmpl-test",
    parent_job_id: null,
    mode: "custom-review",
    scope: "custom",
    scope_base: null,
    scope_paths: ["seed.txt"],
    source_content_transmission: "sent",
    disclosure: "Selected source content was sent to DeepSeek through direct API auth.",
  });
  assert.equal(record.result.includes("Verdict: APPROVE"), true);
  assert.deepEqual(record.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API provider session_id accepts safe provider ID shapes", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  for (const id of [
    "chatcmpl-AbC123",
    "req_01AbC.dEf/G+h=",
    "arn:aws:bedrock:us-west-2:123456789012:inference-profile/example",
    "x".repeat(200),
  ]) {
    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash", id),
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.external_review.session_id, id);
  }
});

test("direct API reviewers reject selected files with no content before provider execution", async () => {
  const cwd = makeWorkspace();
  writeFileSync(path.join(cwd, "empty.txt"), "");
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "empty.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assertDirectApiNotSent(record, "DeepSeek");
});

test("direct API reviewers redact provider results before printing or persisting records", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash", "chatcmpl-test", "Echoed secret-test-value in provider output"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.result, "Echoed [REDACTED] in provider output");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API provider session_id rejects unsafe values", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  for (const id of ["bad\nid", "x".repeat(201), "<script>", "<script>alert(1)</script>", "abc\u202edef"]) {
    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash", id),
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.session_id, null);
    assert.doesNotMatch(result.stdout, /bad\\nid|<script>/);
  }
});

test("direct API timeout marks selected content as sent", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startHangingChatServer();
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);

    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_TIMEOUT_MS: "20",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    assert.notEqual(result.stdout, "", result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "timeout");
    assert.match(record.suggested_action, /timeout/i);
    assert.match(record.suggested_action, /API_REVIEWERS_TIMEOUT_MS/);
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.external_review.disclosure,
      "Selected source content was sent to DeepSeek through direct API auth, but the provider did not return a clean result.");
  } finally {
    server.close();
  }
});

test("direct API HTTP failures mark selected content as sent", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "rate_limited");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.external_review.disclosure,
      "Selected source content was sent to DeepSeek through direct API auth, but the provider did not return a clean result.");
  } finally {
    server.close();
  }
});

test("direct API provider_unavailable under Codex recommends sandbox network access", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  writeDeepSeekProviderConfig(pluginRoot, "http://127.0.0.1:9");

  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      CODEX_SANDBOX: "seatbelt",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.error_code, "provider_unavailable");
  assert.match(record.suggested_action, /network_access = true/);
  assert.match(record.suggested_action, /outside sandbox/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API provider_unavailable ignores false-like Codex sandbox values", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  writeDeepSeekProviderConfig(pluginRoot, "http://127.0.0.1:9");

  for (const value of ["false", "0"]) {
    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        CODEX_SANDBOX: value,
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "provider_unavailable");
    assert.doesNotMatch(record.suggested_action, /network_access = true/);
    assert.doesNotMatch(record.suggested_action, /outside sandbox/);
  }
});

test("direct API HTTP provider_unavailable under Codex does not recommend sandbox network access", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "provider temporarily unavailable" } }));
  });
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);

    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        CODEX_SANDBOX: "seatbelt",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "provider_unavailable");
    assert.equal(record.http_status, 503);
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.doesNotMatch(record.suggested_action, /network_access = true/);
    assert.doesNotMatch(record.suggested_action, /outside sandbox/);
  } finally {
    server.close();
  }
});

test("direct API live malformed responses mark selected content as sent", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{not json");
  });
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "malformed_response");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.external_review.disclosure,
      "Selected source content was sent to DeepSeek through direct API auth, but the provider did not return a clean result.");
  } finally {
    server.close();
  }
});

test("branch-diff default reviews committed changes against main with scrubbed git env", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "review",
    "--foreground",
    "--prompt", "Check this branch.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "Live verification context",
      DEEPSEEK_API_KEY: "secret-test-value",
      GIT_DIR: path.join(cwd, "not-a-repo"),
      GIT_CONFIG_GLOBAL: path.join(cwd, "malicious-gitconfig"),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.scope, "branch-diff");
  assert.equal(record.scope_base, "main");
  assert.deepEqual(record.scope_paths, ["feature.txt"]);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("branch-diff git spawn failure returns structured scope failure JobRecord", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "review",
    "--foreground",
    "--prompt", "Check this branch.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
      PATH: "",
    },
  });
  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /git_failed:/);
  assert.match(record.suggested_action, /Adjust --scope/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("GLM direct API custom-review uses coding endpoint and request defaults", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const result = await run([
    "run",
    "--provider", "glm",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "Live verification context",
      ZAI_API_KEY: "",
      ZAI_GLM_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.provider, "glm");
  assert.equal(record.model, "glm-5.1");
  assert.equal(record.credential_ref, "ZAI_GLM_API_KEY");
  assert.equal(record.endpoint, "https://api.z.ai/api/coding/paas/v4");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API reviewers fail closed when no explicit API-key auth is available", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: { DEEPSEEK_API_KEY: "" },
  });
  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "missing_key");
  assert.match(record.suggested_action, /DEEPSEEK_API_KEY/);
  assert.equal(
    record.external_review.disclosure,
    "Selected source content was not sent to DeepSeek through direct API auth.",
  );
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(record.disclosure_note, record.external_review.disclosure);
});

test("direct API reviewers mark scope failures as not sent", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.equal(
    record.external_review.disclosure,
    "Selected source content was not sent to DeepSeek through direct API auth.",
  );
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(record.disclosure_note, record.external_review.disclosure);
});

test("direct API reviewers mark in-process mock assertion failures as not sent", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "text that is intentionally absent",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "mock_assertion_failed");
  assert.equal(
    record.external_review.disclosure,
    "Selected source content was not sent to DeepSeek through direct API auth.",
  );
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(record.disclosure_note, record.external_review.disclosure);
});

test("direct API reviewers mark malformed mock responses as not sent", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: "not-json",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "malformed_response");
  assert.equal(
    record.external_review.disclosure,
    "Selected source content was not sent to DeepSeek through direct API auth.",
  );
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(record.disclosure_note, record.external_review.disclosure);
});
