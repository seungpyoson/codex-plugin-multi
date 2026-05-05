import { once } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { externalReviewLaunchedEvent } from "../../scripts/lib/companion-common.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/grok/scripts/grok-web-reviewer.mjs");
const GROK_EXPECTED_KEYS = Object.freeze([
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
  "review_metadata",
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
  "runtime_diagnostics",
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

function run(args, options = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
  });
}

function runAsync(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function parseStdout(result) {
  assert.doesNotMatch(result.stderr, /secret|token|cookie|xai/i);
  return JSON.parse(result.stdout);
}

function parseJsonLines(result) {
  assert.doesNotMatch(result.stderr, /secret|token|cookie|xai/i);
  return result.stdout.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

function rmTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function makeEmptyBranchDiffWorkspace() {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-empty-branch-diff-")));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  execFileSync("git", ["add", "review.js"], { cwd });
  execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
  return cwd;
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}/api`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readJsonRequest(req) {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

test("doctor reports subscription-backed local tunnel mode and checks chat readiness", async () => {
  await withServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer secret-cookie-like-token");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      assert.equal(req.method, "GET");
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      assert.equal(req.method, "POST");
      const body = await readJsonRequest(req);
      assert.equal(body.model, "grok-4.20-fast");
      assert.equal(body.stream, false);
      assert.equal(body.messages.length, 1);
      assert.match(body.messages[0].content, /Return exactly: ok/);
      res.end(JSON.stringify({
        id: "chatcmpl-doctor",
        model: "grok-4.20-fast",
        choices: [{ message: { content: "ok" } }],
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.provider, "grok-web");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.chat_ready, true);
    assert.equal(parsed.auth_mode, "subscription_web");
    assert.equal(parsed.endpoint, baseUrl);
    assert.equal(parsed.probe_endpoint, `${baseUrl}/models`);
    assert.equal(parsed.chat_probe_endpoint, `${baseUrl}/chat/completions`);
    assert.equal(parsed.chat_doctor_timeout_ms, 10000);
    assert.deepEqual(parsed.cost_quota_readiness, {
      status: "unknown_not_probed",
      source: "doctor_does_not_call_billing_or_usage_endpoints",
      billing_mutation: "not_supported",
    });
    assert.match(parsed.summary, /subscription-backed/i);
    assert.match(parsed.next_action, /Grok web review/i);
    assert.equal(parsed.credential_ref, "GROK_WEB_TUNNEL_API_KEY");
    assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
    assert.doesNotMatch(result.stdout, /api\.x\.ai/i);
  });
});

test("rejects prototype-shaped option keys", () => {
  const result = run(["doctor", "--constructor", "polluted"], {
    env: {
      GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
    },
  });
  const parsed = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /unsupported option --constructor/);
  assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
});

test("doctor points bad chat model 400s at GROK_WEB_MODEL", async () => {
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      const body = await readJsonRequest(req);
      assert.equal(body.model, "grok-does-not-exist");
      res.writeHead(400);
      res.end(JSON.stringify({
        error: { message: "Model not found: grok-does-not-exist", type: "invalid_request_error", code: "model_not_found" },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_MODEL: "grok-does-not-exist",
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.chat_ready, false);
    assert.equal(parsed.error_code, "grok_chat_model_rejected");
    assert.equal(parsed.chat_http_status, 400);
    assert.match(parsed.error_message, /Model not found/);
    assert.match(parsed.next_action, /GROK_WEB_MODEL/);
  });
});

test("doctor does not classify quota 400s that mention model as model rejection", async () => {
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      const body = await readJsonRequest(req);
      assert.equal(body.model, "grok-4.20-fast");
      res.writeHead(400);
      res.end(JSON.stringify({
        error: { message: "invalid request: quota exceeded for model grok-4.20-fast" },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.chat_ready, false);
    assert.equal(parsed.error_code, "usage_limited");
    assert.equal(parsed.chat_http_status, 400);
    assert.match(parsed.error_message, /quota|usage-tier|billing|credit/i);
    assert.doesNotMatch(parsed.next_action, /GROK_WEB_MODEL/);
  });
});

test("doctor maps non-OK model probe responses without throwing", async () => {
  await withServer(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.writeHead(500);
    res.end(JSON.stringify({
      error: { message: "quota verifier unavailable; retry later" },
    }));
  }, async (baseUrl) => {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.reachable, false);
    assert.equal(parsed.error_code, "tunnel_error");
    assert.equal(parsed.http_status, 500);
    assert.match(parsed.error_message, /quota verifier unavailable/);
  });
});

test("doctor maps non-OK chat probe responses without throwing", async () => {
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      res.writeHead(500);
      res.end(JSON.stringify({
        error: { message: "billing quota verifier unavailable; retry later" },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.chat_ready, false);
    assert.equal(parsed.error_code, "tunnel_error");
    assert.equal(parsed.chat_http_status, 500);
    assert.match(parsed.error_message, /billing quota verifier unavailable/);
  });
});

test("doctor chat probe uses a separate configurable timeout", async () => {
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      await new Promise((resolve) => setTimeout(resolve, 700));
      res.end(JSON.stringify({
        id: "chatcmpl-doctor",
        model: "grok-4.20-fast",
        choices: [{ message: { content: "ok" } }],
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "10000",
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.doctor_timeout_ms, 500);
    assert.equal(parsed.chat_doctor_timeout_ms, 10000);
  });
});

for (const [name, envName] of [
  ["review", "GROK_WEB_TIMEOUT_MS"],
  ["models doctor", "GROK_WEB_DOCTOR_TIMEOUT_MS"],
  ["chat doctor", "GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS"],
]) {
  test(`rejects invalid ${name} timeout env`, () => {
    const result = run(["doctor"], {
      env: {
        [envName]: "not-a-number",
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 1);
    assert.equal(parsed.error_code, "bad_args");
    assert.match(parsed.error_message, new RegExp(`${envName} must be a positive integer number of milliseconds`));
  });
}

test("custom-review rejects invalid GROK_WEB_TIMEOUT_MS env", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-invalid-review-timeout-cwd-"));
  try {
    writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_TIMEOUT_MS: "not-a-number",
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 1);
    assert.deepEqual(Object.keys(parsed), [...GROK_EXPECTED_KEYS]);
    assert.equal(parsed.status, "failed");
    assert.equal(parsed.error_code, "bad_args");
    assert.match(parsed.error_message, /GROK_WEB_TIMEOUT_MS must be a positive integer number of milliseconds/);
    assert.equal(parsed.external_review.source_content_transmission, "not_sent");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("custom-review rejects invalid GROK_WEB_MAX_PROMPT_CHARS env", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-invalid-prompt-budget-cwd-"));
  try {
    writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_MAX_PROMPT_CHARS: "not-a-number",
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 1);
    assert.deepEqual(Object.keys(parsed), [...GROK_EXPECTED_KEYS]);
    assert.equal(parsed.status, "failed");
    assert.equal(parsed.error_code, "bad_args");
    assert.match(parsed.error_message, /GROK_WEB_MAX_PROMPT_CHARS must be a positive integer character count/);
    assert.equal(parsed.external_review.source_content_transmission, "not_sent");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("doctor is not review-ready when models work but chat returns upstream 400", async () => {
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      await readJsonRequest(req);
      res.writeHead(400);
      res.end(JSON.stringify({
        error: { message: "Chat upstream returned 400", type: "upstream_error", code: "upstream_error" },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const result = await runAsync(["doctor"], {
      env: { GROK_WEB_BASE_URL: baseUrl },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.chat_ready, false);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.error_code, "models_ok_chat_400");
    assert.equal(parsed.http_status, 200);
    assert.equal(parsed.chat_http_status, 400);
    assert.match(parsed.error_message, /Chat upstream returned 400/);
    assert.match(parsed.summary, /models.*chat/i);
    assert.match(parsed.next_action, /session|tunnel|rate-limit/i);
  });
});

test("doctor reports tunnel_unavailable when the local Grok tunnel is not reachable", () => {
  const result = run(["doctor"], {
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
    },
  });
  const parsed = parseStdout(result);

  assert.equal(result.status, 0);
  assert.equal(parsed.provider, "grok-web");
  assert.equal(parsed.ready, false);
  assert.equal(parsed.reachable, false);
  assert.equal(parsed.error_code, "tunnel_unavailable");
  assert.equal(parsed.auth_mode, "subscription_web");
  assert.match(parsed.endpoint, /^http:\/\/127\.0\.0\.1:9\/v1$/);
  assert.equal(parsed.probe_endpoint, "http://127.0.0.1:9/v1/models");
  assert.match(parsed.summary, /local tunnel is not reachable/i);
  assert.match(parsed.next_action, /Start the local Grok web tunnel/i);
  assert.doesNotMatch(result.stdout, /api\.x\.ai/i);
});

test("doctor explains direct Grok API keys are ignored for subscription web mode", () => {
  const result = run(["doctor"], {
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      GROK_API_KEY: "xai-direct-api-key",
    },
  });
  const parsed = parseStdout(result);

  assert.equal(result.status, 0);
  assert.equal(parsed.provider, "grok-web");
  assert.equal(parsed.ready, false);
  assert.equal(parsed.reachable, false);
  assert.equal(parsed.error_code, "tunnel_unavailable");
  assert.match(parsed.error_message, /GROK_API_KEY is ignored/i);
  assert.match(parsed.error_message, /GROK_WEB_TUNNEL_API_KEY/i);
  assert.match(parsed.next_action, /Start the local Grok web tunnel/i);
  assert.doesNotMatch(result.stdout, /xai-direct-api-key/);
});

test("doctor explains XAI_API_KEY is ignored for subscription web mode", () => {
  const result = run(["doctor"], {
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      XAI_API_KEY: "xai-direct-api-key",
    },
  });
  const parsed = parseStdout(result);

  assert.equal(result.status, 0);
  assert.equal(parsed.error_code, "tunnel_unavailable");
  assert.match(parsed.error_message, /XAI_API_KEY is ignored/i);
  assert.doesNotMatch(result.stdout, /xai-direct-api-key/);
});

test("doctor explains XAI_KEY is ignored for subscription web mode", () => {
  const result = run(["doctor"], {
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      XAI_KEY: "xai-direct-api-key",
    },
  });
  const parsed = parseStdout(result);

  assert.equal(result.status, 0);
  assert.equal(parsed.error_code, "tunnel_unavailable");
  assert.match(parsed.error_message, /XAI_KEY is ignored/i);
  assert.doesNotMatch(result.stdout, /xai-direct-api-key/);
});

test("custom-review sends selected source to a local Grok web tunnel and persists a JobRecord", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n// ``` nested markdown fence\n");

  let requestCount = 0;
  await withServer(async (req, res) => {
    requestCount += 1;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/chat/completions");
    assert.equal(req.headers.authorization, "Bearer secret-cookie-like-token");
    const body = await readJsonRequest(req);
    assert.equal(body.model, "grok-4.20-fast");
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0);
    assert.match(body.messages[0].content, /Provider: Grok Web/);
    assert.match(body.messages[0].content, /Checklist/);
    assert.match(body.messages[0].content, /Timed out, truncated, interrupted, blocked, or shallow output is NOT an approval/);
    assert.match(body.messages[0].content, /review\.js/);
    assert.match(body.messages[0].content, /export const value = 42/);
    assert.match(body.messages[0].content, /^BEGIN GROK FILE 1: review\.js$/m);
    assert.doesNotMatch(body.messages[0].content, /^```$/m);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `grok-web-session-${requestCount}`,
      model: "grok-4.20-fast",
      choices: [{ message: { content: `Verdict: no findings ${requestCount}.` } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
        GROK_WEB_TIMEOUT_MS: "123456",
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 0);
    assert.deepEqual(Object.keys(record), [...GROK_EXPECTED_KEYS]);
    assert.equal(record.target, "grok-web");
    assert.equal(record.provider, "grok-web");
    assert.equal(record.auth_mode, "subscription_web");
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Verdict: no findings 1.");
    assert.equal(record.schema_version, 10);
    assert.equal(record.review_metadata.prompt_contract_version, 1);
    assert.equal(record.review_metadata.prompt_provider, "Grok Web");
    assert.equal(record.review_metadata.scope, "custom");
    assert.deepEqual(record.review_metadata.scope_paths, ["review.js"]);
    assert.deepEqual(record.review_metadata.raw_output, {
      http_status: 200,
      raw_model: "grok-4.20-fast",
      parsed_ok: true,
      result_chars: "Verdict: no findings 1.".length,
    });
    assert.match(record.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
    assert.equal(record.review_metadata.audit_manifest.request.model, "grok-4.20-fast");
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 123456);
    assert.equal(record.review_metadata.audit_manifest.request.temperature, 0);
    assert.match(record.review_metadata.audit_manifest.prompt_builder.plugin_commit, /^[a-f0-9]{40}$/);
    assert.notEqual(
      record.review_metadata.audit_manifest.prompt_builder.plugin_commit,
      record.review_metadata.audit_manifest.git_identity.head_sha,
      "plugin_commit must identify the plugin source, not the reviewed repository head"
    );
    assert.equal(record.review_metadata.audit_manifest.provider_ids.session_id, "grok-web-session-1");
    assert.deepEqual(record.review_metadata.audit_manifest.selected_source.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      hashOk: /^[a-f0-9]{64}$/.test(file.content_hash.value),
    })), [
      { path: "review.js", bytes: "export const value = 42;\n// ``` nested markdown fence\n".length, hashOk: true },
    ]);
    assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("Check this file"), false);
    assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("export const value"), false);
    assert.equal(record.external_review.provider, "Grok Web");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.match(record.disclosure_note, /subscription-backed web session/i);
    assert.equal(record.credential_ref, "GROK_WEB_TUNNEL_API_KEY");
    assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);

    const persisted = JSON.parse(readFileSync(path.join(dataDir, "jobs", record.job_id, "meta.json"), "utf8"));
    assert.equal(persisted.result, "Verdict: no findings 1.");
    assert.equal(persisted.external_review.session_id, "grok-web-session-1");
    assert.equal(Object.hasOwn(persisted, "grok_session_id"), false);
    assert.doesNotMatch(JSON.stringify(persisted), /secret-cookie-like-token/);

    const resultLookup = run(["result", "--job-id", record.job_id], {
      cwd,
      env: {
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    const lookedUp = parseStdout(resultLookup);
    assert.equal(resultLookup.status, 0);
    assert.equal(lookedUp.job_id, record.job_id);
    assert.equal(lookedUp.result, "Verdict: no findings 1.");
    assert.doesNotMatch(resultLookup.stdout, /secret-cookie-like-token/);

    const secondResult = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file again.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const secondRecord = parseStdout(secondResult);
    assert.equal(secondResult.status, 0);

    const listResult = run(["list"], {
      cwd,
      env: {
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    const listed = parseStdout(listResult);
    assert.equal(listResult.status, 0);
    assert.equal(listed.ok, true);
    assert.equal(listed.jobs[0].job_id, secondRecord.job_id);
    assert.equal(listed.jobs[1].job_id, record.job_id);
  });
});

test("custom-review lifecycle jsonl emits launch before terminal record", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  await withServer(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-session-lifecycle",
      model: "grok-4.20-fast",
      choices: [{ message: { content: "Verdict: no findings." } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--lifecycle-events", "jsonl",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lines = parseJsonLines(result);
    assert.equal(lines.length, 2);
    const [launch, record] = lines;
    assert.deepEqual(launch, externalReviewLaunchedEvent({
      job_id: launch.job_id,
      target: "grok-web",
    }, launch.external_review));
    assert.equal(launch.external_review.provider, "Grok Web");
    assert.equal(launch.external_review.source_content_transmission, "may_be_sent");
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
  });
});

test("custom-review escalates Grok file delimiters when selected source collides", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), [
    "const marker = `BEGIN GROK FILE 1: review.js`;",
    "const end = `END GROK FILE 1: review.js`;",
    "export const value = marker + end;",
    "",
  ].join("\n"));

  await withServer(async (req, res) => {
    const body = await readJsonRequest(req);
    assert.match(body.messages[0].content, /BEGIN GROK FILE 1: review\.js #/);
    assert.match(body.messages[0].content, /END GROK FILE 1: review\.js #/);
    assert.match(body.messages[0].content, /BEGIN GROK FILE 1: review\.js`/);
    assert.match(body.messages[0].content, /END GROK FILE 1: review\.js`/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-delimiter-session",
      choices: [{ message: { content: "Verdict: delimiter collision handled." } }],
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: { GROK_WEB_BASE_URL: baseUrl },
    });
    const record = parseStdout(result);
    assert.equal(result.status, 0);
    assert.equal(record.result, "Verdict: delimiter collision handled.");
  });
});

