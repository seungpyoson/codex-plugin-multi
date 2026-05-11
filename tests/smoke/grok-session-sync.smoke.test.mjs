import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCookiePlaintext, selectCookie } from "../../plugins/grok/scripts/grok-sync-browser-session.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYNC = path.join(REPO_ROOT, "plugins/grok/scripts/grok-sync-browser-session.mjs");
const VALID_SESSION_TOKEN = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature";

test("decodeCookiePlaintext strips Chromium host digest prefix before UTF-8 fallback", () => {
  const hostKey = ".grok.com";
  const plaintext = Buffer.concat([
    createHash("sha256").update(hostKey).digest(),
    Buffer.from(VALID_SESSION_TOKEN, "utf8"),
  ]);

  assert.equal(decodeCookiePlaintext(plaintext, hostKey), VALID_SESSION_TOKEN);
  assert.equal(
    decodeCookiePlaintext(plaintext),
    plaintext.toString("utf8"),
  );
});

test("selectCookie preserves sso-rw priority before JWT preference across names", () => {
  const selected = selectCookie([
    { name: "sso-rw", value: "decrypted-control-looking-cookie-value" },
    { name: "sso", value: VALID_SESSION_TOKEN },
  ]);

  assert.deepEqual(selected, {
    name: "sso-rw",
    value: "decrypted-control-looking-cookie-value",
  });
});

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
  const secret = VALID_SESSION_TOKEN;
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
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      const body = await readJsonRequest(req);
      assert.deepEqual(body, { pool: "super", tokens: [secret] });
      currentTokens.push({ token: secret, pool: "super", status: "active", quota: { auto: { remaining: 50, total: 50 } } });
      res.end(JSON.stringify({ status: "success", count: 1 }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/batch/refresh") {
      const body = await readJsonRequest(req);
      assert.deepEqual(body, { tokens: [secret] });
      res.end(JSON.stringify({ status: "success" }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/admin/api/tokens") {
      const body = await readJsonRequest(req);
      assert.deepEqual(body, []);
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
    assert.equal(parsed.deleted_count, 0);
    assert.deepEqual(parsed.tokens.map((entry) => entry.pool), ["basic", "super"]);
    assert.doesNotMatch(result.stdout, /eyJhbGci/);
    assert.doesNotMatch(result.stderr, /eyJhbGci/);
    assert.match(result.stderr, /Reading Grok session cookies/i);
    assert.match(result.stderr, /default grok2api admin key/i);
  });

  assert.ok(requests.every((entry) => entry.authorization === "Bearer grok2api"));
});

test("sync-browser-session rejects malformed non-JWT cookie values before mutating grok2api", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const malformed = "decrypted-control-looking-cookie-value";
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: malformed }]));

  const requests = [];
  await withGrok2ApiServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: [] }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: "mutation should not be reached" } }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "--cookie-source-json", cookieSource,
      "--grok2api-base-url", baseUrl,
      "--pool", "super",
    ]);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error_code, "malformed_cookie_token");
    assert.equal(parsed.source, "cookie_source_json");
    assert.equal(parsed.selected_cookie, "sso-rw");
    assert.match(parsed.error_message, /JWT-shaped/i);
    assert.doesNotMatch(result.stdout, new RegExp(malformed));
    assert.doesNotMatch(result.stderr, new RegExp(malformed));
  });

  assert.deepEqual(requests, ["GET /admin/api/tokens"]);
});

test("sync-browser-session rejects malformed sso-rw before falling back to sso", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const secret = VALID_SESSION_TOKEN;
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([
    { name: "sso-rw", value: "decrypted-control-looking-cookie-value" },
    { name: "sso", value: secret },
  ]));

  let currentTokens = [];
  await withGrok2ApiServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: currentTokens }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      assert.fail("malformed preferred cookie should block mutation before add");
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/batch/refresh") {
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
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.selected_cookie, "sso-rw");
    assert.equal(parsed.error_code, "malformed_cookie_token");
    assert.match(parsed.error_message, /JWT-shaped/i);
    assert.doesNotMatch(result.stdout, /eyJhbGci/);
    assert.doesNotMatch(result.stderr, /eyJhbGci/);
  });
});

