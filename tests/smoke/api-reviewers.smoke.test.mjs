import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { externalReviewLaunchedEvent } from "../../scripts/lib/companion-common.mjs";
import { CONCURRENCY_FACTS, resolveConcurrencyAdmission } from "../../scripts/lib/provider-route-policy.mjs";
import { assertJobRecordShape } from "../helpers/job-record-shape.mjs";
import { badVerdictReviewFixture, requestChangesReviewFixture, substantiveReviewFixture } from "../helpers/review-fixtures.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/api-reviewers/scripts/api-reviewer.mjs");
const SESSION_APPROVAL_POLICY = JSON.parse(readFileSync(path.join(REPO_ROOT, "plugins/api-reviewers/config/session-approval.json"), "utf8"));
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
  "credential_source",
  "endpoint",
  "http_status",
  "raw_model",
  "schema_version",
]);

function approvalArgsForRun(args) {
  if (args[0] !== "run") return null;
  const approvalArgs = ["approval-request"];
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--foreground" || token === "--background") continue;
    if (token === "--lifecycle-events" || token === "--approval-token") {
      index += 1;
      continue;
    }
    approvalArgs.push(token);
  }
  return approvalArgs;
}

async function run(args, { cwd = REPO_ROOT, env = {}, companion = COMPANION } = {}) {
  let finalArgs = args;
  if (env.API_REVIEWERS_TEST_AUTO_APPROVAL !== "0" && !args.includes("--approval-token")) {
    const approvalArgs = approvalArgsForRun(args);
    if (approvalArgs) {
      const approval = await run(approvalArgs, {
        cwd,
        companion,
        env: {
          ...env,
          API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        },
      });
      if (approval.status === 0) {
        const parsed = parseJson(approval.stdout);
        finalArgs = [...args, "--approval-token", parsed.approval_token.value];
      }
    }
  }
  return new Promise((resolve) => {
    const workloadLockDir = env.RELAY_PROVIDER_WORKLOAD_LOCK_DIR
      ?? path.join(env.API_REVIEWERS_PLUGIN_DATA ?? cwd, ".provider-workload");
    execFile(process.execPath, [companion, ...finalArgs], {
      cwd,
      env: {
        ...process.env,
        API_REVIEWERS_DISABLE_ENV_CACHE: "1",
        RELAY_PROVIDER_WORKLOAD_LOCK_DIR: workloadLockDir,
        RELAY_WORKLOAD_TEST_MODE: "1",
        ...env,
      },
      timeout: 10000,
    }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, status: error?.code ?? 0 });
    });
  });
}

async function runExecutable(args, { cwd = REPO_ROOT, env = {}, executable } = {}) {
  return new Promise((resolve) => {
    const workloadLockDir = env.RELAY_PROVIDER_WORKLOAD_LOCK_DIR
      ?? path.join(env.API_REVIEWERS_PLUGIN_DATA ?? cwd, ".provider-workload");
    execFile(executable, args, {
      cwd,
      env: {
        ...process.env,
        API_REVIEWERS_DISABLE_ENV_CACHE: "1",
        RELAY_PROVIDER_WORKLOAD_LOCK_DIR: workloadLockDir,
        RELAY_WORKLOAD_TEST_MODE: "1",
        ...env,
      },
      timeout: 10000,
    }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, status: error?.code ?? 0 });
    });
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function canonicalJsonForTest(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonForTest(item)).join(",")}]`;
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
    return JSON.stringify(value);
  }
  if (type === "object") {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonForTest(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new Error(`canonical_json_unsupported:${type}`);
}

function approvalFingerprintForTest(approvalTuple) {
  return createHash("sha256").update(canonicalJsonForTest(approvalTuple)).digest("hex");
}

function parseJsonLines(stdout) {
  return stdout.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

function parseCompactJsonLines(stdout) {
  return stdout.split(/\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
}

async function waitForValue(fn, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail("timed out waiting for expected value");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockResponse(model, id = "chatcmpl-test", content = substantiveReviewFixture(`Provider model: ${model}`)) {
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

async function importApiReviewerInternalsForTest() {
  return await import(new URL("../../plugins/api-reviewers/scripts/api-reviewer.mjs", import.meta.url).href);
}

function makeWorkspace() {
  const cwd = mkdtempSync(path.join(tmpdir(), "api-reviewers-smoke-"));
  writeFileSync(path.join(cwd, "seed.txt"), "hello from selected scope\n");
  return cwd;
}

function writeOccupiedApiReviewerWorkloadSlots({ provider, cwd, dataDir }) {
  const route = "direct_api";
  const workloadLockDir = path.join(dataDir, ".provider-workload");
  const env = {
    RELAY_PROVIDER_WORKLOAD_LOCK_DIR: workloadLockDir,
    RELAY_WORKLOAD_TEST_MODE: "1",
    RELAY_BOOT_ID: "TEST",
  };
  const fact = CONCURRENCY_FACTS[provider]?.[route];
  assert.ok(fact, `expected concurrency fact for ${provider}.${route}`);
  const admission = resolveConcurrencyAdmission({
    category: fact.category,
    declaredLimit: fact.limit,
    limitEnv: fact.limit_env,
    provider,
    route,
    env,
  });
  assert.equal(admission.concurrencyKey, `${provider}.${route}`);
  mkdirSync(admission.lockRoot, { recursive: true });
  for (let index = 0; index < admission.limit; index += 1) {
    const holder = {
      schema_version: 1,
      provider,
      concurrency_key: admission.concurrencyKey,
      key_slug: admission.concurrencyKey,
      job_id: `held-api-reviewer-workload-${index}`,
      pid: process.pid,
      boot_id: env.RELAY_BOOT_ID,
      hostname: hostname(),
      cwd,
      started_at: new Date().toISOString(),
      token: `blocked-boundary-token-${index}`,
    };
    writeFileSync(
      path.join(admission.lockRoot, `${admission.concurrencyKey}.slot-${index}.json`),
      `${JSON.stringify(holder)}\n`,
    );
  }
  return { admission, env };
}

async function createGlmSessionGrant({ cwd, dataDir, prompt = "Review seed file only.", ttlMs = "900000", env = {} } = {}) {
  const commonArgs = [
    "--provider", "glm",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--prompt", prompt,
  ];
  const commonEnv = {
    API_REVIEWERS_PLUGIN_DATA: dataDir,
    ZAI_API_KEY: "secret-test-value",
    ...env,
  };
  const requestResult = await run([
    "approval-grant",
    "request",
    ...commonArgs,
    "--grant-ttl-ms", ttlMs,
  ], { cwd, env: commonEnv });
  assert.equal(requestResult.status, 0, requestResult.stderr || requestResult.stdout);
  const request = parseJson(requestResult.stdout);
  const activationResult = await run([
    "approval-grant",
    "activate",
    ...commonArgs,
    "--grant-expires-at", request.grant_bounds.expires_at,
    "--approval-token", request.grant_approval_token.value,
  ], { cwd, env: commonEnv });
  assert.equal(activationResult.status, 0, activationResult.stderr || activationResult.stdout);
  return {
    commonArgs,
    env: commonEnv,
    request,
    activation: parseJson(activationResult.stdout),
  };
}

function expireGlmSessionGrantRecord(dataDir, activation, expiresAt = new Date(Date.now() - 1000).toISOString()) {
  const file = path.join(dataDir, "approval-grants", `${activation.grant_id}.json`);
  const record = parseJson(readFileSync(file, "utf8"));
  record.expires_at = expiresAt;
  record.approval_tuple.grant_bounds.expires_at = expiresAt;
  const fingerprint = approvalFingerprintForTest(record.approval_tuple);
  record.approval_fingerprint = fingerprint;
  record.grant_id = `grant_${fingerprint}`;
  record.grant_session_id = `session_${fingerprint.slice(0, 32)}`;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

function makeMultiFileScopeWorkspace() {
  const cwd = mkdtempSync(path.join(tmpdir(), "api-reviewers-multifile-"));
  for (let i = 1; i <= 5; i += 1) {
    const filler = `file ${i} content line ${"x".repeat(40)}\n`.repeat(26);
    writeFileSync(path.join(cwd, `f${i}.txt`), filler);
  }
  writeFileSync(path.join(cwd, "seed.txt"), "hello from selected scope\n");
  return cwd;
}

function apiReviewerMetaPath(dataDir, jobId) {
  const candidate = path.join(dataDir, "jobs", jobId, "meta.json");
  assert.equal(existsSync(candidate), true, `expected meta.json for ${jobId}`);
  return candidate;
}

function defaultApiReviewerDataRoot(cwd) {
  const workspace = path.resolve(cwd);
  const slug = path.basename(workspace).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return path.resolve(tmpdir(), "relay", "api-reviewers", `${slug}-${hash}`);
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

function makeOpEnvCacheHome(values) {
  const home = mkdtempSync(path.join(tmpdir(), "api-reviewers-op-home-"));
  const cacheDir = path.join(home, ".cache", "op");
  mkdirSync(cacheDir, { recursive: true });
  const envFile = path.join(cacheDir, "env.sh");
  const lines = Object.entries(values).map(([name, value]) => `export ${name}='${value}'`);
  writeFileSync(envFile, `${lines.join("\n")}\n`, "utf8");
  chmodSync(envFile, 0o600);
  return home;
}

function writeSingleProviderConfig(pluginRoot, provider, cfg) {
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), JSON.stringify({
    [provider]: cfg,
  }, null, 2));
}

test("packaged direct API providers expose one canonical credential env key each", () => {
  const providers = JSON.parse(readFileSync(
    path.join(REPO_ROOT, "plugins", "api-reviewers", "config", "providers.json"),
    "utf8",
  ));
  assert.deepEqual(providers.deepseek.env_keys, ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(providers.glm.env_keys, ["ZAI_API_KEY"]);
  for (const [provider, cfg] of Object.entries(providers)) {
    assert.equal(cfg.env_keys.length, 1, `${provider} must expose exactly one credential env key`);
  }
});

test("direct API reviewers default plugin state outside the reviewed workspace", async () => {
  const cwd = makeWorkspace();
  try {
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
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash"),
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    const record = parseJson(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(record.status, "completed");
    assert.equal(existsSync(path.join(cwd, ".codex-plugin-data")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
  return startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
  });
}

async function readChatRequest(req) {
  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

function respondSourceFreePreflight(body, res, model = "deepseek-v4-pro") {
  const prompt = body.messages?.[0]?.content ?? "";
  if (prompt !== "Return exactly: ok") return false;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(mockResponse(model, "chatcmpl-pre-send-preflight", "ok"));
  return true;
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

function makeEmptyBranchDiffWorkspace() {
  const cwd = makeWorkspace();
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  git(cwd, ["add", "seed.txt"]);
  git(cwd, ["commit", "-m", "seed"]);
  git(cwd, ["checkout", "-b", "feature"]);
  return cwd;
}

test("doctor reports DeepSeek API-key readiness by key name only", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  let requestBody = null;
  const server = await startChatServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requestBody = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(mockResponse("deepseek-v4-flash", "chatcmpl-doctor", "ok"));
    });
  });
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
    const result = await run(["doctor", "--provider", "deepseek"], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: { DEEPSEEK_API_KEY: "secret-test-value" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.provider, "deepseek");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.credential_ref, "DEEPSEEK_API_KEY");
    assert.equal(parsed.auth_mode, "api_key");
    assert.equal(parsed.provider_probe.status, "ok");
    assert.equal(parsed.provider_probe.source_content_transmission, "not_sent");
    assert.equal(requestBody.model, "deepseek-v4-flash");
    assert.equal(requestBody.messages.length, 1);
    assert.match(requestBody.messages[0].content, /Return exactly: ok/);
    assert.doesNotMatch(JSON.stringify(requestBody), /seed\.txt|hello from selected scope/);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

test("doctor missing key diagnoses current process env, not provider readiness", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const result = await run(["doctor", "--provider", "glm"], {
    companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
    env: { ZAI_API_KEY: "", ZAI_GLM_API_KEY: "" },
  });
  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.provider, "glm");
  assert.equal(parsed.status, "missing_key");
  assert.equal(parsed.ready, false);
  assert.deepEqual(parsed.credential_candidates, ["ZAI_API_KEY"]);
  assert.deepEqual(parsed.present_credential_env_keys, []);
  assert.match(parsed.next_action, /this Codex process cannot see a non-empty credential env var/i);
  assert.match(parsed.next_action, /restart or launch the session/i);
  assert.match(parsed.next_action, /ZAI_API_KEY/);
  assert.doesNotMatch(parsed.next_action, /ZAI_GLM_API_KEY/);
});

test("doctor loads direct API credential from owner-only op env cache when process env is missing", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const home = makeOpEnvCacheHome({
    DEEPSEEK_API_KEY: "cached-deepseek-test-value",
    _OP_KEYS_LOADED: "true",
  });
  let authorizationHeader = null;
  const server = await startChatServer((req, res) => {
    authorizationHeader = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("deepseek-v4-flash", "chatcmpl-doctor", "ok"));
  });
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
    const result = await run(["doctor", "--provider", "deepseek"], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        API_REVIEWERS_DISABLE_ENV_CACHE: "0",
        HOME: home,
        _OP_KEYS_LOADED: "",
        DEEPSEEK_API_KEY: "",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.provider, "deepseek");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.credential_ref, "DEEPSEEK_API_KEY");
    assert.equal(parsed.credential_source, "env_cache");
    assert.equal(parsed.provider_probe.status, "ok");
    assert.equal(authorizationHeader, "Bearer cached-deepseek-test-value");
    assert.doesNotMatch(result.stdout, /cached-deepseek-test-value/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor prefers refreshed owner-only op env cache over stale process env", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const home = makeOpEnvCacheHome({
    DEEPSEEK_API_KEY: "rotated-deepseek-test-value",
    _OP_KEYS_LOADED: "true",
  });
  let authorizationHeader = null;
  const server = await startChatServer((req, res) => {
    authorizationHeader = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("deepseek-v4-flash", "chatcmpl-doctor", "ok"));
  });
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
    const result = await run(["doctor", "--provider", "deepseek"], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        API_REVIEWERS_DISABLE_ENV_CACHE: "0",
        HOME: home,
        _OP_KEYS_LOADED: "",
        DEEPSEEK_API_KEY: "stale-deepseek-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.provider, "deepseek");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.credential_ref, "DEEPSEEK_API_KEY");
    assert.equal(parsed.provider_probe.status, "ok");
    assert.equal(authorizationHeader, "Bearer rotated-deepseek-test-value");
    assert.equal(parsed.credential_source, "env_cache");
    assert.doesNotMatch(result.stdout, /rotated-deepseek-test-value|stale-deepseek-test-value/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reports env credential source when no usable op env cache exists", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const home = mkdtempSync(path.join(tmpdir(), "api-reviewers-no-cache-home-"));
  let authorizationHeader = null;
  const server = await startChatServer((req, res) => {
    authorizationHeader = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("deepseek-v4-flash", "chatcmpl-doctor", "ok"));
  });
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
    const result = await run(["doctor", "--provider", "deepseek"], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        HOME: home,
        DEEPSEEK_API_KEY: "env-deepseek-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.provider, "deepseek");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.credential_ref, "DEEPSEEK_API_KEY");
    assert.equal(parsed.credential_source, "env");
    assert.equal(authorizationHeader, "Bearer env-deepseek-test-value");
    assert.doesNotMatch(result.stdout, /env-deepseek-test-value/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor keeps process env source when op env cache is disabled", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const home = makeOpEnvCacheHome({
    DEEPSEEK_API_KEY: "rotated-deepseek-test-value",
  });
  let authorizationHeader = null;
  const server = await startChatServer((req, res) => {
    authorizationHeader = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("deepseek-v4-flash", "chatcmpl-doctor", "ok"));
  });
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
    const result = await run(["doctor", "--provider", "deepseek"], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        API_REVIEWERS_DISABLE_ENV_CACHE: "1",
        HOME: home,
        DEEPSEEK_API_KEY: "env-deepseek-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.provider, "deepseek");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.credential_ref, "DEEPSEEK_API_KEY");
    assert.equal(parsed.credential_source, "env");
    assert.equal(authorizationHeader, "Bearer env-deepseek-test-value");
    assert.doesNotMatch(result.stdout, /rotated-deepseek-test-value|env-deepseek-test-value/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor unquotes env cache credentials before trailing comments", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const home = mkdtempSync(path.join(tmpdir(), "api-reviewers-op-home-"));
  const cacheDir = path.join(home, ".cache", "op");
  mkdirSync(cacheDir, { recursive: true });
  const envFile = path.join(cacheDir, "env.sh");
  writeFileSync(envFile, 'export DEEPSEEK_API_KEY="cached-deepseek-test-value" # loaded by op\n', "utf8");
  chmodSync(envFile, 0o600);
  let authorizationHeader = null;
  const server = await startChatServer((req, res) => {
    authorizationHeader = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("deepseek-v4-flash", "chatcmpl-doctor", "ok"));
  });
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
    const result = await run(["doctor", "--provider", "deepseek"], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: {
        API_REVIEWERS_DISABLE_ENV_CACHE: "0",
        HOME: home,
        _OP_KEYS_LOADED: "",
        DEEPSEEK_API_KEY: "",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(authorizationHeader, "Bearer cached-deepseek-test-value");
    assert.doesNotMatch(result.stdout, /cached-deepseek-test-value/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects prototype-shaped option keys", async () => {
  const result = await run(["doctor", "--__proto__", "polluted"], {
    env: { DEEPSEEK_API_KEY: "secret-test-value" },
  });
  const parsed = parseJson(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /unsupported option --__proto__/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("doctor ignores GLM legacy alias without leaking value", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("glm-5.1", "chatcmpl-doctor", "ok"));
  });
  try {
    const { port } = server.address();
    writeSingleProviderConfig(pluginRoot, "glm", {
      display_name: "GLM",
      auth_mode: "api_key",
      env_keys: ["ZAI_API_KEY"],
      base_url: `http://127.0.0.1:${port}`,
      model: "glm-5.1",
    });
    const result = await run(["doctor", "--provider", "glm"], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: { ZAI_API_KEY: "", ZAI_GLM_API_KEY: "secret-test-value" },
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.provider, "glm");
    assert.equal(parsed.ready, false);
    assert.equal(parsed.status, "missing_key");
    assert.deepEqual(parsed.credential_candidates, ["ZAI_API_KEY"]);
    assert.deepEqual(parsed.present_credential_env_keys, []);
    assert.doesNotMatch(parsed.next_action, /ZAI_GLM_API_KEY/);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

test("doctor source-free live probe classifies network sandbox failures", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  writeDeepSeekProviderConfig(pluginRoot, "http://127.0.0.1:9");

  const result = await run(["doctor", "--provider", "deepseek"], {
    companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
    env: {
      CODEX_SANDBOX: "seatbelt",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.provider, "deepseek");
  assert.equal(parsed.ready, false);
  assert.equal(parsed.status, "provider_unavailable");
  assert.equal(parsed.provider_probe.status, "provider_unavailable");
  assert.equal(parsed.provider_probe.source_content_transmission, "not_sent");
  assert.match(parsed.next_action, /network_access = true/);
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
  assert.match(parsed.next_action, /configured providers file/);
  assert.doesNotMatch(parsed.next_action, /plugins\/api-reviewers/);
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
  assert.deepEqual(parsed.commands, ["doctor", "ping", "approval-request", "approval-grant", "run", "result"]);
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

test("direct API reviewer maps held provider workload to a counts-only blocked terminal record", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-workload-block-"));
  const { admission, env: workloadEnv } = writeOccupiedApiReviewerWorkloadSlots({
    provider: "deepseek",
    cwd,
    dataDir,
  });
  try {
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
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "MUST_NOT_REACH_API_REVIEWER"),
        DEEPSEEK_API_KEY: "secret-test-value",
        ...workloadEnv,
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.provider, "deepseek");
    assert.equal(record.error_code, "provider_workload_blocked");
    assertDirectApiNotSent(record, "DeepSeek");
    assert.deepEqual(record.runtime_diagnostics.provider_workload, {
      reason: "active_same_provider_job",
      capacity: { active_count: admission.limit, limit: admission.limit },
    });
    // The deepEqual above pins the persisted shape to counts-only. The §8 holder-strip itself (when
    // a producer DOES attach a holder) is guarded by the cross-consumer injection test in
    // tests/unit/job-record.test.mjs — this smoke path's real producer never emits a holder, so a
    // bare `holder === undefined` assertion here would be vacuous (it cannot fail).
    assert.doesNotMatch(result.stdout, /held-api-reviewer-workload|blocked-boundary-token|MUST_NOT_REACH_API_REVIEWER|external_review_launched/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewer persistence prunes old terminal job directories without touching active or unsafe entries", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const jobsDir = path.join(dataDir, "jobs");
  mkdirSync(jobsDir, { recursive: true });

  const oldJobs = Array.from({ length: 51 }, (_, index) => {
    const id = `job_old_${String(index).padStart(2, "0")}`;
    const dir = path.join(jobsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, job_id: id, status: "completed" }) + "\n");
    writeFileSync(path.join(dir, "prompt.txt"), "stale prompt material\n");
    return {
      id,
      job_id: id,
      status: "completed",
      updatedAt: `2000-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    };
  });
  mkdirSync(path.join(jobsDir, "active_job"), { recursive: true });
  writeFileSync(path.join(jobsDir, "active_job", "prompt.txt"), "active prompt material\n");
  mkdirSync(path.join(jobsDir, "..unsafe"), { recursive: true });
  writeFileSync(path.join(jobsDir, "..unsafe", "prompt.txt"), "unsafe should remain\n");
  writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({
    version: 1,
    jobs: [
      ...oldJobs,
      { id: "active_job", job_id: "active_job", status: "running", updatedAt: "1999-01-01T00:00:00.000Z" },
      { id: "../unsafe", job_id: "../unsafe", status: "completed", updatedAt: "1998-01-01T00:00:00.000Z" },
    ],
  }, null, 2) + "\n");

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
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  const state = JSON.parse(readFileSync(path.join(dataDir, "state.json"), "utf8"));
  const retainedIds = state.jobs.map((job) => job.id);
  assert.equal(retainedIds.includes(record.id), true);
  assert.equal(retainedIds.includes("active_job"), true);
  assert.equal(existsSync(path.join(dataDir, "jobs", record.id, "meta.json")), true);
  assert.equal(existsSync(path.join(jobsDir, "active_job", "prompt.txt")), true);
  assert.equal(existsSync(path.join(jobsDir, "..unsafe", "prompt.txt")), true);
  assert.equal(existsSync(path.join(jobsDir, "job_old_00")), false);
  assert.ok(readdirSync(jobsDir).length <= 52, "prune should not retain all seeded terminal job directories");
});

test("direct API reviewer persistence discovers and prunes pre-state job directories", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const jobsDir = path.join(dataDir, "jobs");
  mkdirSync(jobsDir, { recursive: true });

  for (let index = 0; index < 51; index += 1) {
    const id = `job_disk_${String(index).padStart(2, "0")}`;
    const dir = path.join(jobsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
      id,
      job_id: id,
      status: "completed",
      provider: "deepseek",
      mode: "custom-review",
      ended_at: `2001-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    }) + "\n");
    writeFileSync(path.join(dir, "prompt.txt"), "stale prompt material\n");
  }
  mkdirSync(path.join(jobsDir, "active_disk"), { recursive: true });
  writeFileSync(path.join(jobsDir, "active_disk", "meta.json"), JSON.stringify({
    id: "active_disk",
    job_id: "active_disk",
    status: "running",
    provider: "deepseek",
    mode: "custom-review",
    updatedAt: "2000-01-01T00:00:00.000Z",
  }) + "\n");
  mkdirSync(path.join(jobsDir, "..unsafe"), { recursive: true });
  writeFileSync(path.join(jobsDir, "..unsafe", "meta.json"), JSON.stringify({
    id: "../unsafe",
    job_id: "../unsafe",
    status: "completed",
  }) + "\n");

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
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  const state = JSON.parse(readFileSync(path.join(dataDir, "state.json"), "utf8"));
  const retainedIds = state.jobs.map((job) => job.id);
  assert.equal(retainedIds.includes(record.id), true);
  assert.equal(retainedIds.includes("active_disk"), true);
  assert.equal(existsSync(path.join(jobsDir, record.id, "meta.json")), true);
  assert.equal(existsSync(path.join(jobsDir, "active_disk", "meta.json")), true);
  assert.equal(existsSync(path.join(jobsDir, "..unsafe", "meta.json")), true);
  assert.equal(existsSync(path.join(jobsDir, "job_disk_00")), false);
  assert.ok(readdirSync(jobsDir).length <= 52, "migration prune should not retain all directory-only jobs");
});