test("custom-review reports exhausted Grok file delimiter collisions as not sent", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  let text = "";
  let delimiter = "GROK FILE 1: review.js";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    text += `BEGIN ${delimiter}\nEND ${delimiter}\n`;
    delimiter = `${delimiter} #`;
  }
  writeFileSync(path.join(cwd, "review.js"), text);

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "review.js",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_delimiter_collision:review\.js/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.external_review.disclosure, /not sent/i);
});

test("custom-review lifecycle jsonl suppresses launch event on scope failure", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  try {
    let text = "";
    let delimiter = "GROK FILE 1: review.js";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      text += `BEGIN ${delimiter}\nEND ${delimiter}\n`;
      delimiter = `${delimiter} #`;
    }
    writeFileSync(path.join(cwd, "review.js"), text);

    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--lifecycle-events", "jsonl",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      },
    });
    const lines = parseJsonLines(result);
    assert.equal(result.status, 1);
    assert.equal(lines.length, 1);
    const record = lines[0];
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "scope_failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("run rejects invalid lifecycle event mode as bad args", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  try {
    writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--lifecycle-events", "pretty",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      },
    });
    const record = parseStdout(result);
    assert.equal(result.status, 1);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "bad_args");
    assert.match(record.error_message, /--lifecycle-events must be jsonl/);
    assert.equal(record.external_review.source_content_transmission, "not_sent");
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("run rejects missing prompt before launch or source transmission", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  try {
    writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--lifecycle-events", "jsonl",
    ], {
      cwd,
      env: {
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      },
    });
    const lines = parseJsonLines(result);
    assert.equal(result.status, 1);
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "bad_args");
    assert.match(record.error_message, /prompt is required/);
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.doesNotMatch(result.stdout, /external_review_launched/);
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("run rejects blank or valueless prompt flags before launch", () => {
  for (const promptArgs of [
    ["--prompt", ""],
    ["--prompt", "   "],
    ["--prompt"],
    ["--prompt="],
    ["--prompt=   "],
    ["--prompt", "--unused-review-flag"],
  ]) {
    const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
    const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
    try {
      writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

      const result = run([
        "run",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--lifecycle-events", "jsonl",
        ...promptArgs,
      ], {
        cwd,
        env: {
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
        },
      });
      const lines = parseJsonLines(result);
      assert.equal(result.status, 1);
      assert.equal(lines.length, 1);
      const [record] = lines;
      assert.equal(record.status, "failed");
      assert.equal(record.error_code, "bad_args");
      assert.match(record.error_message, /prompt is required/);
      assert.equal(record.prompt_head, "");
      assert.equal(record.external_review.source_content_transmission, "not_sent");
      assert.doesNotMatch(result.stdout, /external_review_launched/);
    } finally {
      rmTree(cwd);
      rmTree(dataDir);
    }
  }
});