test("sync-browser-session append mode keeps existing same-pool tokens", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const secret = VALID_SESSION_TOKEN;
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: secret }]));

  const requests = [];
  let currentTokens = [{ token: "prior-super-token", pool: "super", status: "active", quota: {} }];
  await withGrok2ApiServer(async (req, res) => {
    requests.push(req.method);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: currentTokens }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      currentTokens.push({ token: secret, pool: "super", status: "active", quota: {} });
      res.end(JSON.stringify({ status: "success", count: 1 }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/batch/refresh") {
      res.end(JSON.stringify({ status: "success" }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/admin/api/tokens") {
      currentTokens = [];
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
      "--append",
    ]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.deleted_count, 0);
    assert.deepEqual(currentTokens.map((entry) => entry.token), ["prior-super-token", secret]);
    assert.doesNotMatch(result.stdout, /eyJhbGci/);
  });

  assert.deepEqual(requests, ["GET", "POST", "POST", "GET"]);
});

test("sync-browser-session does not delete existing tokens when add fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const secret = VALID_SESSION_TOKEN;
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: secret }]));

  const requests = [];
  let currentTokens = [{ token: "prior-working-token", pool: "super", status: "active", quota: {} }];
  await withGrok2ApiServer(async (req, res) => {
    requests.push(req.method);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: currentTokens }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "add failed" } }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/admin/api/tokens") {
      currentTokens = [];
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
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error_code, "grok2api_import_failed");
    assert.equal(parsed.previous_pool_count, 1);
    assert.equal(parsed.pool_emptied, false);
    assert.deepEqual(currentTokens, [{ token: "prior-working-token", pool: "super", status: "active", quota: {} }]);
    assert.doesNotMatch(result.stdout, /eyJhbGci/);
  });

  assert.deepEqual(requests, ["GET", "POST"]);
});

test("sync-browser-session reports stale token count when old-token deletion fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const secret = VALID_SESSION_TOKEN;
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: secret }]));

  let currentTokens = [{ token: "prior-working-token", pool: "super", status: "active", quota: {} }];
  await withGrok2ApiServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: currentTokens }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      currentTokens.push({ token: secret, pool: "super", status: "active", quota: {} });
      res.end(JSON.stringify({ status: "success", count: 1 }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/batch/refresh") {
      res.end(JSON.stringify({ status: "success" }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/admin/api/tokens") {
      const body = await readJsonRequest(req);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: `delete failed for ${JSON.stringify(body)}` } }));
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
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error_code, "grok2api_import_failed");
    assert.equal(parsed.previous_pool_count, 1);
    assert.equal(parsed.pool_emptied, false);
    assert.equal(parsed.stale_token_count, 1);
    assert.doesNotMatch(result.stdout, /eyJhbGci/);
    assert.doesNotMatch(result.stdout, /prior-working-token/);
  });
});

test("sync-browser-session preserves grok2api_timeout during mid-import hangs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const secret = VALID_SESSION_TOKEN;
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: secret }]));

  await withGrok2ApiServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: [{ token: "prior-working-token", pool: "super", status: "active", quota: {} }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      req.resume();
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "--cookie-source-json", cookieSource,
      "--grok2api-base-url", baseUrl,
      "--pool", "super",
      "--admin-timeout-ms", "300",
    ]);
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error_code, "grok2api_timeout");
    assert.equal(parsed.previous_pool_count, 1);
    assert.equal(parsed.pool_emptied, false);
    assert.doesNotMatch(result.stdout, /eyJhbGci/);
    assert.doesNotMatch(result.stdout, /prior-working-token/);
  });
});

test("sync-browser-session redacts existing pool tokens when append import fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const secret = VALID_SESSION_TOKEN;
  const existingToken = "prior-working-token";
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: secret }]));

  await withGrok2ApiServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: [{ token: existingToken, pool: "super", status: "active", quota: {} }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: `append conflict with ${existingToken}` } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "--cookie-source-json", cookieSource,
      "--grok2api-base-url", baseUrl,
      "--pool", "super",
      "--append",
      "true",
    ]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /eyJhbGci/);
    assert.doesNotMatch(result.stdout, /prior-working-token/);
    assert.match(result.stdout, /\[REDACTED\]/);
  });
});

