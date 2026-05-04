import { once } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
  assert.doesNotMatch(result.stderr, /secret|token|cookie|xai/i);
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
    assert.match(body.messages[0].content, /review\.js/);
    assert.match(body.messages[0].content, /export const value = 42/);
    assert.match(body.messages[0].content, /BEGIN GROK FILE 1: review\.js/);
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
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(record.target, "grok-web");
    assert.equal(record.provider, "grok-web");
    assert.equal(record.auth_mode, "subscription_web");
    assert.equal(record.status, "completed");
    assert.equal(record.result, "Verdict: no findings 1.");
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

test("custom-review preserves canonical JobRecord when state index is malformed", async () => {
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
    assert.match(record.disclosure_note, /JobRecord persistence failed/i);

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
    assert.match(lookedUp.disclosure_note, /JobRecord persistence failed/i);
  });
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
        GROK_WEB_TIMEOUT_MS: "100",
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 1);
    assert.ok(receivedBytes > 0);
    assert.equal(record.error_code, "tunnel_timeout");
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
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  execFileSync("git", ["add", "review.js"], { cwd });
  execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
  writeFileSync(path.join(cwd, "review.js"), "export const value = 2;\n");

  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/chat/completions");
    const body = await readJsonRequest(req);
    assert.match(body.messages[0].content, /review\.js/);
    assert.match(body.messages[0].content, /export const value = 2/);
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
      "--scope-base", "main",
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
      },
    });
    const record = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(record.status, "completed");
    assert.equal(record.mode, "review");
    assert.equal(record.scope, "branch-diff");
    assert.equal(record.scope_base, "main");
    assert.equal(record.result, "Verdict: branch diff reviewed.");
  });
});

for (const { status, code } of [
  { status: 401, code: "session_expired" },
  { status: 403, code: "session_expired" },
  { status: 429, code: "usage_limited" },
  { status: 500, code: "tunnel_error" },
]) {
  test(`custom-review maps HTTP ${status} to ${code} without leaking secrets`, async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
    writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

    await withServer(async (_req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "Authorization: Bearer secret-cookie-like-token failed" } }));
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
      assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
      assert.match(record.error_message, /\[REDACTED\]/);
    });
  });
}

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
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.suggested_action, /Start the local Grok web tunnel/i);
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