test("custom-review rejects aggregate selected source that exceeds the prompt cap before contacting the tunnel", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const files = [];
  for (let i = 0; i < 5; i += 1) {
    const file = `large-${i}.js`;
    files.push(file);
    writeFileSync(path.join(cwd, file), `export const value${i} = "${"x".repeat(220 * 1024)}";\n`);
  }

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", files.join(","),
    "--foreground",
    "--prompt", "Check these files.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_total_too_large/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.external_review.disclosure, /not sent/i);
});

test("branch-diff with no changed files explains recovery before contacting the tunnel", async () => {
  const cwd = makeEmptyBranchDiffWorkspace();
  const result = await runAsync([
    "run",
    "--mode", "adversarial-review",
    "--scope", "branch-diff",
    "--scope-base", "main",
    "--foreground",
    "--lifecycle-events", "jsonl",
    "--prompt", "Review this branch.",
  ], {
    cwd,
    env: { GROK_WEB_BASE_URL: "http://127.0.0.1:9/api" },
  });
  const lines = parseJsonLines(result);
  assert.equal(result.status, 1);
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_empty: branch-diff selected no files/);
  assert.match(record.suggested_action, /different --scope-base/);
  assert.match(record.suggested_action, /--scope-base HEAD~1/);
  assert.match(record.suggested_action, /custom-review/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.external_review.disclosure, /not sent/i);
  assert.doesNotMatch(result.stdout, /external_review_launched/);
});