test("direct API reviewer pruning does not follow symlinked job dirs during tmp cleanup", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const jobsDir = path.join(dataDir, "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const outsideDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-outside-"));
  const outsideTmp = path.join(outsideDir, "meta.json.outside.tmp");
  writeFileSync(outsideTmp, "must not be deleted\n");

  const symlinkJobId = "job_symlink_tmp";
  symlinkSync(outsideDir, path.join(jobsDir, symlinkJobId), "dir");

  const oldJobs = Array.from({ length: 50 }, (_, index) => {
    const id = `job_keep_${String(index).padStart(2, "0")}`;
    const dir = path.join(jobsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, job_id: id, status: "completed" }) + "\n");
    return {
      id,
      job_id: id,
      status: "completed",
      updatedAt: `2002-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    };
  });
  writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({
    version: 1,
    jobs: [
      ...oldJobs,
      { id: symlinkJobId, job_id: symlinkJobId, status: "completed", updatedAt: "1999-01-01T00:00:00.000Z" },
    ],
  }, null, 2) + "\n");

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
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(outsideTmp), true, "tmp cleanup must not follow a symlinked job dir");
  assert.equal(existsSync(path.join(jobsDir, symlinkJobId)), false, "pruning should remove only the symlink node");
});

test("direct API reviewer concurrent cross-provider runs retain every completed job in state", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const runCount = 2;

  const results = await Promise.all(Array.from({ length: runCount }, (_, index) => run([
    "run",
    "--provider", index % 2 === 0 ? "deepseek" : "glm",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", `Check this file ${index}.`,
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse(index % 2 === 0 ? "deepseek-v4-pro" : "glm-5.1", `mock-${index}`),
      DEEPSEEK_API_KEY: "secret-test-value",
      ZAI_API_KEY: "secret-test-value",
    },
  })));

  for (const result of results) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const records = results.map((result) => parseJson(result.stdout));
  const state = JSON.parse(readFileSync(path.join(dataDir, "state.json"), "utf8"));
  const retainedIds = new Set(state.jobs.map((job) => job.id));
  for (const record of records) {
    assert.equal(existsSync(path.join(dataDir, "jobs", record.id, "meta.json")), true);
    assert.equal(retainedIds.has(record.id), true, `missing ${record.id} from state.json`);
  }
});

test("direct API reviewer lock does not reclaim a live old owner", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const lockDir = path.join(dataDir, ".state.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 120000).toISOString(),
    token: "live-test-owner",
  }) + "\n");
  const oldTime = new Date(Date.now() - 120000);
  utimesSync(lockDir, oldTime, oldTime);

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
      API_REVIEWERS_STATE_LOCK_TIMEOUT_MS: "150",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.match(record.disclosure_note, /JobRecord persistence failed: api_reviewer_state_lock_timeout/);
  assert.equal(existsSync(path.join(lockDir, "owner.json")), true);
  assert.equal(existsSync(path.join(dataDir, "jobs", record.id, "meta.json")), true);
  assert.equal(existsSync(path.join(dataDir, "state.json")), false);
});

test("direct API reviewer lock reclaims a dead same-host owner", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const lockDir = path.join(dataDir, ".state.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: 999999999,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 120000).toISOString(),
    token: "dead-test-owner",
  }) + "\n");
  const oldTime = new Date(Date.now() - 120000);
  utimesSync(lockDir, oldTime, oldTime);

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
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  const state = JSON.parse(readFileSync(path.join(dataDir, "state.json"), "utf8"));
  assert.equal(state.jobs.some((job) => job.id === record.id), true);
  assert.equal(existsSync(path.join(dataDir, "jobs", record.id, "meta.json")), true);
  assert.equal(existsSync(lockDir), false);
});

test("direct API reviewer lock does not reclaim a cross-host owner", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const lockDir = path.join(dataDir, ".state.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: 999999999,
    hostname: "remote-host.invalid",
    startedAt: new Date(Date.now() - 120000).toISOString(),
    token: "remote-test-owner",
  }) + "\n");
  const oldTime = new Date(Date.now() - 120000);
  utimesSync(lockDir, oldTime, oldTime);

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
      API_REVIEWERS_STATE_LOCK_TIMEOUT_MS: "150",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.match(record.disclosure_note, /JobRecord persistence failed: api_reviewer_state_lock_timeout/);
  assert.equal(existsSync(path.join(lockDir, "owner.json")), true);
  assert.equal(existsSync(path.join(dataDir, "jobs", record.id, "meta.json")), true);
  assert.equal(existsSync(path.join(dataDir, "state.json")), false);
});

test("direct API reviewer lock does not reclaim unreadable owner metadata", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const lockDir = path.join(dataDir, ".state.lock");
  mkdirSync(path.join(lockDir, "owner.json"), { recursive: true });
  const oldTime = new Date(Date.now() - 120000);
  utimesSync(lockDir, oldTime, oldTime);

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
      API_REVIEWERS_STATE_LOCK_TIMEOUT_MS: "150",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.match(record.disclosure_note, /JobRecord persistence failed: api_reviewer_state_lock_timeout/);
  assert.equal(existsSync(path.join(lockDir, "owner.json")), true);
  assert.equal(existsSync(path.join(dataDir, "jobs", record.id, "meta.json")), true);
  assert.equal(existsSync(path.join(dataDir, "state.json")), false);
});

test("direct API reviewer lock waits behind a live gate owner", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const gateDir = path.join(dataDir, ".state.lock.gate");
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(path.join(gateDir, "owner.json"), JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 120000).toISOString(),
    token: "live-gate-owner",
  }) + "\n");
  const oldTime = new Date(Date.now() - 120000);
  utimesSync(gateDir, oldTime, oldTime);

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
      API_REVIEWERS_STATE_LOCK_TIMEOUT_MS: "150",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.match(record.disclosure_note, /JobRecord persistence failed: api_reviewer_state_lock_timeout/);
  assert.equal(existsSync(path.join(gateDir, "owner.json")), true);
  assert.equal(existsSync(path.join(dataDir, "jobs", record.id, "meta.json")), true);
  assert.equal(existsSync(path.join(dataDir, "state.json")), false);
});

test("direct API reviewer restores current meta if pre-index artifact is pruned", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const jobsDir = path.join(dataDir, "jobs");
  const gateDir = path.join(dataDir, ".state.lock.gate");
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(path.join(gateDir, "owner.json"), JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    token: "test-held-gate",
  }) + "\n");

  const child = execFile(process.execPath, [
    COMPANION,
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
      ...process.env,
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_DISABLE_ENV_CACHE: "1",
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      API_REVIEWERS_STATE_LOCK_TIMEOUT_MS: "5000",
      RELAY_PROVIDER_WORKLOAD_LOCK_DIR: path.join(dataDir, ".provider-workload"),
      RELAY_WORKLOAD_TEST_MODE: "1",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
    timeout: 10000,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const childResult = new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({
        status: code ?? 0,
        stdout,
        stderr,
      });
    });
  });

  const jobId = await waitForValue(() => {
    try {
      return readdirSync(jobsDir).find((name) => existsSync(path.join(jobsDir, name, "meta.json")));
    } catch {
      return null;
    }
  });

  rmSync(path.join(jobsDir, jobId), { recursive: true, force: true });
  rmSync(gateDir, { recursive: true, force: true });

  const result = await childResult;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  const state = JSON.parse(readFileSync(path.join(dataDir, "state.json"), "utf8"));
  assert.equal(record.id, jobId);
  assert.equal(state.jobs.some((job) => job.id === record.id), true);
  assert.equal(existsSync(path.join(jobsDir, record.id, "meta.json")), true);
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
      API_REVIEWERS_TIMEOUT_MS: "234567",
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
  assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 234567);
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
    assert.equal(record.status, "failed", result.stdout || result.stderr);
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
  assert.match(record.suggested_action, /configured providers file/);
  assert.doesNotMatch(record.suggested_action, /plugins\/api-reviewers/);
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

test("run rejects Git binary policy errors distinctly before direct API scope collection", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "api-reviewers-git-policy-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const marker = path.join(cwd, "executed");
  const maliciousGit = path.join(cwd, "malicious-git");
  writeFileSync(maliciousGit, `#!/bin/sh\necho executed > ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
  chmodSync(maliciousGit, 0o700);
  writeFileSync(path.join(cwd, "seed.txt"), "selected source\n");

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
      DEEPSEEK_API_KEY: "secret-test-value",
      RELAY_GIT_BINARY: maliciousGit,
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "git_binary_rejected");
  assert.equal(record.error_cause, "git_binary_policy");
  assert.match(record.error_message, /RELAY_GIT_BINARY/);
  assert.match(record.suggested_action, /RELAY_GIT_BINARY|trusted Git/i);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(existsSync(marker), false, "rejected git override must not execute");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("approval-request rejects Git binary policy errors distinctly before source approval", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "api-reviewers-approval-git-policy-"));
  const marker = path.join(cwd, "executed");
  const maliciousGit = path.join(cwd, "malicious-git");
  writeFileSync(maliciousGit, `#!/bin/sh\necho executed > ${JSON.stringify(marker)}\nexit 0\n`, "utf8");
  chmodSync(maliciousGit, 0o700);
  writeFileSync(path.join(cwd, "seed.txt"), "selected source\n");

  const result = await run([
    "approval-request",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      DEEPSEEK_API_KEY: "secret-test-value",
      RELAY_GIT_BINARY: maliciousGit,
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.ok, false);
  assert.equal(record.provider, "deepseek");
  assert.equal(record.error_code, "git_binary_rejected");
  assert.match(record.error_message, /RELAY_GIT_BINARY/);
  assert.doesNotMatch(result.stdout, /external_review_approval_request/);
  assert.equal(existsSync(marker), false, "rejected git override must not execute");
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

test("direct API reviewer fails closed before provider contact when plugin data root is unwritable", async () => {
  const cwd = makeWorkspace();
  const dataRoot = path.join(tmpdir(), `api-reviewers-data-file-${Date.now()}-${process.pid}-secret-test-value`);
  writeFileSync(dataRoot, "not a directory\n");
  const pluginRoot = makeInstalledApiReviewersRoot();
  let requestCount = 0;
  const server = await startChatServer((req, res) => {
    requestCount += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("deepseek-v4-flash"));
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
        API_REVIEWERS_PLUGIN_DATA: dataRoot,
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });

    assert.equal(requestCount, 0);
    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.provider, "deepseek");
    assert.equal(record.error_code, "sandbox_blocked");
    assert.equal(record.error_cause, "sandbox_access");
    assert.match(record.suggested_action, /API_REVIEWERS_PLUGIN_DATA|writable/);
    assertDirectApiNotSent(record, "DeepSeek");
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

for (const scenario of [
  {
    provider: "deepseek",
    displayName: "DeepSeek",
    env: { DEEPSEEK_API_KEY: "secret-test-value" },
    envKeys: ["DEEPSEEK_API_KEY"],
    credentialRef: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-flash",
  },
  {
    provider: "glm",
    displayName: "GLM",
    env: { ZAI_API_KEY: "secret-test-value" },
    envKeys: ["ZAI_API_KEY"],
    credentialRef: "ZAI_API_KEY",
    model: "glm-5.1",
  },
]) {
  test(`installed api-reviewers package layout is self-contained for ${scenario.provider} doctor`, async () => {
    const pluginRoot = makeInstalledApiReviewersRoot();
    const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
    const server = await startChatServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(mockResponse(scenario.model, "chatcmpl-doctor", "ok"));
    });
    try {
      const { port } = server.address();
      const endpoint = `http://127.0.0.1:${port}`;
      writeSingleProviderConfig(pluginRoot, scenario.provider, {
        display_name: scenario.displayName,
        auth_mode: "api_key",
        env_keys: scenario.envKeys,
        base_url: endpoint,
        model: scenario.model,
      });
      const result = await run(["doctor", "--provider", scenario.provider], {
        companion,
        env: scenario.env,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = parseJson(result.stdout);
      assert.equal(parsed.provider, scenario.provider);
      assert.equal(parsed.ready, true);
      assert.equal(parsed.credential_ref, scenario.credentialRef);
      assert.equal(parsed.endpoint, endpoint);
      assert.equal(parsed.provider_probe.status, "ok");
      assert.doesNotMatch(result.stdout, /secret-test-value/);
    } finally {
      server.close();
    }
  });
}

test("installed api-reviewers bin executable runs doctor without internal script path", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const executable = path.join(pluginRoot, "bin", "api-reviewer");
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("glm-5.1", "chatcmpl-doctor", "ok"));
  });
  try {
    const { port } = server.address();
    const endpoint = `http://127.0.0.1:${port}`;
    writeSingleProviderConfig(pluginRoot, "glm", {
      display_name: "GLM",
      auth_mode: "api_key",
      env_keys: ["ZAI_API_KEY"],
      base_url: endpoint,
      model: "glm-5.1",
    });
    const result = await runExecutable(["doctor", "--provider", "glm"], {
      executable,
      env: { ZAI_API_KEY: "secret-test-value" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.provider, "glm");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.credential_ref, "ZAI_API_KEY");
    assert.equal(parsed.endpoint, endpoint);
    assert.equal(parsed.provider_probe.status, "ok");
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
    rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
  }
});

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
  const sourceText = "hello from selected scope\n// ``` nested markdown fence\n";
  writeFileSync(path.join(cwd, "seed.txt"), sourceText);
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
      API_REVIEWERS_TIMEOUT_MS: "123456",
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "BEGIN API REVIEWER FILE 1: seed.txt",
      API_REVIEWERS_MOCK_ASSERT_PROMPT_EXCLUDES: "\n```\n",
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
  assert.equal(record.credential_source, "env");
  assert.equal(record.schema_version, 10);
  assert.equal(record.review_metadata.prompt_contract_version, 1);
  assert.equal(record.review_metadata.prompt_provider, "DeepSeek");
  assert.equal(record.review_metadata.raw_output.http_status, 200);
  assert.match(record.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
  assert.deepEqual(record.review_metadata.audit_manifest.selected_source.files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    hashOk: /^[a-f0-9]{64}$/.test(file.content_hash.value),
  })), [
    { path: "seed.txt", bytes: sourceText.length, hashOk: true },
  ]);
  assert.equal(record.review_metadata.audit_manifest.request.model, "deepseek-v4-pro");
  assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 123456);
  assert.equal(record.review_metadata.audit_manifest.request.max_tokens, 65536);
    assert.equal(record.review_metadata.audit_manifest.request.temperature, 0);
    assert.equal(record.review_metadata.audit_manifest.request.stream, false);
    assert.match(record.review_metadata.audit_manifest.prompt_builder.plugin_commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(record.review_metadata.audit_manifest.auth_path, {
      auth_mode: "api_key",
      credential_ref: "DEEPSEEK_API_KEY",
      credential_source: "env",
    });
    assert.deepEqual(record.review_metadata.audit_manifest.billing_path, { endpoint: "https://api.deepseek.com", model: "deepseek-v4-pro" });
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, true);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "approved");
    assert.notEqual(
      record.review_metadata.audit_manifest.prompt_builder.plugin_commit,
      record.review_metadata.audit_manifest.git_identity.head_sha,
    "plugin_commit must identify the plugin source, not the reviewed repository head"
  );
  assert.equal(record.review_metadata.audit_manifest.provider_ids.session_id, "chatcmpl-test");
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("Check this file"), false);
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("hello from selected scope"), false);
  assert.equal(record.kimi_session_id, null);
  assert.equal(record.external_review.review_slot?.verdict, "approved");
  assert.equal(record.external_review.review_slot?.source_state, "sent");
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
    review_slot: record.external_review.review_slot,
    disclosure: "Selected source content was sent to DeepSeek through direct API auth.",
  });
  assert.equal(record.result.includes("Verdict: APPROVE"), true);
  assert.deepEqual(record.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("DeepSeek direct API persisted result redacts selected source body sentinel", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const sourceText = "SOURCE_BODY_SENTINEL_DO_NOT_PERSIST\n";
  writeFileSync(path.join(cwd, "seed.txt"), sourceText);
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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse(
        "deepseek-v4-pro",
        "chatcmpl-source-sentinel",
        substantiveReviewFixture("SOURCE_BODY_SENTINEL_DO_NOT_PERSIST"),
      ),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    const persisted = JSON.parse(readFileSync(apiReviewerMetaPath(dataDir, record.job_id), "utf8"));
    assert.equal(record.result.includes("Verdict: APPROVE"), true);
    assert.doesNotMatch(result.stdout, /SOURCE_BODY_SENTINEL_DO_NOT_PERSIST/);
    assert.doesNotMatch(JSON.stringify(persisted), /SOURCE_BODY_SENTINEL_DO_NOT_PERSIST/);
    assert.match(record.result, /\[redacted_source_excerpt\]/);
    assert.match(persisted.result, /\[redacted_source_excerpt\]/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run launch gate uses direct API credential from owner-only op env cache before source send", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-env-cache-run-"));
  const home = makeOpEnvCacheHome({
    DEEPSEEK_API_KEY: "cached-deepseek-test-value",
    _OP_KEYS_LOADED: "true",
  });
  try {
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
        API_REVIEWERS_DISABLE_ENV_CACHE: "0",
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
        HOME: home,
        _OP_KEYS_LOADED: "",
        DEEPSEEK_API_KEY: "",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.credential_ref, "DEEPSEEK_API_KEY");
    assert.equal(parsed.external_review.source_content_transmission, "sent");
    assert.doesNotMatch(result.stdout, /cached-deepseek-test-value/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("api reviewer result --job requires a job id", async () => {
  const result = await run(["result"], {
    cwd: makeWorkspace(),
    env: { API_REVIEWERS_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "api-reviewers-data-")) },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "bad_args");
  assert.match(parsed.error, /--job <id> is required/);
});

test("api reviewer result --job reports missing records as not_found", async () => {
  const result = await run(["result", "--job", "missing-job-123"], {
    cwd: makeWorkspace(),
    env: { API_REVIEWERS_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "api-reviewers-data-")) },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "not_found");
  assert.equal(parsed.job_id, "missing-job-123");
  assert.match(parsed.suggested_action, /--cwd <workspace used when the job was launched>/);
});

