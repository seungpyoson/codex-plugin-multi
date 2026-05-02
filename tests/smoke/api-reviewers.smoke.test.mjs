import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/api-reviewers/scripts/api-reviewer.mjs");

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

function mockResponse(model, id = "chatcmpl-test") {
  return JSON.stringify({
    id,
    object: "chat.completion",
    model,
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: `Verdict: APPROVE\nProvider model: ${model}`,
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function makeWorkspace() {
  const cwd = mkdtempSync(path.join(tmpdir(), "api-reviewers-smoke-"));
  writeFileSync(path.join(cwd, "seed.txt"), "hello from selected scope\n");
  return cwd;
}

function makeInstalledApiReviewersRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "api-reviewers-installed-"));
  const pluginRoot = path.join(root, "api-reviewers", "0.1.0");
  cpSync(path.join(REPO_ROOT, "plugins", "claude"), path.join(root, "api-reviewers", "claude"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "plugins", "api-reviewers"), pluginRoot, { recursive: true });
  return pluginRoot;
}

function startHangingChatServer() {
  const server = createServer((req, res) => {
    if (req.url === "/chat/completions") {
      req.resume();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "Live verification context",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.provider, "deepseek");
  assert.equal(record.model, "deepseek-v4-flash");
  assert.equal(record.credential_ref, "DEEPSEEK_API_KEY");
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

test("direct API provider session_id rejects oversized and control-character values", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  for (const id of ["bad\nid", "x".repeat(201)]) {
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
    assert.doesNotMatch(result.stdout, /bad\\nid/);
  }
});

test("direct API timeout marks selected content as sent", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startHangingChatServer();
  try {
    const { port } = server.address();
    writeFileSync(path.join(pluginRoot, "config", "providers.json"), JSON.stringify({
      deepseek: {
        display_name: "DeepSeek",
        auth_mode: "api_key",
        env_keys: ["DEEPSEEK_API_KEY"],
        base_url: `http://127.0.0.1:${port}`,
        model: "deepseek-v4-flash",
      },
    }, null, 2));

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
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), JSON.stringify({
    deepseek: {
      display_name: "DeepSeek",
      auth_mode: "api_key",
      env_keys: ["DEEPSEEK_API_KEY"],
      base_url: "http://127.0.0.1:9",
      model: "deepseek-v4-flash",
    },
  }, null, 2));

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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash"),
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