test("branch-diff rejects option-shaped scope-base before contacting the tunnel", async () => {
  const cwd = makeEmptyBranchDiffWorkspace();
  try {
    const result = await runAsync([
      "run",
      "--mode", "adversarial-review",
      "--scope", "branch-diff",
      "--scope-base", "--definitely-not-a-real-ref",
      "--foreground",
      "--lifecycle-events", "jsonl",
      "--prompt", "Review this branch.",
    ], {
      cwd,
      env: { GROK_WEB_BASE_URL: "http://127.0.0.1:9/api" },
    });
    const lines = parseJsonLines(result);
    assert.equal(result.status, 1);
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "scope_failed");
    assert.match(record.error_message, /scope_base_invalid/);
    assert.match(record.suggested_action, /option-shaped values/);
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.match(record.external_review.disclosure, /not sent/i);
    assert.doesNotMatch(result.stdout, /external_review_launched/);
    assert.doesNotMatch(result.stdout, /invalid option/);
  } finally {
    rmTree(cwd);
  }
});

test("rendered prompt over Grok budget fails before contacting the tunnel", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "review.js",
    "--foreground",
    "--lifecycle-events", "jsonl",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      GROK_WEB_MAX_PROMPT_CHARS: "100",
    },
  });
  const lines = parseJsonLines(result);
  assert.equal(result.status, 1);
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /prompt_too_large:/);
  assert.match(record.suggested_action, /narrower scope|split/i);
  assert.match(record.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
  assert.equal(record.review_metadata.audit_manifest.selected_source.files.length, 1);
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("Check this file"), false);
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("export const value"), false);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.doesNotMatch(result.stdout, /external_review_launched/);
});

test("concurrent Grok runs preserve every completed job in the state index", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  const runCount = 8;
  let received = 0;
  const releaseAfterAll = [];

  await withServer(async (req, res) => {
    await readJsonRequest(req);
    received += 1;
    if (received === runCount) {
      for (const release of releaseAfterAll) release();
    } else {
      await new Promise((resolve) => releaseAfterAll.push(resolve));
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `grok-web-concurrent-${received}`,
      choices: [{ message: { content: `Verdict: concurrent ${received}.` } }],
    }));
  }, async (baseUrl) => {
    const results = await Promise.all(Array.from({ length: runCount }, (_, i) => runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", `Check this file ${i}.`,
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_PLUGIN_DATA: dataDir,
      },
    })));
    const records = results.map((result) => {
      const record = parseStdout(result);
      assert.equal(result.status, 0);
      assert.equal(record.status, "completed");
      return record;
    });

    const listResult = run(["list"], {
      cwd,
      env: { GROK_PLUGIN_DATA: dataDir },
    });
    const listed = parseStdout(listResult);
    assert.equal(listResult.status, 0);
    assert.equal(listed.ok, true);
    const listedIds = new Set(listed.jobs.map((job) => job.job_id));
    for (const record of records) assert.equal(listedIds.has(record.job_id), true);
    assert.equal(listed.jobs.length, runCount);
  });
});

test("Grok state index recovers stale locks owned by dead same-host processes", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  const lockDir = path.join(dataDir, "state.json.lock");
  const deadOwner = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(deadOwner.status, 0);
  mkdirSync(lockDir);
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: deadOwner.pid,
    host: hostname(),
    startedAt: new Date(Date.now() - 120000).toISOString(),
  }));

  await withServer(async (req, res) => {
    await readJsonRequest(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-stale-lock",
      choices: [{ message: { content: "Verdict: stale lock recovered." } }],
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const record = parseStdout(result);
    assert.equal(result.status, 0);
    assert.equal(record.status, "completed");
    assert.doesNotMatch(record.disclosure_note, /state_lock_timeout/);

    const listResult = run(["list"], {
      cwd,
      env: { GROK_PLUGIN_DATA: dataDir },
    });
    const listed = parseStdout(listResult);
    assert.equal(listResult.status, 0);
    assert.equal(listed.jobs[0].job_id, record.job_id);
  });
});

test("Grok state index recovers stale locks without owner metadata by age", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  const lockDir = path.join(dataDir, "state.json.lock");
  mkdirSync(lockDir);
  const oldTime = new Date(Date.now() - 120000);
  utimesSync(lockDir, oldTime, oldTime);

  await withServer(async (req, res) => {
    await readJsonRequest(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-stale-lock-missing-owner",
      choices: [{ message: { content: "Verdict: stale missing-owner lock recovered." } }],
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const record = parseStdout(result);
    assert.equal(result.status, 0);
    assert.equal(record.status, "completed");
    assert.doesNotMatch(record.disclosure_note, /state_lock_timeout/);
  });
});

test("Grok state index recovers old locks owned by different hosts", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  const lockDir = path.join(dataDir, "state.json.lock");
  mkdirSync(lockDir);
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: process.pid,
    host: "other-host.example.invalid",
    startedAt: new Date(Date.now() - 120000).toISOString(),
  }));
  const oldTime = new Date(Date.now() - 120000);
  utimesSync(lockDir, oldTime, oldTime);

  await withServer(async (req, res) => {
    await readJsonRequest(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-stale-lock-other-host",
      choices: [{ message: { content: "Verdict: stale different-host lock recovered." } }],
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const record = parseStdout(result);
    assert.equal(result.status, 0);
    assert.equal(record.status, "completed");
    assert.doesNotMatch(record.disclosure_note, /state_lock_timeout/);
  });
});

test("custom-review repairs malformed state index from persisted JobRecords", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");
  writeFileSync(path.join(dataDir, "state.json"), "{bad json");

  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/chat/completions");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-session-corrupt-state",
      model: "grok-4.20-fast",
      choices: [{ message: { content: "Verdict: state index malformed." } }],
    }));
  }, async (baseUrl) => {
    const runReview = () => runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const result = await runReview();
    const record = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(record.status, "completed");
    assert.doesNotMatch(record.disclosure_note, /JobRecord persistence failed/i);

    const persisted = JSON.parse(readFileSync(path.join(dataDir, "jobs", record.job_id, "meta.json"), "utf8"));
    assert.equal(persisted.job_id, record.job_id);
    assert.equal(persisted.result, "Verdict: state index malformed.");

    const resultLookup = run(["result", "--job-id", record.job_id], {
      cwd,
      env: { GROK_PLUGIN_DATA: dataDir },
    });
    const lookedUp = parseStdout(resultLookup);
    assert.equal(resultLookup.status, 0);
    assert.equal(lookedUp.job_id, record.job_id);
    assert.equal(lookedUp.result, "Verdict: state index malformed.");
    assert.doesNotMatch(lookedUp.disclosure_note, /JobRecord persistence failed/i);

    const secondResult = await runReview();
    const secondRecord = parseStdout(secondResult);
    assert.equal(secondResult.status, 0);
    assert.equal(secondRecord.status, "completed");
    assert.doesNotMatch(secondRecord.disclosure_note, /JobRecord persistence failed/i);

    const state = JSON.parse(readFileSync(path.join(dataDir, "state.json"), "utf8"));
    assert.equal(state.jobs[0].job_id, secondRecord.job_id);
    assert.equal(state.jobs[1].job_id, record.job_id);

    const listResult = run(["list"], {
      cwd,
      env: { GROK_PLUGIN_DATA: dataDir },
    });
    const listed = parseStdout(listResult);
    assert.equal(listResult.status, 0);
    assert.equal(listed.jobs[0].job_id, secondRecord.job_id);
    assert.equal(listed.jobs[1].job_id, record.job_id);
  });
});