test("api reviewer result normalizes default data root to git workspace from subdirectories", async () => {
  const repo = makeWorkspace();
  const nested = path.join(repo, "nested");
  mkdirSync(nested);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const repoDataRoot = defaultApiReviewerDataRoot(repo);
  const nestedDataRoot = defaultApiReviewerDataRoot(nested);
  rmSync(repoDataRoot, { recursive: true, force: true });
  rmSync(nestedDataRoot, { recursive: true, force: true });

  try {
    const review = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd: nested,
      env: {
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(review.status, 0, review.stderr || review.stdout);
    const record = parseJson(review.stdout);

    const result = await run(["result", "--job", record.job_id, "--cwd", nested], {
      cwd: nested,
      env: { DEEPSEEK_API_KEY: "secret-test-value" },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(parseJson(result.stdout).job_id, record.job_id);
  } finally {
    rmSync(repoDataRoot, { recursive: true, force: true });
    rmSync(nestedDataRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("api reviewer result --job reports malformed records without echoing file contents", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const created = await run([
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
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const record = parseJson(created.stdout);
  writeFileSync(apiReviewerMetaPath(dataDir, record.job_id), "{ malformed secret-test-value");

  const result = await run(["result", "--job", record.job_id], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "malformed_record");
  assert.equal(parsed.job_id, record.job_id);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("api reviewer result --job rejects unsafe job ids before filesystem access", async () => {
  const result = await run(["result", "--job", "../../etc/passwd"], {
    cwd: makeWorkspace(),
    env: { API_REVIEWERS_PLUGIN_DATA: mkdtempSync(path.join(tmpdir(), "api-reviewers-data-")) },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "bad_args");
  assert.equal(parsed.error, "unsafe_job_id");
  assert.doesNotMatch(result.stdout, /\.\./);
  assert.doesNotMatch(result.stdout, /passwd/);
});

test("api reviewer result --job reports unreadable records without exposing paths", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const created = await run([
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
      ZAI_API_KEY: "secret-test-value",
    },
  });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const record = parseJson(created.stdout);
  const metaPath = apiReviewerMetaPath(dataDir, record.job_id);
  rmSync(metaPath);
  mkdirSync(metaPath);

  const result = await run(["result", "--job", record.job_id], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      ZAI_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "read_failed");
  assert.equal(parsed.job_id, record.job_id);
  assert.equal(parsed.error, "read_failed");
  assert.doesNotMatch(result.stdout, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("api reviewer result --job redacts configured nonstandard credential names at read time", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  writeSingleProviderConfig(pluginRoot, "deepseek", {
    display_name: "DeepSeek",
    auth_mode: "api_key",
    env_keys: ["CUSTOM_CRED"],
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  });
  const jobId = "custom-redaction-job";
  const jobDir = path.join(dataDir, "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(path.join(jobDir, "meta.json"), JSON.stringify({
    job_id: jobId,
    target: "deepseek",
    provider: "deepseek",
    result: "provider echoed custom-secret-1234",
    runtime_diagnostics: {
      detail: "custom-secret-1234",
    },
  }, null, 2));

  const result = await run(["result", "--job", jobId], {
    cwd,
    companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      CUSTOM_CRED: "custom-secret-1234",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.job_id, jobId);
  assert.equal(parsed.result, "provider echoed [REDACTED]");
  assert.equal(parsed.runtime_diagnostics.detail, "[REDACTED]");
  assert.doesNotMatch(result.stdout, /custom-secret-1234/);
});

test("api reviewer result --job fails closed when provider config cannot load for read-time redaction", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), "{ malformed custom-secret-1234");
  const jobId = "custom-redaction-config-error-job";
  const jobDir = path.join(dataDir, "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(path.join(jobDir, "meta.json"), JSON.stringify({
    job_id: jobId,
    target: "deepseek",
    provider: "deepseek",
    result: "provider echoed custom-secret-1234",
    runtime_diagnostics: {
      detail: "custom-secret-1234",
    },
  }, null, 2));

  const result = await run(["result", "--job", jobId], {
    cwd,
    companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      CUSTOM_CRED: "custom-secret-1234",
    },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "config_error");
  assert.equal(parsed.error, "provider_config_unavailable");
  assert.equal(parsed.job_id, jobId);
  assert.doesNotMatch(result.stdout, /custom-secret-1234/);
  assert.doesNotMatch(result.stderr, /custom-secret-1234/);
  assert.doesNotMatch(result.stdout, /malformed/);
});

test("api reviewer result --job fails closed when provider config is missing for read-time redaction", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  rmSync(path.join(pluginRoot, "config", "providers.json"));
  const jobId = "custom-redaction-missing-config-job";
  const jobDir = path.join(dataDir, "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(path.join(jobDir, "meta.json"), JSON.stringify({
    job_id: jobId,
    target: "deepseek",
    provider: "deepseek",
    result: "provider echoed custom-secret-1234",
  }, null, 2));

  const result = await run(["result", "--job", jobId], {
    cwd,
    companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      CUSTOM_CRED: "custom-secret-1234",
    },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "config_error");
  assert.equal(parsed.error, "provider_config_unavailable");
  assert.equal(parsed.job_id, jobId);
  assert.doesNotMatch(result.stdout, /custom-secret-1234/);
  assert.doesNotMatch(result.stderr, /custom-secret-1234/);
});

for (const { provider, model, key } of [
  { provider: "deepseek", model: "deepseek-v4-pro", key: "DEEPSEEK_API_KEY" },
  { provider: "glm", model: "glm-5.1", key: "ZAI_API_KEY" },
]) {
  test(`${provider} result --job returns a completed direct API JobRecord`, async () => {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
    const result = await run([
      "run",
      "--provider", provider,
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MOCK_RESPONSE: mockResponse(model),
        [key]: "secret-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseJson(result.stdout);

    const retrieved = await run([
      "result",
      "--job", record.job_id,
      "--cwd", cwd,
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        [key]: "secret-test-value",
      },
    });

    assert.equal(retrieved.status, 0, retrieved.stderr || retrieved.stdout);
    const parsed = parseJson(retrieved.stdout);
    assert.equal(parsed.job_id, record.job_id);
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.provider, provider);
    assert.equal(parsed.result, record.result);
    assert.doesNotMatch(retrieved.stdout, /secret-test-value/);
  });

  test(`${provider} result --job-id aliases --job for completed direct API JobRecords`, async () => {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
    const result = await run([
      "run",
      "--provider", provider,
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MOCK_RESPONSE: mockResponse(model),
        [key]: "secret-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseJson(result.stdout);

    const retrieved = await run([
      "result",
      "--job-id", record.job_id,
      "--cwd", cwd,
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        [key]: "secret-test-value",
      },
    });

    assert.equal(retrieved.status, 0, retrieved.stderr || retrieved.stdout);
    const parsed = parseJson(retrieved.stdout);
    assert.equal(parsed.job_id, record.job_id);
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.provider, provider);
    assert.equal(parsed.result, record.result);
    assert.doesNotMatch(retrieved.stdout, /secret-test-value/);
  });
}

test("direct API reviewer result resolves JobRecord from launched --cwd without plugin data", async () => {
  const callerCwd = makeWorkspace();
  const reviewCwd = makeWorkspace();
  try {
    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--cwd", reviewCwd,
      "--prompt", "Check this file.",
    ], {
      cwd: callerCwd,
      env: {
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.cwd, reviewCwd);
    assert.equal(record.workspace_root, reviewCwd);

    const retrieved = await run([
      "result",
      "--job", record.job_id,
      "--cwd", reviewCwd,
    ], {
      cwd: callerCwd,
      env: {
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });

    assert.equal(retrieved.status, 0, retrieved.stderr || retrieved.stdout);
    const parsed = parseJson(retrieved.stdout);
    assert.equal(parsed.job_id, record.job_id);
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.workspace_root, reviewCwd);
  } finally {
    rmSync(defaultApiReviewerDataRoot(callerCwd), { recursive: true, force: true });
    rmSync(defaultApiReviewerDataRoot(reviewCwd), { recursive: true, force: true });
    rmSync(callerCwd, { recursive: true, force: true });
    rmSync(reviewCwd, { recursive: true, force: true });
  }
});

test("direct API reviewers fail closed on shallow HTTP 200 review output", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const shallowResult = "Verdict: APPROVE\nNo blocking findings.";
  writeFileSync(path.join(cwd, "seed.txt"), "export const value = 1;\n");

  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Review this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "chatcmpl-shallow", shallowResult),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "review_not_completed");
  assert.match(record.error_summary, /shallow_output/);
  assert.equal(record.result, shallowResult);
  assert.equal(record.external_review.source_content_transmission, "sent");
  assert.equal(typeof record.review_metadata.raw_output.elapsed_ms, "number");
  assert.ok(record.review_metadata.raw_output.elapsed_ms >= 0);
  assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, true);
  assert.deepEqual(record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons, ["shallow_output"]);
});

test("direct API reviewers guide substantive missing-verdict retry without automatic resend", async () => {
  const cases = [
    { provider: "deepseek", model: "deepseek-v4-pro", env: { DEEPSEEK_API_KEY: "secret-test-value" } },
    { provider: "glm", model: "glm-5.1", env: { ZAI_API_KEY: "secret-test-value" } },
  ];

  for (const c of cases) {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), `api-reviewers-${c.provider}-bad-verdict-data-`));
    const badResult = badVerdictReviewFixture(`Provider marker: ${c.provider}.`);
    writeFileSync(path.join(cwd, "seed.txt"), "export const value = 1;\n");

    try {
      const result = await run([
        "run",
        "--provider", c.provider,
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--foreground",
        "--prompt", "Review this file.",
      ], {
        cwd,
        env: {
          API_REVIEWERS_PLUGIN_DATA: dataDir,
          API_REVIEWERS_MOCK_RESPONSE: mockResponse(c.model, `chatcmpl-${c.provider}-bad-verdict`, badResult),
          ...c.env,
        },
      });

      assert.equal(result.status, 1, `${c.provider}: ${result.stderr || result.stdout}`);
      const record = parseJson(result.stdout);
      assert.equal(record.status, "failed", c.provider);
      assert.equal(record.error_code, "review_not_completed", c.provider);
      assert.equal(record.error_message, "review_quality_failed:missing_verdict", c.provider);
      assert.match(record.error_summary, /missing_verdict/, c.provider);
      assert.equal(record.result, badResult, c.provider);
      assert.equal(record.external_review.source_content_transmission, "sent", c.provider);
      assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, true, c.provider);
      assert.deepEqual(
        record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons,
        ["missing_verdict"],
        c.provider,
      );
      assert.match(record.suggested_action, /Treat this .* slot as failed/i, c.provider);
      assert.match(record.suggested_action, /Do not automatically resend selected source/i, c.provider);
      assert.match(record.suggested_action, /fresh matching approval token/i, c.provider);
      assert.match(record.suggested_action, /narrowing the scope/i, c.provider);
      assert.match(record.suggested_action, /sharding/i, c.provider);
      assert.match(record.suggested_action, /relaying/i, c.provider);
      const recovery = record.runtime_diagnostics?.packet_recovery;
      assert.ok(recovery, `${c.provider}: source-sent no-verdict failures must include packet_recovery`);
      assert.equal(record.error_code, recovery.reason, c.provider);
      assert.equal(recovery.provider_capabilities.supports_no_source_resume, false, c.provider);
      assert.deepEqual(
        recovery.actions.map((action) => action.type),
        ["resend_with_confirmation", "switch_provider", "waive_slot"],
        c.provider,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("direct API reviewers block same-packet resend after a failed source-sent slot", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-retry-guard-data-"));
  const badResult = badVerdictReviewFixture("Provider marker: deepseek retry guard.");
  const commonArgs = [
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Review this file.",
  ];
  const commonEnv = {
    API_REVIEWERS_PLUGIN_DATA: dataDir,
    API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "chatcmpl-retry-guard", badResult),
    DEEPSEEK_API_KEY: "secret-test-value",
  };

  try {
    writeFileSync(path.join(cwd, "seed.txt"), "export const value = 1;\n");

    const first = await run(commonArgs, { cwd, env: commonEnv });
    assert.equal(first.status, 1, first.stderr || first.stdout);
    const firstRecord = parseJson(first.stdout);
    assert.equal(firstRecord.error_code, "review_not_completed");
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");
    assert.equal(firstRecord.review_metadata.audit_manifest.review_quality.failed_review_slot, true);

    const second = await run(commonArgs, { cwd, env: commonEnv });
    assert.equal(second.status, 1, second.stderr || second.stdout);
    const secondRecord = parseJson(second.stdout);
    assert.equal(secondRecord.status, "failed");
    assert.equal(secondRecord.error_code, "review_slot_disposition_required");
    assert.equal(secondRecord.external_review.source_content_transmission, "not_sent");
    assert.equal(secondRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
    assert.equal(secondRecord.review_metadata.audit_manifest.review_slot.retry_disposition_required, true);
    assert.equal(
      secondRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "review_slot_retry_blocked",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers require resend confirmation even when large source packet override is approved", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-large-resend-confirmation-"));
  const files = [];
  for (let index = 0; index < 3; index += 1) {
    const file = `large-${index}.txt`;
    files.push(file);
    writeFileSync(path.join(cwd, file), "x".repeat(180 * 1024));
  }
  const badResult = badVerdictReviewFixture("Provider marker: deepseek large resend guard.");
  const commonArgs = [
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", files.join(","),
    "--foreground",
    "--allow-large-source-packet",
    "--prompt", "Review these files.",
  ];
  const commonEnv = {
    API_REVIEWERS_PLUGIN_DATA: dataDir,
    API_REVIEWERS_MAX_PROMPT_CHARS: "2000000",
    API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "chatcmpl-large-resend-guard", badResult),
    DEEPSEEK_API_KEY: "secret-test-value",
  };

  try {
    const first = await run(commonArgs, { cwd, env: commonEnv });
    assert.equal(first.status, 1, first.stderr || first.stdout);
    const firstRecord = parseJson(first.stdout);
    assert.equal(firstRecord.error_code, "review_not_completed");
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");
    assert.equal(firstRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action, "send_after_source_packet_override");

    const blocked = await run(
      [...commonArgs, "--review-slot-disposition", "retry"],
      { cwd, env: commonEnv },
    );
    assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
    const blockedRecord = parseJson(blocked.stdout);
    assert.equal(blockedRecord.error_code, "resend_confirmation_required");
    assert.equal(blockedRecord.external_review.source_content_transmission, "not_sent");
    const blockedPolicy = blockedRecord.review_metadata.audit_manifest.source_packet_policy;
    assert.equal(blockedPolicy.source_packet_action, "resend_confirmation_required");
    assert.equal(blockedPolicy.source_packet_override_approved, true);
    assert.equal(blockedPolicy.source_packet_override_source, "--allow-large-source-packet");
    assert.doesNotMatch(blocked.stdout, /external_review_launched/);

    const confirmed = await run(
      [...commonArgs, "--review-slot-disposition", "retry", "--resend-confirmation-approved"],
      {
        cwd,
        env: {
          ...commonEnv,
          API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "chatcmpl-large-resend-confirmed"),
        },
      },
    );
    assert.equal(confirmed.status, 0, confirmed.stderr || confirmed.stdout);
    const confirmedRecord = parseJson(confirmed.stdout);
    assert.equal(confirmedRecord.external_review.source_content_transmission, "sent");
    const confirmedPolicy = confirmedRecord.review_metadata.audit_manifest.source_packet_policy;
    assert.equal(confirmedPolicy.source_packet_action, "send_after_resend_confirmation");
    assert.equal(confirmedPolicy.source_packet_override_approved, true);
    assert.equal(confirmedPolicy.source_packet_override_source, "--allow-large-source-packet");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers block same-packet resend after a request-changes slot", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-request-changes-guard-data-"));
  const requestChangesResult = requestChangesReviewFixture("Provider marker: deepseek request changes guard.");
  const commonArgs = [
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Review this file.",
  ];
  const commonEnv = {
    API_REVIEWERS_PLUGIN_DATA: dataDir,
    API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "chatcmpl-request-changes-guard", requestChangesResult),
    DEEPSEEK_API_KEY: "secret-test-value",
  };

  try {
    writeFileSync(path.join(cwd, "seed.txt"), "export const value = 1;\n");

    const first = await run(commonArgs, { cwd, env: commonEnv });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstRecord = parseJson(first.stdout);
    assert.equal(firstRecord.status, "completed");
    assert.equal(firstRecord.external_review.review_slot?.verdict, "request_changes");
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");

    const second = await run(commonArgs, { cwd, env: commonEnv });
    assert.equal(second.status, 1, second.stderr || second.stdout);
    const secondRecord = parseJson(second.stdout);
    assert.equal(secondRecord.status, "failed");
    assert.equal(secondRecord.error_code, "review_slot_disposition_required");
    assert.equal(secondRecord.external_review.source_content_transmission, "not_sent");
    assert.equal(secondRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
    assert.equal(
      secondRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "review_slot_retry_blocked",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers approval-request blocks same-packet request-changes retry without disposition", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-approval-request-changes-"));
  const requestChangesResult = requestChangesReviewFixture("Provider marker: deepseek approval retry guard.");
  const commonArgs = [
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--prompt", "Review this file.",
  ];
  const commonEnv = {
    API_REVIEWERS_PLUGIN_DATA: dataDir,
    API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "chatcmpl-approval-request-changes", requestChangesResult),
    DEEPSEEK_API_KEY: "secret-test-value",
  };

  try {
    writeFileSync(path.join(cwd, "seed.txt"), "export const value = 1;\n");

    const first = await run(["run", ...commonArgs, "--foreground"], { cwd, env: commonEnv });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstRecord = parseJson(first.stdout);
    assert.equal(firstRecord.external_review.review_slot?.verdict, "request_changes");
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");

    const secondApproval = await run(["approval-request", ...commonArgs], {
      cwd,
      env: { ...commonEnv, API_REVIEWERS_TEST_AUTO_APPROVAL: "0" },
    });
    assert.equal(secondApproval.status, 1, secondApproval.stderr || secondApproval.stdout);
    const blocked = parseJson(secondApproval.stdout);
    assert.equal(blocked.error_code, "review_slot_disposition_required");
    assert.equal(blocked.runtime_diagnostics.review_slot.retry_count, 1);
    assert.equal(blocked.runtime_diagnostics.review_slot.verdict, "failed_slot");
    assert.equal(blocked.runtime_diagnostics.source_packet_policy.source_packet_action, "review_slot_retry_blocked");
    assert.equal(Object.hasOwn(blocked, "approval_token"), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers allow an explicit same-packet retry disposition", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-retry-disposition-data-"));
  const badResult = badVerdictReviewFixture("Provider marker: deepseek retry disposition.");
  const commonArgs = [
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--prompt", "Review this file.",
  ];
  const commonEnv = {
    API_REVIEWERS_PLUGIN_DATA: dataDir,
    API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "chatcmpl-retry-disposition", badResult),
    DEEPSEEK_API_KEY: "secret-test-value",
  };

  try {
    writeFileSync(path.join(cwd, "seed.txt"), "export const value = 1;\n");

    const first = await run(commonArgs, { cwd, env: commonEnv });
    assert.equal(first.status, 1, first.stderr || first.stdout);
    const firstRecord = parseJson(first.stdout);
    assert.equal(firstRecord.error_code, "review_not_completed");
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");

    const retried = await run(
      [...commonArgs, "--review-slot-disposition", "retry", "--resend-confirmation-approved"],
      {
        cwd,
        env: {
          ...commonEnv,
          API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "chatcmpl-retry-disposition-ok"),
        },
      },
    );
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    const retriedRecord = parseJson(retried.stdout);
    assert.equal(retriedRecord.external_review.source_content_transmission, "sent");
    assert.equal(retriedRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
    assert.equal(retriedRecord.review_metadata.audit_manifest.review_slot.retry_disposition_required, true);
    assert.equal(retriedRecord.review_metadata.audit_manifest.review_slot.disposition, "retry");
    assert.equal(retriedRecord.review_metadata.audit_manifest.review_slot.waiver_artifact, null);
    assert.equal(retriedRecord.review_metadata.audit_manifest.review_slot.override_artifact, null);
    assert.equal(
      retriedRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
      "send_after_resend_confirmation",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API JobRecord construction does not mutate execution input", async () => {
  const { buildRecord } = await importApiReviewerInternalsForTest();
  const startedAt = "2026-01-01T00:00:00.000Z";
  const endedAt = "2026-01-01T00:00:01.000Z";
  const execution = Object.freeze({
    exitCode: 0,
    parsed: {
      ok: true,
      result: substantiveReviewFixture("Inspection statement: I inspected seed.txt."),
      raw_model: "deepseek-v4-pro",
    },
    http_status: 200,
    session_id: "chatcmpl-test",
    payload_sent: true,
    prompt: "Review seed.txt\n\nSelected Source\nseed text",
    diagnostics: Object.freeze({
      configured_timeout_ms: 123456,
      elapsed_ms: 1000,
      prompt_chars: 42,
      request_defaults: Object.freeze({}),
      max_tokens: 65536,
      temperature: 0,
    }),
  });

  const record = buildRecord({
    provider: "deepseek",
    cfg: {
      display_name: "DeepSeek",
      env_keys: ["DEEPSEEK_API_KEY"],
      model: "deepseek-v4-pro",
    },
    mode: "custom-review",
    options: {
      jobId: "job-test",
      prompt: "Review seed.txt",
    },
    scopeInfo: {
      cwd: "/tmp/workspace",
      workspaceRoot: "/tmp/workspace",
      scope: "custom",
      scope_base: null,
      scope_paths: ["seed.txt"],
      files: [{ path: "seed.txt", text: "seed text\n" }],
      repository: "repo",
      head_ref: "main",
      base_commit: null,
      head_commit: "abc123",
    },
    execution,
    startedAt,
    endedAt,
  });

  assert.equal(record.status, "completed");
  assert.equal(record.review_metadata.raw_output.elapsed_ms, 1000);
  assert.equal(Object.hasOwn(execution, "review_metadata"), false);
});

