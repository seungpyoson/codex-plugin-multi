import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYNC = path.join(REPO_ROOT, "plugins/grok/scripts/grok-sync-browser-session.mjs");

function runAsync(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SYNC, ...args], {
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

async function readJsonRequest(req) {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

async function withGrok2ApiServer(handler, fn) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("sync-browser-session imports sso-rw into grok2api, forces super pool, and redacts token output", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const secret = "super-secret-sso-rw-token-value";
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([
    { name: "sso", value: "less-preferred-sso-value" },
    { name: "sso-rw", value: secret },
  ]));

  const requests = [];
  let currentTokens = [{ token: "old-token", pool: "basic", status: "active", quota: {} }];
  await withGrok2ApiServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: currentTokens }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/admin/api/tokens") {
      const body = await readJsonRequest(req);
      assert.deepEqual(body, ["old-token"]);
      currentTokens = [];
      res.end(JSON.stringify({ status: "success" }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      const body = await readJsonRequest(req);
      assert.deepEqual(body, { pool: "super", tokens: [secret] });
      currentTokens = [{ token: secret, pool: "super", status: "active", quota: { auto: { remaining: 50, total: 50 } } }];
      res.end(JSON.stringify({ status: "success", count: 1 }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/batch/refresh") {
      const body = await readJsonRequest(req);
      assert.deepEqual(body, { tokens: [secret] });
      res.end(JSON.stringify({ status: "success" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "--cookie-source-json", cookieSource,
      "--grok2api-base-url", baseUrl,
      "--pool", "super",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.source, "cookie_source_json");
    assert.equal(parsed.selected_cookie, "sso-rw");
    assert.equal(parsed.pool, "super");
    assert.equal(parsed.deleted_count, 1);
    assert.deepEqual(parsed.tokens, [{
      pool: "super",
      status: "active",
      quota: { auto: { remaining: 50, total: 50 } },
      use_count: null,
      last_used_at: null,
      tags: [],
    }]);
    assert.doesNotMatch(result.stdout, /super-secret-sso-rw-token-value/);
    assert.doesNotMatch(result.stderr, /super-secret-sso-rw-token-value/);
    assert.match(result.stderr, /Reading Grok session cookies/i);
  });

  assert.ok(requests.every((entry) => entry.authorization === "Bearer grok2api"));
});

test("sync-browser-session refuses to touch cookies when grok2api is unreachable", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: "secret-value-that-must-not-load" }]));

  const result = await runAsync([
    "--cookie-source-json", cookieSource,
    "--grok2api-base-url", "http://127.0.0.1:9",
  ]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "grok2api_unreachable");
  assert.doesNotMatch(result.stdout, /secret-value-that-must-not-load/);
  assert.doesNotMatch(result.stderr, /secret-value-that-must-not-load/);
});