test("state index updates do not import orphaned job records when state is healthy", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");
  const orphanJobId = "job_11111111-1111-4111-9111-111111111111";
  mkdirSync(path.join(dataDir, "jobs", orphanJobId), { recursive: true });
  writeFileSync(path.join(dataDir, "jobs", orphanJobId, "meta.json"), JSON.stringify({
    ok: true,
    job_id: orphanJobId,
    status: "completed",
    mode: "custom-review",
    provider: "grok-web",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:00.000Z",
    result: "orphaned historical result",
  }));
  writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({
    version: 1,
    jobs: [],
  }));

  await withServer(async (req, res) => {
    await readJsonRequest(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-healthy-state",
      choices: [{ message: { content: "Verdict: healthy state." } }],
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const record = parseStdout(result);
    assert.equal(result.status, 0);

    const listed = parseStdout(run(["list"], {
      cwd,
      env: { GROK_PLUGIN_DATA: dataDir },
    }));
    assert.deepEqual(listed.jobs.map((job) => job.job_id), [record.job_id]);
  });
});

test("Grok state lock does not reclaim live same-host owners by age", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  const lockDir = path.join(dataDir, "state.json.lock");
  mkdirSync(lockDir);
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(Date.now() - 120000).toISOString(),
  }));
  const oldTime = new Date(Date.now() - 120000);
  utimesSync(lockDir, oldTime, oldTime);

  await withServer(async (req, res) => {
    await readJsonRequest(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-live-lock",
      choices: [{ message: { content: "Verdict: live lock preserved." } }],
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const record = parseStdout(result);
    assert.equal(result.status, 0);
    assert.equal(record.status, "completed");
    assert.match(record.disclosure_note, /state_lock_timeout/);
    assert.equal(readFileSync(path.join(lockDir, "owner.json"), "utf8").includes(`"pid":${process.pid}`), true);
  });
});

test("state lock release leaves unexpected lock contents without failing a successful callback", async () => {
  const { withStateLock } = await import(`file://${COMPANION}`);
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const lockDir = path.join(dataDir, "state.json.lock");

  const result = await withStateLock(dataDir, async () => {
    writeFileSync(path.join(lockDir, "foreign-file"), "leave this alone\n");
    return "callback-result";
  });

  assert.equal(result, "callback-result");
  assert.equal(existsSync(path.join(lockDir, "foreign-file")), true);
});

test("state lock release does not remove a lock owned by a different token", async () => {
  const { releaseStateLock } = await import(`file://${COMPANION}`);
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const lockDir = path.join(dataDir, "state.json.lock");
  mkdirSync(lockDir);
  const originalOwner = `${JSON.stringify({ pid: 1111, host: "old-host", startedAt: "2026-01-01T00:00:00.000Z" })}\n`;
  const currentOwner = `${JSON.stringify({ pid: 2222, host: "new-host", startedAt: "2026-01-01T00:01:00.000Z" })}\n`;
  writeFileSync(path.join(lockDir, "owner.json"), currentOwner);

  await releaseStateLock(lockDir, originalOwner);

  assert.equal(existsSync(lockDir), true);
  assert.equal(readFileSync(path.join(lockDir, "owner.json"), "utf8"), currentOwner);
});

test("result rejects unsafe job ids without reading outside the data root", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const result = run(["result", "--job-id", "../../etc/passwd"], {
    cwd,
    env: { GROK_PLUGIN_DATA: dataDir },
  });
  const parsed = parseStdout(result);
  assert.equal(result.status, 1);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "bad_args");
});

test("list returns an empty job list on a fresh data root", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const result = run(["list"], {
    cwd,
    env: { GROK_PLUGIN_DATA: dataDir },
  });
  const parsed = parseStdout(result);
  assert.equal(result.status, 0);
  assert.deepEqual(parsed, { ok: true, jobs: [] });
});

test("list repairs malformed state from persisted JobRecords without echoing raw content", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const jobId = "job_22222222-2222-4222-9222-222222222222";
  mkdirSync(path.join(dataDir, "jobs", jobId), { recursive: true });
  writeFileSync(path.join(dataDir, "jobs", jobId, "meta.json"), JSON.stringify({
    ok: true,
    job_id: jobId,
    status: "completed",
    mode: "custom-review",
    provider: "grok-web",
    started_at: "2026-01-02T00:00:00.000Z",
    ended_at: "2026-01-02T00:00:00.000Z",
    result: "persisted review text",
  }));
  writeFileSync(path.join(dataDir, "state.json"), "{\"jobs\":[{\"result\":\"proprietary list text\"");
  const result = run(["list"], {
    cwd,
    env: { GROK_PLUGIN_DATA: dataDir },
  });
  const parsed = parseStdout(result);
  assert.equal(result.status, 0);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.repaired_from_disk, true);
  assert.equal(parsed.jobs[0].job_id, jobId);
  assert.doesNotMatch(result.stdout, /proprietary list text/);
});

test("list reports state lock timeout when malformed state repair cannot acquire the lock", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const lockDir = path.join(dataDir, "state.json.lock");
  mkdirSync(lockDir);
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(Date.now() - 120000).toISOString(),
  }));
  const oldTime = new Date(Date.now() - 120000);
  utimesSync(lockDir, oldTime, oldTime);
  writeFileSync(path.join(dataDir, "state.json"), "{\"jobs\":[{\"result\":\"proprietary list text\"");

  const result = run(["list"], {
    cwd,
    env: { GROK_PLUGIN_DATA: dataDir },
  });
  const parsed = parseStdout(result);
  assert.equal(result.status, 1);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "state_lock_timeout");
  assert.doesNotMatch(result.stdout, /proprietary list text/);
});

test("state summary sorting pushes invalid timestamps behind valid recent jobs", async () => {
  const { sortJobSummaries } = await import(`file://${COMPANION}`);
  const jobs = sortJobSummaries([
    { job_id: "job_bad", updatedAt: "not-a-date" },
    { job_id: "job_new", updatedAt: "2026-01-02T00:00:00.000Z" },
    { job_id: "job_old", updatedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(jobs.map((job) => job.job_id), ["job_new", "job_old", "job_bad"]);
});

test("stale lock inspection treats a concurrently released lock as retryable", async () => {
  const { staleLockReason } = await import(`file://${COMPANION}`);
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const lockDir = path.join(dataDir, "state.json.lock");
  const reason = await staleLockReason(lockDir);
  assert.equal(reason, null);
});

test("result reports malformed persisted records without echoing raw content", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const jobId = "job_12345678-1234-4234-9234-123456789abc";
  const jobDir = path.join(dataDir, "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(path.join(jobDir, "meta.json"), "{\"result\":\"proprietary review text\"");

  const result = run(["result", "--job-id", jobId], {
    cwd,
    env: { GROK_PLUGIN_DATA: dataDir },
  });
  const parsed = parseStdout(result);
  assert.equal(result.status, 1);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "malformed_record");
  assert.doesNotMatch(result.stdout, /proprietary review text/);
});

test("custom-review marks stalled uploaded tunnel requests as unknown transmission", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-workspace-")));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  let receivedBytes = 0;
  await withServer(async (req) => {
    req.on("data", (chunk) => { receivedBytes += chunk.length; });
    req.resume();
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TIMEOUT_MS: "1000",
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 1);
    assert.ok(receivedBytes > 0);
    assert.equal(record.error_code, "tunnel_timeout");
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 1000);
    assert.equal(typeof record.error_summary, "string");
    assert.match(record.error_summary, /configured_timeout_ms=1000/);
    assert.equal(record.external_review.source_content_transmission, "unknown");
    assert.match(record.external_review.disclosure, /may have been sent/i);
  });
});