test("direct API reviewer chooses a collision-free source delimiter", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  writeFileSync(path.join(cwd, "seed.txt"), [
    "BEGIN API REVIEWER FILE 1: seed.txt",
    "source content that resembles the default delimiter",
    "END API REVIEWER FILE 1: seed.txt",
    "",
  ].join("\n"));
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
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "BEGIN API REVIEWER FILE 1: seed.txt #",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.external_review.source_content_transmission, "sent");
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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash", "chatcmpl-test", substantiveReviewFixture("Echoed secret-test-value in provider output")),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.match(record.result, /Echoed \[REDACTED\] in provider output/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API reviewers redact cache-sourced provider echoes after cache rotation", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-cache-redaction-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const home = makeOpEnvCacheHome({
    DEEPSEEK_API_KEY: "rotated-cache-secret-value",
  });
  const envFile = path.join(home, ".cache", "op", "env.sh");
  let authorizationHeader = null;
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res, "deepseek-v4-flash")) return;
    authorizationHeader = req.headers.authorization ?? null;
    writeFileSync(envFile, "export DEEPSEEK_API_KEY='replacement-cache-secret-value'\n", "utf8");
    chmodSync(envFile, 0o600);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse(
      "deepseek-v4-flash",
      "chatcmpl-cache-rotation",
      substantiveReviewFixture("Provider echoed rotated-cache-secret-value after cache rotation"),
    ));
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
        API_REVIEWERS_DISABLE_ENV_CACHE: "0",
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        HOME: home,
        DEEPSEEK_API_KEY: "stale-process-secret-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.credential_ref, "DEEPSEEK_API_KEY");
    assert.equal(record.credential_source, "env_cache");
    assert.equal(authorizationHeader, "Bearer rotated-cache-secret-value");
    assert.match(record.result, /Provider echoed \[REDACTED\] after cache rotation/);
    assert.doesNotMatch(
      result.stdout,
      /rotated-cache-secret-value|replacement-cache-secret-value|stale-process-secret-value/,
    );
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
  }
});

test("direct API reviewers redact authorization-shaped provider echoes", async () => {
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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash", "chatcmpl-test", substantiveReviewFixture("Echoed Authorization: Bearer reflected-token-value\nAuthorization: Token abc1234\nBearer shrt\nBearer alternate-token-value")),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.match(record.result, /Authorization: \[REDACTED\]/);
  assert.match(record.result, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /reflected-token-value|Token abc1234|Bearer shrt|alternate-token-value/);
});

test("direct API reviewers redact configured non-API_KEY credential names", async () => {
  const cwd = makeWorkspace();
  const pluginRoot = makeInstalledApiReviewersRoot();
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), JSON.stringify({
    deepseek: {
      display_name: "DeepSeek",
      auth_mode: "api_key",
      env_keys: ["DEEPSEEK_CREDENTIAL"],
      base_url: "https://api.deepseek.com",
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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash", "chatcmpl-test", substantiveReviewFixture("Echoed token-token-value in provider output")),
      DEEPSEEK_CREDENTIAL: "token-token-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.credential_ref, "DEEPSEEK_CREDENTIAL");
  assert.match(record.result, /Echoed \[REDACTED\] in provider output/);
  assert.doesNotMatch(result.stdout, /token-token-value/);
});

test("direct API reviewers redact realistic short configured credentials without redacting one-byte collisions", async () => {
  const cwd = makeWorkspace();
  const pluginRoot = makeInstalledApiReviewersRoot();
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), JSON.stringify({
    deepseek: {
      display_name: "DeepSeek",
      auth_mode: "api_key",
      env_keys: ["DEEPSEEK_CREDENTIAL"],
      base_url: "https://api.deepseek.com",
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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash", "chatcmpl-test", substantiveReviewFixture("a normal alphabet payload")),
      DEEPSEEK_CREDENTIAL: "a",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.match(record.result, /a normal alphabet payload/);
  assert.doesNotMatch(result.stdout, /\[REDACTED\] normal/);

  const shortSecretResult = await run([
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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash", "chatcmpl-test", substantiveReviewFixture("provider echoed abcd")),
      DEEPSEEK_CREDENTIAL: "abcd",
    },
  });
  assert.equal(shortSecretResult.status, 0, shortSecretResult.stderr || shortSecretResult.stdout);
  const shortSecretRecord = parseJson(shortSecretResult.stdout);
  assert.equal(shortSecretRecord.status, "completed");
  assert.match(shortSecretRecord.result, /provider echoed \[REDACTED\]/);
  assert.doesNotMatch(shortSecretResult.stdout, /provider echoed abcd/);
});

test("direct API reviewer prompt names the selected provider", async () => {
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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "Provider: DeepSeek",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
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
        API_REVIEWERS_TIMEOUT_MS: "200",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    assert.notEqual(result.stdout, "", result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "timeout");
    assert.match(record.error_summary, /timeout after \d+ms/i);
    assert.match(record.error_summary, /configured_timeout_ms=200/);
    assert.match(record.error_summary, /selected_files=1/);
    assert.match(record.error_summary, /selected_bytes=\d+/);
    assert.match(record.error_summary, /prompt_chars=\d+/);
    assert.match(record.error_summary, /estimated_tokens=\d+/);
    const promptChars = Number(/prompt_chars=(\d+)/.exec(record.error_summary)?.[1]);
    const estimatedTokens = Number(/estimated_tokens=(\d+)/.exec(record.error_summary)?.[1]);
    assert.equal(estimatedTokens, Math.ceil(promptChars / 4));
    assert.match(record.error_message, /This operation was aborted|aborted|request timed out after/i);
    assert.match(record.suggested_action, /timeout/i);
    assert.match(record.suggested_action, /API_REVIEWERS_TIMEOUT_MS/);
    assert.match(record.suggested_action, /Do not automatically resend selected source/i);
    assert.match(record.suggested_action, /fresh matching approval token/i);
    assert.equal((record.suggested_action.match(/fresh matching approval token/gi) ?? []).length, 1);
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.external_review.disclosure,
      "Selected source content was sent to DeepSeek through direct API auth, but the provider did not return a clean result.");
  } finally {
    server.close();
  }
});

test("direct API generic 429 rate limits stay rate_limited and mark selected content as sent", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
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
    assert.equal(record.error_cause, "direct_api_provider");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.external_review.disclosure,
      "Selected source content was sent to DeepSeek through direct API auth, but the provider did not return a clean result.");
  } finally {
    server.close();
  }
});

test("direct API 429 quota status outranks unavailable wording and preserves numeric codes", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: 429,
        type: "rate_limit",
        message: "Payment required; service unavailable for the billing account.",
      },
    }));
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
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.error_cause, "cost_quota_usage_limit");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.http_status, 429);
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, "429");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, "rate_limit");
    assert.match(record.suggested_action, /Do not automatically resend selected source/i);
    assert.match(record.suggested_action, /fresh matching approval token/i);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API exhausted credits response points at usage limits instead of retry", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(429, { "content-type": "application/json", server: "cloudflare" });
    res.end(JSON.stringify({
      code: "Some resource has been exhausted",
      error: "Your team has either used all available credits or reached its monthly spending limit.",
    }));
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
    assert.equal(record.provider, "deepseek");
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.error_cause, "cost_quota_usage_limit");
    assert.equal(record.http_status, 429);
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.provider_request.prompt_chars, "Return exactly: ok".length);
    assert.match(record.suggested_action, /quota|usage-tier|billing|credit/i);
    assert.match(record.suggested_action, /fresh matching approval token/i);
    assertDirectApiNotSent(record, "DeepSeek");
    assert.doesNotMatch(result.stdout, /secret-test-value|monthly spending limit|available credits/i);
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
  }
});

test("direct API 403 quota payloads are usage_limited, not auth_rejected", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "insufficient_quota",
        type: "billing",
        message: "Credit limit exceeded for billing account user@example.com plan_id=pro+stripe-sub-abc/123.",
      },
    }));
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
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.error_cause, "cost_quota_usage_limit");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.http_status, 403);
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, "insufficient_quota");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, "billing");
    assert.doesNotMatch(result.stdout, /user@example\.com|stripe-sub|plan_id|secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API status-only quota failures use safe diagnostics", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "card_required",
        type: "checkout_required",
        message: "Payment required: see checkout session cs_test_abc123 and customer cus_NXLKj1H.",
      },
    }));
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
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.error_cause, "cost_quota_usage_limit");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.doesNotMatch(result.stdout, /cs_test|cus_NXLKj1H|secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API non-JSON quota payloads are usage_limited with safe diagnostics", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("insufficient_quota for billing account user@example.com plan_id=pro+stripe-sub-abc/123");
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
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.error_cause, "cost_quota_usage_limit");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.http_status, 403);
    assert.doesNotMatch(result.stdout, /user@example\.com|stripe-sub|plan_id|secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API 501 compatibility errors stay provider_error", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "insufficient_quota",
        type: "unsupported_operation",
        message: "The requested model or method is not implemented for this quota endpoint.",
      },
    }));
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
    assert.equal(record.error_code, "provider_error");
    assert.equal(record.error_cause, "direct_api_provider");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.runtime_diagnostics.cost_quota.http_status, 501);
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, "insufficient_quota");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, "unsupported_operation");
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API unlisted 5xx quota-looking errors stay provider_error", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(505, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "insufficient_quota",
        type: "unsupported_http_version",
        message: "quota endpoint unavailable for this unsupported HTTP version.",
      },
    }));
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
    assert.equal(record.error_code, "provider_error");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.runtime_diagnostics.cost_quota.http_status, 505);
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, "insufficient_quota");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, "unsupported_http_version");
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API auth failures outrank billing-looking error text", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "invalid_api_key",
        message: "API key rejected for a billing-gated quota tier.",
      },
    }));
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
    assert.equal(record.error_code, "auth_rejected");
    assert.equal(record.error_cause, "direct_api_provider");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.external_review.source_content_transmission, "sent");
  } finally {
    server.close();
  }
});

test("direct API 403 auth failure with bare error code stays auth_rejected", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "permission_denied",
        message: "Error code: 403\nAuthentication failed.",
      },
    }));
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
    assert.equal(record.error_code, "auth_rejected");
    assert.equal(record.error_cause, "direct_api_provider");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.runtime_diagnostics.cost_quota.http_status, 403);
  } finally {
    server.close();
  }
});

test("direct API non-quota rate wording on provider errors is not cost-quota usage limited", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "rate_limited",
        type: "server_overloaded",
        message: "Provider rate limit overloaded this shard.",
      },
    }));
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
    assert.equal(record.error_code, "provider_unavailable");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.external_review.source_content_transmission, "sent");
  } finally {
    server.close();
  }
});

test("direct API provider-unavailable wording keeps quota diagnostics aligned on 400s", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "billing_account_unavailable",
        type: "provider_unavailable",
        message: "billing account quota verifier unavailable; retry later",
      },
    }));
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
    assert.equal(record.error_code, "provider_unavailable");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, "billing_account_unavailable");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, "provider_unavailable");
    assert.equal(record.external_review.source_content_transmission, "sent");
  } finally {
    server.close();
  }
});

test("direct API preserves non-payment prefixed provider diagnostic tokens", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "in_progress",
        type: "sub_required",
        message: "Provider feature is still being enabled.",
      },
    }));
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
    assert.equal(record.error_code, "provider_error");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, "in_progress");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, "sub_required");
  } finally {
    server.close();
  }
});

test("direct API flat quota response keeps diagnostics aligned with error code", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      message: "quota exceeded for this billing account",
    }));
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
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.error_cause, "cost_quota_usage_limit");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.http_status, 400);
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, null);
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, null);
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API billing-provider outages are provider unavailable, not cost-quota usage limited", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "billing_provider_outage",
        type: "provider_unavailable",
        message: "billing account quota verifier unavailable for customer cus_NXLKj1H; retry later",
      },
    }));
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
    assert.equal(record.error_code, "provider_unavailable");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "not_reported");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.doesNotMatch(result.stdout, /cus_NXLKj1H/);
  } finally {
    server.close();
  }
});

test("direct API quota and billing failures are classified as usage_limited with safe diagnostics", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "insufficient_quota",
        type: "billing",
        message: "Credit limit exceeded for this billing cycle.",
      },
    }));
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
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.error_cause, "cost_quota_usage_limit");
    assert.match(record.suggested_action, /does not purchase credits|does not upgrade tiers/i);
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.http_status, 402);
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, "insufficient_quota");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, "billing");
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API cost-quota diagnostics drop PII-shaped provider error tokens", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "ii_1Mt5L0HabcDEF12345",
        type: "acct_test_12345",
        message: "Credit limit exceeded for this billing cycle.",
      },
    }));
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
    assert.equal(record.error_code, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, null);
    assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, null);
    assert.doesNotMatch(result.stdout, /ii_1Mt5L0HabcDEF12345|acct_test_12345/);
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
  assert.match(record.runtime_diagnostics.provider_request.fetch_error.name, /^(TypeError|Error)$/);
  assert.match(record.runtime_diagnostics.provider_request.fetch_error.message, /fetch failed|connect|refused/i);
  assert.match(
    JSON.stringify(record.runtime_diagnostics.provider_request.fetch_error),
    /bad port|ECONNREFUSED|connect|refused/i,
  );
  assert.match(record.suggested_action, /network_access = true/);
  assert.match(record.suggested_action, /outside sandbox/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API request timeout is classified as timeout with cause diagnostics", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  let reviewRequestCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const prompt = String(parsed.messages?.[0]?.content ?? "");
      if (prompt === "Return exactly: ok") {
        res.setHeader("content-type", "application/json");
        res.end(mockResponse("deepseek-v4-flash", "chatcmpl-doctor", "ok"));
        return;
      }
      reviewRequestCount += 1;
      // Keep the source-bearing request open so the client timeout owns classification.
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
        API_REVIEWERS_TIMEOUT_MS: "50",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    assert.equal(reviewRequestCount, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "timeout");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.runtime_diagnostics.provider_request.configured_timeout_ms, 50);
    assert.equal(record.runtime_diagnostics.provider_request.fetch_error.name, "AbortError");
    assert.equal(record.runtime_diagnostics.provider_request.fetch_error.code, "API_REVIEWERS_REQUEST_TIMEOUT");
    assert.match(record.suggested_action, /narrow/i);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API provider request does not depend on global fetch transport", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const fetchMock = path.join(mkdtempSync(path.join(tmpdir(), "api-reviewers-fetch-mock-")), "mock-fetch.mjs");
  writeFileSync(fetchMock, `
globalThis.fetch = async () => {
  const cause = new Error("Headers Timeout Error");
  cause.name = "HeadersTimeoutError";
  cause.code = "UND_ERR_HEADERS_TIMEOUT";
  const error = new TypeError("fetch failed");
  error.cause = cause;
  throw error;
};
`, "utf8");
  let requestCount = 0;
  let reviewRequestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/chat/completions");
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.model, "deepseek-v4-flash");
      const prompt = parsed.messages?.[0]?.content ?? "";
      if (prompt !== "Return exactly: ok") {
        reviewRequestCount += 1;
        assert.match(prompt, /Check this file/);
      }
      res.setHeader("content-type", "application/json");
      res.end(mockResponse("deepseek-v4-flash", "chatcmpl-http-transport"));
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
        API_REVIEWERS_TIMEOUT_MS: "900000",
        DEEPSEEK_API_KEY: "secret-test-value",
        NODE_OPTIONS: `--import ${fetchMock}`,
      },
    });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(requestCount, 2);
    assert.equal(reviewRequestCount, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "completed");
    assert.equal(record.runtime_diagnostics.provider_request.configured_timeout_ms, 900000);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
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
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
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
        API_REVIEWERS_TIMEOUT_MS: "345678",
        CODEX_SANDBOX: "seatbelt",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "provider_unavailable");
    assert.equal(record.http_status, 503);
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 345678);
    assert.equal(record.external_review.source_content_transmission, "sent");
    const recovery = record.runtime_diagnostics?.packet_recovery;
    assert.ok(recovery, "source-sent provider_unavailable failures must include packet_recovery");
    assert.equal(recovery.provider, "deepseek");
    assert.equal(recovery.reason, "provider_unavailable");
    assert.equal(record.error_code, recovery.reason);
    assert.equal(recovery.source_content_transmission, "sent");
    assert.deepEqual(
      recovery.actions.map((action) => action.type),
      ["resend_with_confirmation", "switch_provider", "waive_slot"],
    );
    assert.deepEqual(record.review_metadata.audit_manifest.packet_recovery, recovery);
    assert.doesNotMatch(record.suggested_action, /network_access = true/);
    assert.doesNotMatch(record.suggested_action, /outside sandbox/);
  } finally {
    server.close();
  }
});

test("direct API fetch failure after source receipt emits conservative packet recovery", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  let sourceBearingRequests = 0;
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
    sourceBearingRequests += 1;
    assert.match(body.messages?.[0]?.content ?? "", /hello from selected scope/);
    res.destroy();
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
    assert.equal(sourceBearingRequests, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "provider_unavailable");
    assert.equal(record.http_status, null);
    assert.equal(record.external_review.source_content_transmission, "unknown");
    const recovery = record.runtime_diagnostics?.packet_recovery;
    assert.ok(recovery, "unknown source-state provider_unavailable failures must include packet_recovery");
    assert.equal(recovery.reason, "provider_unavailable");
    assert.equal(recovery.source_content_transmission, "unknown");
    assert.deepEqual(
      recovery.actions.map((action) => action.type),
      ["resend_with_confirmation", "switch_provider", "waive_slot"],
    );
    assert.deepEqual(record.review_metadata.audit_manifest.packet_recovery, recovery);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
  }
});

test("direct API HTTP provider_unavailable with transport-looking wording still does not recommend sandbox access", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream fetch failed at provider" } }));
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
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
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
        API_REVIEWERS_TIMEOUT_MS: "456789",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "malformed_response");
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 456789);
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.external_review.disclosure,
      "Selected source content was sent to DeepSeek through direct API auth, but the provider did not return a clean result.");
  } finally {
    server.close();
  }
});

test("custom-review rejects symlinked scope files before provider delivery", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  writeFileSync(path.join(cwd, "secret.txt"), "workspace secret should not be sent\n");
  symlinkSync(path.join(cwd, "secret.txt"), path.join(cwd, "linked-secret.txt"));
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "linked-secret.txt",
    "--foreground",
    "--prompt", "Check this file.",
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
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /unsafe_scope_path:linked-secret\.txt/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.doesNotMatch(result.stdout, /workspace secret should not be sent/);
});

test("scope file reads open canonical paths after symlink boundary check", () => {
  const source = readFileSync(COMPANION, "utf8");
  assert.match(source, /const SCOPE_FILE_OPEN_FLAGS = fsConstants\.O_RDONLY \| \(fsConstants\.O_NOFOLLOW \?\? 0\);/);
  assert.match(source, /if \(beforeOpen\.isSymbolicLink\(\)\) \{/);
  assert.match(source, /const realRel = relative\(realWorkspaceRoot, realAbs\);/);
  assert.match(source, /if \(e\?\.code === "ENOENT"\) return null;/);
  assert.match(source, /const text = await readUtf8ScopeFileWithinLimit\(realAbs, normalizedRel, beforeOpen\);/);
  assert.doesNotMatch(source, /readUtf8ScopeFileWithinLimit\(abs, normalizedRel\)/);
});

test("scope file reads reject stale file identity after secure open", async () => {
  const cwd = makeWorkspace();
  const first = path.join(cwd, "first.txt");
  const second = path.join(cwd, "second.txt");
  writeFileSync(first, "first file\n");
  writeFileSync(second, "second file\n");
  const beforeOpen = lstatSync(first);
  const { readUtf8ScopeFileWithinLimit } = await importApiReviewerInternalsForTest();

  await assert.rejects(
    () => readUtf8ScopeFileWithinLimit(second, "first.txt", beforeOpen),
    /unsafe_scope_path:first\.txt: file changed before secure open/,
  );
});

test("custom-review rejects oversized scope files before provider delivery", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  writeFileSync(path.join(cwd, "large.txt"), "x".repeat(256 * 1024 + 1));
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "large.txt",
    "--foreground",
    "--prompt", "Check this file.",
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
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_file_too_large:large\.txt/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
});

test("custom-review rejects over-budget source packets before direct API approval or delivery", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const files = [];
  for (let index = 0; index < 3; index += 1) {
    const file = `packet-${index}.txt`;
    files.push(file);
    writeFileSync(path.join(cwd, file), "x".repeat(180 * 1024));
  }

  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", files.join(","),
    "--foreground",
    "--prompt", "Check these files.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MAX_PROMPT_CHARS: "2000000",
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "source_packet_too_large");
  assert.match(record.error_message, /source_packet_too_large:/);
  assert.equal(record.error_cause, "pre_send_source_packet_budget");
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_send_allowed, false);
  assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_packet_action, "narrow_source_packet");
  const recovery = record.runtime_diagnostics?.packet_recovery;
  assert.ok(recovery, "source packet budget failures must include packet_recovery diagnostics");
  assert.equal(recovery.schema_version, 1);
  assert.equal(recovery.provider, "deepseek");
  assert.equal(recovery.mode, "custom-review");
  assert.equal(recovery.reason, "source_packet_too_large");
  assert.equal(recovery.source_content_transmission, "not_sent");
  assert.equal(record.error_code, recovery.reason);
  assert.equal(recovery.provider_capabilities.provider, "deepseek");
  assert.equal(recovery.provider_capabilities.route_step, "direct_api");
  assert.equal(recovery.provider_capabilities.source_packet_budget_bytes, 512 * 1024);
  assert.deepEqual(
    recovery.actions.map((action) => action.type),
    ["diff_packet", "allow_large_source_packet", "switch_provider", "waive_slot"],
  );
  assert.deepEqual(record.review_metadata.audit_manifest.packet_recovery, recovery);
  assert.doesNotMatch(JSON.stringify(recovery), /secret-test-value|approval_token|approval-token/i);
  assert.doesNotMatch(result.stdout, /external_review_launched|secret-test-value/);
});