test("sync-browser-session redacts before truncating non-json admin errors", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const secret = VALID_SESSION_TOKEN;
  const adminKey = "abc1234";
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: secret }]));

  await withGrok2ApiServer(async (req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      res.statusCode = 500;
      res.end(`${"x".repeat(195)}${adminKey}`);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  }, async (baseUrl) => {
    const result = await runAsync([
      "--cookie-source-json", cookieSource,
      "--grok2api-base-url", baseUrl,
      "--admin-key", adminKey,
    ]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /abc12/);
    assert.match(result.stdout, /\[REDACTED\]/);
  });
});

test("sync-browser-session redacts short custom admin keys from import failures", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const secret = VALID_SESSION_TOKEN;
  const adminKey = "abc1234";
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: secret }]));

  await withGrok2ApiServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: `Bearer ${adminKey} failed` } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "--cookie-source-json", cookieSource,
      "--grok2api-base-url", baseUrl,
      "--admin-key", adminKey,
    ]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, new RegExp(adminKey));
    assert.match(result.stdout, /\[REDACTED\]/);
  });
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

test("sync-browser-session times out stalled grok2api admin calls before reading cookies", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-sync-"));
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([{ name: "sso-rw", value: "secret-value-that-must-not-load" }]));

  await withGrok2ApiServer(async () => {
    // Intentionally keep the connection open until the helper aborts the call.
  }, async (baseUrl) => {
    const result = await runAsync([
      "--cookie-source-json", cookieSource,
      "--grok2api-base-url", baseUrl,
      "--admin-timeout-ms", "50",
    ]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error_code, "grok2api_unreachable");
    assert.doesNotMatch(result.stdout, /secret-value-that-must-not-load/);
    assert.doesNotMatch(result.stderr, /secret-value-that-must-not-load/);
  });
});

test("chrome cookie decrypt helper handles v10/v11 ciphertext and rejects unsupported formats", () => {
  const script = `
    import { createCipheriv, pbkdf2Sync } from "node:crypto";
    import { chromeDecrypt } from ${JSON.stringify(SYNC)};
    const password = "test-safe-storage-password";
    const plaintext = "plain-cookie-value";
    const key = pbkdf2Sync(Buffer.from(password, "utf8"), Buffer.from("saltysalt"), 1003, 16, "sha1");
    const iv = Buffer.alloc(16, " ");
    function encryptedHex(version) {
      const cipher = createCipheriv("aes-128-cbc", key, iv);
      return Buffer.concat([Buffer.from(version), cipher.update(plaintext, "utf8"), cipher.final()]).toString("hex");
    }
    if (chromeDecrypt(encryptedHex("v10"), password) !== plaintext) throw new Error("v10 decrypt failed");
    if (chromeDecrypt(encryptedHex("v11"), password) !== plaintext) throw new Error("v11 decrypt failed");
    try {
      chromeDecrypt(Buffer.from("v12bad").toString("hex"), password);
      throw new Error("unsupported format did not throw");
    } catch (error) {
      if (!/unsupported encrypted cookie format/.test(error.message)) throw error;
    }
    try {
      chromeDecrypt(Buffer.from("v20bad").toString("hex"), password);
      throw new Error("v20 format did not throw");
    } catch (error) {
      if (!/v20 app-bound encrypted cookies are not supported/.test(error.message)) throw error;
      if (!/--cookie-source-json/.test(error.message)) throw error;
      if (!/local tunnel/.test(error.message)) throw error;
    }
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(stdout, "");
});

test("unexpected sync errors redact explicit admin keys", () => {
  const script = `
    import { redactUnexpectedError } from ${JSON.stringify(SYNC)};
    const rendered = redactUnexpectedError(new Error("admin failure abc1234-secret-key"), ["--admin-key", "abc1234-secret-key"], {});
    if (rendered.includes("abc1234")) throw new Error(rendered);
    if (!rendered.includes("[REDACTED]")) throw new Error(rendered);
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(stdout, "");
});

test("cookie extraction errors redact local paths and admin keys", () => {
  const script = `
    import { redactCookieExtractError } from ${JSON.stringify(SYNC)};
    const source = "/tmp/private-profile/cookies.json";
    const rendered = redactCookieExtractError(
      new Error("failed reading /tmp/private-profile/cookies.json with admin abc1234-secret-key"),
      ["--cookie-source-json", source, "--admin-key", "abc1234-secret-key"],
      {},
    );
    if (rendered.includes(source)) throw new Error(rendered);
    if (rendered.includes("abc1234")) throw new Error(rendered);
    if (!rendered.includes("[REDACTED]")) throw new Error(rendered);
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(stdout, "");
});