test("custom-review marks socket drops after upload as unknown transmission", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-workspace-")));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  let receivedBytes = 0;
  await withServer(async (req) => {
    req.on("data", (chunk) => {
      receivedBytes += chunk.length;
      req.socket.destroy();
    });
    req.resume();
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: { GROK_WEB_BASE_URL: baseUrl },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 1);
    assert.ok(receivedBytes > 0);
    assert.equal(record.error_code, "tunnel_unavailable");
    assert.equal(record.external_review.source_content_transmission, "unknown");
    assert.match(record.external_review.disclosure, /may have been sent/i);
  });
});

test("custom-review redacts before truncating structured tunnel errors", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-workspace-")));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");
  const secret = "super-secret-sso-rw-token-value";

  await withServer(async (req, res) => {
    await readJsonRequest(req);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      detail: `${"x".repeat(780)}${secret}`,
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: secret,
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 1);
    assert.equal(record.error_code, "tunnel_error");
    assert.doesNotMatch(record.error_message, /super-secr/);
    assert.doesNotMatch(result.stdout, /super-secr/);
  });
});

test("review mode uses branch-diff scope with scrubbed git environment", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-branch-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const hostileGitDir = mkdtempSync(path.join(tmpdir(), "grok-hostile-git-dir-"));
  const hostilePath = mkdtempSync(path.join(tmpdir(), "grok-hostile-path-"));
  const hostileGitMarker = path.join(hostilePath, "git-was-used");
  const hostileGit = path.join(hostilePath, "git");
  writeFileSync(hostileGit, `#!/bin/sh\ntouch ${JSON.stringify(hostileGitMarker)}\nexit 99\n`);
  chmodSync(hostileGit, 0o700);
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  writeFileSync(path.join(cwd, "local-config.txt"), "base config\n");
  execFileSync("git", ["add", "local-config.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "base config"], { cwd, stdio: "ignore" });
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  execFileSync("git", ["add", "review.js"], { cwd });
  execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
  const mainCommit = execFileSync("git", ["rev-parse", "main"], { cwd, encoding: "utf8" }).trim();
  execFileSync("git", ["tag", "-a", "review-base", "-m", "review base", "main"], { cwd, stdio: "ignore" });
  const tagObject = execFileSync("git", ["rev-parse", "review-base"], { cwd, encoding: "utf8" }).trim();
  assert.notEqual(tagObject, mainCommit);
  execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
  writeFileSync(path.join(cwd, "review.js"), "export const value = 2;\n");
  writeFileSync(path.join(cwd, "extra.js"), "export const extra = true;\n");
  execFileSync("git", ["add", "review.js", "extra.js"], { cwd });
  execFileSync("git", ["commit", "-m", "feature"], { cwd, stdio: "ignore" });
  writeFileSync(path.join(cwd, "review.js"), "GROK_DIRTY_SELECTED_SECRET\n");
  writeFileSync(path.join(cwd, "local-config.txt"), "GROK_LOCAL_DIRTY_SECRET\n");
  writeFileSync(path.join(cwd, "untracked-secret.js"), "GROK_UNTRACKED_SECRET\n");

  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/chat/completions");
    const body = await readJsonRequest(req);
    assert.match(body.messages[0].content, /review\.js/);
    assert.doesNotMatch(body.messages[0].content, /extra\.js/);
    assert.doesNotMatch(body.messages[0].content, /export const extra/);
    assert.match(body.messages[0].content, new RegExp(`Base commit: ${mainCommit}`));
    assert.doesNotMatch(body.messages[0].content, new RegExp(`Base commit: ${tagObject}`));
    assert.match(body.messages[0].content, /export const value = 2/);
    assert.doesNotMatch(body.messages[0].content, /GROK_DIRTY_SELECTED_SECRET/);
    assert.doesNotMatch(body.messages[0].content, /local-config\.txt/);
    assert.doesNotMatch(body.messages[0].content, /GROK_LOCAL_DIRTY_SECRET/);
    assert.doesNotMatch(body.messages[0].content, /untracked-secret\.js/);
    assert.doesNotMatch(body.messages[0].content, /GROK_UNTRACKED_SECRET/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-branch-session",
      choices: [{ message: { content: "Verdict: branch diff reviewed." } }],
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "review",
      "--scope", "branch-diff",
      "--scope-base", "review-base",
      "--scope-paths", "review.?s",
      "--foreground",
      "--prompt", "Review the branch diff.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
        GROK_PLUGIN_DATA: dataDir,
        GIT_DIR: hostileGitDir,
        GIT_WORK_TREE: hostileGitDir,
        PATH: hostilePath,
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(record.status, "completed");
    assert.equal(record.mode, "review");
    assert.equal(record.scope, "branch-diff");
    assert.equal(record.scope_base, "review-base");
    assert.deepEqual(record.scope_paths, ["review.js"]);
    assert.deepEqual(
      record.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
      ["review.js"]
    );
    assert.equal(
      record.review_metadata.audit_manifest.scope_resolution.reason,
      "git diff -z --name-only review-base...HEAD -- filtered by explicit --scope-paths"
    );
    assert.equal(record.result, "Verdict: branch diff reviewed.");
    assert.equal(existsSync(hostileGitMarker), false);
  });
});