test("custom-review explicit large source override reaches direct API reviewers", async () => {
  for (const { provider, model, envKey } of [
    { provider: "deepseek", model: "deepseek-v4-pro", envKey: "DEEPSEEK_API_KEY" },
    { provider: "glm", model: "glm-5.1", envKey: "ZAI_API_KEY" },
  ]) {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
    const files = [];
    for (let index = 0; index < 3; index += 1) {
      const file = `packet-${index}.txt`;
      files.push(file);
      writeFileSync(path.join(cwd, file), "x".repeat(180 * 1024));
    }

    const result = await run([
      "run",
      "--provider", provider,
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", files.join(","),
      "--foreground",
      "--allow-large-source-packet",
      "--prompt", "Check these files.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MAX_PROMPT_CHARS: "2000000",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse(model),
        [envKey]: "secret-test-value",
      },
    });

    assert.equal(result.status, 0, `${provider}: ${result.stderr || result.stdout}`);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "completed", provider);
    assert.equal(record.external_review.source_content_transmission, "sent", provider);
    const policy = record.review_metadata.audit_manifest.source_packet_policy;
    assert.equal(policy.source_send_allowed, true, provider);
    assert.equal(policy.source_packet_action, "send_after_source_packet_override", provider);
    assert.equal(policy.source_packet_override_approved, true, provider);
    assert.equal(policy.source_packet_override_source, "--allow-large-source-packet", provider);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  }
});

test("branch-diff default reviews committed changes against main with scrubbed git env", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  writeFileSync(path.join(cwd, "feature.txt"), "DIRTY_SELECTED_SECRET\n");
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
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "diff --git a/feature.txt b/feature.txt",
      API_REVIEWERS_MOCK_ASSERT_PROMPT_EXCLUDES: "DIRTY_SELECTED_SECRET",
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
  assert.doesNotMatch(result.stdout, /DIRTY_SELECTED_SECRET/);
});

test("branch-diff rejects control characters in selected paths before provider delivery", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  writeFileSync(path.join(cwd, "bad\nname.txt"), "newline path should not reach the prompt\n");
  git(cwd, ["add", "bad\nname.txt"]);
  git(cwd, ["commit", "-m", "newline path"]);
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "review",
    "--scope", "branch-diff",
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
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /unsafe_scope_path:bad\nname\.txt/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.doesNotMatch(result.stdout, /newline path should not reach the prompt/);
});

test("branch-diff scope paths narrow committed changes", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  writeFileSync(path.join(cwd, "extra.txt"), "extra committed change\n");
  git(cwd, ["add", "extra.txt"]);
  git(cwd, ["commit", "-m", "extra"]);
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "review",
    "--scope", "branch-diff",
    "--scope-paths", "feature.txt",
    "--foreground",
    "--prompt", "Check this branch.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "feature.txt",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.deepEqual(record.scope_paths, ["feature.txt"]);
  assert.deepEqual(
    record.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
    ["feature.txt"]
  );
  assert.equal(
    record.review_metadata.audit_manifest.scope_resolution.reason,
    "git diff -z --name-only main...HEAD -- filtered by explicit --scope-paths"
  );
  assert.doesNotMatch(result.stdout, /extra committed change/);
});

test("branch-diff scope paths honor glob patterns when narrowing committed changes", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  writeFileSync(path.join(cwd, "extra.txt"), "extra committed change\n");
  git(cwd, ["add", "extra.txt"]);
  git(cwd, ["commit", "-m", "extra"]);
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "review",
    "--scope", "branch-diff",
    "--scope-paths", "feature.*",
    "--foreground",
    "--prompt", "Check this branch.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "feature.txt",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.deepEqual(record.scope_paths, ["feature.txt"]);
  assert.deepEqual(
    record.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
    ["feature.txt"]
  );
  assert.doesNotMatch(result.stdout, /extra committed change/);
});

test("branch-diff scope paths treat **/ as a path segment glob", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  mkdirSync(path.join(cwd, "nested"));
  writeFileSync(path.join(cwd, "nested", "feature.txt"), "nested committed change\n");
  writeFileSync(path.join(cwd, "prefixfeature.txt"), "prefix committed change\n");
  git(cwd, ["add", "nested/feature.txt", "prefixfeature.txt"]);
  git(cwd, ["commit", "-m", "nested feature"]);
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "review",
    "--scope", "branch-diff",
    "--scope-paths", "**/feature.txt",
    "--foreground",
    "--prompt", "Check this branch.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "nested committed change",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.deepEqual(record.scope_paths, ["feature.txt", "nested/feature.txt"]);
  assert.deepEqual(
    record.review_metadata.audit_manifest.selected_source.files.map((file) => file.path),
    ["feature.txt", "nested/feature.txt"]
  );
  assert.doesNotMatch(result.stdout, /prefix committed change/);
});

test("branch-diff uses hardened git path despite ambient PATH sabotage", async () => {
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
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.error_code, null);
  assert.equal(record.external_review.source_content_transmission, "sent");
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
      ZAI_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "completed");
  assert.equal(record.provider, "glm");
  assert.equal(record.model, "glm-5.1");
  assert.equal(record.credential_ref, "ZAI_API_KEY");
  assert.equal(record.endpoint, "https://api.z.ai/api/coding/paas/v4");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("branch-diff rejects oversized committed scope files before provider delivery", async () => {
  const cwd = makeBranchDiffWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  writeFileSync(path.join(cwd, "large.txt"), "x".repeat(256 * 1024 + 1));
  git(cwd, ["add", "large.txt"]);
  git(cwd, ["commit", "-q", "-m", "large"]);
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "review",
    "--foreground",
    "--scope-paths", "large.txt",
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
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_file_too_large:large\.txt/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
});

