import { once } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/grok/scripts/grok-web-reviewer.mjs");

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
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
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

test("doctor reports subscription-backed local tunnel mode and checks reachability", async () => {
  await withServer(async (req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/api/models");
    assert.equal(req.headers.authorization, "Bearer secret-cookie-like-token");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
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
    assert.equal(parsed.auth_mode, "subscription_web");
    assert.equal(parsed.endpoint, baseUrl);
    assert.equal(parsed.probe_endpoint, `${baseUrl}/models`);
    assert.match(parsed.summary, /subscription-backed/i);
    assert.match(parsed.next_action, /Grok web review/i);
    assert.equal(parsed.credential_ref, "GROK_WEB_TUNNEL_API_KEY");
    assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
    assert.doesNotMatch(result.stdout, /api\.x\.ai/i);
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

test("custom-review sends selected source to a local Grok web tunnel and persists a JobRecord", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/chat/completions");
    assert.equal(req.headers.authorization, "Bearer secret-cookie-like-token");
    const body = await readJsonRequest(req);
    assert.equal(body.model, "grok-4.20-fast");
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0);
    assert.match(body.messages[0].content, /review\.js/);
    assert.match(body.messages[0].content, /export const value = 42/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-session-1",
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
      "--prompt", "Check this file.",
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
    assert.equal(record.target, "grok-web");
    assert.equal(record.provider, "grok-web");
    assert.equal(record.auth_mode, "subscription_web");
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Verdict: no findings.");
    assert.equal(record.external_review.provider, "Grok Web");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.match(record.disclosure_note, /subscription-backed web session/i);
    assert.equal(record.credential_ref, "GROK_WEB_TUNNEL_API_KEY");
    assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);

    const persisted = JSON.parse(readFileSync(path.join(dataDir, "jobs", record.job_id, "meta.json"), "utf8"));
    assert.equal(persisted.result, "Verdict: no findings.");
    assert.doesNotMatch(JSON.stringify(persisted), /secret-cookie-like-token/);
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
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.suggested_action, /Start the local Grok web tunnel/i);
  assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
});

test("help exposes only subscription-backed Grok commands", () => {
  const parsed = JSON.parse(execFileSync(process.execPath, [COMPANION, "help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.commands, ["doctor", "ping", "run"]);
  assert.equal(parsed.provider, "grok-web");
  assert.equal(parsed.default_auth_mode, "subscription_web");
  assert.doesNotMatch(JSON.stringify(parsed), /api\.x\.ai/i);
});