test("branch-diff treats **/ as a path segment glob", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-branch-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  writeFileSync(path.join(cwd, "feature.txt"), "base feature\n");
  execFileSync("git", ["add", "feature.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
  execFileSync("git", ["tag", "-a", "review-base", "-m", "review base", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
  mkdirSync(path.join(cwd, "nested"));
  writeFileSync(path.join(cwd, "feature.txt"), "root feature change\n");
  writeFileSync(path.join(cwd, "nested", "feature.txt"), "nested feature change\n");
  writeFileSync(path.join(cwd, "prefixfeature.txt"), "prefix feature change\n");
  execFileSync("git", ["add", "feature.txt", "nested/feature.txt", "prefixfeature.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "feature changes"], { cwd, stdio: "ignore" });

  await withServer(async (req, res) => {
    const body = await readJsonRequest(req);
    assert.match(body.messages[0].content, /root feature change/);
    assert.match(body.messages[0].content, /nested feature change/);
    assert.doesNotMatch(body.messages[0].content, /prefix feature change/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-glob-session",
      choices: [{ message: { content: "Verdict: glob reviewed." } }],
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "review",
      "--scope", "branch-diff",
      "--scope-base", "review-base",
      "--scope-paths", "**/feature.txt",
      "--foreground",
      "--prompt", "Review the branch diff.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 0);
    assert.deepEqual(record.scope_paths, ["feature.txt", "nested/feature.txt"]);
    assert.deepEqual(
      record.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
      ["feature.txt", "nested/feature.txt"]
    );
    assert.equal(record.result, "Verdict: glob reviewed.");
  });
});

test("custom-review keeps prompt delimiter exceptions as scope failures before tunnel delivery", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-workspace-")));
  const delimiter = "GROK FILE 1: review.js";
  writeFileSync(path.join(cwd, "review.js"), Array.from({ length: 101 }, (_, index) => {
    const suffix = " #".repeat(index);
    return `BEGIN ${delimiter}${suffix}\nEND ${delimiter}${suffix}`;
  }).join("\n"));

  const result = await runAsync([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "review.js",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: { GROK_WEB_BASE_URL: "http://127.0.0.1:9" },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.error_code, "scope_failed");
  assert.equal(record.error_cause, "scope_resolution");
  assert.match(record.suggested_action, /scope/i);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
});

test("scope file reads use canonical real paths after symlink boundary check", () => {
  // Structural guard for the reviewed TOCTOU fix: later I/O must keep using the verified path
  // and must read through the bounded file-handle helper instead of unbounded readFile().
  const source = readFileSync(COMPANION, "utf8");
  assert.match(source, /const SCOPE_FILE_OPEN_FLAGS = fsConstants\.O_RDONLY \| \(fsConstants\.O_NOFOLLOW \?\? 0\);/);
  assert.match(source, /handle = await open\(filePath, SCOPE_FILE_OPEN_FLAGS\);/);
  assert.match(source, /const info = await handle\.stat\(\);/);
  assert.match(source, /if \(!sameFileIdentity\(beforeOpen, info\)\)/);
  assert.match(source, /beforeOpen = await lstat\(abs\);/);
  assert.match(source, /if \(beforeOpen\.isSymbolicLink\(\)\)/);
  assert.match(source, /const \{ bytesRead \} = await handle\.read\(buffer, 0, buffer\.length, null\);/);
  assert.match(source, /const text = await readUtf8ScopeFileWithinLimit\(realAbs, normalizedRel, beforeOpen\);/);
  assert.doesNotMatch(source, /const text = await readFile\(realAbs, "utf8"\);/);
});

test("scope file reads reject stale file identity after secure open", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-workspace-")));
  const first = path.join(cwd, "first.txt");
  const second = path.join(cwd, "second.txt");
  writeFileSync(first, "first file\n");
  writeFileSync(second, "second file\n");
  const beforeOpen = lstatSync(first);
  const { readUtf8ScopeFileWithinLimit } = await import(pathToFileURL(COMPANION).href);

  await assert.rejects(
    () => readUtf8ScopeFileWithinLimit(second, "first.txt", beforeOpen),
    /unsafe_scope_path:first\.txt: file changed before secure open/,
  );
});

test("tunnel invocation catch is separated from prompt construction catch", () => {
  // Structural guard so prompt/scope failures and unexpected tunnel throws cannot share one catch.
  const source = readFileSync(COMPANION, "utf8");
  assert.match(source, /prompt = promptFor\(/);
  assert.match(source, /providerFailure\(e\.message\.startsWith\("bad_args:"\) \? "bad_args" : "scope_failed"/);
  assert.match(source, /timeoutMs: execution\.diagnostics\?\.configured_timeout_ms \?\? cfg\.timeout_ms \?\? null/);
  assert.match(source, /execution = await callGrokTunnel\(cfg, prompt\)/);
  assert.match(source, /"tunnel_error"/);
  assert.match(source, /payloadSentForFetchError\(e\)/);
});

for (const { status, code, quotaBody = false } of [
  { status: 401, code: "session_expired", quotaBody: true },
  { status: 403, code: "session_expired" },
  { status: 408, code: "tunnel_error", quotaBody: true },
  { status: 400, code: "usage_limited" },
  { status: 402, code: "usage_limited" },
  { status: 429, code: "usage_limited" },
  { status: 500, code: "tunnel_error", quotaBody: true },
]) {
  test(`custom-review maps HTTP ${status} to ${code} without leaking secrets`, async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
    writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

    await withServer(async (_req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: {
          code: code === "usage_limited" || quotaBody ? "account=user@example.com:plan_id=pro+stripe-sub-abc/123" : "server_error",
          type: code === "usage_limited" || quotaBody ? "billing/account=user@example.com" : "server_error",
          message: code === "usage_limited" || quotaBody
            ? "quota exceeded for billing account user@example.com plan_id=pro+stripe-sub-abc/123 customer cus_NXLKj1H invoice item ii_1Mt5L0HabcDEF12345; Authorization: Bearer secret-cookie-like-token failed"
            : "Authorization: Bearer secret-cookie-like-token failed",
        },
      }));
    }, async (baseUrl) => {
      const result = await runAsync([
        "run",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Check this file.",
      ], {
        cwd,
        env: {
          GROK_WEB_BASE_URL: baseUrl,
          GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
        },
      });
      const record = parseStdout(result);

      assert.equal(result.status, 1);
      assert.equal(record.status, "failed");
      assert.equal(record.error_code, code);
      assert.equal(record.http_status, status);
      assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 600000);
      assert.match(record.error_summary, /configured_timeout_ms=600000/);
      if (code === "usage_limited") {
        assert.equal(record.error_cause, "cost_quota_usage_limit");
        assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
        assert.equal(record.runtime_diagnostics.cost_quota.http_status, status);
        assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, null);
        assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, null);
        assert.equal(record.runtime_diagnostics.tunnel_request.configured_timeout_ms, 600000);
        assert.doesNotMatch(record.error_summary, /\[object Object\]/);
        assert.match(record.suggested_action, /subscription usage|manual approval/i);
      } else if (quotaBody) {
        assert.notEqual(record.error_cause, "cost_quota_usage_limit");
        assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
        assert.equal(record.runtime_diagnostics.cost_quota.http_status, status);
      }
      assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
      assert.doesNotMatch(result.stdout, /user@example\.com|stripe-sub|plan_id|cus_NXLKj1H|ii_1Mt5L0HabcDEF12345/);
      if (code === "usage_limited" || quotaBody) {
        assert.match(record.error_message, /quota|usage-tier|billing|credit/i);
      } else {
        assert.match(record.error_message, /\[REDACTED\]/);
      }
    });
  });
}

test("custom-review preserves safe numeric cost-quota provider codes", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  await withServer(async (_req, res) => {
    res.statusCode = 402;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: {
        code: 429,
        type: "billing",
        message: "quota exceeded for this billing account; Authorization: Bearer secret-cookie-like-token failed",
      },
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 1);
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, "429");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, "billing");
    assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
  });
});