test("direct API reviewers lifecycle jsonl emits launch before terminal projection", async () => {
  const cwd = makeWorkspace();
  writeFileSync(path.join(cwd, "seed.txt"), "SOURCE_BODY_SENTINEL_DO_NOT_PERSIST\n");
  const pluginRoot = makeInstalledApiReviewersRoot();
  const reviewText = substantiveReviewFixture("SOURCE_BODY_SENTINEL_DO_NOT_PERSIST");
  const server = await startChatServer(async (req, res) => {
    req.resume();
    await sleep(100);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("deepseek-v4-pro", "chatcmpl-test", reviewText));
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
      "--lifecycle-events", "jsonl",
      "--prompt", "Check this file.",
    ], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      cwd,
      env: {
        CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS: "5",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lines = parseJsonLines(result.stdout);
    assert.ok(lines.length >= 3, result.stdout);
    const [launch] = lines;
    const progress = lines.find((line) => line.event === "external_review_progress");
    const record = lines.at(-1);
    assert.deepEqual(launch, externalReviewLaunchedEvent({
      job_id: launch.job_id,
      target: "deepseek",
    }, launch.external_review));
    assert.equal(progress.job_id, launch.job_id);
    assert.equal(progress.target, "deepseek");
    assert.equal(progress.status, "running");
    assert.equal(progress.heartbeat, 1);
    assert.equal(launch.external_review.provider, "DeepSeek");
    assert.equal(launch.external_review.source_content_transmission, "may_be_sent");
    assert.equal(record.event, "external_review_terminal");
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(Object.hasOwn(record, "result"), false);
    assert.equal(Object.hasOwn(record, "runtime_diagnostics"), false);
    assert.doesNotMatch(result.stdout, /SOURCE_BODY_SENTINEL_DO_NOT_PERSIST/);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("direct API reviewers reject invalid lifecycle event mode as bad args", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--lifecycle-events", "pretty",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "bad_args");
  assert.match(record.error_message, /--lifecycle-events must be jsonl/);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API reviewers render lifecycle markdown cards before source transmission", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--lifecycle-events", "markdown",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^### EXTERNAL REVIEW/m);
  assert.match(result.stdout, /\| Provider \| DeepSeek \|/);
  assert.match(result.stdout, /\| Source \| not_sent \|/);
  assert.match(result.stdout, /\| Status \| failed \|/);
  assert.match(result.stdout, /\| Retrieve \| result --job job_[0-9a-f-]+ --cwd [^|]+ \|/);
  assert.match(result.stdout, /\| Panel \| review-panel --workspace [^|]+ \|/);
  assert.match(result.stdout, /\| Error \| bad_args \|/);
  assert.match(result.stdout, /\| Message \| [^|]*prompt is required[^|]*--prompt <focus>[^|]* \|/);
  assert.match(result.stdout, /\| Summary \| [^|]+ \|/);
  assert.match(result.stdout, /\| Action \| Correct the api-reviewer command arguments and retry\. \|/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
  assert.doesNotMatch(result.stdout, /^\{/);
});

test("direct API reviewers lifecycle markdown emits launch and terminal cards on success", async () => {
  const cwd = makeWorkspace();
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer(async (req, res) => {
    req.resume();
    await sleep(100);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("deepseek-v4-pro"));
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
      "--lifecycle-events", "markdown",
      "--prompt", "Check this file.",
    ], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      cwd,
      env: {
        CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS: "5",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok((result.stdout.match(/^### EXTERNAL REVIEW/gm) ?? []).length >= 3, result.stdout);
    assert.match(result.stdout, /\| Provider \| DeepSeek \|/);
    assert.match(result.stdout, /\| Source \| may_be_sent \|/);
    assert.match(result.stdout, /\| Status \| launched \|/);
    assert.match(result.stdout, /\| Status \| running \|/);
    assert.match(result.stdout, /\| Source \| sent \|/);
    assert.match(result.stdout, /\| Status \| completed \|/);
    assert.equal(parseCompactJsonLines(result.stdout).some((line) => line.event === "external_review_progress"), false);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
    assert.doesNotMatch(result.stdout, /^\{\n/m);
  } finally {
    server.close();
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("direct API reviewers lifecycle markdown streams running card before provider exit", async () => {
  const cwd = makeWorkspace();
  const pluginRoot = makeInstalledApiReviewersRoot();
  let releaseProvider;
  const providerReleased = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const server = await startChatServer(async (req, res) => {
    const body = await readChatRequest(req);
    if (respondSourceFreePreflight(body, res)) return;
    await providerReleased;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(mockResponse("deepseek-v4-pro"));
  });
  let child = null;
  try {
    const { port } = server.address();
    writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
    const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
    const approval = await run([
      "approval-request",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Check this file.",
    ], {
      companion,
      cwd,
      env: { DEEPSEEK_API_KEY: "secret-test-value" },
    });
    assert.equal(approval.status, 0, approval.stderr || approval.stdout);
    const approvalToken = parseJson(approval.stdout).approval_token.value;
    let stdout = "";
    let stderr = "";
    child = spawn(process.execPath, [
      companion,
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--lifecycle-events", "markdown",
      "--prompt", "Check this file.",
      "--approval-token", approvalToken,
    ], {
      cwd,
      env: {
        ...process.env,
        API_REVIEWERS_DISABLE_ENV_CACHE: "1",
        CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS: "5",
        RELAY_PROVIDER_WORKLOAD_LOCK_DIR: path.join(cwd, ".provider-workload"),
        RELAY_WORKLOAD_TEST_MODE: "1",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const streamed = await waitForValue(() => (
      child.exitCode === null && /\| Status \| running \|/.test(stdout) ? stdout : null
    ), { timeoutMs: 2000, intervalMs: 10 });
    assert.match(streamed, /^### EXTERNAL REVIEW/m);
    assert.match(streamed, /\| Source \| may_be_sent \|/);
    assert.equal(child.exitCode, null, "running lifecycle card must arrive before the process exits");

    releaseProvider();
    const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    assert.equal(exitCode, 0, stderr || stdout);
    assert.match(stdout, /\| Source \| sent \|/);
    assert.match(stdout, /\| Status \| completed \|/);
    assert.doesNotMatch(stdout, /secret-test-value/);
    assert.doesNotMatch(stdout, /^\{\n/m);
  } finally {
    releaseProvider?.();
    if (child && child.exitCode === null) child.kill("SIGTERM");
    server.close();
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("direct API reviewers reject missing prompt before launch or source transmission", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--lifecycle-events", "jsonl",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "bad_args");
  assert.match(record.error_message, /prompt is required/);
  assertDirectApiNotSent(record, "DeepSeek");
  assert.doesNotMatch(result.stdout, /external_review_launched/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API reviewers validate missing prompt before collecting scope", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "missing-source.txt",
    "--foreground",
    "--lifecycle-events", "jsonl",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "bad_args");
  assert.match(record.error_message, /prompt is required/);
  assertDirectApiNotSent(record, "DeepSeek");
  assert.doesNotMatch(result.stdout, /external_review_launched/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API reviewers explain empty branch-diff recovery before launch", async () => {
  const cwd = makeEmptyBranchDiffWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "adversarial-review",
    "--scope", "branch-diff",
    "--scope-base", "main",
    "--lifecycle-events", "jsonl",
    "--prompt", "Review this branch.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_empty: branch-diff selected no files/);
  assert.match(record.suggested_action, /different --scope-base/);
  assert.match(record.suggested_action, /--scope-base HEAD~1/);
  assert.match(record.suggested_action, /custom-review/);
  assertDirectApiNotSent(record, "DeepSeek");
  assert.doesNotMatch(result.stdout, /external_review_launched/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API reviewers reject option-shaped scope-base before git diff", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "adversarial-review",
    "--scope", "branch-diff",
    "--scope-base", "--definitely-not-a-real-ref",
    "--lifecycle-events", "jsonl",
    "--prompt", "Review this branch.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_base_invalid/);
  assert.match(record.suggested_action, /option-shaped values/);
  assertDirectApiNotSent(record, "DeepSeek");
  assert.doesNotMatch(result.stdout, /external_review_launched/);
  assert.doesNotMatch(result.stdout, /invalid option/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

test("direct API reviewers reject invalid API_REVIEWERS_MAX_PROMPT_CHARS env", async () => {
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
      API_REVIEWERS_MAX_PROMPT_CHARS: "not-a-number",
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "bad_args");
  assert.match(record.error_message, /API_REVIEWERS_MAX_PROMPT_CHARS must be a positive integer number of characters/);
  assertDirectApiNotSent(record, "DeepSeek");
});

test("direct API reviewers reject rendered prompt over provider budget before launch", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--lifecycle-events", "jsonl",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MAX_PROMPT_CHARS: "100",
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "prompt_too_large");
  assert.match(record.error_message, /prompt_too_large:/);
  assert.match(record.suggested_action, /narrower scope|split/i);
  assert.match(record.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
  assert.equal(record.review_metadata.audit_manifest.selected_source.files.length, 1);
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("Check this file"), false);
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("hello from selected scope"), false);
  assertDirectApiNotSent(record, "DeepSeek");
  assert.doesNotMatch(result.stdout, /external_review_launched/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

for (const promptCapProvider of [
  { provider: "deepseek", displayName: "DeepSeek", model: "deepseek-v4-pro", env: { DEEPSEEK_API_KEY: "secret-test-value" } },
  { provider: "glm", displayName: "GLM", model: "glm-5.1", env: { ZAI_API_KEY: "secret-test-value" } },
]) {
  test(`direct API ${promptCapProvider.provider} reviewer emits sharding plan with per-shard approval tuple when rendered prompt exceeds cap`, async () => {
    const cwd = makeMultiFileScopeWorkspace();
    const result = await run([
      "run",
      "--provider", promptCapProvider.provider,
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "f1.txt,f2.txt,f3.txt,f4.txt,f5.txt",
      "--foreground",
      "--lifecycle-events", "jsonl",
      "--prompt", "Check changed files.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_MAX_PROMPT_CHARS: "5000",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse(promptCapProvider.model),
        ...promptCapProvider.env,
      },
    });
    assert.equal(result.status, 1);
    const lines = parseJsonLines(result.stdout);
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "prompt_too_large");
    assert.match(record.error_message, /prompt_too_large:/);
    assertDirectApiNotSent(record, promptCapProvider.displayName);
    assert.doesNotMatch(result.stdout, /external_review_launched/);

    const plan = record.runtime_diagnostics?.sharding_plan;
    assert.ok(plan, "sharding_plan must be present when prompt exceeds cap");
    assert.equal(plan.reason, "prompt_too_large");
    assert.equal(plan.source_content_transmission, "not_sent");
    assert.equal(plan.cap, 5000);
    assert.equal(typeof plan.rendered_prompt_chars, "number");
    assert.ok(plan.rendered_prompt_chars > plan.cap);
    assert.ok(Array.isArray(plan.shards) && plan.shards.length >= 2, "fixture must split into >=2 bounded shards");

    const hashes = new Set();
    const tupleFingerprints = new Set();
    for (const [i, shard] of plan.shards.entries()) {
      assert.equal(shard.index, i + 1);
      assert.equal(shard.total, plan.shards.length);
      assert.ok(Array.isArray(shard.scope_paths) && shard.scope_paths.length > 0);
      assert.equal(typeof shard.rendered_prompt_chars, "number");
      assert.ok(shard.rendered_prompt_chars > 0);
      assert.ok(shard.rendered_prompt_chars <= plan.cap, `shard ${i + 1} size ${shard.rendered_prompt_chars} must fit cap ${plan.cap}`);
      const tuple = shard.approval_tuple;
      assert.ok(tuple);
      assert.equal(tuple.provider, promptCapProvider.provider);
      assert.equal(tuple.mode, "custom-review");
      assert.equal(tuple.selected_route, "direct_api");
      assert.equal(tuple.fallback_reason, "subscription_not_supported");
      assert.equal(tuple.approval_scope, "session");
      assert.match(tuple.rendered_prompt_hash, /^[a-f0-9]{64}$/);
      hashes.add(tuple.rendered_prompt_hash);
      assert.ok(tuple.approval_tuple_fingerprint, "recovery shard approval tuple must carry a non-token fingerprint");
      assert.equal(tuple.approval_tuple_fingerprint.algorithm, "sha256");
      assert.match(tuple.approval_tuple_fingerprint.value, /^[a-f0-9]{64}$/);
      tupleFingerprints.add(tuple.approval_tuple_fingerprint.value);
      assert.deepEqual([...tuple.scope_paths].sort(), [...shard.scope_paths].sort());
      assert.ok(tuple.source_packet);
      assert.equal(tuple.source_packet.totals.files, shard.scope_paths.length);
      assert.deepEqual(
        tuple.source_packet.files.map((file) => file.path).sort(),
        [...shard.scope_paths].sort(),
      );
      for (const file of tuple.source_packet.files) {
        assert.match(file.content_hash.value, /^[a-f0-9]{64}$/);
        assert.equal(typeof file.bytes, "number");
        assert.equal(typeof file.lines, "number");
      }
      assert.equal(tuple.auth_path?.auth_mode, "api_key");
      assert.equal(typeof tuple.auth_path?.credential_ref, "string");
      assert.equal(typeof tuple.billing_path?.endpoint, "string");
      assert.equal(typeof tuple.billing_path?.model, "string");
      assert.ok(tuple.request_settings && typeof tuple.request_settings === "object");
      assert.ok(tuple.scope_resolution);
    }
    assert.equal(hashes.size, plan.shards.length, "each shard must have a unique rendered_prompt_hash");
    assert.equal(tupleFingerprints.size, plan.shards.length, "each recovery shard must have a unique approval tuple fingerprint");

    const recovery = record.runtime_diagnostics?.packet_recovery;
    assert.ok(recovery, "prompt cap failures must include packet_recovery");
    assert.equal(recovery.reason, "prompt_too_large");
    assert.equal(recovery.source_content_transmission, "not_sent");
    assert.equal(recovery.provider, promptCapProvider.provider);
    assert.equal(recovery.mode, "custom-review");
    assert.equal(recovery.provider_capabilities.rendered_prompt_budget_chars, 5000);
    const shardAction = recovery.actions.find((action) => action.type === "shard");
    assert.ok(shardAction, "prompt cap recovery must expose the existing sharding plan");
    assert.equal(shardAction.shards.length, plan.shards.length);
    assert.deepEqual(shardAction.shards, plan.shards);
    assert.deepEqual(record.review_metadata.audit_manifest.packet_recovery, recovery);
    assert.doesNotMatch(JSON.stringify(recovery), /secret-test-value|approval_token|approval-token/i);

    const planJson = JSON.stringify(plan);
    assert.equal(planJson.includes("hello from selected scope"), false);
    assert.equal(planJson.includes("secret-test-value"), false);
    assert.equal(planJson.includes("Check changed files."), false);
    assert.doesNotMatch(planJson, /approval_token|approval-token/i);
    assert.equal(planJson.includes("file 1 content"), false);
  });
}

test("direct API recovery shard requires fresh approval when approval tuple changes", async () => {
  const cwd = makeMultiFileScopeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-recovery-shard-approval-"));
  try {
    const fullScope = await run([
      "approval-request",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "f1.txt,f2.txt,f3.txt,f4.txt,f5.txt",
      "--prompt", "Check changed files.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MAX_PROMPT_CHARS: "5000",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(fullScope.status, 1, fullScope.stderr || fullScope.stdout);
    const plan = parseJson(fullScope.stdout).runtime_diagnostics?.sharding_plan;
    assert.ok(Array.isArray(plan?.shards) && plan.shards.length >= 2, "fixture must produce at least two recovery shards");
    const [firstShard, secondShard] = plan.shards;

    const firstApproval = await run([
      "approval-request",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", firstShard.scope_paths.join(","),
      "--prompt", "Check changed files.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MAX_PROMPT_CHARS: "5000",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(firstApproval.status, 0, firstApproval.stderr || firstApproval.stdout);
    const firstApprovalToken = parseJson(firstApproval.stdout).approval_token.value;

    const secondShardRun = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", secondShard.scope_paths.join(","),
      "--foreground",
      "--lifecycle-events", "jsonl",
      "--prompt", "Check changed files.",
      "--approval-token", firstApprovalToken,
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_MAX_PROMPT_CHARS: "5000",
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });

    assert.equal(secondShardRun.status, 1, secondShardRun.stderr || secondShardRun.stdout);
    const [record] = parseJsonLines(secondShardRun.stdout);
    assert.equal(record.error_code, "approval_required");
    assertDirectApiNotSent(record, "DeepSeek");
    assert.doesNotMatch(secondShardRun.stdout, /external_review_launched/);
    assert.doesNotMatch(secondShardRun.stdout, /file 1 content|file 2 content|secret-test-value/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers reject blank or valueless prompt flags before launch", async () => {
  for (const promptArgs of [
    ["--prompt", ""],
    ["--prompt", "   "],
    ["--prompt"],
    ["--prompt="],
    ["--prompt=   "],
    ["--prompt", "--unused-review-flag"],
  ]) {
    const cwd = makeWorkspace();
    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--lifecycle-events", "jsonl",
      ...promptArgs,
    ], {
      cwd,
      env: {
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    const lines = parseJsonLines(result.stdout);
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "bad_args");
    assert.match(record.error_message, /prompt is required/);
    assert.equal(record.prompt_head, "");
    assertDirectApiNotSent(record, "DeepSeek");
    assert.doesNotMatch(result.stdout, /external_review_launched/);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  }
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

test("direct API reviewers lifecycle jsonl suppresses launch when API key is missing", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--lifecycle-events", "jsonl",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: { DEEPSEEK_API_KEY: "" },
  });
  assert.equal(result.status, 1);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.length, 1);
  const record = lines[0];
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "missing_key");
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(record.disclosure_note, record.external_review.disclosure);
});

test("direct API reviewers approval-request describes external source transmission without sending source", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const cwd = makeWorkspace();
  try {
    writeFileSync(path.join(cwd, "seed.txt"), "hello from selected scope\n");

    const result = await run([
      "approval-request",
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        CODEX_SANDBOX: "",
        ZAI_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 0);
    const request = parseJson(result.stdout);
    assert.equal(request.event, "external_review_approval_request");
    assert.equal(request.provider, "glm");
    assert.equal(request.display_name, "GLM");
    assert.equal(request.mode, "custom-review");
    assert.equal(request.scope, "custom");
    assert.deepEqual(request.scope_paths, ["seed.txt"]);
    assert.equal(request.source_content_transmission, "not_sent");
    assert.match(request.approval_question, /Allow sending 1 selected file \(26 bytes, 1 line\) to GLM for external review\?/);
    assert.notEqual(request.recommended_tool_justification, request.approval_question);
    assert.match(request.recommended_tool_justification, /Selected source content has not been sent to GLM/);
    assert.match(request.recommended_tool_justification, /current execution environment/);
    assert.match(request.recommended_tool_justification, /Do not broaden local execution access for a normal source send/);
    assert.match(request.recommended_tool_justification, /sandbox_blocked[\s\S]*source_content_transmission: "not_sent"/);
    assert.doesNotMatch(request.recommended_tool_justification, /retry with broader access|broader access until|until the source send succeeds/i);
    assert.doesNotMatch(request.recommended_tool_justification, /\bCodex\b|sandbox_permissions|require_escalated/);
    assert.match(request.recommended_tool_justification, /approval_token/);
    assert.match(request.approval_token.value, /^[a-f0-9]{64}$/);
    assert.equal(request.approval_token.algorithm, "sha256");
    assert.match(request.denial_fallback, /generate a relay prompt/i);
    assert.deepEqual(request.denial_action, {
      action: "generate_relay_prompt",
      source_content_transmission: "not_sent",
    });
    assert.equal(request.selected_source.totals.files, 1);
    assert.equal(request.selected_source.totals.bytes, 26);
    assert.equal(request.selected_source.totals.lines, 1);
    assert.deepEqual(request.selected_source.files.map((file) => file.path), ["seed.txt"]);
    assert.match(request.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
    assert.equal(request.request.timeout_ms, 900000);
    assert.equal(request.request.model, "glm-5.1");
    assert.equal(JSON.stringify(request).includes("hello from selected scope"), false);
    assert.equal(JSON.stringify(request).includes("secret-test-value"), false);
    assert.equal(JSON.stringify(request).includes(cwd), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers approval-request emits Codex sandbox guidance inside Codex", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-codex-guidance-"));
  const cwd = makeWorkspace();
  try {
    writeFileSync(path.join(cwd, "seed.txt"), "hello from selected scope\n");

    const result = await run([
      "approval-request",
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        CODEX_SANDBOX: "seatbelt",
        ZAI_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const request = parseJson(result.stdout);
    assert.match(request.recommended_tool_justification, /default Codex sandbox/);
    assert.match(request.recommended_tool_justification, /Do not request `sandbox_permissions: "require_escalated"` for a normal source send/);
    assert.match(request.recommended_tool_justification, /sandbox_blocked[\s\S]*source_content_transmission: "not_sent"/);
    assert.doesNotMatch(request.recommended_tool_justification, /retry with broader access|broader access until|until the source send succeeds/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers approval-grant request emits source-free bounded grant proof", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-request-"));
  const cwd = makeWorkspace();
  try {
    writeFileSync(path.join(cwd, "seed.txt"), "hello from selected scope\n");

    const result = await run([
      "approval-grant",
      "request",
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
      "--grant-ttl-ms", "900000",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        CODEX_SANDBOX: "",
        ZAI_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const request = parseJson(result.stdout);
    assert.equal(request.event, "external_review_session_approval_request");
    assert.equal(request.provider, "glm");
    assert.equal(request.display_name, "GLM");
    assert.equal(request.mode, "custom-review");
    assert.equal(request.scope, "custom");
    assert.deepEqual(request.scope_paths, ["seed.txt"]);
    assert.equal(request.source_content_transmission, "not_sent");
    assert.equal(request.approval_scope, "grant");
    assert.match(request.recommended_tool_justification, /current execution environment/);
    assert.match(request.recommended_tool_justification, /Do not broaden local execution access for a normal source send/);
    assert.match(request.recommended_tool_justification, /sandbox_blocked[\s\S]*source_content_transmission: "not_sent"/);
    assert.doesNotMatch(request.recommended_tool_justification, /retry with broader access|broader access until|until the source send succeeds/i);
    assert.doesNotMatch(request.recommended_tool_justification, /\bCodex\b|sandbox_permissions|require_escalated/);
    assert.match(request.grant_approval_token.value, /^[a-f0-9]{64}$/);
    assert.equal(request.grant_approval_token.algorithm, "sha256");
    assert.equal(Object.hasOwn(request, "approval_token"), false);
    assert.deepEqual(request.grant_bounds.provider_allowlist, ["glm"]);
    assert.deepEqual(request.grant_bounds.mode_allowlist, ["custom-review"]);
    assert.equal(request.grant_bounds.max_files, 1);
    assert.equal(request.grant_bounds.max_bytes, 26);
    assert.equal(request.grant_bounds.max_ttl_ms, SESSION_APPROVAL_POLICY.max_ttl_ms);
    assert.match(request.grant_bounds.expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(request.grant_bounds.workspace_root_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(request.grant_bounds.path_constraints, {
      scope: "custom",
      scope_paths: ["seed.txt"],
    });
    assert.equal(request.selected_source.totals.files, 1);
    assert.equal(request.selected_source.totals.bytes, 26);
    assert.equal(request.selected_source.totals.lines, 1);
    assert.deepEqual(request.selected_source.files.map((file) => file.path), ["seed.txt"]);
    assert.match(request.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(request).includes("hello from selected scope"), false);
    assert.equal(JSON.stringify(request).includes("secret-test-value"), false);
    assert.equal(JSON.stringify(request).includes(cwd), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers approval-grant request requires explicit TTL", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-ttl-required-"));
  const cwd = makeWorkspace();
  try {
    const result = await run([
      "approval-grant",
      "request",
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        ZAI_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.error_code, "bad_args");
    assert.match(parsed.error_message, /--grant-ttl-ms is required/);
    assert.equal(JSON.stringify(parsed).includes("hello from selected scope"), false);
    assert.equal(JSON.stringify(parsed).includes("secret-test-value"), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers approval-grant without subcommand shows command help", async () => {
  const result = await run(["approval-grant"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "approval-grant");
  assert.deepEqual(parsed.subcommands, ["request", "activate"]);
  assert.equal(parsed.source_content_transmission, "not_sent");
});

test("direct API reviewers approval-grant activate requires exact request expiry", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-expiry-"));
  const cwd = makeWorkspace();
  try {
    const commonArgs = [
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
    ];
    const env = {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      ZAI_API_KEY: "secret-test-value",
    };
    const requestResult = await run([
      "approval-grant",
      "request",
      ...commonArgs,
      "--grant-ttl-ms", "900000",
    ], { cwd, env });
    assert.equal(requestResult.status, 0, requestResult.stderr || requestResult.stdout);
    const request = parseJson(requestResult.stdout);
    const changedExpiry = new Date(Date.parse(request.grant_bounds.expires_at) + 1000).toISOString();

    const activation = await run([
      "approval-grant",
      "activate",
      ...commonArgs,
      "--grant-expires-at", changedExpiry,
      "--approval-token", request.grant_approval_token.value,
    ], { cwd, env });

    assert.equal(activation.status, 1, activation.stderr || activation.stdout);
    const parsed = parseJson(activation.stdout);
    assert.equal(parsed.error_code, "approval_required");
    assert.equal(JSON.stringify(parsed).includes(request.grant_approval_token.value), false);
    assert.equal(existsSync(path.join(dataDir, "approval-grants")), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers activation uses the canonical grant tuple from the request builder", () => {
  const source = readFileSync(COMPANION, "utf8");

  assert.doesNotMatch(source, /function\s+grantApprovalTupleFromRequest\s*\(/);
  assert.doesNotMatch(source, /grantApprovalTupleFromRequest\s*\(\s*approvalRequest\s*\)/);
  assert.match(source, /\(\{\s*approvalRequest,\s*approvalTuple\s*\}\s*=\s*buildApprovalGrantRequest/);
  assert.match(source, /approvalFingerprintFor\s*\(\s*approvalTuple\s*\)/);
});

test("direct API reviewers approval-grant activate rejects session and once approval tokens", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-token-class-"));
  const cwd = makeWorkspace();
  try {
    const commonArgs = [
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
    ];
    const env = {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      DEEPSEEK_API_KEY: "secret-test-value",
    };
    const expiresAt = new Date(Date.now() + 900000).toISOString();
    for (const approvalScopeArgs of [[], ["--approval-scope", "once"]]) {
      const approval = await run(["approval-request", ...commonArgs, ...approvalScopeArgs], { cwd, env });
      assert.equal(approval.status, 0, approval.stderr || approval.stdout);
      const approvalRequest = parseJson(approval.stdout);

      const activation = await run([
        "approval-grant",
        "activate",
        ...commonArgs,
        "--grant-expires-at", expiresAt,
        "--approval-token", approvalRequest.approval_token.value,
      ], { cwd, env });

      assert.equal(activation.status, 1, activation.stderr || activation.stdout);
      const parsed = parseJson(activation.stdout);
      assert.equal(parsed.error_code, "approval_required");
      assert.equal(JSON.stringify(parsed).includes(approvalRequest.approval_token.value), false);
    }
    assert.equal(existsSync(path.join(dataDir, "approval-grants")), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers approval-grant activate persists strict idempotent grant file", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-persist-"));
  const cwd = makeWorkspace();
  try {
    const commonArgs = [
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
    ];
    const env = {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      ZAI_API_KEY: "secret-test-value",
    };
    const requestResult = await run([
      "approval-grant",
      "request",
      ...commonArgs,
      "--grant-ttl-ms", "900000",
    ], { cwd, env });
    assert.equal(requestResult.status, 0, requestResult.stderr || requestResult.stdout);
    const request = parseJson(requestResult.stdout);
    const activationArgs = [
      "approval-grant",
      "activate",
      ...commonArgs,
      "--grant-expires-at", request.grant_bounds.expires_at,
      "--approval-token", request.grant_approval_token.value,
    ];

    const first = await run(activationArgs, { cwd, env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstActivation = parseJson(first.stdout);
    assert.equal(firstActivation.event, "external_review_session_approval_grant");
    assert.equal(firstActivation.source_content_transmission, "not_sent");
    assert.match(firstActivation.grant_id, /^grant_[a-f0-9]{64}$/);

    const grantsDir = path.join(dataDir, "approval-grants");
    const grantFile = path.join(grantsDir, `${firstActivation.grant_id}.json`);
    const grant = parseJson(readFileSync(grantFile, "utf8"));
    assert.deepEqual(Object.keys(grant), [
      "schema_version",
      "grant_id",
      "created_at",
      "expires_at",
      "grant_session_id",
      "provider_allowlist",
      "mode_allowlist",
      "workspace_root_hash",
      "path_constraints",
      "max_files",
      "max_bytes",
      "max_ttl_ms",
      "approval_fingerprint",
      "approval_tuple",
      "activation",
    ]);
    assert.equal(grant.schema_version, 1);
    assert.equal(grant.grant_id, firstActivation.grant_id);
    assert.equal(grant.expires_at, request.grant_bounds.expires_at);
    assert.equal(grant.approval_fingerprint, firstActivation.approval_fingerprint);
    assert.equal(grant.provider_allowlist.includes("glm"), true);
    assert.deepEqual(grant.provider_allowlist, grant.approval_tuple.grant_bounds.provider_allowlist);
    assert.deepEqual(grant.mode_allowlist, grant.approval_tuple.grant_bounds.mode_allowlist);
    assert.equal(grant.workspace_root_hash, grant.approval_tuple.grant_bounds.workspace_root_hash);
    assert.deepEqual(grant.path_constraints, grant.approval_tuple.grant_bounds.path_constraints);
    assert.equal(grant.max_files, grant.approval_tuple.grant_bounds.max_files);
    assert.equal(grant.max_bytes, grant.approval_tuple.grant_bounds.max_bytes);
    assert.equal(grant.max_ttl_ms, grant.approval_tuple.grant_bounds.max_ttl_ms);
    for (const forbidden of ["provider", "mode", "selected_source", "rendered_prompt_hash", "request", "scope_resolution", "auth_path", "billing_path", "selected_route", "route_step", "route_steps", "fallback_reason", "approval_scope", "grant_bounds"]) {
      assert.equal(Object.hasOwn(grant, forbidden), false, `grant file must not duplicate tuple field ${forbidden} at top level`);
    }
    const grantText = readFileSync(grantFile, "utf8");
    assert.equal(grantText.includes(request.grant_approval_token.value), false);
    assert.equal(grantText.includes("hello from selected scope"), false);
    assert.equal(grantText.includes("secret-test-value"), false);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(grantFile).mode & 0o777, 0o600);
    }

    const second = await run(activationArgs, { cwd, env });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondActivation = parseJson(second.stdout);
    assert.equal(secondActivation.grant_id, firstActivation.grant_id);
    assert.deepEqual(readdirSync(grantsDir).filter((name) => name.endsWith(".json")), [`${firstActivation.grant_id}.json`]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers run uses matching session grant without per-run approval token", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-run-"));
  const cwd = makeWorkspace();
  try {
    const commonArgs = [
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
    ];
    const env = {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      ZAI_API_KEY: "secret-test-value",
      API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
      API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1", "session-grant-run"),
    };
    const requestResult = await run([
      "approval-grant",
      "request",
      ...commonArgs,
      "--grant-ttl-ms", "900000",
    ], { cwd, env });
    assert.equal(requestResult.status, 0, requestResult.stderr || requestResult.stdout);
    const request = parseJson(requestResult.stdout);
    const activationResult = await run([
      "approval-grant",
      "activate",
      ...commonArgs,
      "--grant-expires-at", request.grant_bounds.expires_at,
      "--approval-token", request.grant_approval_token.value,
    ], { cwd, env });
    assert.equal(activationResult.status, 0, activationResult.stderr || activationResult.stdout);
    const activation = parseJson(activationResult.stdout);

    const runResult = await run(["run", ...commonArgs, "--foreground"], { cwd, env });

    assert.equal(runResult.status, 0, runResult.stderr || runResult.stdout);
    const record = parseJson(runResult.stdout);
    assert.equal(record.external_review.source_content_transmission, "sent");
    const auditManifest = record.review_metadata.audit_manifest;
    assert.equal(auditManifest.approval_scope, "grant");
    assert.equal(auditManifest.approval_source, "session_grant");
    assert.equal(auditManifest.approval_grant.grant_id, activation.grant_id);
    assert.equal(auditManifest.approval_grant.grant_session_id, activation.grant_session_id);
    assert.equal(auditManifest.approval_grant.max_files, request.grant_bounds.max_files);
    assert.equal(auditManifest.approval_grant.max_bytes, request.grant_bounds.max_bytes);
    assert.equal(auditManifest.selected_source.files[0].content_hash.value, request.selected_source.files[0].content_hash.value);
    assert.equal(auditManifest.rendered_prompt_hash.value, request.rendered_prompt_hash.value);
    assert.equal(JSON.stringify(record).includes(request.grant_approval_token.value), false);
    assert.equal(JSON.stringify(record).includes("secret-test-value"), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers session grants clean clearly expired grant files during lookup", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-expired-cleanup-"));
  const cwd = makeWorkspace();
  try {
    const grant = await createGlmSessionGrant({ cwd, dataDir });
    const grantFile = expireGlmSessionGrantRecord(dataDir, grant.activation);
    assert.equal(existsSync(grantFile), true);

    const result = await run(["run", ...grant.commonArgs, "--foreground"], {
      cwd,
      env: {
        ...grant.env,
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1", "grant-expired-cleanup"),
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "approval_required");
    assertDirectApiNotSent(record, "GLM");
    assert.equal(existsSync(grantFile), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers session grants fail closed on provider, mode, source, prompt, request, expiry, and tamper mismatches", async () => {
  const cases = [
    {
      name: "provider",
      mutateBeforeRun: () => {},
      runArgs: [
        "--provider", "deepseek",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--prompt", "Review seed file only.",
      ],
      runEnv: { DEEPSEEK_API_KEY: "secret-test-value", API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro", "grant-provider-mismatch") },
    },
    {
      name: "mode",
      mutateBeforeRun: () => {},
      runArgs: [
        "--provider", "glm",
        "--mode", "adversarial-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--prompt", "Review seed file only.",
      ],
    },
    {
      name: "source-content",
      mutateBeforeRun: (cwd) => writeFileSync(path.join(cwd, "seed.txt"), "changed selected scope\n"),
    },
    {
      name: "scope-path",
      mutateBeforeRun: (cwd) => writeFileSync(path.join(cwd, "other.txt"), "hello from selected scope\n"),
      runArgs: [
        "--provider", "glm",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "other.txt",
        "--prompt", "Review seed file only.",
      ],
    },
    {
      name: "scope-paths-null-not-wildcard",
      mutateBeforeRun: (cwd, dataDir, activation) => {
        const file = path.join(dataDir, "approval-grants", `${activation.grant_id}.json`);
        const grant = parseJson(readFileSync(file, "utf8"));
        grant.path_constraints.scope_paths = null;
        grant.approval_tuple.scope_resolution.scope_paths = null;
        grant.approval_tuple.grant_bounds.path_constraints.scope_paths = null;
        const fingerprint = approvalFingerprintForTest(grant.approval_tuple);
        grant.approval_fingerprint = fingerprint;
        grant.grant_id = `grant_${fingerprint}`;
        grant.grant_session_id = `session_${fingerprint.slice(0, 32)}`;
        writeFileSync(file, `${JSON.stringify(grant, null, 2)}\n`);
      },
    },
    {
      name: "prompt",
      mutateBeforeRun: () => {},
      runArgs: [
        "--provider", "glm",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--prompt", "Review a different focus.",
      ],
    },
    {
      name: "request-settings",
      mutateBeforeRun: () => {},
      runEnv: { API_REVIEWERS_TIMEOUT_MS: "123456" },
    },
    {
      name: "expired",
      mutateBeforeRun: (cwd, dataDir, activation) => {
        expireGlmSessionGrantRecord(dataDir, activation);
      },
    },
    {
      name: "tampered-fingerprint",
      mutateBeforeRun: (cwd, dataDir, activation) => {
        const file = path.join(dataDir, "approval-grants", `${activation.grant_id}.json`);
        const grant = parseJson(readFileSync(file, "utf8"));
        grant.approval_fingerprint = "0".repeat(64);
        writeFileSync(file, `${JSON.stringify(grant, null, 2)}\n`);
      },
    },
    {
      name: "projection-max-bytes-mismatch",
      mutateBeforeRun: (cwd, dataDir, activation) => {
        const file = path.join(dataDir, "approval-grants", `${activation.grant_id}.json`);
        const grant = parseJson(readFileSync(file, "utf8"));
        grant.max_bytes += 1;
        writeFileSync(file, `${JSON.stringify(grant, null, 2)}\n`);
      },
    },
    {
      name: "projection-max-files-mismatch",
      mutateBeforeRun: (cwd, dataDir, activation) => {
        const file = path.join(dataDir, "approval-grants", `${activation.grant_id}.json`);
        const grant = parseJson(readFileSync(file, "utf8"));
        grant.max_files += 1;
        writeFileSync(file, `${JSON.stringify(grant, null, 2)}\n`);
      },
    },
    {
      name: "timestamp-format",
      mutateBeforeRun: (cwd, dataDir, activation) => {
        const file = path.join(dataDir, "approval-grants", `${activation.grant_id}.json`);
        const grant = parseJson(readFileSync(file, "utf8"));
        grant.created_at = "not-a-timestamp";
        writeFileSync(file, `${JSON.stringify(grant, null, 2)}\n`);
      },
    },
    {
      name: "schema-extra-field",
      mutateBeforeRun: (cwd, dataDir, activation) => {
        const file = path.join(dataDir, "approval-grants", `${activation.grant_id}.json`);
        const grant = parseJson(readFileSync(file, "utf8"));
        grant.unexpected = true;
        writeFileSync(file, `${JSON.stringify(grant, null, 2)}\n`);
      },
    },
    {
      name: "malformed-json",
      mutateBeforeRun: (cwd, dataDir, activation) => {
        const file = path.join(dataDir, "approval-grants", `${activation.grant_id}.json`);
        writeFileSync(file, "{not json\n");
      },
    },
  ];

  for (const item of cases) {
    const dataDir = mkdtempSync(path.join(tmpdir(), `api-reviewers-grant-mismatch-${item.name}-`));
    const cwd = makeWorkspace();
    try {
      const grant = await createGlmSessionGrant({ cwd, dataDir, ttlMs: item.ttlMs ?? "900000" });
      await item.mutateBeforeRun?.(cwd, dataDir, grant.activation);
      const env = {
        ...grant.env,
        ...item.runEnv,
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: item.runEnv?.API_REVIEWERS_MOCK_RESPONSE ?? mockResponse("glm-5.1", `grant-${item.name}-mismatch`),
      };
      const result = await run(["run", ...(item.runArgs ?? grant.commonArgs), "--foreground"], { cwd, env });
      assert.equal(result.status, 1, `${item.name}: ${result.stderr || result.stdout}`);
      const record = parseJson(result.stdout);
      assert.equal(record.error_code, "approval_required", item.name);
      assertDirectApiNotSent(record, item.name === "provider" ? "DeepSeek" : "GLM");
      assert.equal(JSON.stringify(record).includes(grant.request.grant_approval_token.value), false, item.name);
      assert.equal(JSON.stringify(record).includes("secret-test-value"), false, item.name);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("direct API reviewers session grants fail closed on workspace mismatch", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-workspace-"));
  const cwd = makeWorkspace();
  const otherCwd = makeWorkspace();
  try {
    const grant = await createGlmSessionGrant({ cwd, dataDir });

    const result = await run(["run", ...grant.commonArgs, "--foreground"], {
      cwd: otherCwd,
      env: {
        ...grant.env,
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1", "grant-workspace-mismatch"),
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "approval_required");
    assertDirectApiNotSent(record, "GLM");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
});

test("direct API reviewers approval-grant request rejects TTL above maximum before activation", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-ttl-max-"));
  const cwd = makeWorkspace();
  try {
    const result = await run([
      "approval-grant",
      "request",
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
      "--grant-ttl-ms", String(SESSION_APPROVAL_POLICY.max_ttl_ms + 1),
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        ZAI_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.error_code, "bad_args");
    assert.match(parsed.error_message, /exceeds configured maximum/);
    assert.equal(existsSync(path.join(dataDir, "approval-grants")), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers session grants fail closed on multiple active matches", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-duplicate-"));
  const cwd = makeWorkspace();
  try {
    const grant = await createGlmSessionGrant({ cwd, dataDir });
    const grantsDir = path.join(dataDir, "approval-grants");
    const originalFile = path.join(grantsDir, `${grant.activation.grant_id}.json`);
    const duplicateFile = path.join(grantsDir, `${grant.activation.grant_id}-duplicate.json`);
    cpSync(originalFile, duplicateFile);

    const result = await run(["run", ...grant.commonArgs, "--foreground"], {
      cwd,
      env: {
        ...grant.env,
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1", "grant-duplicate"),
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "approval_required");
    assertDirectApiNotSent(record, "GLM");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers run rejects grant approval token as normal per-request token", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-grant-token-run-"));
  const cwd = makeWorkspace();
  try {
    const grant = await createGlmSessionGrant({ cwd, dataDir });

    const result = await run([
      "run",
      ...grant.commonArgs,
      "--foreground",
      "--approval-token", grant.request.grant_approval_token.value,
    ], {
      cwd,
      env: {
        ...grant.env,
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1", "grant-token-normal-run"),
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "approval_required");
    assertDirectApiNotSent(record, "GLM");
    assert.equal(JSON.stringify(record).includes(grant.request.grant_approval_token.value), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers session grants are bound to auth, billing, and route fallback fields", async () => {
  const cases = [
    {
      name: "auth-path",
      approvalConfig: {
        display_name: "Custom Reviewer",
        auth_mode: "api_key",
        env_keys: ["PRIMARY_API_KEY", "SECONDARY_API_KEY"],
        base_url: "https://billing-a.example.invalid",
        model: "custom-review-model",
      },
      approvalEnv: { PRIMARY_API_KEY: "primary-secret-value", SECONDARY_API_KEY: "" },
      runEnv: { PRIMARY_API_KEY: "", SECONDARY_API_KEY: "secondary-secret-value" },
      mutateConfig: null,
    },
    {
      name: "billing-path",
      approvalConfig: {
        display_name: "Custom Reviewer",
        auth_mode: "api_key",
        env_keys: ["CUSTOM_API_KEY"],
        base_url: "https://billing-a.example.invalid",
        model: "custom-review-model",
      },
      approvalEnv: { CUSTOM_API_KEY: "secret-test-value" },
      runEnv: { CUSTOM_API_KEY: "secret-test-value" },
      mutateConfig: {
        display_name: "Custom Reviewer",
        auth_mode: "api_key",
        env_keys: ["CUSTOM_API_KEY"],
        base_url: "https://billing-b.example.invalid",
        model: "custom-review-model",
      },
    },
    {
      name: "fallback-reason",
      approvalConfig: {
        display_name: "Custom Reviewer",
        auth_mode: "api_key",
        env_keys: ["CUSTOM_API_KEY"],
        base_url: "https://billing-a.example.invalid",
        model: "custom-review-model",
      },
      approvalEnv: { CUSTOM_API_KEY: "secret-test-value" },
      runEnv: { CUSTOM_API_KEY: "secret-test-value", API_REVIEWERS_ROUTE_FALLBACK_REASON: "usage_limited" },
      mutateConfig: null,
    },
  ];

  for (const item of cases) {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), `api-reviewers-grant-${item.name}-`));
    const pluginRoot = makeInstalledApiReviewersRoot();
    const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
    try {
      writeSingleProviderConfig(pluginRoot, "custom", item.approvalConfig);
      const commonArgs = [
        "--provider", "custom",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--prompt", "Check this file.",
      ];
      const approvalEnv = {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        ...item.approvalEnv,
      };
      const requestResult = await run([
        "approval-grant",
        "request",
        ...commonArgs,
        "--grant-ttl-ms", "900000",
      ], { cwd, companion, env: approvalEnv });
      assert.equal(requestResult.status, 0, `${item.name}: ${requestResult.stderr || requestResult.stdout}`);
      const request = parseJson(requestResult.stdout);
      const activationResult = await run([
        "approval-grant",
        "activate",
        ...commonArgs,
        "--grant-expires-at", request.grant_bounds.expires_at,
        "--approval-token", request.grant_approval_token.value,
      ], { cwd, companion, env: approvalEnv });
      assert.equal(activationResult.status, 0, `${item.name}: ${activationResult.stderr || activationResult.stdout}`);

      if (item.mutateConfig) writeSingleProviderConfig(pluginRoot, "custom", item.mutateConfig);

      const result = await run(["run", ...commonArgs, "--foreground"], {
        cwd,
        companion,
        env: {
          API_REVIEWERS_PLUGIN_DATA: dataDir,
          API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
          API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
          API_REVIEWERS_MOCK_RESPONSE: mockResponse("custom-review-model"),
          ...item.runEnv,
        },
      });
      assert.equal(result.status, 1, `${item.name}: ${result.stderr || result.stdout}`);
      const record = parseJson(result.stdout);
      assert.equal(record.error_code, "approval_required", item.name);
      assertDirectApiNotSent(record, "Custom Reviewer");
      assert.doesNotMatch(result.stdout, /primary-secret-value|secondary-secret-value|secret-test-value/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
    }
  }
});

test("direct API reviewers approval-request matches run prompt hash and request settings", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const cwd = makeWorkspace();
  const pluginRoot = makeInstalledApiReviewersRoot();
  const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
  const sourceText = "hello from selected scope\n";
  try {
    writeFileSync(path.join(cwd, "seed.txt"), sourceText);
    writeFileSync(path.join(pluginRoot, "config", "providers.json"), JSON.stringify({
      custom: {
        display_name: "Custom Reviewer",
        auth_mode: "api_key",
        env_keys: ["CUSTOM_API_KEY"],
        base_url: "https://custom.example.invalid",
        model: "custom-review-model",
        request_defaults: {
          max_tokens: 7777,
          top_p: 0.85,
        },
      },
    }, null, 2));

    const commonArgs = [
      "--provider", "custom",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Review seed file only.",
    ];
    const commonEnv = {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      API_REVIEWERS_TIMEOUT_MS: "234567",
      CUSTOM_API_KEY: "secret-test-value",
    };

    const approvalResult = await run(["approval-request", ...commonArgs], {
      cwd,
      companion,
      env: commonEnv,
    });
    assert.equal(approvalResult.status, 0, approvalResult.stderr || approvalResult.stdout);
    const approval = parseJson(approvalResult.stdout);
    assert.deepEqual(Object.keys(approval), [
      "event",
      "provider",
      "display_name",
      "mode",
      "scope",
      "scope_base",
      "scope_paths",
      "source_content_transmission",
      "disclosure",
      "approval_question",
      "recommended_tool_justification",
      "approval_token",
      "selected_source",
      "rendered_prompt_hash",
      "source_packet_policy",
      "review_slot_retry_policy",
      "review_slot",
      "request",
      "selected_route",
      "route_step",
      "route_steps",
      "fallback_reason",
      "approval_scope",
      "auth_path",
      "billing_path",
      "scope_resolution",
      "denial_action",
      "denial_fallback",
    ]);

    const runResult = await run(["run", ...commonArgs, "--foreground", "--approval-token", approval.approval_token.value], {
      cwd,
      companion,
      env: {
        ...commonEnv,
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("custom-review-model"),
      },
    });
    assert.equal(runResult.status, 0, runResult.stderr || runResult.stdout);
    const record = parseJson(runResult.stdout);
    const auditManifest = record.review_metadata.audit_manifest;

    assert.deepEqual(approval.request, auditManifest.request);
    assert.deepEqual(approval.selected_source, auditManifest.selected_source);
    assert.deepEqual(approval.scope_resolution, auditManifest.scope_resolution);
    assert.deepEqual(approval.source_packet_policy, auditManifest.source_packet_policy);
    assert.deepEqual(approval.review_slot_retry_policy, auditManifest.review_slot_retry_policy);
    assert.equal(approval.review_slot.retry_fingerprint, auditManifest.review_slot.retry_fingerprint);
    assert.equal(approval.review_slot.retry_count, 0);
    assert.equal(approval.review_slot.retry_disposition_required, false);
    assert.equal(approval.rendered_prompt_hash.value, auditManifest.rendered_prompt_hash.value);
    assert.equal(auditManifest.selected_route, "direct_api");
    assert.equal(auditManifest.fallback_reason, "subscription_not_supported");
    assert.equal(auditManifest.approval_scope, "session");
    assert.deepEqual(auditManifest.auth_path, approval.auth_path);
    assert.deepEqual(auditManifest.billing_path, approval.billing_path);
    assert.equal(auditManifest.source_send_approval_required, true);
    assert.equal(auditManifest.source_send_approval_state, "approved");
    assert.equal(approval.request.timeout_ms, 234567);
    assert.equal(approval.request.max_tokens, 7777);
    assert.equal(approval.request.max_steps_per_turn, null);
    assert.equal(approval.request.temperature, 0);
    assert.equal(approval.request.stream, false);
    assert.equal(approval.selected_route, "direct_api");
    assert.equal(approval.fallback_reason, "subscription_not_supported");
    assert.equal(approval.approval_scope, "session");
    assert.deepEqual(approval.auth_path, {
      auth_mode: "api_key",
      credential_ref: "CUSTOM_API_KEY",
      credential_source: "env",
    });
    assert.deepEqual(approval.billing_path, { endpoint: "https://custom.example.invalid", model: "custom-review-model" });
    assert.equal(JSON.stringify(approval).includes(sourceText.trim()), false);
    assert.equal(JSON.stringify(approval).includes("secret-test-value"), false);

    const replayResult = await run(["run", ...commonArgs, "--foreground", "--approval-token", approval.approval_token.value], {
      cwd,
      companion,
      env: {
        ...commonEnv,
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("custom-review-model", "session-replay"),
      },
    });
    assert.equal(replayResult.status, 0, replayResult.stderr || replayResult.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
  }
});

test("direct API reviewers one-time approval token cannot be replayed", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-once-approval-"));
  try {
    const commonArgs = [
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--approval-scope", "once",
      "--prompt", "Review seed file only.",
    ];
    const commonEnv = {
      API_REVIEWERS_PLUGIN_DATA: dataDir,
      DEEPSEEK_API_KEY: "secret-test-value",
      API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
    };

    const approvalResult = await run(["approval-request", ...commonArgs], {
      cwd,
      env: commonEnv,
    });
    assert.equal(approvalResult.status, 0, approvalResult.stderr || approvalResult.stdout);
    const approval = parseJson(approvalResult.stdout);
    assert.equal(approval.approval_scope, "once");

    const firstRun = await run([
      "run",
      ...commonArgs,
      "--foreground",
      "--approval-token", approval.approval_token.value,
    ], { cwd, env: commonEnv });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstRecord = parseJson(firstRun.stdout);
    assert.equal(firstRecord.external_review.source_content_transmission, "sent");
    assert.equal(firstRecord.review_metadata.audit_manifest.approval_scope, "once");

    const replay = await run([
      "run",
      ...commonArgs,
      "--foreground",
      "--approval-token", approval.approval_token.value,
    ], { cwd, env: commonEnv });
    assert.equal(replay.status, 1, replay.stderr || replay.stdout);
    const replayRecord = parseJson(replay.stdout);
    assert.equal(replayRecord.error_code, "approval_required");
    assertDirectApiNotSent(replayRecord, "DeepSeek");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers run requires approval token before provider execution", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  try {
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
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed", result.stdout || result.stderr);
    assert.equal(record.error_code, "approval_required");
    assert.match(record.error_message, /approval-request/);
    assertDirectApiNotSent(record, "DeepSeek");
    assert.doesNotMatch(result.stdout, /hello from selected scope/);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    provider: "deepseek",
    displayName: "DeepSeek",
    model: "deepseek-v4-flash",
    envKey: "DEEPSEEK_API_KEY",
  },
  {
    provider: "glm",
    displayName: "GLM",
    model: "glm-5.1",
    envKey: "ZAI_API_KEY",
  },
]) {
  test(`direct API ${scenario.provider} run ignores stale doctor success and re-probes before source send`, async () => {
    const pluginRoot = makeInstalledApiReviewersRoot();
    const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
    let mode = "doctor-ok";
    let sourceBearingRequests = 0;
    const requestPrompts = [];
    const server = await startChatServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const prompt = parsed.messages?.[0]?.content ?? "";
        requestPrompts.push(prompt);
        if (prompt === "Return exactly: ok") {
          if (mode === "doctor-ok") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(mockResponse(scenario.model, "chatcmpl-doctor", "ok"));
            return;
          }
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "source-free pre-send probe failed" } }));
          return;
        }
        sourceBearingRequests += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(mockResponse(scenario.model, "chatcmpl-source"));
      });
    });
    try {
      const { port } = server.address();
      writeSingleProviderConfig(pluginRoot, scenario.provider, {
        display_name: scenario.displayName,
        auth_mode: "api_key",
        env_keys: [scenario.envKey],
        base_url: `http://127.0.0.1:${port}`,
        model: scenario.model,
      });

      const env = {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        [scenario.envKey]: "secret-test-value",
      };
      const doctor = await run(["doctor", "--provider", scenario.provider], {
        cwd,
        companion,
        env,
      });
      assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
      assert.equal(parseJson(doctor.stdout).ready, true);

      const commonArgs = [
        "--provider", scenario.provider,
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--prompt", "Review selected file.",
      ];
      const approval = await run(["approval-request", ...commonArgs], {
        cwd,
        companion,
        env,
      });
      assert.equal(approval.status, 0, approval.stderr || approval.stdout);
      mode = "preflight-fail";

      const result = await run([
        "run",
        ...commonArgs,
        "--foreground",
        "--approval-token", parseJson(approval.stdout).approval_token.value,
      ], {
        cwd,
        companion,
        env,
      });

      assert.equal(result.status, 1);
      assert.equal(sourceBearingRequests, 0, "stale doctor success must not authorize selected-source send");
      assert.deepEqual(requestPrompts, ["Return exactly: ok", "Return exactly: ok"]);
      const record = parseJson(result.stdout);
      assert.equal(record.status, "failed");
      assert.equal(record.error_code, "provider_unavailable");
      assertDirectApiNotSent(record, scenario.displayName);
      assert.doesNotMatch(result.stdout, /hello from selected scope/);
      assert.doesNotMatch(result.stdout, /secret-test-value/);
    } finally {
      server.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
    }
  });
}

test("direct API reviewers run rejects approval token when prompt changes", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  try {
    const approvalResult = await run([
      "approval-request",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(approvalResult.status, 0, approvalResult.stderr || approvalResult.stdout);
    const approval = parseJson(approvalResult.stdout);

    const result = await run([
      "run",
      "--provider", "deepseek",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--foreground",
      "--prompt", "Check this file with a changed prompt.",
      "--approval-token", approval.approval_token.value,
    ], {
      cwd,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-reasoner"),
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "approval_required");
    assertDirectApiNotSent(record, "DeepSeek");
    assert.doesNotMatch(result.stdout, /hello from selected scope/);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers approval token is bound to provider, source packet, and request settings", async () => {
  const cases = [
    {
      name: "provider",
      mutateBeforeRun(cwd) {
        return {
          providerArgs: ["--provider", "glm"],
          env: { ZAI_API_KEY: "secret-test-value", API_REVIEWERS_MOCK_RESPONSE: mockResponse("glm-5.1") },
          displayName: "GLM",
        };
      },
    },
    {
      name: "scope-path",
      mutateBeforeRun(cwd) {
        writeFileSync(path.join(cwd, "other.txt"), "other selected scope\n");
        return {
          providerArgs: ["--provider", "deepseek"],
          sourceArgs: ["--scope-paths", "other.txt"],
          env: { API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-reasoner") },
          displayName: "DeepSeek",
        };
      },
    },
    {
      name: "source-bytes",
      mutateBeforeRun(cwd) {
        writeFileSync(path.join(cwd, "seed.txt"), "changed selected scope\n");
        return {
          providerArgs: ["--provider", "deepseek"],
          env: { API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-reasoner") },
          displayName: "DeepSeek",
        };
      },
    },
    {
      name: "request-timeout",
      mutateBeforeRun() {
        return {
          providerArgs: ["--provider", "deepseek"],
          env: {
            API_REVIEWERS_TIMEOUT_MS: "123456",
            API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-reasoner"),
          },
          displayName: "DeepSeek",
        };
      },
    },
    {
      name: "mode",
      mutateBeforeRun() {
        return {
          providerArgs: ["--provider", "deepseek"],
          mode: "adversarial-review",
          env: { API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-reasoner") },
          displayName: "DeepSeek",
        };
      },
    },
  ];

  for (const item of cases) {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), `api-reviewers-approval-${item.name}-`));
    try {
      const approvalArgs = [
        "approval-request",
        "--provider", "deepseek",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--prompt", "Check this file.",
      ];
      const baseEnv = {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        DEEPSEEK_API_KEY: "secret-test-value",
      };
      const approvalResult = await run(approvalArgs, { cwd, env: baseEnv });
      assert.equal(approvalResult.status, 0, approvalResult.stderr || approvalResult.stdout);
      const approval = parseJson(approvalResult.stdout);

      const mutation = item.mutateBeforeRun(cwd);
      const runArgs = [
        "run",
        ...(mutation.providerArgs ?? ["--provider", "deepseek"]),
        "--mode", mutation.mode ?? "custom-review",
        "--scope", "custom",
        ...(mutation.sourceArgs ?? ["--scope-paths", "seed.txt"]),
        "--foreground",
        "--lifecycle-events", "jsonl",
        "--prompt", "Check this file.",
        "--approval-token", approval.approval_token.value,
      ];
      const result = await run(runArgs, {
        cwd,
        env: {
          ...baseEnv,
          API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
          ...(mutation.env ?? {}),
        },
      });

      assert.equal(result.status, 1, item.name);
      const lines = parseJsonLines(result.stdout);
      assert.equal(lines.length, 1, item.name);
      const [record] = lines;
      assert.equal(record.status, "failed", item.name);
      assert.equal(record.error_code, "approval_required", item.name);
      assertDirectApiNotSent(record, mutation.displayName);
      assert.doesNotMatch(result.stdout, /external_review_launched/);
      assert.doesNotMatch(result.stdout, /hello from selected scope|changed selected scope|other selected scope/);
      assert.doesNotMatch(result.stdout, /secret-test-value/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("direct API reviewers approval token is bound to auth and billing paths", async () => {
  const cases = [
    {
      name: "auth-path",
      approvalConfig: {
        display_name: "Custom Reviewer",
        auth_mode: "api_key",
        env_keys: ["PRIMARY_API_KEY", "SECONDARY_API_KEY"],
        base_url: "https://billing-a.example.invalid",
        model: "custom-review-model",
      },
      approvalEnv: { PRIMARY_API_KEY: "primary-secret-value", SECONDARY_API_KEY: "" },
      runEnv: { PRIMARY_API_KEY: "", SECONDARY_API_KEY: "secondary-secret-value" },
      mutateConfig: null,
      expectedApprovalAuthPath: { auth_mode: "api_key", credential_ref: "PRIMARY_API_KEY", credential_source: "env" },
      expectedApprovalBillingPath: { endpoint: "https://billing-a.example.invalid", model: "custom-review-model" },
    },
    {
      name: "billing-path",
      approvalConfig: {
        display_name: "Custom Reviewer",
        auth_mode: "api_key",
        env_keys: ["CUSTOM_API_KEY"],
        base_url: "https://billing-a.example.invalid",
        model: "custom-review-model",
      },
      approvalEnv: { CUSTOM_API_KEY: "secret-test-value" },
      runEnv: { CUSTOM_API_KEY: "secret-test-value" },
      mutateConfig: {
        display_name: "Custom Reviewer",
        auth_mode: "api_key",
        env_keys: ["CUSTOM_API_KEY"],
        base_url: "https://billing-b.example.invalid",
        model: "custom-review-model",
      },
      expectedApprovalAuthPath: { auth_mode: "api_key", credential_ref: "CUSTOM_API_KEY", credential_source: "env" },
      expectedApprovalBillingPath: { endpoint: "https://billing-a.example.invalid", model: "custom-review-model" },
    },
    {
      name: "fallback-reason",
      approvalConfig: {
        display_name: "Custom Reviewer",
        auth_mode: "api_key",
        env_keys: ["CUSTOM_API_KEY"],
        base_url: "https://billing-a.example.invalid",
        model: "custom-review-model",
      },
      approvalEnv: { CUSTOM_API_KEY: "secret-test-value" },
      runEnv: { CUSTOM_API_KEY: "secret-test-value", API_REVIEWERS_ROUTE_FALLBACK_REASON: "usage_limited" },
      mutateConfig: null,
      expectedApprovalAuthPath: { auth_mode: "api_key", credential_ref: "CUSTOM_API_KEY", credential_source: "env" },
      expectedApprovalBillingPath: { endpoint: "https://billing-a.example.invalid", model: "custom-review-model" },
    },
  ];

  for (const item of cases) {
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), `api-reviewers-approval-${item.name}-`));
    const pluginRoot = makeInstalledApiReviewersRoot();
    const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
    try {
      writeSingleProviderConfig(pluginRoot, "custom", item.approvalConfig);
      const commonArgs = [
        "--provider", "custom",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--prompt", "Check this file.",
      ];
      const approvalResult = await run(["approval-request", ...commonArgs], {
        cwd,
        companion,
        env: {
          API_REVIEWERS_PLUGIN_DATA: dataDir,
          API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
          ...item.approvalEnv,
        },
      });
      assert.equal(approvalResult.status, 0, approvalResult.stderr || approvalResult.stdout);
      const approval = parseJson(approvalResult.stdout);
      assert.deepEqual(approval.auth_path, item.expectedApprovalAuthPath, item.name);
      assert.deepEqual(approval.billing_path, item.expectedApprovalBillingPath, item.name);
      assert.equal(approval.selected_route, "direct_api", item.name);
      assert.equal(approval.fallback_reason, "subscription_not_supported", item.name);

      if (item.mutateConfig) {
        writeSingleProviderConfig(pluginRoot, "custom", item.mutateConfig);
      }

      const result = await run([
        "run",
        ...commonArgs,
        "--foreground",
        "--lifecycle-events", "jsonl",
        "--approval-token", approval.approval_token.value,
      ], {
        cwd,
        companion,
        env: {
          API_REVIEWERS_PLUGIN_DATA: dataDir,
          API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
          API_REVIEWERS_MOCK_RESPONSE: mockResponse("custom-review-model"),
          ...item.runEnv,
        },
      });

      assert.equal(result.status, 1, item.name);
      const lines = parseJsonLines(result.stdout);
      assert.equal(lines.length, 1, item.name);
      const [record] = lines;
      assert.equal(record.status, "failed", item.name);
      assert.equal(record.error_code, "approval_required", item.name);
      assertDirectApiNotSent(record, "Custom Reviewer");
      assert.doesNotMatch(result.stdout, /external_review_launched/);
      assert.doesNotMatch(result.stdout, /hello from selected scope/);
      assert.doesNotMatch(result.stdout, /primary-secret-value|secondary-secret-value|secret-test-value/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
    }
  }
});

test("direct API reviewers approval token is bound to credential source", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-approval-credential-source-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
  const home = makeOpEnvCacheHome({
    CUSTOM_API_KEY: "cache-secret-value",
  });
  try {
    writeSingleProviderConfig(pluginRoot, "custom", {
      display_name: "Custom Reviewer",
      auth_mode: "api_key",
      env_keys: ["CUSTOM_API_KEY"],
      base_url: "https://billing-a.example.invalid",
      model: "custom-review-model",
    });
    const commonArgs = [
      "--provider", "custom",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Check this file.",
    ];

    const approvalResult = await run(["approval-request", ...commonArgs], {
      cwd,
      companion,
      env: {
        API_REVIEWERS_DISABLE_ENV_CACHE: "1",
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        CUSTOM_API_KEY: "env-secret-value",
      },
    });
    assert.equal(approvalResult.status, 0, approvalResult.stderr || approvalResult.stdout);
    const approval = parseJson(approvalResult.stdout);
    assert.deepEqual(approval.auth_path, {
      auth_mode: "api_key",
      credential_ref: "CUSTOM_API_KEY",
      credential_source: "env",
    });

    const result = await run([
      "run",
      ...commonArgs,
      "--foreground",
      "--lifecycle-events", "jsonl",
      "--approval-token", approval.approval_token.value,
    ], {
      cwd,
      companion,
      env: {
        API_REVIEWERS_DISABLE_ENV_CACHE: "0",
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("custom-review-model"),
        HOME: home,
        CUSTOM_API_KEY: "env-secret-value",
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const lines = parseJsonLines(result.stdout);
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "approval_required");
    assertDirectApiNotSent(record, "Custom Reviewer");
    assert.doesNotMatch(result.stdout, /external_review_launched/);
    assert.doesNotMatch(result.stdout, /hello from selected scope/);
    assert.doesNotMatch(result.stdout, /env-secret-value|cache-secret-value/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
  }
});

test("direct API reviewers reject invalid route fallback reason as bad args before source send", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-invalid-route-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
  try {
    writeSingleProviderConfig(pluginRoot, "custom", {
      display_name: "Custom Reviewer",
      auth_mode: "api_key",
      env_keys: ["CUSTOM_API_KEY"],
      base_url: "https://billing-a.example.invalid",
      model: "custom-review-model",
    });
    const commonArgs = [
      "--provider", "custom",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "seed.txt",
      "--prompt", "Check this file.",
    ];
    const approvalResult = await run(["approval-request", ...commonArgs], {
      cwd,
      companion,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_TEST_AUTO_APPROVAL: "0",
        CUSTOM_API_KEY: "secret-test-value",
      },
    });
    assert.equal(approvalResult.status, 0, approvalResult.stderr || approvalResult.stdout);
    const approval = parseJson(approvalResult.stdout);

    const result = await run([
      "run",
      ...commonArgs,
      "--foreground",
      "--approval-token", approval.approval_token.value,
    ], {
      cwd,
      companion,
      env: {
        API_REVIEWERS_PLUGIN_DATA: dataDir,
        API_REVIEWERS_REQUIRE_APPROVAL_TOKEN_IN_MOCKS: "1",
        API_REVIEWERS_MOCK_RESPONSE: mockResponse("custom-review-model"),
        API_REVIEWERS_ROUTE_FALLBACK_REASON: "invalid-test-reason",
        CUSTOM_API_KEY: "secret-test-value",
      },
    });

    assert.equal(result.status, 1);
    const record = parseJson(result.stdout);
    assert.equal(record.status, "failed", result.stdout || result.stderr);
    assert.equal(record.error_code, "bad_args");
    assert.match(record.error_message, /unsupported route fallback reason/);
    assertDirectApiNotSent(record, "Custom Reviewer");
    assert.doesNotMatch(result.stdout, /external_review_launched|hello from selected scope|secret-test-value/);
    assert.doesNotMatch(result.stderr, /Error:|at /);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
  }
});

test("direct API reviewers approval-request rejects rendered prompt over provider budget", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "approval-request",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MAX_PROMPT_CHARS: "100",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.provider, "deepseek");
  assert.equal(parsed.status, "prompt_too_large");
  assert.equal(parsed.error_code, "prompt_too_large");
  assert.match(parsed.error_message, /prompt_too_large:/);
  assert.doesNotMatch(result.stdout, /external_review_approval_request/);
  assert.doesNotMatch(result.stdout, /hello from selected scope/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

for (const promptCapProvider of [
  { provider: "deepseek", env: { DEEPSEEK_API_KEY: "secret-test-value" } },
  { provider: "glm", env: { ZAI_API_KEY: "secret-test-value" } },
]) {
  test(`direct API ${promptCapProvider.provider} approval-request emits sharding plan when rendered prompt exceeds cap`, async () => {
    const cwd = makeMultiFileScopeWorkspace();
    const result = await run([
      "approval-request",
      "--provider", promptCapProvider.provider,
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "f1.txt,f2.txt,f3.txt,f4.txt,f5.txt",
      "--prompt", "Check changed files.",
    ], {
      cwd,
      env: {
        API_REVIEWERS_MAX_PROMPT_CHARS: "5000",
        ...promptCapProvider.env,
      },
    });

    assert.equal(result.status, 1);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.provider, promptCapProvider.provider);
    assert.equal(parsed.status, "prompt_too_large");
    assert.equal(parsed.error_code, "prompt_too_large");
    assert.match(parsed.error_message, /prompt_too_large:/);
    assert.doesNotMatch(result.stdout, /external_review_approval_request/);

    const plan = parsed.runtime_diagnostics?.sharding_plan;
    assert.ok(plan, "approval-request prompt-cap failures must include sharding_plan");
    assert.equal(plan.reason, "prompt_too_large");
    assert.equal(plan.source_content_transmission, "not_sent");
    assert.equal(plan.cap, 5000);
    assert.equal(typeof plan.rendered_prompt_chars, "number");
    assert.ok(plan.rendered_prompt_chars > plan.cap);
    assert.ok(Array.isArray(plan.shards) && plan.shards.length >= 2, "fixture must split into >=2 bounded shards");

    const hashes = new Set();
    const tupleFingerprints = new Set();
    for (const [i, shard] of plan.shards.entries()) {
      assert.equal(shard.index, i + 1);
      assert.equal(shard.total, plan.shards.length);
      assert.ok(Array.isArray(shard.scope_paths) && shard.scope_paths.length > 0);
      assert.equal(typeof shard.rendered_prompt_chars, "number");
      assert.ok(shard.rendered_prompt_chars <= plan.cap);
      const tuple = shard.approval_tuple;
      assert.ok(tuple);
      assert.equal(tuple.provider, promptCapProvider.provider);
      assert.equal(tuple.mode, "custom-review");
      assert.equal(tuple.selected_route, "direct_api");
      assert.equal(tuple.fallback_reason, "subscription_not_supported");
      assert.equal(tuple.approval_scope, "session");
      assert.match(tuple.rendered_prompt_hash, /^[a-f0-9]{64}$/);
      hashes.add(tuple.rendered_prompt_hash);
      assert.ok(tuple.approval_tuple_fingerprint);
      assert.equal(tuple.approval_tuple_fingerprint.algorithm, "sha256");
      assert.match(tuple.approval_tuple_fingerprint.value, /^[a-f0-9]{64}$/);
      tupleFingerprints.add(tuple.approval_tuple_fingerprint.value);
      assert.deepEqual([...tuple.scope_paths].sort(), [...shard.scope_paths].sort());
      assert.ok(tuple.source_packet);
      assert.deepEqual(
        tuple.source_packet.files.map((file) => file.path).sort(),
        [...shard.scope_paths].sort(),
      );
    }
    assert.equal(hashes.size, plan.shards.length, "each shard must have a unique rendered_prompt_hash");
    assert.equal(tupleFingerprints.size, plan.shards.length, "each shard must have a unique approval tuple fingerprint");

    const recovery = parsed.runtime_diagnostics?.packet_recovery;
    assert.ok(recovery, "approval-request prompt-cap failures must include packet_recovery before any approval token exists");
    assert.equal(recovery.reason, "prompt_too_large");
    assert.equal(recovery.source_content_transmission, "not_sent");
    assert.equal(recovery.provider, promptCapProvider.provider);
    assert.equal(recovery.mode, "custom-review");
    const shardAction = recovery.actions.find((action) => action.type === "shard");
    assert.ok(shardAction, "approval-request recovery must expose shard action");
    assert.deepEqual(shardAction.shards, plan.shards);
    assert.equal("approval_token" in parsed, false);

    const planJson = JSON.stringify(plan);
    assert.equal(planJson.includes("hello from selected scope"), false);
    assert.equal(planJson.includes("secret-test-value"), false);
    assert.equal(planJson.includes("Check changed files."), false);
    assert.doesNotMatch(JSON.stringify(recovery), /approval_token|approval-token|secret-test-value/i);
    assert.doesNotMatch(result.stdout, /hello from selected scope/);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  });
}

test("direct API reviewers approval-request redacts configured non-generic credential names", async () => {
  const cwd = makeBranchDiffWorkspace();
  const pluginRoot = makeInstalledApiReviewersRoot();
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), JSON.stringify({
    custom: {
      display_name: "CustomProvider",
      auth_mode: "api_key",
      env_keys: ["CUSTOM_CREDENTIAL"],
      base_url: "https://custom.example.invalid",
      model: "custom-reviewer",
    },
  }, null, 2));

  const result = await run([
    "approval-request",
    "--provider", "custom",
    "--mode", "review",
    "--scope-base", "token-token-value",
    "--prompt", "Review this branch.",
  ], {
    cwd,
    companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
    env: {
      CUSTOM_CREDENTIAL: "token-token-value",
    },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.provider, "custom");
  assert.equal(parsed.status, "scope_failed");
  assert.equal(parsed.error_code, "scope_failed");
  assert.match(parsed.error_message, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /token-token-value/);
});

test("direct API reviewers approval-request reports structured config errors", async () => {
  const pluginRoot = makeInstalledApiReviewersRoot();
  const companion = path.join(pluginRoot, "scripts", "api-reviewer.mjs");
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), "{not json\n");
  const result = await run([
    "approval-request",
    "--provider", "glm",
    "--mode", "review",
    "--prompt", "Review this branch.",
  ], {
    companion,
    env: { ZAI_API_KEY: "secret-test-value" },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.provider, "glm");
  assert.equal(parsed.status, "config_error");
  assert.equal(parsed.error_code, "config_error");
  assert.match(parsed.error_message, /providers config unreadable/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
  assert.doesNotMatch(result.stdout, /^\{\s*"ok": false,\s*"error"/m);
});

test("direct API reviewers approval-request reports structured bad args", async () => {
  const result = await run([
    "approval-request",
    "--mode", "rescue",
    "--prompt", "Review this branch.",
  ], {
    env: { ZAI_API_KEY: "secret-test-value" },
  });

  assert.equal(result.status, 1);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.provider, null);
  assert.equal(parsed.status, "bad_args");
  assert.equal(parsed.error_code, "bad_args");
  assert.match(parsed.error_message, /--provider is required/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
  assert.doesNotMatch(result.stdout, /^\{\s*"ok": false,\s*"error"/m);
});

test("direct API reviewers approval-request validates prompt before collecting scope", async () => {
  const cwd = makeWorkspace();
  try {
    const result = await run([
      "approval-request",
      "--provider", "glm",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "missing.txt",
    ], {
      cwd,
      env: { ZAI_API_KEY: "secret-test-value" },
    });

    assert.equal(result.status, 1);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.provider, "glm");
    assert.equal(parsed.status, "bad_args");
    assert.equal(parsed.error_code, "bad_args");
    assert.match(parsed.error_message, /prompt is required/);
    assert.doesNotMatch(parsed.error_message, /missing\.txt/);
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("direct API reviewers lifecycle jsonl suppresses launch on invalid provider env", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "seed.txt",
    "--foreground",
    "--lifecycle-events", "jsonl",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MAX_TOKENS: "0",
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.length, 1);
  const record = lines[0];
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "bad_args");
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.error_message, /API_REVIEWERS_MAX_TOKENS/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
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

test("direct API reviewers lifecycle jsonl suppresses launch on scope failure", async () => {
  const cwd = makeWorkspace();
  const result = await run([
    "run",
    "--provider", "deepseek",
    "--mode", "custom-review",
    "--scope", "custom",
    "--foreground",
    "--lifecycle-events", "jsonl",
    "--prompt", "Check this file.",
  ], {
    cwd,
    env: {
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-flash"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 1);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.length, 1);
  const record = lines[0];
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.equal(record.external_review.source_content_transmission, "not_sent");
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

// AC7-AC8 (#106): smoke replay against recorded fixtures.
//
// For each recorded fixture under tests/smoke/fixtures/api-reviewers-*/,
// synthesize the HTTP response shape the real provider returned, run the
// wrapper through the existing 127.0.0.1 server harness, and assert the
// replayed JobRecord matches the recorded fixture's *shape* (status,
// error_code, http_status, transmission, schema_version). Field-level
// content (cwd, endpoint, sessions, exact prompt hash) is NOT compared —
// only the architecture's schema invariants.

const REPLAY_FIXTURES_ROOT = path.join(REPO_ROOT, "tests", "smoke", "fixtures");

function readReplayFixture(plugin, scenario) {
  const fixturePath = path.join(REPLAY_FIXTURES_ROOT, plugin, `${scenario}.response.json`);
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function buildHttpResponseFromApiReviewersFixture(fixture) {
  if (fixture.status === "completed" && fixture.http_status === 200) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        id: "chatcmpl-replay",
        object: "chat.completion",
        model: fixture.raw_model ?? fixture.model,
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: fixture.result ?? substantiveReviewFixture("Replay fixture marker.") },
        }],
        usage: fixture.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    };
  }
  return {
    statusCode: fixture.http_status ?? 500,
    body: JSON.stringify({ error: { message: fixture.error_message ?? "replay error" } }),
  };
}

for (const scenarioCase of [
  { plugin: "api-reviewers-deepseek", scenario: "happy-path-review", provider: "deepseek", credentialEnv: "DEEPSEEK_API_KEY" },
  { plugin: "api-reviewers-deepseek", scenario: "auth-rejected", provider: "deepseek", credentialEnv: "DEEPSEEK_API_KEY" },
]) {
  test(`smoke replay: ${scenarioCase.plugin}/${scenarioCase.scenario} reproduces recorded JobRecord shape`, async () => {
    const fixture = readReplayFixture(scenarioCase.plugin, scenarioCase.scenario);
    const httpResp = buildHttpResponseFromApiReviewersFixture(fixture);
    const cwd = makeWorkspace();
    const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-replay-"));
    const pluginRoot = makeInstalledApiReviewersRoot();
    // Capture the request the wrapper sends so we can assert that the
    // outgoing payload matches what the recorded fixture implies (model,
    // auth shape, content delivery). Without this, a regression that broke
    // the wrapper's request side would still pass — server returns canned
    // bytes regardless.
    const captured = { url: null, method: null, authorization: null, body: null };
    const server = await startChatServer(async (req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += chunk;
      let body = null;
      try { body = JSON.parse(raw); } catch { body = raw; }
      if (body && typeof body === "object" && respondSourceFreePreflight(body, res, "deepseek-v4-flash")) return;
      captured.url = req.url;
      captured.method = req.method;
      captured.authorization = req.headers.authorization ?? null;
      captured.body = body;
      res.writeHead(httpResp.statusCode, { "content-type": "application/json" });
      res.end(httpResp.body);
    });
    try {
      const { port } = server.address();
      writeDeepSeekProviderConfig(pluginRoot, `http://127.0.0.1:${port}`);
      const result = await run([
        "run",
        "--provider", scenarioCase.provider,
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--foreground",
        "--prompt", "Replayed against recorded fixture.",
      ], {
        cwd,
        companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
        env: {
          API_REVIEWERS_PLUGIN_DATA: dataDir,
          [scenarioCase.credentialEnv]: "secret-test-value",
        },
      });
      assert.equal(result.status, fixture.exit_code, result.stderr || result.stdout);
      const replayed = parseJson(result.stdout);
      // Two-axis shape check: subset (every expected key present) plus an
      // internal-state guard (no extra key matches a suspicious internal
      // pattern). See tests/helpers/job-record-shape.mjs.
      assertJobRecordShape(replayed, [...API_REVIEWER_EXPECTED_KEYS], {
        label: `${scenarioCase.plugin}/${scenarioCase.scenario}`,
      });
      assert.equal(replayed.schema_version, fixture.schema_version);
      assert.equal(replayed.status, fixture.status);
      assert.equal(replayed.error_code, fixture.error_code);
      assert.equal(replayed.http_status, fixture.http_status);
      assert.equal(replayed.target, fixture.target);
      assert.equal(replayed.provider, fixture.provider);
      assert.equal(replayed.review_metadata.prompt_provider, fixture.review_metadata.prompt_provider);
      assert.equal(
        replayed.review_metadata.audit_manifest.schema_version,
        fixture.review_metadata.audit_manifest.schema_version,
      );
      assert.equal(
        replayed.external_review.source_content_transmission,
        fixture.external_review.source_content_transmission,
        "transmission must match recorded fixture (security-critical invariant)",
      );
      assert.doesNotMatch(result.stdout, /secret-test-value/);
      // Round-trip the raw provider result text on happy path. Skipped for
      // negative paths where fixture.result is null.
      if (fixture.status === "completed" && typeof fixture.result === "string") {
        assert.equal(
          replayed.result,
          fixture.result,
          "binary result text must round-trip through the wrapper",
        );
      }
      // Request-side assertions: the wrapper actually hit the chat endpoint,
      // POSTed an OpenAI-compat body with the configured model + the seed
      // content, and presented Bearer auth. Without these, the replay only
      // checks what the wrapper accepts; we want to also pin what it sends.
      assert.equal(captured.method, "POST", "wrapper must POST to chat endpoint");
      assert.equal(captured.url, "/chat/completions", "wrapper must hit /chat/completions");
      assert.match(
        captured.authorization ?? "",
        /^Bearer secret-test-value$/,
        "wrapper must present Bearer auth with the configured key",
      );
      assert.equal(typeof captured.body, "object", "request body must be JSON");
      assert.equal(captured.body.model, "deepseek-v4-flash", "request body must carry the configured model");
      assert.ok(Array.isArray(captured.body.messages) && captured.body.messages.length >= 1,
        "request body must include at least one message");
      const firstMessage = captured.body.messages[0];
      assert.equal(typeof firstMessage.content, "string", "first message must have string content");
      assert.match(
        firstMessage.content,
        /hello from selected scope/,
        "transmission=sent paths must put the selected source content into the request body",
      );
    } finally {
      server.close();
    }
  });
}