test("custom-review status-only usage limits use safe diagnostics", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  await withServer(async (_req, res) => {
    res.statusCode = 402;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: {
        code: "card_required",
        type: "checkout_required",
        message: "Payment required: see checkout session cs_test_abc123 and customer cus_NXLKj1H.",
      },
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 1);
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.error_cause, "cost_quota_usage_limit");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.doesNotMatch(result.stdout, /cs_test|cus_NXLKj1H|secret-cookie-like-token/);
  });
});

test("custom-review preserves non-payment prefixed provider diagnostic tokens", async () => {
  await withServer(async (req, res) => {
    await readJsonRequest(req);
    res.setHeader("content-type", "application/json");
    res.writeHead(500);
    res.end(JSON.stringify({
      error: {
        code: "in_progress",
        type: "sub_required",
        message: "Internal tunnel error while enabling provider feature.",
      },
    }));
  }, async (baseUrl) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
    writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");
    const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    assert.equal(result.status, 1);
    const record = parseStdout(result);
    assert.equal(record.error_code, "tunnel_error");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, "in_progress");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, "sub_required");
  });
});

test("custom-review cost-quota diagnostics drop account-shaped provider tokens", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  await withServer(async (_req, res) => {
    res.statusCode = 402;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: {
        code: "ii_1Mt5L0HabcDEF12345",
        type: "acct_test_12345",
        message: "Credit limit exceeded for this billing cycle.",
      },
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 1);
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, null);
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, null);
    assert.doesNotMatch(result.stdout, /ii_1Mt5L0HabcDEF12345|acct_test_12345/);
  });
});

test("custom-review non-JSON quota payloads use safe diagnostics", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  await withServer(async (_req, res) => {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain");
    res.end("quota exceeded for billing account user@example.com plan_id=pro+stripe-sub-abc/123");
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 1);
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.error_cause, "cost_quota_usage_limit");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.http_status, 400);
    assert.doesNotMatch(result.stdout, /user@example\.com|stripe-sub|plan_id|secret-cookie-like-token/);
  });
});

test("custom-review maps malformed tunnel responses", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  await withServer(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: {} }] }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 1);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "malformed_response");
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 600000);
    assert.match(record.suggested_action, /unsupported response shape/i);
  });
});

test("local tunnel connection failure is structured as not sent", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "review.js",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      GROK_WEB_TIMEOUT_MS: "500",
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "tunnel_unavailable");
  assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 500);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.suggested_action, /Start the local Grok web tunnel/i);
  assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
});

test("local tunnel connection failure lifecycle jsonl emits launch then failed terminal record", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "review.js",
    "--foreground",
    "--lifecycle-events", "jsonl",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      GROK_WEB_TIMEOUT_MS: "500",
    },
  });
  const lines = parseJsonLines(result);
  assert.equal(result.status, 1);
  assert.equal(lines.length, 2);
  const [launch, record] = lines;
  assert.deepEqual(launch, externalReviewLaunchedEvent({
    job_id: launch.job_id,
    target: "grok-web",
  }, launch.external_review));
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "tunnel_unavailable");
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
});

test("custom-review rejects oversized selected files before contacting the tunnel", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "large.js"), `${"x".repeat(256 * 1024 + 1)}\n`);

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "large.js",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_file_too_large:large\.js/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
});

test("branch-diff rejects oversized committed files before contacting the tunnel", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-branch-large-"));
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  writeFileSync(path.join(cwd, "large.js"), "export const value = 1;\n");
  execFileSync("git", ["add", "large.js"], { cwd });
  execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
  writeFileSync(path.join(cwd, "large.js"), `${"x".repeat(16 * 1024 * 1024 + 1)}\n`);
  execFileSync("git", ["add", "large.js"], { cwd });
  execFileSync("git", ["commit", "-m", "large"], { cwd, stdio: "ignore" });

  const result = run([
    "run",
    "--mode", "review",
    "--scope", "branch-diff",
    "--scope-base", "main",
    "--foreground",
    "--prompt", "Review this large file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_file_too_large:large\.js/);
  assert.doesNotMatch(record.error_message, /ENOBUFS/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
});

test("run rejects Git binary policy errors distinctly before Grok scope collection", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-git-policy-"));
  const marker = path.join(cwd, "executed");
  const maliciousGit = path.join(cwd, "malicious-git");
  writeFileSync(maliciousGit, `#!/bin/sh\necho executed > ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
  chmodSync(maliciousGit, 0o700);
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "review.js",
    "--foreground",
    "--prompt", "Review this file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      CODEX_PLUGIN_MULTI_GIT_BINARY: maliciousGit,
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "git_binary_rejected");
  assert.equal(record.error_cause, "git_binary_policy");
  assert.match(record.error_message, /CODEX_PLUGIN_MULTI_GIT_BINARY/);
  assert.match(record.suggested_action, /CODEX_PLUGIN_MULTI_GIT_BINARY|trusted Git/i);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(existsSync(marker), false, "rejected git override must not execute");
});

test("custom-review rejects unsafe scope paths before contacting the tunnel", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "../review.js",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /unsafe_scope_path/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
});

test("custom-review rejects control characters in scope paths before contacting the tunnel", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "review.js\tother.js",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
      GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /unsafe_scope_path/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
});

test("custom-review rejects symlinks that resolve outside the workspace", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const outside = mkdtempSync(path.join(tmpdir(), "grok-web-outside-"));
  writeFileSync(path.join(outside, "secret.js"), "export const secret = 1;\n");
  symlinkSync(path.join(outside, "secret.js"), path.join(cwd, "linked-secret.js"));

  const result = run([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "linked-secret.js",
    "--foreground",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:1/api",
      GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
    },
  });

  const record = parseStdout(result);
  assert.equal(result.status, 1);
  assert.equal(record.error_code, "scope_failed");
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.error_message, /unsafe_scope_path:linked-secret\.js/);
  assert.doesNotMatch(record.error_message, /export const secret/);
});

test("custom-review accepts files when cwd itself is a symlink to the workspace", async () => {
  const realWorkspace = mkdtempSync(path.join(tmpdir(), "grok-web-real-workspace-"));
  const linkRoot = mkdtempSync(path.join(tmpdir(), "grok-web-link-root-"));
  const linkedWorkspace = path.join(linkRoot, "workspace");
  writeFileSync(path.join(realWorkspace, "review.js"), "export const value = 42;\n");
  symlinkSync(realWorkspace, linkedWorkspace);

  await withServer(async (req, res) => {
    const body = await readJsonRequest(req);
    assert.match(body.messages[0].content, /BEGIN GROK FILE 1: review\.js/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-session-linked-workspace",
      choices: [{ message: { content: "Verdict: symlinked cwd accepted." } }],
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--cwd", linkedWorkspace,
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      env: { GROK_WEB_BASE_URL: baseUrl },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Verdict: symlinked cwd accepted.");
  });
});

test("help exposes only subscription-backed Grok commands", () => {
  const parsed = JSON.parse(execFileSync(process.execPath, [COMPANION, "help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.commands, ["doctor", "ping", "run", "result", "list"]);
  assert.equal(parsed.provider, "grok-web");
  assert.equal(parsed.default_auth_mode, "subscription_web");
  assert.doesNotMatch(JSON.stringify(parsed), /api\.x\.ai/i);
});
