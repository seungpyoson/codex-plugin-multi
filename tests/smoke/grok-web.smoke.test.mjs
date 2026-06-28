import { once } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { externalReviewLaunchedEvent } from "../../scripts/lib/companion-common.mjs";
import { assertJobRecordShape } from "../helpers/job-record-shape.mjs";
import { badVerdictReviewFixture, substantiveReviewFixture } from "../helpers/review-fixtures.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/grok/scripts/grok-companion.mjs");
const COMPANION_RUNTIME = path.join(REPO_ROOT, "plugins/grok/scripts/grok-web-reviewer.mjs");
const DEFAULT_GROK_SMOKE_DATA_ROOTS = new Set();
const VALID_SESSION_TOKEN = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature";
const GROK_EXPECTED_KEYS = Object.freeze([
  "id",
  "job_id",
  "target",
  "provider",
  "fallback_from",
  "transport",
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
  const defaultTransportEnv = options.defaultTransport === false ? {} : { GROK_TRANSPORT: "web" };
  const cwd = options.cwd ?? REPO_ROOT;
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    env: grokSmokeEnv(cwd, options.env, defaultTransportEnv),
    encoding: "utf8",
  });
}

function runAsync(args, options = {}) {
  const defaultTransportEnv = options.defaultTransport === false ? {} : { GROK_TRANSPORT: "web" };
  const cwd = options.cwd ?? REPO_ROOT;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd,
      env: grokSmokeEnv(cwd, options.env, defaultTransportEnv),
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

function grokSmokeEnv(cwd, env = {}, defaultTransportEnv = {}) {
  const explicitPluginDataRoot = env.GROK_PLUGIN_DATA
    ?? process.env.GROK_PLUGIN_DATA
    ?? null;
  const fallbackPluginDataRoot = explicitPluginDataRoot ?? defaultGrokSmokeDataRoot(cwd);
  const workloadLockDir = env.RELAY_PROVIDER_WORKLOAD_LOCK_DIR
    ?? path.join(fallbackPluginDataRoot, ".provider-workload");
  return {
    ...process.env,
    ...defaultTransportEnv,
    ...env,
    ...(explicitPluginDataRoot === null ? {} : { GROK_PLUGIN_DATA: explicitPluginDataRoot }),
    RELAY_PROVIDER_WORKLOAD_LOCK_DIR: workloadLockDir,
    RELAY_WORKLOAD_TEST_MODE: "1",
  };
}

after(() => {
  for (const dataRoot of DEFAULT_GROK_SMOKE_DATA_ROOTS) {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("grok smoke env defaults workload locks outside the repo root", () => {
  const env = grokSmokeEnv(REPO_ROOT, {});
  const expectedDataRoot = defaultDataRootFor("grok", REPO_ROOT);
  if (process.env.GROK_PLUGIN_DATA == null) {
    assert.equal(Object.hasOwn(env, "GROK_PLUGIN_DATA"), false);
  }
  assert.equal(env.RELAY_PROVIDER_WORKLOAD_LOCK_DIR, path.join(expectedDataRoot, ".provider-workload"));
  assert.notEqual(env.RELAY_PROVIDER_WORKLOAD_LOCK_DIR, path.join(REPO_ROOT, ".provider-workload"));
  assert.ok(!env.RELAY_PROVIDER_WORKLOAD_LOCK_DIR.startsWith(REPO_ROOT + path.sep));
});

function defaultGrokSmokeDataRoot(cwd) {
  const dataRoot = defaultDataRootFor("grok", cwd);
  DEFAULT_GROK_SMOKE_DATA_ROOTS.add(dataRoot);
  return dataRoot;
}

function parseStdout(result) {
  assert.doesNotMatch(result.stderr, /secret|token|cookie|xai/i);
  return JSON.parse(result.stdout);
}

function parseJsonLines(result) {
  assert.doesNotMatch(result.stderr, /secret|token|cookie|xai/i);
  return result.stdout.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

function parseCompactJsonLines(result) {
  assert.doesNotMatch(result.stderr, /secret|token|cookie|xai/i);
  return result.stdout.split(/\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
}

function defaultDataRootFor(pluginName, cwd) {
  const workspace = path.resolve(cwd);
  const slug = path.basename(workspace).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return path.resolve(tmpdir(), "relay", pluginName, `${slug}-${hash}`);
}

function initGitRepo(cwd) {
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
}

function rmTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForValue(fn, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error(`timed out after ${timeoutMs}ms waiting for value`);
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

async function withServer(handler, fn, options = {}) {
  const autoPreflight = options.autoPreflight !== false;
  const server = http.createServer(async (req, res) => {
    if (autoPreflight && req.headers["x-relay-grok-readiness-preflight"] === "1") {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      assert.equal(body.messages.length, 1);
      assert.equal(body.messages[0].content, "Return exactly: ok");
      assert.doesNotMatch(body.messages[0].content, /review\.js|BEGIN GROK FILE|export const/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-web-readiness-preflight",
        model: "grok-4.20-fast",
        choices: [{ message: { content: "ok" } }],
      }));
      return;
    }
    await handler(req, res);
  });
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

async function unusedLoopbackPort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function makeFakeGrok2ApiHome() {
  const home = mkdtempSync(path.join(tmpdir(), "fake-grok2api-home-"));
  mkdirSync(path.join(home, "app"), { recursive: true });
  writeFileSync(path.join(home, "app", "main.py"), "app = object()\n");
  writeFileSync(path.join(home, "pyproject.toml"), "[project]\nname = \"fake-grok2api\"\n");
  return home;
}

function makeFakeUvBin(options = {}) {
  const mode = options.mode ?? "reachable";
  const envCapturePath = options.envCapturePath ?? null;
  const binDir = mkdtempSync(path.join(tmpdir(), "fake-uv-bin-"));
  const uvPath = path.join(binDir, "uv");
  writeFileSync(uvPath, `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  console.log("uv 0.0.0-fake");
  process.exit(0);
}
const envCapturePath = ${JSON.stringify(envCapturePath)};
if (envCapturePath) {
  fs.writeFileSync(envCapturePath, JSON.stringify({
    UV_CACHE_DIR: Object.prototype.hasOwnProperty.call(process.env, "UV_CACHE_DIR") ? process.env.UV_CACHE_DIR : null,
    PATH: process.env.PATH || null,
  }));
}
const mode = ${JSON.stringify(mode)};
if (mode === "unreachable") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(0), 30000);
} else if (mode === "late-reachable-ignore-sigterm") {
  process.on("SIGTERM", () => {});
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  const host = process.argv[process.argv.indexOf("--host") + 1] || "127.0.0.1";
  setTimeout(() => {
    const server = http.createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    server.listen(port, host);
  }, 350);
  setTimeout(() => process.exit(0), 30000);
} else if (mode === "slow-reachable") {
  process.on("SIGTERM", () => process.exit(0));
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  const host = process.argv[process.argv.indexOf("--host") + 1] || "127.0.0.1";
  setTimeout(() => {
    const server = http.createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.end(JSON.stringify({
          id: "fake-grok2api-slow-chat",
          model: "grok-4.20-fast",
          choices: [{ message: { content: "ok" } }],
        }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    server.listen(port, host);
  }, 750);
  setTimeout(() => process.exit(0), 30000);
} else {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  const host = process.argv[process.argv.indexOf("--host") + 1] || "127.0.0.1";
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.end(JSON.stringify({
        id: "fake-grok2api-chat",
        model: "grok-4.20-fast",
        choices: [{ message: { content: "ok" } }],
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  server.listen(port, host);
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 30000);
}
`);
  chmodSync(uvPath, 0o700);
  return binDir;
}

function makeFakeGitBinary({ mode = "success" } = {}) {
  const binDir = mkdtempSync(path.join(tmpdir(), "fake-git-bin-"));
  const gitPath = path.join(binDir, "git");
  writeFileSync(gitPath, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] !== "clone") {
  console.error("unexpected git command");
  process.exit(2);
}
const dest = process.argv[process.argv.length - 1];
fs.mkdirSync(path.join(dest, "app"), { recursive: true });
if (${JSON.stringify(mode)} === "partial-fail") {
  fs.writeFileSync(path.join(dest, "app", "partial.py"), "partial clone\\n");
  console.error("simulated clone failure after creating destination");
  process.exit(128);
}
fs.writeFileSync(path.join(dest, "app", "main.py"), "app = object()\\n");
fs.writeFileSync(path.join(dest, "pyproject.toml"), "[project]\\nname = \\"fake-grok2api\\"\\n");
`);
  chmodSync(gitPath, 0o700);
  return { binDir, gitPath };
}

function makeFakeGrokCli({
  modelsOutput = null,
  modelsExitStatus = 0,
  modelsStderr = "grok models failed\n",
  sourceFreeAuthStderr = null,
  failSourceBearing = false,
  failSourceBearingHomeCleanup = false,
  failSourceBearingPromptCleanup = false,
  failNeutralCwdCleanup = false,
  blockNeutralCwdCleanup = false,
  failSourceFreeHomeCleanup = false,
  sourceBearingDelayMs = 0,
  ignoreSourceBearingSigterm = false,
  mutateAuthOnSource = false,
  mutateAuthOnSourceFree = false,
  sourceFreeHangMs = 0,
} = {}) {
  const binDir = mkdtempSync(path.join(tmpdir(), "fake-grok-cli-bin-"));
  const logPath = path.join(binDir, "grok-log.jsonl");
  const grokPath = path.join(binDir, "grok");
  writeFileSync(grokPath, `#!${process.execPath}
const fs = require("node:fs");
const logPath = ${JSON.stringify(logPath)};
const failSourceBearing = ${JSON.stringify(failSourceBearing)};
const failSourceBearingHomeCleanup = ${JSON.stringify(failSourceBearingHomeCleanup)};
const failSourceBearingPromptCleanup = ${JSON.stringify(failSourceBearingPromptCleanup)};
const failNeutralCwdCleanup = ${JSON.stringify(failNeutralCwdCleanup)};
const blockNeutralCwdCleanup = ${JSON.stringify(blockNeutralCwdCleanup)};
const failSourceFreeHomeCleanup = ${JSON.stringify(failSourceFreeHomeCleanup)};
const sourceBearingDelayMs = ${JSON.stringify(sourceBearingDelayMs)};
const ignoreSourceBearingSigterm = ${JSON.stringify(ignoreSourceBearingSigterm)};
const modelsExitStatus = ${JSON.stringify(modelsExitStatus)};
const modelsStderr = ${JSON.stringify(modelsStderr)};
const sourceFreeAuthStderr = ${JSON.stringify(sourceFreeAuthStderr)};
const mutateAuthOnSource = ${JSON.stringify(mutateAuthOnSource)};
const mutateAuthOnSourceFree = ${JSON.stringify(mutateAuthOnSourceFree)};
const sourceFreeHangMs = ${JSON.stringify(sourceFreeHangMs)};
const args = process.argv.slice(2);
const apiEnvKeys = ["GROK_API_KEY", "XAI_API_KEY", "XAI_KEY"].filter((key) => Object.prototype.hasOwnProperty.call(process.env, key));
const sensitiveEnvKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "GITHUB_TOKEN", "GH_TOKEN"].filter((key) => Object.prototype.hasOwnProperty.call(process.env, key));
fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd(), apiEnvKeys, sensitiveEnvKeys }) + "\\n");
if (args.includes("--version") || args[0] === "version") {
  process.stdout.write("grok 0.1.211 (mock)\\n");
  process.exit(0);
}
if (args[0] === "models") {
  if (modelsExitStatus !== 0) {
    process.stderr.write(modelsStderr);
    process.exit(modelsExitStatus);
  }
  process.stdout.write(${JSON.stringify(modelsOutput ?? ["You are logged in with grok.com.", "", "Default model: grok-build", "", "Available models:", "  * grok-build (default)", ""].join("\n"))});
  process.exit(0);
}
const promptFileIndex = args.indexOf("--prompt-file");
if (promptFileIndex < 0 || !args[promptFileIndex + 1]) {
  process.stderr.write("missing --prompt-file\\n");
  process.exit(2);
}
const promptPath = args[promptFileIndex + 1];
const prompt = fs.readFileSync(promptPath, "utf8");
if (failSourceBearingPromptCleanup && prompt.includes("CLI_SOURCE_SECRET")) {
  fs.writeFileSync(require("node:path").join(require("node:path").dirname(promptPath), "source-copy.txt"), prompt.slice(0, 128));
}
if (failNeutralCwdCleanup && prompt.includes("CLI_SOURCE_SECRET")) {
  fs.writeFileSync(require("node:path").join(process.cwd(), "source-copy.txt"), prompt.slice(0, 128));
}
if (blockNeutralCwdCleanup && prompt.includes("CLI_SOURCE_SECRET")) {
  const blocked = require("node:path").join(process.cwd(), "blocked-cleanup");
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(require("node:path").join(blocked, "source.txt"), prompt.slice(0, 128));
  fs.chmodSync(blocked, 0o000);
}
const grokHome = process.env.GROK_HOME || null;
if (grokHome) {
  fs.mkdirSync(require("node:path").join(grokHome, "sessions"), { recursive: true });
  fs.writeFileSync(require("node:path").join(grokHome, "sessions", "session.jsonl"), prompt.slice(0, 128));
  if (
    (mutateAuthOnSource && prompt.includes("CLI_SOURCE_SECRET"))
    || (mutateAuthOnSourceFree && !prompt.includes("CLI_SOURCE_SECRET"))
  ) {
    fs.writeFileSync(require("node:path").join(grokHome, "auth.json"), "{\\"token\\":\\"mutated\\"}\\n");
  }
  if (failSourceBearingHomeCleanup && prompt.includes("CLI_SOURCE_SECRET")) {
    const blocked = require("node:path").join(grokHome, "blocked-cleanup");
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(require("node:path").join(blocked, "source.txt"), prompt.slice(0, 128));
    fs.chmodSync(blocked, 0o000);
  }
  if (failSourceFreeHomeCleanup && !prompt.includes("CLI_SOURCE_SECRET")) {
    const blocked = require("node:path").join(grokHome, "blocked-cleanup");
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(require("node:path").join(blocked, "preflight.txt"), prompt.slice(0, 128));
    fs.chmodSync(blocked, 0o000);
  }
}
fs.appendFileSync(logPath, JSON.stringify({
  pid: process.pid,
  promptPath,
  existsDuring: fs.existsSync(promptPath),
  promptHasSource: prompt.includes("CLI_SOURCE_SECRET"),
  promptHasDelimiter: prompt.includes("BEGIN GROK FILE 1: review.js"),
  grokHome,
  envPath: process.env.PATH || "",
  grokHomeExistsDuring: grokHome ? fs.existsSync(grokHome) : false,
  grokHomeHasAuthLink: grokHome ? fs.lstatSync(require("node:path").join(grokHome, "auth.json")).isSymbolicLink() : false,
  grokHomeHasMcpCredentials: grokHome ? fs.existsSync(require("node:path").join(grokHome, "mcp_credentials.json")) : false,
  apiEnvKeys,
  sensitiveEnvKeys,
  cwd: process.cwd(),
}) + "\\n");
if (failSourceBearing && prompt.includes("CLI_SOURCE_SECRET")) {
  process.stderr.write("unknown option --no-memory\\n");
  process.exit(2);
}
if (sourceFreeAuthStderr && !prompt.includes("CLI_SOURCE_SECRET")) {
  process.stderr.write(sourceFreeAuthStderr);
  process.exit(1);
}
if (sourceFreeHangMs > 0 && !prompt.includes("CLI_SOURCE_SECRET")) {
  // Silent stall on the source-free probe (no OAuth stderr): forces the parent
  // to enforce its own timeout bound rather than the child exiting on its own.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sourceFreeHangMs);
}
if (ignoreSourceBearingSigterm && prompt.includes("CLI_SOURCE_SECRET")) {
  process.on("SIGTERM", () => {});
  setTimeout(() => process.exit(0), 5000);
  setInterval(() => {}, 1000);
}
if (sourceBearingDelayMs > 0 && prompt.includes("CLI_SOURCE_SECRET")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sourceBearingDelayMs);
}
process.stdout.write(JSON.stringify({
  text: "Verdict: APPROVE\\n\\nBlocking findings\\n- None. I inspected review.js, packet-1.js, and packet-2.js from the selected source packet and found no blocking issue.\\n\\nNon-blocking concerns\\n- None. The large-packet override only changes the source packet budget gate and does not alter route selection, CLI authentication, or fallback behavior.\\n\\nInspection status\\n- Source inspection completed for the explicitly scoped custom-review files. The prompt included the CLI source marker and the extra packet files, and this mock response confirms the selected source was reviewed before producing the approval.\\n\\nChecklist item 1: PASS source packet was present and reviewed.\\nChecklist item 2: PASS no behavioral regression found.\\nChecklist item 3: PASS no missing test blocker found.\\nChecklist item 4: PASS no unsafe fallback behavior found.\\nChecklist item 5: PASS result is ready for merge-readiness aggregation.",
  model: "grok-build",
  usage: { input_tokens: 1, output_tokens: 1 }
}));
`);
  chmodSync(grokPath, 0o700);
  return { binDir, grokPath, logPath };
}

function writeGrokCliAuthFixture(cwd, authHome) {
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
  writeFileSync(path.join(authHome, "mcp_credentials.json"), "{\"token\":\"mcp-must-not-copy\"}\n");
}

function readGrokCliLog(logPath) {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, "utf8").trim();
  if (!text) return [];
  return text.split(/\n/).map((line) => JSON.parse(line));
}

const GROK_MODELS_READY_LOGGED_OUT = [
  "Default model: grok-build",
  "",
  "Available models:",
  "  * grok-build (default)",
  "",
].join("\n");

const GROK_SOURCE_FREE_AUTH_TIMEOUT_STDERR = [
  "Signing in with Grok...",
  "ERROR failed to get default browser: The operation could not be completed. (OSStatus error -10661.)",
  "Open this URL to sign in:",
  "  https://auth.x.ai/oauth2/authorize?state=fake-state",
  "ERROR auth: timed out after 10 minutes waiting for auth code",
  "Error: Login timed out after 10 minutes. Please try again.",
  "",
].join("\n");

function writeExpiredGrokCliAuthFixture(authHome) {
  writeFileSync(path.join(authHome, "auth.json"), JSON.stringify({
    auth_mode: "Oidc",
    expires_at: "2000-01-01T00:00:00.000Z",
  }) + "\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
}

function testJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function writeExpiredGrokCliJwtAuthFixture(authHome) {
  writeFileSync(path.join(authHome, "auth.json"), JSON.stringify({
    auth_mode: "Oidc",
    access_token: testJwt({ exp: 946684800 }),
  }) + "\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
}

async function readJsonRequest(req) {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

test("custom-review defaults to Grok CLI without contacting legacy tunnel", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli();
  const workspaceToolBin = path.join(cwd, "node_modules", ".bin");
  mkdirSync(workspaceToolBin, { recursive: true });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${workspaceToolBin}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
        GROK_API_KEY: "direct-api-key-must-not-reach-grok-cli",
        XAI_API_KEY: "xai-api-key-must-not-reach-grok-cli",
        XAI_KEY: "xai-key-must-not-reach-grok-cli",
        OPENAI_API_KEY: "openai-api-key-must-not-reach-grok-cli",
        ANTHROPIC_API_KEY: "anthropic-api-key-must-not-reach-grok-cli",
        AWS_ACCESS_KEY_ID: "aws-access-key-must-not-reach-grok-cli",
        GITHUB_TOKEN: "github-token-must-not-reach-grok-cli",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseStdout(result);
    assert.equal(record.provider, "grok");
    assert.equal(record.target, "grok");
    assert.equal(record.auth_mode, "subscription_cli");
    assert.equal(record.external_review.provider, "Grok CLI");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(record.model, "grok-build");
    assert.equal(record.raw_model, "grok-build");
    assert.equal(record.review_metadata.audit_manifest.selected_route, "subscription_cli");
    assert.equal(record.review_metadata.audit_manifest.fallback_reason, null);
    assert.equal(record.review_metadata.audit_manifest.auth_path, "subscription_cli");
    assert.equal(record.review_metadata.audit_manifest.billing_path, null);
    assert.equal(record.review_metadata.audit_manifest.source_bearing, true);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, false);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "not_required");
    assert.equal(record.review_metadata.audit_manifest.approval_scope, null);
    assert.equal(record.runtime_diagnostics.cli_request.grok_version, "grok 0.1.211 (mock)");
    assert.equal(record.runtime_diagnostics.cli_request.default_model, "grok-build");
    assert.equal(record.runtime_diagnostics.cli_request.model_ready, true);
    assert.equal(record.runtime_diagnostics.cli_request.prompt_cleanup, "deleted");
    assert.equal(record.runtime_diagnostics.cli_request.source_free_prompt_cleanup, "deleted");
    assert.equal(record.runtime_diagnostics.cli_request.source_free_grok_home_cleanup, "deleted");
    assert.equal(record.runtime_diagnostics.cli_request.grok_home_cleanup, "deleted");
    assert.match(record.runtime_diagnostics.cli_request.grok_home_source, /grok-cli-auth-home-/);
    assert.match(record.result, /Verdict: APPROVE/);
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);

    const logLines = readFileSync(logPath, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
    const promptInvocations = logLines.filter((line) => line.promptPath);
    assert.deepEqual(logLines.flatMap((line) => line.apiEnvKeys ?? []), []);
    assert.deepEqual(logLines.flatMap((line) => line.sensitiveEnvKeys ?? []), []);
    assert.equal(promptInvocations.length, 2);
    assert.equal(promptInvocations[0].promptHasSource, false);
    const reviewInvocation = promptInvocations.find((line) => line.promptHasSource);
    assert.ok(reviewInvocation, "mock Grok CLI should receive a source-bearing prompt file");
    assert.equal(reviewInvocation.promptHasSource, true);
    assert.equal(reviewInvocation.promptHasDelimiter, true);
    assert.equal(reviewInvocation.grokHomeExistsDuring, true);
    assert.equal(reviewInvocation.grokHomeHasAuthLink, false);
    assert.equal(reviewInvocation.grokHomeHasMcpCredentials, false);
    assert.doesNotMatch(reviewInvocation.envPath, new RegExp(workspaceToolBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(reviewInvocation.envPath, /node_modules[\\/]\.bin/);
    assert.notEqual(reviewInvocation.cwd, cwd);
    assert.equal(existsSync(reviewInvocation.promptPath), false);
    assert.equal(existsSync(reviewInvocation.grokHome), false);
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review explicit large source override reaches Grok CLI", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-large-source-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-large-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-large-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli();
  writeGrokCliAuthFixture(cwd, authHome);
  writeFileSync(path.join(cwd, "review.js"), `export const marker = 'CLI_SOURCE_SECRET';\n${"x".repeat(180 * 1024)}\n`);
  writeFileSync(path.join(cwd, "packet-1.js"), `${"y".repeat(180 * 1024)}\n`);
  writeFileSync(path.join(cwd, "packet-2.js"), `${"z".repeat(180 * 1024)}\n`);

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js,packet-1.js,packet-2.js",
      "--foreground",
      "--allow-large-source-packet",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_CLI_MAX_PROMPT_CHARS: "2000000",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    const policy = record.review_metadata.audit_manifest.source_packet_policy;
    assert.equal(policy.source_send_allowed, true);
    assert.equal(policy.source_packet_action, "send_after_source_packet_override", JSON.stringify(policy));
    assert.equal(policy.source_packet_override_approved, true);
    assert.equal(policy.source_packet_override_source, "--allow-large-source-packet");
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
    rmTree(binDir);
  }
});

test("custom-review ignores stale successful Grok doctor and re-probes before source send", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-stale-doctor-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-stale-doctor-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-stale-doctor-auth-home-"));
  const readyCli = makeFakeGrokCli();
  const failingCli = makeFakeGrokCli({ sourceFreeAuthStderr: "grok auth expired before source send\n" });
  writeGrokCliAuthFixture(cwd, authHome);
  try {
    const doctor = run(["doctor"], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${readyCli.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: readyCli.grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assert.equal(parseStdout(doctor).ready, true);

    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--lifecycle-events", "jsonl",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${failingCli.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: failingCli.grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 1);
    const lines = parseJsonLines(result);
    assert.equal(lines.length, 1, "stale doctor success must not emit launch before fresh preflight");
    const [record] = lines;
    assert.equal(record.error_code, "grok_cli_failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest, null);
    assert.doesNotMatch(result.stdout, /CLI_SOURCE_SECRET|external_review_launched/);
    const failingPromptInvocations = readGrokCliLog(failingCli.logPath).filter((line) => line.promptPath);
    assert.equal(failingPromptInvocations.length, 1, "fresh preflight must invoke the current Grok CLI once before launch");
    assert.equal(failingPromptInvocations[0].promptHasSource, false, "fresh preflight must be source-free");
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
    rmTree(readyCli.binDir);
    rmTree(failingCli.binDir);
  }
});

test("Grok CLI lifecycle markdown streams running card before source-bearing CLI exits", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-lifecycle-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-lifecycle-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-lifecycle-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ sourceBearingDelayMs: 3000 });
  writeGrokCliAuthFixture(cwd, authHome);
  let child = null;
  try {
    child = spawn(process.execPath, [
      COMPANION,
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--lifecycle-events", "markdown",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      env: grokSmokeEnv(cwd, {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        RELAY_PROVIDER_WORKLOAD_LOCK_DIR: path.join(dataDir, ".provider-workload"),
        RELAY_WORKLOAD_TEST_MODE: "1",
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
        CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS: "25",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    await waitForValue(() => readGrokCliLog(logPath).some((line) => line.promptHasSource), {
      timeoutMs: 10000,
      intervalMs: 10,
    });
    assert.equal(child.exitCode, null, "companion must still be running while fake Grok CLI is delayed");
    const streamed = await waitForValue(() => (
      /\| Status \| running \|/.test(stdout) ? stdout : null
    ), {
      timeoutMs: 2000,
      intervalMs: 10,
    });
    assert.match(streamed, /^### EXTERNAL REVIEW/m);
    assert.match(streamed, /\| Provider \| Grok CLI \|/);
    assert.match(streamed, /\| Source \| may_be_sent \|/);

    const [status, signal] = await once(child, "close");
    assert.equal(signal, null);
    assert.equal(status, 0, stderr || stdout);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("Grok CLI timeout escalates when source-bearing process ignores SIGTERM", {
  skip: process.env.CODEX_PLUGIN_COVERAGE === "1" && process.platform === "darwin"
    ? "NODE_V8_COVERAGE can make source-bearing timeout races exceed the synthetic budget; regular smoke covers SIGTERM escalation"
    : false,
}, async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-timeout-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-timeout-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-timeout-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ ignoreSourceBearingSigterm: true });
  writeGrokCliAuthFixture(cwd, authHome);
  let child = null;
  try {
    child = spawn(process.execPath, [
      COMPANION,
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      env: grokSmokeEnv(cwd, {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        RELAY_PROVIDER_WORKLOAD_LOCK_DIR: path.join(dataDir, ".provider-workload"),
        RELAY_WORKLOAD_TEST_MODE: "1",
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
        GROK_CLI_TIMEOUT_MS: "3000",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const result = await Promise.race([
      once(child, "close").then(([status, signal]) => ({ status, signal })),
      sleep(6000).then(() => null),
    ]);
    assert.ok(result, "companion must exit after escalating ignored Grok CLI SIGTERM");
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, stderr || stdout);
    const record = JSON.parse(stdout);
    assert.equal(record.error_code, "grok_cli_timeout");
    assert.equal(record.external_review.source_content_transmission, "may_be_sent");
    assert.equal(record.runtime_diagnostics.cli_request.prompt_cleanup, "deleted");
    assert.equal(record.runtime_diagnostics.cli_request.grok_home_cleanup, "deleted");
    assert.equal(record.runtime_diagnostics.cli_request.neutral_cwd_cleanup, "deleted");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    for (const line of readGrokCliLog(logPath)) {
      if (line.promptHasSource && Number.isInteger(line.pid)) {
        try { process.kill(line.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review rejects workspace PATH Grok CLI binaries before source transmission", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-untrusted-path-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-untrusted-path-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-untrusted-path-auth-home-"));
  const workspaceBin = path.join(cwd, "node_modules", ".bin");
  const { grokPath, logPath } = makeFakeGrokCli();
  mkdirSync(workspaceBin, { recursive: true });
  cpSync(grokPath, path.join(workspaceBin, "grok"));
  chmodSync(path.join(workspaceBin, "grok"), 0o700);
  writeGrokCliAuthFixture(cwd, authHome);

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${workspaceBin}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "grok_cli_untrusted_binary");
    assert.equal(record.error_cause, "grok_cli");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.deepEqual(readGrokCliLog(logPath), []);
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review syncs refreshed Grok CLI auth file without copying source artifacts", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-auth-isolation-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-auth-isolation-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-auth-isolation-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ mutateAuthOnSource: true });
  writeGrokCliAuthFixture(cwd, authHome);

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = parseStdout(result);
    assert.equal(record.runtime_diagnostics.cli_request.grok_home_auth_sync, "updated");
    assert.equal(readFileSync(path.join(authHome, "auth.json"), "utf8"), "{\"token\":\"mutated\"}\n");
    assert.equal(existsSync(path.join(authHome, "sessions")), false);
    assert.equal(readFileSync(path.join(authHome, "mcp_credentials.json"), "utf8"), "{\"token\":\"mcp-must-not-copy\"}\n");
    const sourceInvocation = readGrokCliLog(logPath).find((line) => line.promptHasSource);
    assert.ok(sourceInvocation, "mock Grok CLI should run source-bearing prompt");
    assert.equal(existsSync(sourceInvocation.grokHome), false);
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("doctor syncs source-free refreshed Grok CLI auth file back to source auth home", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-source-free-auth-sync-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-source-free-auth-sync-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ mutateAuthOnSourceFree: true });
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");

  try {
    const result = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.readiness_layers.source_free_prompt.status, "ready");
    assert.equal(parsed.readiness_layers.source_free_prompt.grok_home_auth_sync, "updated");
    assert.equal(readFileSync(path.join(authHome, "auth.json"), "utf8"), "{\"token\":\"mutated\"}\n");
    assert.equal(existsSync(path.join(authHome, "sessions")), false);

    const promptInvocations = readGrokCliLog(logPath).filter((line) => line.promptPath);
    assert.equal(promptInvocations.length, 1);
    assert.equal(promptInvocations[0].promptHasSource, false);
    assert.equal(existsSync(promptInvocations[0].grokHome), false);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("Grok auth sync writes refreshed auth temp file privately before rename", () => {
  const source = readFileSync(COMPANION_RUNTIME, "utf8");
  const body = source.match(/async function syncGrokCliRuntimeAuthFile\(runtimeHome\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body;
  assert.ok(body, "syncGrokCliRuntimeAuthFile body not found");
  assert.doesNotMatch(body, /copyFile\(runtimeAuth, tmpAuth\)/);
  assert.match(body, /writeFile\(tmpAuth, await readFile\(runtimeAuth\), \{[\s\S]*mode: 0o600,[\s\S]*flag: "wx"/u);
});

test("doctor fails fast on expired Grok CLI auth without starting OAuth preflight", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-auth-recovery-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-auth-recovery-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    modelsOutput: GROK_MODELS_READY_LOGGED_OUT,
    mutateAuthOnSourceFree: true,
  });
  writeExpiredGrokCliAuthFixture(authHome);

  try {
    const result = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.error_code, "grok_cli_auth_expired");
    assert.equal(parsed.logged_in, false);
    assert.equal(parsed.auth_freshness.status, "expired");
    assert.equal(parsed.readiness_layers.cli_login.status, "failed");
    assert.equal(parsed.readiness_layers.cli_auth_file.status, "expired");
    assert.equal(parsed.readiness_layers.source_free_prompt.status, "skipped");
    assert.match(parsed.next_action, /grok login/i);
    assert.doesNotMatch(parsed.next_action, /source-free auth probe/i);
    assert.notEqual(readFileSync(path.join(authHome, "auth.json"), "utf8"), "{\"token\":\"mutated\"}\n");

    const logLines = readGrokCliLog(logPath);
    assert.deepEqual(logLines.filter((line) => Array.isArray(line.args)).map((line) => line.args[0]), [
      "--version", "models",
    ]);
    assert.equal(logLines.some((line) => line.promptPath), false);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("custom-review fails closed when Grok CLI model is ready but login is false", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-login-required-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-login-required-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-login-required-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeGrokCliAuthFixture(cwd, authHome);
  const webRequests = [];

  try {
    await withServer(async (req, res) => {
      webRequests.push(`${req.method} ${req.url}`);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "web fallback must not be contacted" } }));
    }, async (baseUrl) => {
      const result = run([
        "run",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Review selected source.",
      ], {
        cwd,
        defaultTransport: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GROK_CLI_BINARY: grokPath,
          GROK_CLI_AUTH_HOME: authHome,
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: baseUrl,
          GROK_API_KEY: "direct-api-key-must-not-reach-grok-cli",
          XAI_API_KEY: "xai-api-key-must-not-reach-grok-cli",
          XAI_KEY: "xai-key-must-not-reach-grok-cli",
        },
      });

      assert.equal(result.status, 1, result.stdout);
      const record = parseStdout(result);
      assert.equal(record.status, "failed");
      assert.equal(record.error_code, "grok_cli_login_required");
      assert.equal(record.error_cause, "grok_cli");
      assert.equal(record.auth_mode, "subscription_cli");
      assert.equal(record.external_review.provider, "Grok CLI");
      assert.equal(record.external_review.source_content_transmission, "not_sent");
      assert.match(record.suggested_action, /grok login/i);
      assert.doesNotMatch(record.suggested_action, /--transport web|grok2api/i);
      assert.equal(record.runtime_diagnostics.cli_request.transport, "cli");
      assert.equal(record.runtime_diagnostics.cli_request.grok_version, "grok 0.1.211 (mock)");
      assert.equal(record.runtime_diagnostics.cli_request.default_model, "grok-build");
      assert.equal(record.runtime_diagnostics.cli_request.logged_in, false);
      assert.equal(record.runtime_diagnostics.cli_request.model_ready, true);
      assert.equal(record.runtime_diagnostics.cli_request.prompt_cleanup, null);
      assert.equal(record.runtime_diagnostics.cli_request.grok_home_cleanup, null);
      assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);
      assert.deepEqual(webRequests, []);

      const logLines = readGrokCliLog(logPath);
      assert.deepEqual(logLines.flatMap((line) => line.apiEnvKeys ?? []), []);
      assert.deepEqual(logLines.map((line) => line.args[0]), ["--version", "models"]);
      assert.equal(logLines.some((line) => line.promptPath), false);
    }, { autoPreflight: false });
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review fails fast on expired Grok CLI auth without starting OAuth preflight", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-expired-auth-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-auth-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    modelsOutput: GROK_MODELS_READY_LOGGED_OUT,
    sourceFreeAuthStderr: GROK_SOURCE_FREE_AUTH_TIMEOUT_STDERR,
  });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeExpiredGrokCliAuthFixture(authHome);

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        XAI_API_KEY: "xai-direct-api-key-must-not-leak",
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "grok_cli_auth_expired");
    assert.equal(record.error_cause, "grok_cli");
    assert.equal(record.auth_mode, "subscription_cli");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.runtime_diagnostics.cli_request.logged_in, false);
    assert.equal(record.runtime_diagnostics.cli_request.model_ready, true);
    assert.equal(record.runtime_diagnostics.cli_request.auth_freshness.status, "expired");
    assert.deepEqual(record.runtime_diagnostics.cli_request.ignored_env_credentials, ["XAI_API_KEY"]);
    assert.equal(record.runtime_diagnostics.cli_request.auth_policy, "api_key_env_ignored");
    assert.match(record.suggested_action, /grok login/i);
    assert.doesNotMatch(result.stdout, /CLI_SOURCE_SECRET|xai-direct-api-key-must-not-leak/);

    const logLines = readGrokCliLog(logPath);
    assert.deepEqual(logLines.filter((line) => Array.isArray(line.args)).map((line) => line.args[0]), [
      "--version", "models",
    ]);
    assert.equal(logLines.some((line) => line.promptPath), false);
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review defers to the live Grok CLI session over an expired cached exp, then fails closed (bounded) when the source-free probe stalls on OAuth", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-logged-in-expired-auth-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-logged-in-expired-auth-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-logged-in-expired-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    sourceFreeAuthStderr: GROK_SOURCE_FREE_AUTH_TIMEOUT_STDERR,
  });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeExpiredGrokCliAuthFixture(authHome);

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    // Precedence fix (#190, #223): a stale cached access-token exp no longer
    // pre-empts the authoritative live `grok models` result. We proceed to the
    // bounded, source-free refresh probe; only when THAT fails — here the CLI
    // stalls on interactive OAuth — do we fail closed, now as grok_cli_auth_timeout
    // rather than the old pre-judged grok_cli_auth_expired. Source is never sent.
    assert.equal(record.error_code, "grok_cli_auth_timeout");
    assert.equal(record.error_cause, "grok_cli");
    assert.equal(record.auth_mode, "subscription_cli");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.runtime_diagnostics.cli_request.logged_in, true);
    assert.equal(record.runtime_diagnostics.cli_request.model_ready, true);
    assert.equal(record.runtime_diagnostics.cli_request.auth_freshness.status, "expired");
    assert.equal(record.runtime_diagnostics.cli_request.exit_status, 1);
    assert.match(record.runtime_diagnostics.cli_request.stderr_head, /OSStatus error -10661/);
    assert.equal(record.runtime_diagnostics.cli_request.source_free_prompt_cleanup, "deleted");
    assert.equal(record.runtime_diagnostics.cli_request.prompt_cleanup, null);
    assert.equal(record.runtime_diagnostics.cli_request.grok_home_cleanup, null);
    assert.match(record.suggested_action, /grok login|auth/i);
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);

    // The source-free probe DID run (third invocation), carrying no selected source.
    const logLines = readGrokCliLog(logPath);
    assert.deepEqual(logLines.filter((line) => Array.isArray(line.args)).map((line) => line.args[0]), [
      "--version", "models", "--prompt-file",
    ]);
    const promptInvocations = logLines.filter((line) => line.promptPath);
    assert.equal(promptInvocations.length, 1);
    assert.equal(promptInvocations[0].promptHasSource, false);
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("doctor treats an expired cached exp as ready when the live Grok CLI session works", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-recovered-doctor-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-recovered-doctor-auth-home-"));
  // No sourceFreeAuthStderr -> the source-free probe succeeds, proving the live session works.
  const { binDir, grokPath, logPath } = makeFakeGrokCli();
  writeExpiredGrokCliAuthFixture(authHome);

  try {
    const result = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    // The cached exp is expired, but the live `grok models` + source-free probe
    // prove the session works -> readiness must be true. Before #190/#223 this was
    // a false negative (grok_cli_auth_expired, ready:false).
    assert.equal(parsed.ready, true);
    assert.equal(parsed.transport, "cli");
    assert.equal(parsed.logged_in, true);
    assert.equal(parsed.model_ready, true);
    assert.equal(parsed.readiness_layers.cli_login.status, "ready");
    assert.equal(parsed.readiness_layers.source_free_prompt.status, "ready");

    const logLines = readGrokCliLog(logPath);
    const promptInvocations = logLines.filter((line) => line.promptPath);
    assert.equal(promptInvocations.length, 1);
    assert.equal(promptInvocations[0].promptHasSource, false);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("the expired-recovery source-free probe is bounded by refresh_probe_timeout_ms, not the full review timeout", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-refresh-bound-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-refresh-bound-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-refresh-bound-auth-home-"));
  // Source-free probe silently stalls for 5s (no OAuth stderr); only the parent's
  // own timeout can end it.
  const { binDir, grokPath } = makeFakeGrokCli({ sourceFreeHangMs: 5000 });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeExpiredGrokCliAuthFixture(authHome);

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        // Generous full review timeout, tiny refresh-probe bound. If the bound
        // governs, the 5s stall is aborted at ~300ms and the run fails closed —
        // it never reaches the success the child would have produced post-hang.
        GROK_CLI_TIMEOUT_MS: "60000",
        GROK_CLI_REFRESH_PROBE_TIMEOUT_MS: "300",
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.runtime_diagnostics.cli_request.logged_in, true);
    assert.equal(record.runtime_diagnostics.cli_request.auth_freshness.status, "expired");
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review cleans partial Grok CLI runtime home when auth copy fails", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-copy-fail-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-copy-fail-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-copy-fail-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli();
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  symlinkSync("missing-config.toml", path.join(authHome, "config.toml"));
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("grok-cli-home-")));
  let leaked = [];

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.error_code, "grok_cli_setup_failed");
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("grok-cli-home-"));
    leaked = after.filter((name) => !before.has(name));
    assert.deepEqual(leaked, [], "partial runtime homes must be cleaned after copy failure");
  } finally {
    for (const name of leaked) rmTree(path.join(tmpdir(), name));
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review explicit CLI transport remains terminal when login is false", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-explicit-login-required-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-explicit-login-required-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-explicit-login-required-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeGrokCliAuthFixture(cwd, authHome);
  const webRequests = [];

  try {
    await withServer(async (req, res) => {
      webRequests.push(`${req.method} ${req.url}`);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "explicit cli must not contact web fallback" } }));
    }, async (baseUrl) => {
      const result = run([
        "run",
        "--transport", "cli",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Review selected source.",
      ], {
        cwd,
        defaultTransport: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GROK_CLI_BINARY: grokPath,
          GROK_CLI_AUTH_HOME: authHome,
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: baseUrl,
        },
      });

      assert.equal(result.status, 1, result.stdout);
      const record = parseStdout(result);
      assert.equal(record.error_code, "grok_cli_login_required");
      assert.equal(record.transport, "cli");
      assert.equal(record.auth_mode, "subscription_cli");
      assert.equal(record.runtime_diagnostics.cli_request.transport, "cli");
      assert.equal(record.fallback_from, null);
      assert.deepEqual(webRequests, []);

      const logLines = readGrokCliLog(logPath);
      assert.deepEqual(logLines.map((line) => line.args[0]), ["--version", "models"]);
    }, { autoPreflight: false });
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review auto transport uses Grok CLI happy path without contacting web", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-auto-cli-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-auto-cli-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-auto-cli-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli();
  writeGrokCliAuthFixture(cwd, authHome);
  const webRequests = [];

  try {
    await withServer(async (req, res) => {
      webRequests.push(`${req.method} ${req.url}`);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "auto cli success must not contact web" } }));
    }, async (baseUrl) => {
      const result = run([
        "run",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Review selected source.",
      ], {
        cwd,
        defaultTransport: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GROK_CLI_BINARY: grokPath,
          GROK_CLI_AUTH_HOME: authHome,
          GROK_PLUGIN_DATA: dataDir,
          GROK_TRANSPORT: "auto",
          GROK_WEB_BASE_URL: baseUrl,
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const record = parseStdout(result);
      assert.equal(record.provider, "grok");
      assert.equal(record.transport, "cli");
      assert.equal(record.auth_mode, "subscription_cli");
      assert.equal(record.external_review.provider, "Grok CLI");
      assert.equal(record.external_review.source_content_transmission, "sent");
      assert.equal(record.review_metadata.audit_manifest.selected_route, "subscription_cli");
      assert.equal(record.review_metadata.audit_manifest.fallback_reason, null);
      assert.equal(record.review_metadata.audit_manifest.auth_path, "subscription_cli");
      assert.equal(record.runtime_diagnostics.cli_request.transport, "cli");
      assert.equal(record.fallback_from, null);
      assert.deepEqual(webRequests, []);

      const logLines = readGrokCliLog(logPath);
      assert.deepEqual(logLines.flatMap((line) => line.apiEnvKeys ?? []), []);
      assert.equal(logLines.some((line) => line.promptPath), true);
    }, { autoPreflight: false });
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review auto transport falls back from Grok CLI login failure to local web tunnel", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-auto-web-fallback-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-auto-web-fallback-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-auto-web-fallback-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeGrokCliAuthFixture(cwd, authHome);
  const webRequests = [];

  try {
    await withServer(async (req, res) => {
      webRequests.push(`${req.method} ${req.url}`);
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      assert.match(body.messages[0].content, /BEGIN GROK FILE 1: review\.js/);
      assert.match(body.messages[0].content, /CLI_SOURCE_SECRET/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-auto-web-fallback",
        model: "grok-4.20-fast",
        choices: [{ message: { content: substantiveReviewFixture("Auto fallback inspected selected source.") } }],
      }));
    }, async (baseUrl) => {
      const result = await runAsync([
        "run",
        "--transport", "auto",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Review selected source.",
      ], {
        cwd,
        defaultTransport: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GROK_CLI_BINARY: grokPath,
          GROK_CLI_AUTH_HOME: authHome,
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: baseUrl,
          GROK_API_KEY: "direct-api-key-must-not-be-used-by-auto-fallback",
          XAI_API_KEY: "xai-api-key-must-not-be-used-by-auto-fallback",
          XAI_KEY: "xai-key-must-not-be-used-by-auto-fallback",
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.doesNotMatch(result.stdout, /direct-api-key-must-not-be-used|xai-api-key-must-not-be-used|xai-key-must-not-be-used/);
      const record = parseStdout(result);
      assert.equal(record.provider, "grok-web");
      assert.equal(record.transport, "web");
      assert.equal(record.auth_mode, "subscription_web");
      assert.equal(record.external_review.provider, "Grok Web");
      assert.equal(record.external_review.source_content_transmission, "sent");
      assert.equal(record.fallback_from, "cli");
      assert.equal(record.review_metadata.audit_manifest.selected_route, "subscription_web");
      assert.equal(record.review_metadata.audit_manifest.fallback_reason, "grok_cli_login_required");
      assert.equal(record.review_metadata.audit_manifest.auth_path, "subscription_web");
      assert.equal(record.review_metadata.audit_manifest.billing_path, null);
      assert.equal(record.review_metadata.audit_manifest.source_bearing, true);
      assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, false);
      assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "not_required");
      assert.equal(record.review_metadata.audit_manifest.source_content_transmission, "sent");
      assert.equal(record.runtime_diagnostics.cli_request.transport, "cli");
      assert.equal(record.runtime_diagnostics.cli_request.logged_in, false);
      assert.equal(record.runtime_diagnostics.tunnel_state.transport, "web");
      assert.deepEqual(webRequests, ["POST /api/chat/completions"]);

      const logLines = readGrokCliLog(logPath);
      assert.deepEqual(logLines.flatMap((line) => line.apiEnvKeys ?? []), []);
      assert.deepEqual(logLines.map((line) => line.args[0]), ["--version", "models"]);
    });
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review auto transport holds provider workload lease through CLI to web fallback", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-auto-web-fallback-lease-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-auto-web-fallback-lease-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-auto-web-fallback-lease-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  writeGrokCliAuthFixture(cwd, authHome);

  let releaseFirstResponse = () => {};
  const firstResponseReleased = new Promise((resolve) => { releaseFirstResponse = resolve; });
  let markFirstWebRequest = () => {};
  const firstWebRequest = new Promise((resolve) => { markFirstWebRequest = resolve; });
  let webRequests = 0;

  try {
    await withServer(async (req, res) => {
      webRequests += 1;
      await readJsonRequest(req);
      if (webRequests === 1) {
        markFirstWebRequest();
        await firstResponseReleased;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `grok-auto-web-fallback-lease-${webRequests}`,
        model: "grok-4.20-fast",
        choices: [{ message: { content: substantiveReviewFixture(`Fallback lease marker: ${webRequests}.`) } }],
      }));
    }, async (baseUrl) => {
      const sharedEnv = {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: baseUrl,
      };
      const argsFor = (prompt) => [
        "run",
        "--transport", "auto",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", prompt,
      ];

      const firstResultPromise = runAsync(argsFor("First fallback review."), {
        cwd,
        defaultTransport: false,
        env: sharedEnv,
      });
      await firstWebRequest;

      const secondResult = await runAsync(argsFor("Second overlapping fallback review."), {
        cwd,
        defaultTransport: false,
        env: sharedEnv,
      });
      releaseFirstResponse();
      const firstResult = await firstResultPromise;

      assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);
      const firstRecord = parseStdout(firstResult);
      assert.equal(firstRecord.status, "completed");
      assert.equal(firstRecord.transport, "web");
      assert.equal(firstRecord.fallback_from, "cli");

      assert.equal(secondResult.status, 1, secondResult.stderr || secondResult.stdout);
      const secondRecord = parseStdout(secondResult);
      assert.equal(secondRecord.status, "failed");
      assert.equal(secondRecord.error_code, "provider_workload_blocked");
      assert.equal(secondRecord.external_review.source_content_transmission, "not_sent");
      assert.equal(secondRecord.runtime_diagnostics?.provider_workload?.reason, "active_same_provider_job");
      assert.equal(webRequests, 1);
    });
  } finally {
    releaseFirstResponse();
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("doctor auto transport reports CLI login failure and ready web fallback", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-auto-doctor-fallback-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-auto-doctor-fallback-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
  const webRequests = [];

  try {
    await withServer(async (req, res) => {
      webRequests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/models") {
        res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
        return;
      }
      if (req.url === "/api/chat/completions") {
        res.end(JSON.stringify({
          id: "chatcmpl-auto-doctor",
          model: "grok-4.20-fast",
          choices: [{ message: { content: "ok" } }],
        }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: "not found" } }));
    }, async (baseUrl) => {
      const result = await runAsync(["doctor", "--transport", "auto"], {
        defaultTransport: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GROK_CLI_BINARY: grokPath,
          GROK_CLI_AUTH_HOME: authHome,
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: baseUrl,
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = parseStdout(result);
      assert.equal(parsed.status, "fallback_ready");
      assert.equal(parsed.ready, true);
      assert.equal(parsed.transport, "auto");
      assert.equal(parsed.selected_transport, "web");
      assert.equal(parsed.selected_route, "subscription_web");
      assert.equal(parsed.chat_ready, true);
      assert.deepEqual(parsed.durability_warnings, []);
      assert.equal(parsed.readiness_layers.listener.status, "reachable");
      assert.equal(parsed.readiness_layers.chat_probe.status, "ready");
      assert.equal(parsed.chat_probe.status, "ready");
      assert.equal(parsed.session_diagnostics.status, "not_checked");
      assert.equal(parsed.cost_quota_readiness.status, "unknown_not_probed");
      assert.ok(Number.isInteger(parsed.doctor_timeout_ms));
      assert.ok(Number.isInteger(parsed.chat_doctor_timeout_ms));
      assert.equal(parsed.fallback_from, "cli");
      assert.equal(parsed.fallback_reason, "grok_cli_login_required");
      assert.equal(parsed.auto_transport.primary.auth_mode, "subscription_cli");
      assert.equal(parsed.auto_transport.primary.selected_route, "subscription_cli");
      assert.equal(parsed.auto_transport.primary.ready, false);
      assert.equal(parsed.auto_transport.primary.error_code, "grok_cli_login_required");
      assert.equal(parsed.auto_transport.primary.logged_in, false);
      assert.equal(parsed.auto_transport.fallback.auth_mode, "subscription_web");
      assert.equal(parsed.auto_transport.fallback.transport, "web");
      assert.equal(parsed.auto_transport.fallback.selected_route, "subscription_web");
      assert.equal(parsed.auto_transport.fallback.ready, true);
      assert.equal(parsed.auto_transport.fallback.error_code, null);
      assert.match(parsed.next_action, /grok login/i);
      assert.match(parsed.next_action, /--transport auto/i);
      assert.deepEqual(readGrokCliLog(logPath).map((line) => line.args[0]), ["--version", "models"]);
      assert.deepEqual(webRequests, ["GET /api/models", "POST /api/chat/completions"]);
      assert.doesNotMatch(result.stdout, /fake|CLI_SOURCE_SECRET/);
    });
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
    rmTree(binDir);
  }
});

test("doctor auto transport reports source-free CLI auth rejection and ready web fallback", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-auto-doctor-source-free-auth-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-auto-doctor-source-free-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    sourceFreeAuthStderr: [
      "ERROR responses API error status=403 Forbidden error_message=error code: 1000",
      "Request URL: https://cli-chat-proxy.grok.com/v1/responses",
      "model_id=grok-build",
      "",
    ].join("\n"),
  });
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
  const webRequests = [];

  try {
    await withServer(async (req, res) => {
      webRequests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/models") {
        res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
        return;
      }
      if (req.url === "/api/chat/completions") {
        res.end(JSON.stringify({
          id: "chatcmpl-auto-doctor-source-free-auth",
          model: "grok-4.20-fast",
          choices: [{ message: { content: "ok" } }],
        }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: "not found" } }));
    }, async (baseUrl) => {
      const result = await runAsync(["doctor", "--transport", "auto"], {
        defaultTransport: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GROK_CLI_BINARY: grokPath,
          GROK_CLI_AUTH_HOME: authHome,
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: baseUrl,
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = parseStdout(result);
      assert.equal(parsed.status, "fallback_ready");
      assert.equal(parsed.ready, true);
      assert.equal(parsed.transport, "auto");
      assert.equal(parsed.selected_transport, "web");
      assert.equal(parsed.selected_route, "subscription_web");
      assert.equal(parsed.fallback_from, "cli");
      assert.equal(parsed.fallback_reason, "grok_cli_auth_unavailable");
      assert.equal(parsed.auto_transport.primary.auth_mode, "subscription_cli");
      assert.equal(parsed.auto_transport.primary.ready, false);
      assert.equal(parsed.auto_transport.primary.error_code, "grok_cli_auth_unavailable");
      assert.equal(parsed.auto_transport.primary.logged_in, true);
      assert.equal(parsed.auto_transport.primary.model_ready, true);
      assert.equal(parsed.auto_transport.fallback.auth_mode, "subscription_web");
      assert.equal(parsed.auto_transport.fallback.ready, true);
      const cliInvocations = readGrokCliLog(logPath);
      assert.equal(cliInvocations.at(-1).promptHasSource, false);
      assert.deepEqual(webRequests, ["GET /api/models", "POST /api/chat/completions"]);
      assert.doesNotMatch(result.stdout, /CLI_SOURCE_SECRET/);
    });
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
    rmTree(binDir);
  }
});

test("doctor auto transport reports untrusted CLI auth policy fields", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-auto-doctor-untrusted-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-auto-doctor-untrusted-data-"));
  const workspaceBin = path.join(cwd, "node_modules", ".bin");
  const { binDir, grokPath, logPath } = makeFakeGrokCli();
  mkdirSync(workspaceBin, { recursive: true });
  cpSync(grokPath, path.join(workspaceBin, "grok"));
  chmodSync(path.join(workspaceBin, "grok"), 0o700);

  try {
    const result = run(["doctor", "--transport", "auto"], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${workspaceBin}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_PLUGIN_DATA: dataDir,
        XAI_API_KEY: "direct-api-key-must-not-leak",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.transport, "auto");
    assert.equal(parsed.selected_transport, "cli");
    assert.equal(parsed.selected_route, "subscription_cli");
    assert.equal(parsed.error_code, "grok_cli_untrusted_binary");
    assert.deepEqual(parsed.ignored_env_credentials, ["XAI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_ignored");
    assert.deepEqual(readGrokCliLog(logPath), []);
    assert.doesNotMatch(result.stdout, /direct-api-key-must-not-leak/);
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
    rmTree(binDir);
  }
});

test("custom-review auto transport falls back from source-free Grok CLI auth rejection", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-auto-source-free-auth-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-auto-source-free-auth-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-auto-source-free-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli({
    sourceFreeAuthStderr: [
      "ERROR responses API error status=403 Forbidden error_message=error code: 1000",
      "Request URL: https://cli-chat-proxy.grok.com/v1/responses",
      "model_id=grok-build",
      "",
    ].join("\n"),
  });
  writeGrokCliAuthFixture(cwd, authHome);
  const webRequests = [];

  try {
    await withServer(async (req, res) => {
      webRequests.push(`${req.method} ${req.url}`);
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      assert.match(body.messages[0].content, /BEGIN GROK FILE 1: review\.js/);
      assert.match(body.messages[0].content, /CLI_SOURCE_SECRET/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-auto-source-free-auth-fallback",
        model: "grok-4.20-fast",
        choices: [{ message: { content: substantiveReviewFixture("Auto fallback handled source-free auth rejection.") } }],
      }));
    }, async (baseUrl) => {
      const result = await runAsync([
        "run",
        "--transport", "auto",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Review selected source.",
      ], {
        cwd,
        defaultTransport: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GROK_CLI_BINARY: grokPath,
          GROK_CLI_AUTH_HOME: authHome,
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: baseUrl,
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const record = parseStdout(result);
      assert.equal(record.provider, "grok-web");
      assert.equal(record.transport, "web");
      assert.equal(record.fallback_from, "cli");
      assert.equal(record.review_metadata.audit_manifest.selected_route, "subscription_web");
      assert.equal(record.review_metadata.audit_manifest.fallback_reason, "grok_cli_auth_unavailable");
      assert.equal(record.external_review.source_content_transmission, "sent");
      assert.equal(record.runtime_diagnostics.cli_request.error_code, "grok_cli_auth_unavailable");
      assert.equal(record.runtime_diagnostics.cli_request.logged_in, true);
      assert.equal(record.runtime_diagnostics.cli_request.model_ready, true);
      assert.deepEqual(webRequests, ["POST /api/chat/completions"]);
    });
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
    rmTree(binDir);
  }
});

test("custom-review auto transport preserves CLI diagnostics when web fallback prompt is too large", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-auto-web-budget-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-auto-web-budget-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-auto-web-budget-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeGrokCliAuthFixture(cwd, authHome);
  const webRequests = [];

  try {
    await withServer(async (req, res) => {
      webRequests.push(`${req.method} ${req.url}`);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "prompt budget should stop before web call" } }));
    }, async (baseUrl) => {
      const result = await runAsync([
        "run",
        "--transport", "auto",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Review selected source.",
      ], {
        cwd,
        defaultTransport: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GROK_CLI_BINARY: grokPath,
          GROK_CLI_AUTH_HOME: authHome,
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: baseUrl,
          GROK_WEB_MAX_PROMPT_CHARS: "100",
        },
      });

      assert.equal(result.status, 1, result.stderr || result.stdout);
      const record = parseStdout(result);
      assert.equal(record.provider, "grok-web");
      assert.equal(record.transport, "web");
      assert.equal(record.error_code, "prompt_too_large");
      assert.equal(record.fallback_from, "cli");
      assert.equal(record.runtime_diagnostics.cli_request.transport, "cli");
      assert.equal(record.runtime_diagnostics.cli_request.logged_in, false);
      assert.equal(record.runtime_diagnostics.cli_request.model_ready, true);
      assert.equal(record.external_review.source_content_transmission, "not_sent");
      assert.deepEqual(webRequests, []);
    });
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("doctor reports Grok CLI unauthenticated when model is ready but login is false", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-login-required-doctor-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-login-required-doctor-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");

  try {
    const result = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.transport, "cli");
    assert.equal(parsed.auth_mode, "subscription_cli");
    assert.equal(parsed.error_code, "grok_cli_login_required");
    assert.equal(parsed.grok_version, "grok 0.1.211 (mock)");
    assert.equal(parsed.default_model, "grok-build");
    assert.equal(parsed.model_ready, true);
    assert.equal(parsed.logged_in, false);
    assert.equal(parsed.readiness_layers.cli_binary.status, "ready");
    assert.equal(parsed.readiness_layers.models.status, "available");
    assert.equal(parsed.readiness_layers.cli_login.status, "failed");
    assert.equal(parsed.readiness_layers.source_free_prompt.status, "skipped");
    assert.match(parsed.next_action, /grok login/i);
    assert.doesNotMatch(JSON.stringify(parsed), /CLI_SOURCE_SECRET/);

    const logLines = readGrokCliLog(logPath);
    assert.deepEqual(logLines.map((line) => line.args[0]), ["--version", "models"]);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("doctor reports expired Grok CLI subscription auth distinctly from API-key masked model access", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-auth-doctor-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-auth-doctor-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeExpiredGrokCliAuthFixture(authHome);

  try {
    const result = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        XAI_API_KEY: "xai-direct-api-key-must-not-leak",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.transport, "cli");
    assert.equal(parsed.auth_mode, "subscription_cli");
    assert.equal(parsed.error_code, "grok_cli_auth_expired");
    assert.equal(parsed.logged_in, false);
    assert.equal(parsed.model_ready, true);
    assert.equal(parsed.auth_freshness.status, "expired");
    assert.equal(parsed.readiness_layers.cli_auth_file.status, "expired");
    assert.deepEqual(parsed.ignored_env_credentials, ["XAI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_ignored");
    assert.match(parsed.error_message, /subscription CLI auth is expired/i);
    assert.match(parsed.error_message, /Direct API env variables are present and ignored/i);
    assert.match(parsed.next_action, /grok login/i);
    assert.doesNotMatch(result.stdout, /xai-direct-api-key-must-not-leak|2000-01-01/);

    const logLines = readGrokCliLog(logPath);
    assert.deepEqual(logLines.filter((line) => Array.isArray(line.args)).map((line) => line.args[0]), [
      "--version", "models",
    ]);
    assert.equal(logLines.some((line) => line.promptPath), false);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("doctor derives expired Grok CLI auth freshness from JWT exp metadata", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-jwt-auth-doctor-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-jwt-auth-doctor-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeExpiredGrokCliJwtAuthFixture(authHome);

  try {
    const result = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.error_code, "grok_cli_auth_expired");
    assert.equal(parsed.auth_freshness.status, "expired");
    assert.equal(parsed.auth_freshness.expiry_known, true);
    assert.equal(parsed.readiness_layers.cli_auth_file.status, "expired");
    assert.doesNotMatch(result.stdout, /946684800|access_token|signature/);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("doctor reports only canonical XAI_API_KEY as ignored, not Grok CLI login", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-login-api-env-doctor-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-login-api-env-doctor-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    modelsOutput: [
      "You are not authenticated.",
      "",
      "Default model: grok-build",
      "",
      "Available models:",
      "  * grok-build (default)",
      "",
    ].join("\n"),
  });
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");

  try {
    const result = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_API_KEY: "same-direct-api-key-must-not-leak",
        XAI_API_KEY: "same-direct-api-key-must-not-leak",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.error_code, "grok_cli_login_required");
    assert.deepEqual(parsed.ignored_env_credentials, ["XAI_API_KEY"]);
    assert.equal(parsed.auth_policy, "api_key_env_ignored");
    assert.match(parsed.error_message, /Direct API env variables are present and ignored by subscription_cli mode/i);
    assert.doesNotMatch(parsed.error_message, /GROK_API_KEY|same redacted/i);
    assert.match(parsed.next_action, /subscription CLI login/i);
    assert.doesNotMatch(result.stdout, /same-direct-api-key-must-not-leak/);

    const logLines = readGrokCliLog(logPath);
    assert.deepEqual(logLines.map((line) => line.apiEnvKeys), [[], []]);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("Grok runtime reads direct API credential names from provider metadata", () => {
  const entrypointSource = readFileSync(COMPANION, "utf8");
  const runtimeSource = readFileSync(COMPANION_RUNTIME, "utf8");
  const transportAdapterSource = readFileSync(
    path.join(REPO_ROOT, "plugins/grok/scripts/lib/grok-transport-adapters.mjs"),
    "utf8",
  );
  assert.match(
    transportAdapterSource,
    /function cliConfig[\s\S]{0,1400}provider:\s*GROK_CANONICAL_PROVIDER,\s*canonical_provider:\s*GROK_CANONICAL_PROVIDER/,
  );
  assert.match(
    transportAdapterSource,
    /function webConfig[\s\S]{0,1800}provider:\s*["']grok-web["'],\s*canonical_provider:\s*GROK_CANONICAL_PROVIDER/,
  );
  assert.match(
    transportAdapterSource,
    /function webFallbackConfig[\s\S]{0,500}\breturn\s+webConfig\(/,
  );
  assert.match(transportAdapterSource, /providerApiCapability\(GROK_CANONICAL_PROVIDER\)/);
  assert.doesNotMatch(transportAdapterSource, /providerApiCapability\(["']grok["']\)/);
  for (const source of [entrypointSource, runtimeSource, transportAdapterSource]) {
    assert.doesNotMatch(source, /\b(?:GROK_API_KEY|XAI_API_KEY|XAI_KEY)\b/);
  }
});

test("custom-review classifies source-free Grok CLI auth timeout as not sent", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-auth-timeout-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-auth-timeout-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-auth-timeout-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    sourceFreeAuthStderr: GROK_SOURCE_FREE_AUTH_TIMEOUT_STDERR,
  });
  writeGrokCliAuthFixture(cwd, authHome);

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "grok_cli_auth_timeout");
    assert.equal(record.error_cause, "grok_cli");
    assert.equal(record.auth_mode, "subscription_cli");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.runtime_diagnostics.cli_request.logged_in, true);
    assert.equal(record.runtime_diagnostics.cli_request.model_ready, true);
    assert.equal(record.runtime_diagnostics.cli_request.exit_status, 1);
    assert.match(record.runtime_diagnostics.cli_request.stderr_head, /OSStatus error -10661/);
    assert.match(record.runtime_diagnostics.cli_request.stderr_head, /Login timed out after 10 minutes/);
    assert.equal(record.runtime_diagnostics.cli_request.source_free_prompt_cleanup, "deleted");
    assert.equal(record.runtime_diagnostics.cli_request.source_free_grok_home_cleanup, "deleted");
    assert.equal(record.runtime_diagnostics.cli_request.prompt_cleanup, null);
    assert.equal(record.runtime_diagnostics.cli_request.grok_home_cleanup, null);
    assert.match(record.suggested_action, /grok login|auth/i);
    assert.doesNotMatch(record.suggested_action, /temporary Grok CLI runtime\/prompt artifacts/);
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);

    const logLines = readGrokCliLog(logPath);
    const promptInvocations = logLines.filter((line) => line.promptPath);
    assert.equal(promptInvocations.length, 1);
    assert.equal(promptInvocations[0].promptHasSource, false);
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("doctor classifies source-free Grok CLI auth timeout as not ready", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-auth-timeout-doctor-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-auth-timeout-doctor-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    sourceFreeAuthStderr: GROK_SOURCE_FREE_AUTH_TIMEOUT_STDERR,
  });
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");

  try {
    const result = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.transport, "cli");
    assert.equal(parsed.auth_mode, "subscription_cli");
    assert.equal(parsed.error_code, "grok_cli_auth_timeout");
    assert.equal(parsed.logged_in, true);
    assert.equal(parsed.model_ready, true);
    assert.equal(parsed.readiness_layers.cli_login.status, "ready");
    assert.equal(parsed.readiness_layers.source_free_prompt.status, "failed");
    assert.match(parsed.next_action, /grok login|auth/i);
    assert.doesNotMatch(JSON.stringify(parsed), /CLI_SOURCE_SECRET/);

    const logLines = readGrokCliLog(logPath);
    const promptInvocations = logLines.filter((line) => line.promptPath);
    assert.equal(promptInvocations.length, 1);
    assert.equal(promptInvocations[0].promptHasSource, false);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("custom-review explicit web transport ignores unauthenticated Grok CLI state", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-explicit-cli-logged-out-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-explicit-cli-logged-out-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-web-explicit-cli-logged-out-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeGrokCliAuthFixture(cwd, authHome);

  try {
    await withServer(async (req, res) => {
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      assert.match(body.messages[0].content, /BEGIN GROK FILE 1: review\.js/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-web-explicit-cli-logged-out",
        model: "grok-4.20-fast",
        choices: [{ message: { content: substantiveReviewFixture("Explicit web transport remains isolated.") } }],
      }));
    }, async (baseUrl) => {
      const result = await runAsync([
        "run",
        "--transport", "web",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Review selected source.",
      ], {
        cwd,
        defaultTransport: false,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          GROK_CLI_BINARY: grokPath,
          GROK_CLI_AUTH_HOME: authHome,
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: baseUrl,
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const record = parseStdout(result);
      assert.equal(record.provider, "grok-web");
      assert.equal(record.auth_mode, "subscription_web");
      assert.equal(record.external_review.provider, "Grok Web");
      assert.equal(record.external_review.source_content_transmission, "sent");
      assert.equal(record.runtime_diagnostics.tunnel_state.transport, "web");
      assert.equal(record.runtime_diagnostics.tunnel_state.reachable, true);
      assert.equal(record.runtime_diagnostics.tunnel_state.chat_ready, true);
      assert.equal(record.runtime_diagnostics.tunnel_state.auto_start_attempted, false);
      assert.equal(record.runtime_diagnostics.session_tokens.repair_attempted, false);
      assert.deepEqual(readGrokCliLog(logPath), []);
    });
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("explicit --transport web fails with tunnel readiness diagnostics and no silent repair when tunnel is unavailable", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-transport-tunnel-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-transport-data-"));
  try {
    writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--transport", "web",
      "--lifecycle-events", "jsonl",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
        GROK_WEB_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "500",
        GROK_WEB_TUNNEL_AUTO_START: "0",
        GROK_WEB_TUNNEL_AUTO_BOOTSTRAP: "0",
      },
    });
    const lines = parseJsonLines(result);
    assert.equal(result.status, 1);
    assert.equal(lines.length, 1, `expected only the terminal record; lifecycle events leaked launch: ${result.stdout}`);
    const [record] = lines;

    assert.doesNotMatch(result.stdout, /external_review_launched/);
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.status, "failed");
    assert.match(record.error_code, /^tunnel_(unavailable|timeout|error)$/);
    assert.ok(record.runtime_diagnostics, "runtime_diagnostics must be present");
    assert.ok(record.runtime_diagnostics.tunnel_state, "runtime_diagnostics.tunnel_state must be populated for --transport web failure");
    assert.equal(record.runtime_diagnostics.tunnel_state.transport, "web");
    assert.equal(record.runtime_diagnostics.tunnel_state.reachable, false);
    assert.ok(typeof record.runtime_diagnostics.tunnel_state.failure_mode === "string"
      && record.runtime_diagnostics.tunnel_state.failure_mode.length > 0,
      "tunnel_state.failure_mode must name a specific failure mode");
    assert.ok(record.runtime_diagnostics.session_tokens, "runtime_diagnostics.session_tokens must be populated for --transport web failure");
    assert.ok(typeof record.runtime_diagnostics.session_tokens.status === "string"
      && record.runtime_diagnostics.session_tokens.status.length > 0,
      "session_tokens.status must be populated even when the tunnel is unavailable");
    assert.equal(record.runtime_diagnostics.tunnel_state.auto_start_attempted ?? false, false,
      "--transport web must never auto-start the tunnel");
    assert.equal(record.runtime_diagnostics.session_tokens.repair_attempted ?? false, false,
      "--transport web must never auto-run browser/session repair");
    assert.match(record.suggested_action, /grok:repair-session|grok:sync-browser-session|local Grok web tunnel/i);
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("explicit --transport web surfaces stale session tokens and suggests repair commands without running them", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-transport-session-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-transport-session-data-"));
  try {
    writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

    const requests = [];
    await withServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/chat/completions") {
        const body = await readJsonRequest(req);
        requests.push({
          method: req.method,
          url: req.url,
          preflight: req.headers["x-relay-grok-readiness-preflight"] === "1",
          prompt: body.messages?.[0]?.content ?? "",
        });
        res.statusCode = 429;
        res.end(JSON.stringify({ error: { message: "No active runtime tokens." } }));
        return;
      }
      if (req.url === "/admin/api/tokens") {
        requests.push({ method: req.method, url: req.url, preflight: false, prompt: null });
        res.end(JSON.stringify({ tokens: [] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: "unexpected endpoint" } }));
    }, async (baseUrl) => {
      const result = await runAsync([
        "run",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--transport", "web",
        "--lifecycle-events", "jsonl",
        "--prompt", "Check this file.",
      ], {
        cwd,
        env: {
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_BASE_URL: baseUrl,
          GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
        },
      });
      const lines = parseJsonLines(result);
      assert.equal(result.status, 1);
      assert.equal(lines.length, 1, `expected only the terminal record; lifecycle events leaked launch: ${result.stdout}`);
      const [record] = lines;

      assert.doesNotMatch(result.stdout, /external_review_launched/);
      assert.equal(record.external_review.source_content_transmission, "not_sent");
      assert.equal(record.status, "failed");
      assert.equal(record.error_code, "grok_session_no_runtime_tokens");
      assert.ok(record.runtime_diagnostics.tunnel_state, "runtime_diagnostics.tunnel_state must be populated");
      assert.equal(record.runtime_diagnostics.tunnel_state.transport, "web");
      assert.equal(record.runtime_diagnostics.tunnel_state.reachable, true);
      assert.ok(record.runtime_diagnostics.session_tokens, "runtime_diagnostics.session_tokens must be populated");
      assert.equal(record.runtime_diagnostics.session_tokens.status, "empty");
      assert.equal(record.runtime_diagnostics.session_tokens.repair_attempted ?? false, false);
      assert.match(record.suggested_action, /grok:repair-session|grok:sync-browser-session/);
      assert.match(record.suggested_action, /approval|approve/i);
      assert.deepEqual(requests.map((r) => [r.method, r.url, r.preflight]), [
        ["POST", "/api/chat/completions", true],
        ["GET", "/admin/api/tokens", false],
      ]);
      assert.equal(requests[0].prompt, "Return exactly: ok");
      assert.doesNotMatch(requests[0].prompt, /review\.js|BEGIN GROK FILE|export const value/);
    }, { autoPreflight: false });
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("repair reports Grok CLI login-required as actionable CLI auth repair", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-login-required-repair-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-login-required-repair-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");

  try {
    const result = run(["repair"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "cli_auth_required");
    assert.equal(parsed.provider, "grok");
    assert.equal(parsed.error_code, "grok_cli_login_required");
    assert.equal(parsed.initial_doctor.error_code, "grok_cli_login_required");
    assert.equal(parsed.sync_session.status, "not_attempted");
    assert.equal(parsed.sync_session.source_content_transmission, "not_sent");
    assert.match(parsed.next_action, /grok login/i);
    assert.doesNotMatch(parsed.next_action, /--approve-browser-session-sync|grok2api/i);
    assert.deepEqual(readGrokCliLog(logPath).map((line) => line.args[0]), ["--version", "models"]);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("repair reports expired Grok CLI auth as actionable CLI auth repair", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-auth-repair-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-expired-auth-repair-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ modelsOutput: GROK_MODELS_READY_LOGGED_OUT });
  writeExpiredGrokCliAuthFixture(authHome);

  try {
    const result = run(["repair"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "cli_auth_required");
    assert.equal(parsed.provider, "grok");
    assert.equal(parsed.error_code, "grok_cli_auth_expired");
    assert.equal(parsed.initial_doctor.error_code, "grok_cli_auth_expired");
    assert.equal(parsed.initial_doctor.auth_freshness.status, "expired");
    assert.equal(parsed.sync_session.status, "not_attempted");
    assert.equal(parsed.sync_session.source_content_transmission, "not_sent");
    assert.match(parsed.next_action, /grok login/i);
    assert.doesNotMatch(parsed.next_action, /--approve-browser-session-sync|grok2api/i);
    assert.deepEqual(readGrokCliLog(logPath).filter((line) => Array.isArray(line.args)).map((line) => line.args[0]), [
      "--version", "models",
    ]);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("repair reports ready Grok CLI state without web/tunnel labels", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-ready-repair-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-ready-repair-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli();
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");

  try {
    const result = run(["repair"], {
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, "ready");
    assert.equal(parsed.provider, "grok");
    assert.match(parsed.next_action, /Grok CLI review/i);
    assert.doesNotMatch(JSON.stringify(parsed), /Grok web review|grok2api/i);
  } finally {
    rmTree(authHome);
    rmTree(dataDir);
  }
});

test("repair reports non-auth Grok CLI failures without web/tunnel labels", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-nonauth-repair-data-"));
  const missingGrok = path.join(dataDir, "missing-grok");

  try {
    const result = run(["repair"], {
      defaultTransport: false,
      env: {
        PATH: process.env.PATH ?? "",
        GROK_CLI_BINARY: missingGrok,
        GROK_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseStdout(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "not_repairable");
    assert.equal(parsed.provider, "grok");
    assert.equal(parsed.error_code, "grok_cli_unavailable");
    assert.equal(parsed.sync_session.status, "not_attempted");
    assert.equal(parsed.sync_session.source_content_transmission, "not_sent");
    assert.match(parsed.next_action, /Grok CLI/i);
    assert.doesNotMatch(JSON.stringify(parsed), /Grok web review|grok2api|browser session sync/i);
  } finally {
    rmTree(dataDir);
  }
});

test("doctor distinguishes Grok CLI login-required from models command failure and preserves layer shape", () => {
  const loginDataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-login-precedence-data-"));
  const loginAuthHome = mkdtempSync(path.join(tmpdir(), "grok-cli-login-precedence-auth-home-"));
  const loginCli = makeFakeGrokCli({ modelsOutput: "Available models:\n" });
  const modelsDataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-models-failed-data-"));
  const modelsAuthHome = mkdtempSync(path.join(tmpdir(), "grok-cli-models-failed-auth-home-"));
  const modelsCli = makeFakeGrokCli({ modelsExitStatus: 1, modelsStderr: "auth store unavailable\n" });

  try {
    for (const authHome of [loginAuthHome, modelsAuthHome]) {
      writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
      writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
    }

    const loginResult = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${loginCli.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: loginCli.grokPath,
        GROK_CLI_AUTH_HOME: loginAuthHome,
        GROK_PLUGIN_DATA: loginDataDir,
      },
    });
    assert.equal(loginResult.status, 0, loginResult.stderr || loginResult.stdout);
    const loginParsed = parseStdout(loginResult);
    assert.equal(loginParsed.ready, false);
    assert.equal(loginParsed.error_code, "grok_cli_login_required");
    assert.equal(loginParsed.logged_in, false);
    assert.equal(loginParsed.model_ready, false);
    assert.ok(Object.hasOwn(loginParsed.readiness_layers, "cli_binary"));
    assert.ok(Object.hasOwn(loginParsed.readiness_layers, "models"));
    assert.ok(Object.hasOwn(loginParsed.readiness_layers, "cli_login"));
    assert.ok(Object.hasOwn(loginParsed.readiness_layers, "source_free_prompt"));
    assert.equal(loginParsed.readiness_layers.cli_login.status, "failed");
    assert.equal(loginParsed.readiness_layers.source_free_prompt.status, "skipped");

    const modelsResult = run(["doctor"], {
      defaultTransport: false,
      env: {
        PATH: `${modelsCli.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: modelsCli.grokPath,
        GROK_CLI_AUTH_HOME: modelsAuthHome,
        GROK_PLUGIN_DATA: modelsDataDir,
      },
    });
    assert.equal(modelsResult.status, 0, modelsResult.stderr || modelsResult.stdout);
    const modelsParsed = parseStdout(modelsResult);
    assert.equal(modelsParsed.ready, false);
    assert.equal(modelsParsed.error_code, "grok_cli_auth_unavailable");
    assert.equal(modelsParsed.logged_in, null);
    assert.equal(modelsParsed.model_ready, null);
  } finally {
    rmTree(loginAuthHome);
    rmTree(loginDataDir);
    rmTree(modelsAuthHome);
    rmTree(modelsDataDir);
  }
});

test("custom-review marks failed source-bearing Grok CLI launches as may-be-sent", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-failed-source-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-failed-source-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-failed-source-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({ failSourceBearing: true });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "grok_cli_failed");
    assert.equal(record.external_review.provider, "Grok CLI");
    assert.equal(record.external_review.source_content_transmission, "may_be_sent");
    assert.match(record.external_review.disclosure, /may have been sent/i);
    assert.equal(record.runtime_diagnostics.cli_request.prompt_cleanup, "deleted");
    assert.equal(record.runtime_diagnostics.cli_request.grok_home_cleanup, "deleted");
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);

    const logLines = readFileSync(logPath, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
    const sourceInvocation = logLines.find((line) => line.promptHasSource);
    assert.ok(sourceInvocation, "mock Grok CLI should launch with a source-bearing prompt file");
    assert.equal(existsSync(sourceInvocation.promptPath), false);
    assert.equal(existsSync(sourceInvocation.grokHome), false);
  } finally {
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review keeps failed source-bearing Grok CLI cleanup errors as may-be-sent", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-failed-cleanup-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-failed-cleanup-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-failed-cleanup-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    failSourceBearing: true,
    failSourceBearingHomeCleanup: true,
  });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
  let runtimeHome = null;

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "privacy_persistence");
    assert.equal(record.error_cause, "privacy_persistence");
    assert.match(record.suggested_action, /temporary Grok CLI runtime\/prompt artifacts/);
    assert.equal(record.external_review.source_content_transmission, "may_be_sent");
    assert.equal(record.runtime_diagnostics.cli_request.grok_home_cleanup, "unverified");
    assert.equal(record.runtime_diagnostics.cli_request.exit_status, 2);
    assert.match(record.runtime_diagnostics.cli_request.stderr_head, /unknown option --no-memory/);
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);

    const logLines = readFileSync(logPath, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
    const sourceInvocation = logLines.find((line) => line.promptHasSource);
    runtimeHome = sourceInvocation?.grokHome ?? null;
    assert.ok(runtimeHome, "mock Grok CLI should expose the temp home it made uncleanable");
  } finally {
    if (runtimeHome && existsSync(runtimeHome)) {
      const blocked = path.join(runtimeHome, "blocked-cleanup");
      if (existsSync(blocked)) chmodSync(blocked, 0o700);
      rmTree(runtimeHome);
    }
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review labels failed source-free Grok CLI preflight cleanup separately", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-preflight-cleanup-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-preflight-cleanup-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-preflight-cleanup-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    failSourceFreeHomeCleanup: true,
  });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
  let runtimeHome = null;

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "privacy_persistence");
    assert.equal(record.error_cause, "privacy_persistence");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.runtime_diagnostics.cli_request.source_free_grok_home_cleanup, "unverified");
    assert.equal(record.runtime_diagnostics.cli_request.grok_home_cleanup, null);
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);

    const logLines = readFileSync(logPath, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
    const sourceFreeInvocation = logLines.find((line) => line.promptPath && !line.promptHasSource);
    runtimeHome = sourceFreeInvocation?.grokHome ?? null;
    assert.ok(runtimeHome, "mock Grok CLI should expose the source-free temp home it made uncleanable");
    assert.equal(logLines.some((line) => line.promptHasSource), false);
  } finally {
    if (runtimeHome && existsSync(runtimeHome)) {
      const blocked = path.join(runtimeHome, "blocked-cleanup");
      if (existsSync(blocked)) chmodSync(blocked, 0o700);
      rmTree(runtimeHome);
    }
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review fails closed when source-bearing Grok CLI prompt cleanup is not verified", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-prompt-cleanup-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-prompt-cleanup-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-prompt-cleanup-auth-home-"));
  const { binDir, grokPath, logPath } = makeFakeGrokCli({
    failSourceBearingPromptCleanup: true,
  });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
  let promptDir = null;

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "privacy_persistence");
    assert.equal(record.error_cause, "privacy_persistence");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.match(record.suggested_action, /temporary Grok CLI runtime\/prompt artifacts/);
    assert.equal(record.runtime_diagnostics.cli_request.prompt_cleanup, "file_deleted");
    assert.equal(record.runtime_diagnostics.cli_request.grok_home_cleanup, "deleted");
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);

    const logLines = readFileSync(logPath, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
    const sourceInvocation = logLines.find((line) => line.promptHasSource);
    promptDir = sourceInvocation?.promptPath ? path.dirname(sourceInvocation.promptPath) : null;
    assert.ok(promptDir, "mock Grok CLI should expose the prompt dir it made uncleanable");
  } finally {
    if (promptDir && existsSync(promptDir)) rmTree(promptDir);
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review cleans non-empty Grok CLI neutral cwd after source-bearing run", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-neutral-cleanup-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-neutral-cleanup-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-neutral-cleanup-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli({
    failNeutralCwdCleanup: true,
  });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
  let neutralCwd = null;

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      },
    });

    assert.equal(result.status, 0, result.stdout);
    const record = parseStdout(result);
    neutralCwd = record.runtime_diagnostics.cli_request.neutral_cwd;
    assert.equal(record.status, "completed");
    assert.equal(record.error_code, null);
    assert.equal(record.error_cause, null);
    assert.equal(record.runtime_diagnostics.cli_request.neutral_cwd_cleanup, "deleted");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);
    assert.equal(existsSync(neutralCwd), false);
  } finally {
    if (neutralCwd) rmTree(neutralCwd);
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review fails closed when Grok CLI neutral cwd cleanup cannot be verified", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-neutral-cleanup-blocked-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-neutral-cleanup-blocked-data-"));
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-neutral-cleanup-blocked-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli({
    blockNeutralCwdCleanup: true,
  });
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");
  writeFileSync(path.join(authHome, "auth.json"), "{\"token\":\"fake\"}\n");
  writeFileSync(path.join(authHome, "config.toml"), "[models]\ndefault = \"grok-build\"\n");
  let neutralCwd = null;

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      },
    });

    const record = parseStdout(result);
    neutralCwd = record.runtime_diagnostics.cli_request.neutral_cwd;
    assert.equal(result.status, 1, result.stdout);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "privacy_persistence");
    assert.equal(record.error_cause, "privacy_persistence");
    assert.equal(record.runtime_diagnostics.cli_request.neutral_cwd_cleanup, "unverified");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);
    assert.equal(existsSync(neutralCwd), true);
  } finally {
    if (neutralCwd) {
      try {
        chmodSync(path.join(neutralCwd, "blocked-cleanup"), 0o700);
      } catch {
        // Cleanup best-effort for failed setup paths.
      }
      rmTree(neutralCwd);
    }
    rmTree(authHome);
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review reports missing Grok CLI binary as not sent", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-missing-workspace-")));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-cli-missing-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const marker = 'CLI_SOURCE_SECRET';\n");

  try {
    const result = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd,
      defaultTransport: false,
      env: {
        GROK_CLI_BINARY: path.join(cwd, "missing-grok"),
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      },
    });

    assert.equal(result.status, 1, result.stdout);
    const record = parseStdout(result);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "grok_cli_unavailable");
    assert.equal(record.error_cause, "grok_cli");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.doesNotMatch(JSON.stringify(record), /CLI_SOURCE_SECRET/);
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("run defaults plugin state outside the reviewed workspace", async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-clean-workspace-")));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");
  try {
    await withServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer secret-cookie-like-token");
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      assert.match(body.messages[0].content, /BEGIN GROK FILE 1: review\.js/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-web-clean-state",
        model: "grok-4.20-fast",
        choices: [{ message: { content: substantiveReviewFixture("Clean workspace state root.") } }],
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

      assert.equal(result.status, 0);
      assert.equal(record.status, "completed");
      assert.equal(existsSync(path.join(cwd, ".codex-plugin-data")), false);
    });
  } finally {
    rmTree(cwd);
  }
});

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

test("doctor auto-start gives uv a sandbox-writable default cache dir", async () => {
  const port = await unusedLoopbackPort();
  const home = makeFakeGrok2ApiHome();
  const capturePath = path.join(mkdtempSync(path.join(tmpdir(), "fake-uv-env-")), "env.json");
  const binDir = makeFakeUvBin({ envCapturePath: capturePath });
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_HOME: home,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        UV_CACHE_DIR: undefined,
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "1000",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "5000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.tunnel_start.status, "started");
    const captured = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(
      captured.UV_CACHE_DIR,
      path.join(tmpdir(), "relay", "runtime", "uv-cache"),
    );
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(home);
    rmTree(binDir);
    rmTree(path.dirname(capturePath));
  }
});

test("doctor auto-start preserves an explicit UV_CACHE_DIR", async () => {
  const port = await unusedLoopbackPort();
  const home = makeFakeGrok2ApiHome();
  const capturePath = path.join(mkdtempSync(path.join(tmpdir(), "fake-uv-env-")), "env.json");
  const explicitUvCache = path.join(tmpdir(), "caller-uv-cache");
  const binDir = makeFakeUvBin({ envCapturePath: capturePath });
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_HOME: home,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        UV_CACHE_DIR: explicitUvCache,
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "1000",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "5000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.tunnel_start.status, "started");
    const captured = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(captured.UV_CACHE_DIR, explicitUvCache);
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(home);
    rmTree(binDir);
    rmTree(path.dirname(capturePath));
  }
});

test("doctor auto-start treats empty UV_CACHE_DIR as unset", async () => {
  const port = await unusedLoopbackPort();
  const home = makeFakeGrok2ApiHome();
  const capturePath = path.join(mkdtempSync(path.join(tmpdir(), "fake-uv-env-")), "env.json");
  const binDir = makeFakeUvBin({ envCapturePath: capturePath });
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_HOME: home,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        UV_CACHE_DIR: "",
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "1000",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "5000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.tunnel_start.status, "started");
    const captured = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(
      captured.UV_CACHE_DIR,
      path.join(tmpdir(), "relay", "runtime", "uv-cache"),
    );
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(home);
    rmTree(binDir);
    rmTree(path.dirname(capturePath));
  }
});

test("doctor auto-starts a local grok2api checkout without Docker", async () => {
  const port = await unusedLoopbackPort();
  const home = makeFakeGrok2ApiHome();
  const binDir = makeFakeUvBin();
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_HOME: home,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "1000",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "5000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.chat_ready, true);
    assert.equal(parsed.error_code, null);
    assert.equal(parsed.tunnel_start.status, "started");
    assert.equal(parsed.tunnel_start.attempted, true);
    assert.equal(parsed.tunnel_start.home_source, "GROK2API_HOME");
    assert.match(parsed.tunnel_start.command, /uv run granian/);
    assert.match(parsed.tunnel_start.command, /app\.main:app/);
    assert.doesNotMatch(parsed.tunnel_start.command, /docker/i);
    assert.equal(parsed.tunnel_start.cleanup_policy, "persistent_reuse");
    assert.equal(parsed.tunnel_start.cleanup_on_exit, false);
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(home);
    rmTree(binDir);
  }
});

test("doctor warns when explicit GROK2API_HOME is under TMPDIR", async () => {
  const port = await unusedLoopbackPort();
  const home = makeFakeGrok2ApiHome();
  const binDir = makeFakeUvBin();
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_HOME: home,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "1000",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "5000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.tunnel_start.home_source, "GROK2API_HOME");
    assert.equal(parsed.durability_warnings.length, 1);
    assert.equal(parsed.durability_warnings[0].code, "grok2api_ephemeral_bootstrap_home");
    assert.equal(parsed.durability_warnings[0].home_source, "GROK2API_HOME");
    assert.match(parsed.durability_warnings[0].recommendation, /durable/i);
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(home);
    rmTree(binDir);
  }
});

test("doctor terminates auto-started grok2api when it stays unreachable", async () => {
  const port = await unusedLoopbackPort();
  const home = makeFakeGrok2ApiHome();
  const binDir = makeFakeUvBin({ mode: "unreachable" });
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_HOME: home,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        GROK_WEB_DOCTOR_TIMEOUT_MS: "100",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "100",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "500",
        GROK_WEB_TUNNEL_CLEANUP_TIMEOUT_MS: "3000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.tunnel_start.status, "started_unreachable");
    assert.equal(parsed.tunnel_start.attempted, true);
    assert.equal(parsed.tunnel_start.cleanup?.attempted, true);
    assert.equal(parsed.tunnel_start.cleanup?.signal, "SIGTERM");
    assert.equal(parsed.tunnel_start.cleanup?.error, null);
    assert.equal(parsed.tunnel_start.cleanup?.reachable_after_signal, false);
    assert.equal(parsed.tunnel_start.cleanup?.exited_after_signal, true);
    assert.ok(
      parsed.tunnel_start.cleanup?.verify_elapsed_ms < 1000,
      `SIGTERM cleanup should stop polling soon after the tunnel is unreachable, got ${parsed.tunnel_start.cleanup?.verify_elapsed_ms}ms`,
    );
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(home);
    rmTree(binDir);
  }
});

test("doctor force kills auto-started grok2api when SIGTERM leaves it reachable", async () => {
  const port = await unusedLoopbackPort();
  const home = makeFakeGrok2ApiHome();
  const binDir = makeFakeUvBin({ mode: "late-reachable-ignore-sigterm" });
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_HOME: home,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        GROK_WEB_DOCTOR_TIMEOUT_MS: "100",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "100",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "100",
        GROK_WEB_TUNNEL_CLEANUP_TIMEOUT_MS: "700",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.tunnel_start.status, "started_unreachable");
    assert.equal(parsed.tunnel_start.cleanup?.signal, "SIGTERM");
    assert.equal(parsed.tunnel_start.cleanup?.reachable_after_signal, true);
    assert.equal(parsed.tunnel_start.cleanup?.exited_after_signal, false);
    assert.equal(parsed.tunnel_start.cleanup?.force_signal, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(200) }),
    );
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(-parsed.tunnel_start.pid, "SIGKILL"); } catch { /* already exited */ }
      try { process.kill(parsed.tunnel_start.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    rmTree(home);
    rmTree(binDir);
  }
});

test("doctor bootstraps a missing grok2api checkout and starts it without Docker", async () => {
  const port = await unusedLoopbackPort();
  const bootstrapRoot = mkdtempSync(path.join(tmpdir(), "grok2api-bootstrap-root-"));
  const bootstrapDir = path.join(bootstrapRoot, "grok2api");
  const fakeGit = makeFakeGitBinary();
  const binDir = makeFakeUvBin();
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_BOOTSTRAP_DIR: bootstrapDir,
        RELAY_GIT_BINARY: fakeGit.gitPath,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "1000",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "5000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.tunnel_start.status, "started");
    assert.equal(parsed.tunnel_start.home_source, "GROK2API_BOOTSTRAP_DIR");
    assert.equal(parsed.tunnel_start.bootstrap.status, "bootstrapped");
    assert.equal(parsed.tunnel_start.bootstrap.attempted, true);
    assert.equal(parsed.tunnel_start.bootstrap.error_code, null);
    assert.equal(existsSync(path.join(bootstrapDir, "app", "main.py")), true);
    assert.match(parsed.tunnel_start.command, /uv run granian/);
    assert.doesNotMatch(parsed.tunnel_start.command, /docker/i);
    assert.equal(parsed.tunnel_start.cleanup_policy, "persistent_reuse");
    assert.equal(parsed.tunnel_start.cleanup_on_exit, false);
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(bootstrapRoot);
    rmTree(fakeGit.binDir);
    rmTree(binDir);
  }
});

test("doctor defaults grok2api bootstrap to a durable managed home", async () => {
  const port = await unusedLoopbackPort();
  const runtimeRoot = mkdtempSync(path.join(REPO_ROOT, ".test-grok2api-durable-runtime-"));
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "grok2api-durable-tmp-"));
  const expectedHome = path.join(runtimeRoot, "grok2api");
  const fakeGit = makeFakeGitBinary();
  const binDir = makeFakeUvBin();
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        RELAY_RUNTIME_DIR: runtimeRoot,
        TMPDIR: `${tmpRoot}${path.sep}`,
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        RELAY_GIT_BINARY: fakeGit.gitPath,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "1000",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "5000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.tunnel_start.status, "started");
    assert.equal(parsed.tunnel_start.home_source, "default_bootstrap_dir");
    assert.equal(parsed.tunnel_start.home_path, expectedHome);
    assert.equal(parsed.tunnel_start.bootstrap.home_path, expectedHome);
    assert.equal(existsSync(path.join(expectedHome, "app", "main.py")), true);
    assert.equal(parsed.durability_warnings.length, 0);
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(runtimeRoot);
    rmTree(tmpRoot);
    rmTree(fakeGit.binDir);
    rmTree(binDir);
  }
});

test("doctor bootstraps the durable managed home instead of reusing a legacy TMPDIR checkout", async () => {
  const port = await unusedLoopbackPort();
  const runtimeRoot = mkdtempSync(path.join(REPO_ROOT, ".test-grok2api-durable-runtime-"));
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "grok2api-legacy-tmp-"));
  const legacyHome = path.join(tmpRoot, "relay", "runtime", "grok2api");
  const expectedHome = path.join(runtimeRoot, "grok2api");
  mkdirSync(path.join(legacyHome, "app"), { recursive: true });
  writeFileSync(path.join(legacyHome, "app", "main.py"), "app = object()\n");
  writeFileSync(path.join(legacyHome, "pyproject.toml"), "[project]\nname = \"legacy-fake-grok2api\"\n");
  const fakeGit = makeFakeGitBinary();
  const binDir = makeFakeUvBin();
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        RELAY_RUNTIME_DIR: runtimeRoot,
        TMPDIR: `${tmpRoot}${path.sep}`,
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        RELAY_GIT_BINARY: fakeGit.gitPath,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "1000",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "5000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.tunnel_start.home_source, "default_bootstrap_dir");
    assert.equal(parsed.tunnel_start.home_path, expectedHome);
    assert.equal(existsSync(path.join(expectedHome, "app", "main.py")), true);
    assert.equal(parsed.durability_warnings.length, 0);
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(runtimeRoot);
    rmTree(tmpRoot);
    rmTree(fakeGit.binDir);
    rmTree(binDir);
  }
});

test("doctor warns when the configured grok2api bootstrap home is under TMPDIR", async () => {
  const port = await unusedLoopbackPort();
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "grok2api-default-bootstrap-tmp-"));
  const bootstrapDir = path.join(tmpRoot, "grok2api");
  const fakeGit = makeFakeGitBinary();
  const binDir = makeFakeUvBin();
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        TMPDIR: `${tmpRoot}${path.sep}`,
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_BOOTSTRAP_DIR: bootstrapDir,
        RELAY_GIT_BINARY: fakeGit.gitPath,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        GROK_WEB_DOCTOR_TIMEOUT_MS: "500",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "1000",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "5000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.tunnel_start.home_source, "GROK2API_BOOTSTRAP_DIR");
    assert.equal(parsed.durability_warnings.length, 1);
    assert.equal(parsed.durability_warnings[0].code, "grok2api_ephemeral_bootstrap_home");
    assert.match(parsed.durability_warnings[0].message, /TMPDIR|temporary/i);
    assert.match(parsed.durability_warnings[0].recommendation, /GROK2API_HOME/i);
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(tmpRoot);
    rmTree(fakeGit.binDir);
    rmTree(binDir);
  }
});

test("doctor warns about an existing default TMPDIR grok2api home when tunnel is already running", async () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "grok2api-existing-default-home-tmp-"));
  const managedRuntimeRoot = mkdtempSync(path.join(tmpdir(), "grok2api-existing-default-home-runtime-"));
  const defaultHome = path.join(tmpRoot, "relay", "runtime", "grok2api");
  mkdirSync(path.join(defaultHome, "app"), { recursive: true });
  writeFileSync(path.join(defaultHome, "app", "main.py"), "app = object()\n");
  writeFileSync(path.join(defaultHome, "pyproject.toml"), "[project]\nname = \"fake-grok2api\"\n");
  try {
    await withServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/models") {
        res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
        return;
      }
      if (req.url === "/api/chat/completions") {
        await readJsonRequest(req);
        res.end(JSON.stringify({
          id: "chatcmpl-doctor-existing-home",
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
          TMPDIR: `${tmpRoot}${path.sep}`,
          RELAY_RUNTIME_DIR: managedRuntimeRoot,
          GROK_WEB_BASE_URL: baseUrl,
        },
      });
      const parsed = parseStdout(result);

      assert.equal(result.status, 0);
      assert.equal(parsed.ready, true);
      assert.equal(parsed.tunnel_start.status, "not_needed");
      assert.equal(parsed.durability_warnings.length, 1);
      assert.equal(parsed.durability_warnings[0].code, "grok2api_ephemeral_bootstrap_home");
      assert.equal(parsed.durability_warnings[0].home_source, "legacy_tmp_bootstrap_dir");
      assert.match(parsed.durability_warnings[0].recommendation, /GROK2API_HOME/i);
    });
  } finally {
    rmTree(tmpRoot);
    rmTree(managedRuntimeRoot);
  }
});

test("doctor failed auto-bootstrap does not leave a partial checkout at the target path", async () => {
  const port = await unusedLoopbackPort();
  const bootstrapRoot = mkdtempSync(path.join(tmpdir(), "grok2api-bootstrap-fail-root-"));
  const bootstrapDir = path.join(bootstrapRoot, "grok2api");
  const fakeGit = makeFakeGitBinary({ mode: "partial-fail" });
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_BOOTSTRAP_DIR: bootstrapDir,
        RELAY_GIT_BINARY: fakeGit.gitPath,
        GROK_WEB_DOCTOR_TIMEOUT_MS: "100",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "100",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "100",
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.tunnel_start.status, "failed");
    assert.equal(parsed.tunnel_start.error_code, "grok2api_bootstrap_failed");
    assert.equal(existsSync(bootstrapDir), false, "failed clone must not leave the final bootstrap target populated");
  } finally {
    rmTree(bootstrapRoot);
    rmTree(fakeGit.binDir);
  }
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

test("doctor treats malformed models payload as failed models health", async () => {
  await withServer(async (req, res) => {
    if (req.url === "/api/models") {
      res.setHeader("content-type", "application/json");
      res.end("not json");
      return;
    }
    if (req.url === "/api/chat/completions") {
      await readJsonRequest(req);
      res.setHeader("content-type", "application/json");
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
      env: { GROK_WEB_BASE_URL: baseUrl },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.models_ready, false);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.error_code, "malformed_response");
    assert.equal(parsed.readiness_layers.models.status, "failed");
  });
});

test("doctor treats unexpected models JSON shape as failed models health", async () => {
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: "not an array" }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      await readJsonRequest(req);
      res.end(JSON.stringify({
        id: "chatcmpl-doctor-unexpected-models",
        model: "grok-4.20-fast",
        choices: [{ message: { content: "ok" } }],
      }));
      return;
    }
    if (req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({
        tokens: [{ token: VALID_SESSION_TOKEN, pool: "super", status: "active" }],
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK2API_BASE_URL: baseUrl.replace(/\/api$/, ""),
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.models_ready, false);
    assert.equal(parsed.model_count, null);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.error_code, "malformed_response");
    assert.equal(parsed.readiness_layers.models.status, "failed");
    assert.equal(parsed.readiness_layers.models.error_code, "malformed_response");
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

test("doctor reports startup timeout instead of a generic tunnel root cause during slow cold start", async () => {
  const port = await unusedLoopbackPort();
  const home = makeFakeGrok2ApiHome();
  const binDir = makeFakeUvBin({ mode: "slow-reachable" });
  let parsed = null;
  try {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `http://127.0.0.1:${port}/v1`,
        GROK2API_HOME: home,
        GROK2API_UV_BINARY: path.join(binDir, "uv"),
        GROK_WEB_DOCTOR_TIMEOUT_MS: "50",
        GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "50",
        GROK_WEB_TUNNEL_START_TIMEOUT_MS: "100",
        GROK_WEB_TUNNEL_CLEANUP_TIMEOUT_MS: "3000",
      },
    });
    parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.error_code, "grok2api_start_timeout");
    assert.equal(parsed.tunnel_start.status, "started_unreachable");
    assert.equal(parsed.tunnel_start.error_code, "grok2api_start_timeout");
    assert.equal(parsed.tunnel_start.last_probe_error_code, "tunnel_unavailable");
    assert.equal(parsed.readiness_layers.process_start.status, "timeout");
    assert.equal(parsed.readiness_layers.listener.status, "unreachable");
    assert.match(parsed.next_action, /startup.*slow|GROK_WEB_TUNNEL_START_TIMEOUT_MS/i);
  } finally {
    if (parsed?.tunnel_start?.pid) {
      try { process.kill(parsed.tunnel_start.pid, "SIGTERM"); } catch { /* already exited */ }
    }
    rmTree(home);
    rmTree(binDir);
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

test("doctor classifies empty grok2api model and account pools as missing session tokens", async () => {
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      await readJsonRequest(req);
      res.writeHead(429);
      res.end(JSON.stringify({
        error: {
          message: "No available accounts for this model tier",
          type: "rate_limit_exceeded",
          code: "rate_limit_exceeded",
        },
      }));
      return;
    }
    if (req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({
        tokens: [],
        account_count: 0,
        pool_count: 0,
      }));
      return;
    }
    if (req.url === "/status") {
      res.end(JSON.stringify({
        status: "ok",
        size: 0,
        account_count: 0,
        pool_count: 0,
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const adminBaseUrl = baseUrl.replace(/\/api$/, "");
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK2API_BASE_URL: adminBaseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.models_ready, false);
    assert.equal(parsed.model_count, 0);
    assert.equal(parsed.error_code, "grok_session_no_runtime_tokens");
    assert.equal(parsed.chat_http_status, 429);
    assert.equal(parsed.session_diagnostics.status, "checked");
    assert.equal(parsed.session_diagnostics.account_count, 0);
    assert.equal(parsed.session_diagnostics.pool_count, 0);
    assert.equal(parsed.session_diagnostics.runtime_size, 0);
    assert.equal(parsed.cost_quota_readiness.status, "unknown_not_probed");
    assert.equal(parsed.readiness_layers.listener.status, "reachable");
    assert.equal(parsed.readiness_layers.models.status, "empty");
    assert.equal(parsed.readiness_layers.session_pool.status, "empty");
    assert.equal(parsed.readiness_layers.chat_probe.status, "session_tokens_missing");
    assert.match(parsed.next_action, /GROK2API_HOME/i);
    assert.match(parsed.next_action, /explicit.*approval|operator.*approval/i);
    assert.doesNotMatch(JSON.stringify(parsed), /api\.x\.ai|XAI_API_KEY|xAI API key/i);
  }, { autoPreflight: false });
});

test("doctor treats no-available-account chat 429 as session tokens missing, not quota", async () => {
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      await readJsonRequest(req);
      res.writeHead(429);
      res.end(JSON.stringify({
        error: {
          message: "No available accounts for this model tier",
          type: "rate_limit_exceeded",
          code: "rate_limit_exceeded",
        },
      }));
      return;
    }
    if (req.url === "/admin/api/tokens") {
      res.writeHead(503);
      res.end(JSON.stringify({ error: { message: "admin not ready" } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const adminBaseUrl = baseUrl.replace(/\/api$/, "");
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK2API_BASE_URL: adminBaseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.error_code, "grok_session_no_runtime_tokens");
    assert.equal(parsed.chat_probe.error_code, "grok_session_no_runtime_tokens");
    assert.equal(parsed.readiness_layers.chat_probe.status, "session_tokens_missing");
    assert.equal(parsed.cost_quota_readiness.status, "unknown_not_probed");
    assert.doesNotMatch(parsed.next_action, /billing|credit|subscription usage/i);
  }, { autoPreflight: false });
});

test("repair pauses before browser session sync until explicit approval", async () => {
  const requests = [];
  await withGrok2ApiServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      await readJsonRequest(req);
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { message: "No available accounts for this model tier" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }, async (baseUrl) => {
    const result = await runAsync(["repair"], {
      env: {
        GROK_WEB_BASE_URL: `${baseUrl}/v1`,
        GROK2API_BASE_URL: baseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "approval_required");
    assert.equal(parsed.error_code, "browser_session_sync_approval_required");
    assert.equal(parsed.initial_doctor.error_code, "grok_session_no_runtime_tokens");
    assert.equal(parsed.sync_session.status, "approval_required");
    assert.equal(parsed.sync_session.source_content_transmission, "not_sent");
    assert.match(parsed.next_action, /--approve-browser-session-sync/);
    assert.match(parsed.next_action, /grok:repair-session/);
    assert.deepEqual(requests.filter((entry) => entry.includes("/admin/api/tokens/add")), []);
  });
});

test("repair pauses before browser session sync for malformed active tokens", async () => {
  const requests = [];
  await withGrok2ApiServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      await readJsonRequest(req);
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "Chat upstream returned 400" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({
        tokens: [{ token: "malformed-control-looking-cookie", pool: "super", status: "active" }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }, async (baseUrl) => {
    const result = await runAsync(["repair"], {
      env: {
        GROK_WEB_BASE_URL: `${baseUrl}/v1`,
        GROK2API_BASE_URL: baseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "approval_required");
    assert.equal(parsed.error_code, "browser_session_sync_approval_required");
    assert.equal(parsed.initial_doctor.error_code, "grok_session_malformed_active_token");
    assert.equal(parsed.sync_session.status, "approval_required");
    assert.equal(parsed.sync_session.source_content_transmission, "not_sent");
    assert.deepEqual(requests.filter((entry) => entry.includes("/admin/api/tokens/add")), []);
  });
});

test("repair syncs an approved browser session and reruns doctor", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-repair-cookie-source-"));
  const cookieSource = path.join(dir, "cookies.json");
  writeFileSync(cookieSource, JSON.stringify([
    { name: "sso-rw", value: VALID_SESSION_TOKEN },
  ]));
  const requests = [];
  let tokens = [];
  try {
    await withGrok2ApiServer(async (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/v1/models") {
        res.end(JSON.stringify({ data: tokens.length ? [{ id: "grok-4.20-fast" }] : [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        await readJsonRequest(req);
        if (tokens.length) {
          res.end(JSON.stringify({
            id: "chatcmpl-repair-ready",
            model: "grok-4.20-fast",
            choices: [{ message: { content: "ok" } }],
          }));
          return;
        }
        res.statusCode = 429;
        res.end(JSON.stringify({ error: { message: "No available accounts for this model tier" } }));
        return;
      }
      if (req.method === "GET" && req.url === "/admin/api/tokens") {
        res.end(JSON.stringify({ tokens }));
        return;
      }
      if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
        const body = await readJsonRequest(req);
        assert.deepEqual(body, { pool: "super", tokens: [VALID_SESSION_TOKEN] });
        tokens = [{ token: VALID_SESSION_TOKEN, pool: "super", status: "active", quota: { auto: { remaining: 50 } } }];
        res.end(JSON.stringify({ status: "success", count: 1 }));
        return;
      }
      if (req.method === "POST" && req.url === "/admin/api/batch/refresh") {
        const body = await readJsonRequest(req);
        assert.deepEqual(body, { tokens: [VALID_SESSION_TOKEN] });
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
        "repair",
        "--approve-browser-session-sync",
        "--cookie-source-json", cookieSource,
      ], {
        env: {
          GROK_WEB_BASE_URL: `${baseUrl}/v1`,
          GROK2API_BASE_URL: baseUrl,
        },
      });
      const parsed = parseStdout(result);

      assert.equal(result.status, 0);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.status, "ready");
      assert.equal(parsed.error_code, null);
      assert.equal(parsed.initial_doctor.error_code, "grok_session_no_runtime_tokens");
      assert.equal(parsed.sync_session.status, "completed");
      assert.equal(parsed.sync_session.source, "cookie_source_json");
      assert.equal(parsed.sync_session.selected_cookie, "sso-rw");
      assert.equal(parsed.sync_session.token_count, 1);
      assert.equal(parsed.final_doctor.ready, true);
      assert.equal(parsed.final_doctor.error_code, null);
      assert.ok(requests.includes("POST /admin/api/tokens/add"));
      assert.doesNotMatch(result.stdout, /eyJhbGci/);
      assert.doesNotMatch(result.stderr, /eyJhbGci/);
    });
  } finally {
    rmTree(dir);
  }
});

test("repair redacts JWT-shaped text from sync failure output", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grok-repair-cookie-source-"));
  const cookieSource = path.join(dir, "cookies.json");
  const leakedToken = "eyJhbGciOiJub25lIn0.eyJsZWFrIjoic3luYy1mYWlsdXJlIn0.signature";
  writeFileSync(cookieSource, JSON.stringify([
    { name: "sso-rw", value: VALID_SESSION_TOKEN },
  ]));
  try {
    await withGrok2ApiServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        await readJsonRequest(req);
        res.statusCode = 429;
        res.end(JSON.stringify({ error: { message: "No available accounts for this model tier" } }));
        return;
      }
      if (req.method === "GET" && req.url === "/admin/api/tokens") {
        res.end(JSON.stringify({ tokens: [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/admin/api/tokens/add") {
        await readJsonRequest(req);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: `sync failed for ${leakedToken}` } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }, async (baseUrl) => {
      const result = await runAsync([
        "repair",
        "--approve-browser-session-sync",
        "--cookie-source-json", cookieSource,
      ], {
        env: {
          GROK_WEB_BASE_URL: `${baseUrl}/v1`,
          GROK2API_BASE_URL: baseUrl,
        },
      });
      const parsed = parseStdout(result);

      assert.equal(result.status, 0);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.status, "sync_failed");
      assert.equal(parsed.sync_session.status, "failed");
      assert.equal(result.stdout.includes(leakedToken), false);
      assert.match(parsed.sync_session.error_message, /\[REDACTED\]/);
    });
  } finally {
    rmTree(dir);
  }
});

test("doctor identifies malformed active Grok session tokens instead of generic chat 400", async () => {
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
    if (req.url === "/admin/api/tokens") {
      assert.equal(req.headers.authorization, "Bearer grok2api");
      res.end(JSON.stringify({
        tokens: [
          { token: "malformed-control-looking-cookie", pool: "super", status: "active", deleted: false },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const adminBaseUrl = baseUrl.replace(/\/api$/, "");
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK2API_BASE_URL: adminBaseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.reachable, true);
    assert.equal(parsed.chat_ready, false);
    assert.equal(parsed.error_code, "grok_session_malformed_active_token");
    assert.equal(parsed.chat_http_status, 400);
    assert.equal(parsed.session_diagnostics.status, "checked");
    assert.equal(parsed.session_diagnostics.active_token_count, 1);
    assert.equal(parsed.session_diagnostics.malformed_active_token_count, 1);
    assert.match(parsed.next_action, /malformed.*Grok.*session/i);
    assert.doesNotMatch(result.stdout, /malformed-control-looking-cookie/);
  });
});

test("doctor derives Grok admin base from tunnel URLs ending in /api/v1", async () => {
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/api/v1/chat/completions") {
      await readJsonRequest(req);
      res.writeHead(400);
      res.end(JSON.stringify({
        error: { message: "Chat upstream returned 400", type: "upstream_error", code: "upstream_error" },
      }));
      return;
    }
    if (req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({
        tokens: [
          { token: "malformed-control-looking-cookie", pool: "super", status: "active", deleted: false },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: `not found: ${req.url}` } }));
  }, async (baseUrl) => {
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: `${baseUrl}/v1`,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.chat_ready, false);
    assert.equal(parsed.error_code, "grok_session_malformed_active_token");
    assert.equal(parsed.session_diagnostics.status, "checked");
    assert.equal(parsed.session_diagnostics.malformed_active_token_count, 1);
    assert.doesNotMatch(result.stdout, /malformed-control-looking-cookie/);
  });
});

test("doctor identifies missing active Grok runtime tokens instead of generic chat 400", async () => {
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
    if (req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({ tokens: [] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const adminBaseUrl = baseUrl.replace(/\/api$/, "");
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK2API_BASE_URL: adminBaseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.error_code, "grok_session_no_runtime_tokens");
    assert.equal(parsed.session_diagnostics.status, "checked");
    assert.equal(parsed.session_diagnostics.active_token_count, 0);
    assert.match(parsed.next_action, /no active runtime session tokens|sync/i);
  });
});

test("doctor identifies grok2api admin/runtime token-table divergence", async () => {
  const validToken = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJncm9rIn0.signature";
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
    if (req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({
        tokens: [
          { token: validToken, pool: "super", status: "active", deleted: false },
        ],
      }));
      return;
    }
    if (req.url === "/status") {
      res.end(JSON.stringify({ status: "ok", size: 0, revision: 146, selection_strategy: "quota" }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const adminBaseUrl = baseUrl.replace(/\/api$/, "");
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK2API_BASE_URL: adminBaseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.error_code, "grok_session_runtime_admin_divergence");
    assert.equal(parsed.session_diagnostics.status, "checked");
    assert.equal(parsed.session_diagnostics.active_token_count, 1);
    assert.equal(parsed.session_diagnostics.runtime_size, 0);
    assert.equal(parsed.session_diagnostics.runtime_revision, 146);
    assert.match(parsed.next_action, /restart|refresh.*tunnel/i);
    assert.doesNotMatch(result.stdout, /eyJhbGci/);
  });
});

test("doctor reports runtime status probe failures when admin tokens look healthy", async () => {
  const validToken = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJncm9rIn0.signature";
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
    if (req.url === "/admin/api/tokens") {
      res.end(JSON.stringify({
        tokens: [
          { token: validToken, pool: "super", status: "active", deleted: false },
        ],
      }));
      return;
    }
    if (req.url === "/status") {
      res.writeHead(503);
      res.end(JSON.stringify({ error: { message: "runtime status down" } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const adminBaseUrl = baseUrl.replace(/\/api$/, "");
    const result = await runAsync(["doctor"], {
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK2API_BASE_URL: adminBaseUrl,
      },
    });
    const parsed = parseStdout(result);

    assert.equal(result.status, 0);
    assert.equal(parsed.ready, false);
    assert.equal(parsed.error_code, "grok_runtime_status_unavailable");
    assert.equal(parsed.session_diagnostics.status, "checked");
    assert.equal(parsed.session_diagnostics.active_token_count, 1);
    assert.equal(parsed.session_diagnostics.runtime_status, "unknown");
    assert.equal(parsed.session_diagnostics.runtime_error_code, "grok_runtime_status_unavailable");
    assert.equal(parsed.session_diagnostics.runtime_http_status, 503);
    assert.match(parsed.next_action, /runtime status|restart|refresh.*tunnel/i);
    assert.doesNotMatch(result.stdout, /eyJhbGci/);
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
  assert.match(parsed.next_action, /GROK2API_HOME|local Grok web tunnel/i);
  assert.doesNotMatch(result.stdout, /api\.x\.ai/i);
});

test("doctor does not expose legacy GROK_API_KEY as a Grok auth path", () => {
  const result = run(["doctor"], {
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      GROK_API_KEY: "xai-direct-api-key",
      XAI_API_KEY: "",
      XAI_KEY: "",
    },
  });
  const parsed = parseStdout(result);

  assert.equal(result.status, 0);
  assert.equal(parsed.provider, "grok-web");
  assert.equal(parsed.ready, false);
  assert.equal(parsed.reachable, false);
  assert.equal(parsed.error_code, "tunnel_unavailable");
  assert.doesNotMatch(parsed.error_message, /GROK_API_KEY|XAI_API_KEY|XAI_KEY/i);
  assert.match(parsed.next_action, /GROK2API_HOME|local Grok web tunnel/i);
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

test("doctor does not expose legacy XAI_KEY as a Grok auth path", () => {
  const result = run(["doctor"], {
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:9/v1",
      GROK_API_KEY: "",
      XAI_KEY: "xai-direct-api-key",
      XAI_API_KEY: "",
    },
  });
  const parsed = parseStdout(result);

  assert.equal(result.status, 0);
  assert.equal(parsed.error_code, "tunnel_unavailable");
  assert.doesNotMatch(parsed.error_message, /GROK_API_KEY|XAI_API_KEY|XAI_KEY/i);
  assert.doesNotMatch(result.stdout, /xai-direct-api-key/);
});

test("custom-review sends selected source to a local Grok web tunnel and persists a JobRecord", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const firstReviewText = substantiveReviewFixture("Provider marker: no findings 1.");
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
      choices: [{ message: { content: substantiveReviewFixture(`Provider marker: no findings ${requestCount}.`) } }],
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
    assert.equal(record.result, firstReviewText);
    assert.equal(record.schema_version, 10);
    assert.equal(record.review_metadata.prompt_contract_version, 1);
    assert.equal(record.review_metadata.prompt_provider, "Grok Web");
    assert.equal(record.review_metadata.scope, "custom");
    assert.deepEqual(record.review_metadata.scope_paths, ["review.js"]);
    assert.deepEqual(record.review_metadata.raw_output, {
      http_status: 200,
      raw_model: "grok-4.20-fast",
      parsed_ok: true,
      result_chars: firstReviewText.length,
      elapsed_ms: record.review_metadata.raw_output.elapsed_ms,
    });
    assert.equal(typeof record.review_metadata.raw_output.elapsed_ms, "number");
    assert.ok(record.review_metadata.raw_output.elapsed_ms >= 0);
    assert.match(record.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
    assert.equal(record.review_metadata.audit_manifest.request.model, "grok-4.20-fast");
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 123456);
    assert.equal(record.review_metadata.audit_manifest.request.temperature, 0);
    assert.match(record.review_metadata.audit_manifest.prompt_builder.plugin_commit, /^[a-f0-9]{40}$/);
    assert.equal(record.review_metadata.audit_manifest.selected_route, "subscription_web");
    assert.equal(record.review_metadata.audit_manifest.fallback_reason, null);
    assert.equal(record.review_metadata.audit_manifest.auth_path, "subscription_web");
    assert.equal(record.review_metadata.audit_manifest.billing_path, null);
    assert.equal(record.review_metadata.audit_manifest.source_bearing, true);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_required, false);
    assert.equal(record.review_metadata.audit_manifest.source_send_approval_state, "not_required");
    assert.equal(record.review_metadata.audit_manifest.approval_scope, null);
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
    assert.equal(persisted.result, firstReviewText);
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
    assert.equal(lookedUp.result, firstReviewText);
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

test("custom-review fails closed when Grok tunnel returns shallow HTTP 200 output", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const shallowResult = "Verdict: APPROVE\nNo blocking findings. secret-cookie-like-token";
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/chat/completions");
    const body = await readJsonRequest(req);
    assert.match(body.messages[0].content, /review\.js/);
    assert.match(body.messages[0].content, /export const value = 42/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-shallow-session",
      model: "grok-4.20-fast",
      choices: [{ message: { content: shallowResult } }],
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

    assert.equal(result.status, 1);
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "review_not_completed");
    assert.equal(record.error_cause, "review_quality");
    assert.match(record.error_message, /review_quality_failed:shallow_output/);
    assert.equal(record.result, "Verdict: APPROVE\nNo blocking findings. [REDACTED]");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(typeof record.review_metadata.raw_output.elapsed_ms, "number");
    assert.ok(record.review_metadata.raw_output.elapsed_ms >= 0);
    assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, true);
    assert.deepEqual(record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons, ["shallow_output"]);

    const persisted = JSON.parse(readFileSync(path.join(dataDir, "jobs", record.job_id, "meta.json"), "utf8"));
    assert.equal(persisted.result, "Verdict: APPROVE\nNo blocking findings. [REDACTED]");

    const lookup = run(["result", "--job-id", record.job_id], {
      cwd,
      env: {
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    const lookedUp = parseStdout(lookup);
    assert.equal(lookup.status, 0);
    assert.equal(lookedUp.result, "Verdict: APPROVE\nNo blocking findings. [REDACTED]");
  });
});

test("custom-review guides substantive missing-verdict retry without automatic resend", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-bad-verdict-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-bad-verdict-data-"));
  const badResult = badVerdictReviewFixture("Grok missing verdict replay marker.");
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  try {
    await withServer(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      assert.match(body.messages[0].content, /review\.js/);
      assert.match(body.messages[0].content, /export const value = 42/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-web-bad-verdict-session",
        model: "grok-4.20-fast",
        choices: [{ message: { content: badResult } }],
        usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 },
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

      assert.equal(result.status, 1);
      assert.equal(record.status, "failed");
      assert.equal(record.error_code, "review_not_completed");
      assert.equal(record.error_cause, "review_quality");
      assert.equal(record.error_message, "review_quality_failed:missing_verdict");
      assert.equal(record.result, badResult);
      assert.equal(record.external_review.source_content_transmission, "sent");
      assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, true);
      assert.deepEqual(
        record.review_metadata.audit_manifest.review_quality.semantic_failure_reasons,
        ["missing_verdict"],
      );
      assert.match(record.suggested_action, /Treat this .* slot as failed/i);
      assert.match(record.suggested_action, /Do not automatically resend selected source/i);
      assert.doesNotMatch(record.suggested_action, /direct API|fresh matching approval token/i);
      assert.match(record.suggested_action, /same Grok reviewer/i);
      assert.match(record.suggested_action, /narrowing the scope/i);
      assert.match(record.suggested_action, /sharding/i);
      assert.match(record.suggested_action, /relaying/i);
      const recovery = record.runtime_diagnostics?.packet_recovery;
      assert.ok(recovery, "Grok no-verdict source-sent failures must include packet_recovery");
      assert.equal(recovery.provider, "grok");
      assert.equal(recovery.provider_capabilities.provider, "grok");
      assert.equal(recovery.provider_capabilities.canonical_provider, "grok");
      assert.equal(recovery.provider, recovery.provider_capabilities.canonical_provider);
      assert.equal(recovery.mode, "custom-review");
      assert.equal(recovery.reason, "review_not_completed");
      assert.equal(recovery.source_content_transmission, "sent");
      assert.equal(record.error_code, recovery.reason);
      assert.equal(recovery.provider_capabilities.supports_no_source_resume, false);
      assert.deepEqual(
        recovery.actions.map((action) => action.type),
        ["resend_with_confirmation", "switch_provider", "waive_slot"],
      );
      assert.deepEqual(record.review_metadata.audit_manifest.packet_recovery, recovery);
    });
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review blocks same-packet Grok resend after a failed source-sent slot", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-retry-guard-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-retry-guard-data-"));
  const badResult = badVerdictReviewFixture("Grok retry guard marker.");
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  try {
    let requestCount = 0;
    await withServer(async (req, res) => {
      requestCount += 1;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      assert.match(body.messages[0].content, /review\.js/);
      assert.match(body.messages[0].content, /export const value = 42/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `grok-web-retry-guard-session-${requestCount}`,
        model: "grok-4.20-fast",
        choices: [{ message: { content: badResult } }],
        usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 },
      }));
    }, async (baseUrl) => {
      const commonArgs = [
        "run",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Check this file.",
      ];
      const commonOptions = {
        cwd,
        env: {
          GROK_WEB_BASE_URL: baseUrl,
          GROK_PLUGIN_DATA: dataDir,
        },
      };

      const first = await runAsync(commonArgs, commonOptions);
      assert.equal(first.status, 1, first.stderr || first.stdout);
      const firstRecord = parseStdout(first);
      assert.equal(firstRecord.error_code, "review_not_completed");
      assert.equal(firstRecord.external_review.source_content_transmission, "sent");

      const second = await runAsync(commonArgs, commonOptions);
      assert.equal(second.status, 1, second.stderr || second.stdout);
      const secondRecord = parseStdout(second);
      assert.equal(secondRecord.error_code, "review_slot_disposition_required");
      assert.equal(secondRecord.external_review.source_content_transmission, "not_sent");
      assert.equal(secondRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
      assert.equal(
        secondRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action,
        "review_slot_retry_blocked",
      );
      assert.equal(requestCount, 1);
    });
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review records changed review surface when Grok retries with a narrowed packet", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-changed-surface-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-changed-surface-data-"));
  const badResult = badVerdictReviewFixture("Grok changed-surface initial slot.");
  writeFileSync(path.join(cwd, "full.js"), "export const full = 'original source body';\n");
  writeFileSync(path.join(cwd, "narrow.js"), "export const narrow = 'fallback source body';\n");

  try {
    let requestCount = 0;
    await withServer(async (req, res) => {
      requestCount += 1;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      if (requestCount === 1) {
        assert.match(body.messages[0].content, /full\.js/);
        assert.match(body.messages[0].content, /narrow\.js/);
      } else {
        assert.doesNotMatch(body.messages[0].content, /full\.js/);
        assert.match(body.messages[0].content, /narrow\.js/);
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `grok-web-changed-surface-session-${requestCount}`,
        model: "grok-4.20-fast",
        choices: [{
          message: {
            content: requestCount === 1
              ? badResult
              : substantiveReviewFixture("Grok changed-surface narrowed packet approved."),
          },
        }],
        usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 },
      }));
    }, async (baseUrl) => {
      const commonOptions = {
        cwd,
        env: {
          GROK_WEB_BASE_URL: baseUrl,
          GROK_PLUGIN_DATA: dataDir,
        },
      };

      const first = await runAsync([
        "run",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "full.js,narrow.js",
        "--foreground",
        "--prompt", "Check this source packet.",
      ], commonOptions);
      assert.equal(first.status, 1, first.stderr || first.stdout);
      const firstRecord = parseStdout(first);
      assert.equal(firstRecord.error_code, "review_not_completed");
      assert.equal(firstRecord.external_review.source_content_transmission, "sent");

      const second = await runAsync([
        "run",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "narrow.js",
        "--foreground",
        "--prompt", "Check this narrowed source packet.",
      ], commonOptions);
      assert.equal(second.status, 0, second.stderr || second.stdout);
      const secondRecord = parseStdout(second);
      const manifest = secondRecord.review_metadata.audit_manifest;
      assert.equal(secondRecord.external_review.source_content_transmission, "sent");
      assert.equal(manifest.source_packet_policy.source_packet_action, "send_narrowed_source_packet");
      assert.equal(manifest.source_packet_policy.review_surface_changed, true);
      assert.equal(manifest.packet_recovery?.review_surface?.changed, true);
      assert.equal(manifest.packet_recovery?.review_surface?.approval_credit, "changed_surface_only");
      assert.equal(manifest.packet_recovery?.review_surface?.original_files, 2);
      assert.equal(manifest.packet_recovery?.review_surface?.current_files, 1);
      assert.notEqual(
        manifest.packet_recovery?.review_surface?.original_packet_hash,
        manifest.packet_recovery?.review_surface?.current_packet_hash,
      );
      assert.equal(requestCount, 2);
    });
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review Grok no-remote audit metadata uses safe local workspace identity", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-local-repo-identity-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");
  const expectedRepository = `local-workspace:${path.basename(cwd)}`;
  const reviewText = substantiveReviewFixture("Grok local repository identity marker.");

  try {
    await withServer(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      assert.match(body.messages[0].content, new RegExp(`Repository: ${expectedRepository}`));
      assert.doesNotMatch(body.messages[0].content, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-web-local-repo-identity-session",
        model: "grok-4.20-fast",
        choices: [{ message: { content: reviewText } }],
        usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 },
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
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const record = parseStdout(result);
      assert.equal(record.review_metadata.audit_manifest.git_identity.remote, expectedRepository);
      assert.doesNotMatch(
        JSON.stringify(record.review_metadata.audit_manifest.git_identity),
        new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    });
  } finally {
    rmTree(cwd);
  }
});

test("custom-review requires resend confirmation for explicit same-packet Grok retry disposition", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-retry-disposition-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-retry-disposition-data-"));
  const badResult = badVerdictReviewFixture("Grok retry disposition marker.");
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  try {
    let requestCount = 0;
    await withServer(async (req, res) => {
      requestCount += 1;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/chat/completions");
      const body = await readJsonRequest(req);
      assert.match(body.messages[0].content, /review\.js/);
      assert.match(body.messages[0].content, /export const value = 42/);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `grok-web-retry-disposition-session-${requestCount}`,
        model: "grok-4.20-fast",
        choices: [{
          message: {
            content: requestCount === 1
              ? badResult
              : substantiveReviewFixture("Grok retry disposition approved."),
          },
        }],
        usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 },
      }));
    }, async (baseUrl) => {
      const commonArgs = [
        "run",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "review.js",
        "--foreground",
        "--prompt", "Check this file.",
      ];
      const commonOptions = {
        cwd,
        env: {
          GROK_WEB_BASE_URL: baseUrl,
          GROK_PLUGIN_DATA: dataDir,
        },
      };

      const first = await runAsync(commonArgs, commonOptions);
      assert.equal(first.status, 1, first.stderr || first.stdout);
      const firstRecord = parseStdout(first);
      assert.equal(firstRecord.error_code, "review_not_completed");
      assert.equal(firstRecord.external_review.source_content_transmission, "sent");

      const blocked = await runAsync(
        [...commonArgs, "--review-slot-disposition", "retry"],
        commonOptions,
      );
      assert.equal(blocked.status, 1, blocked.stderr || blocked.stdout);
      const blockedRecord = parseStdout(blocked);
      assert.equal(blockedRecord.error_code, "resend_confirmation_required");
      assert.equal(blockedRecord.external_review.source_content_transmission, "not_sent");
      assert.equal(blockedRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
      assert.equal(blockedRecord.review_metadata.audit_manifest.review_slot.retry_disposition_required, true);
      assert.equal(blockedRecord.review_metadata.audit_manifest.review_slot.disposition, "retry");
      assert.equal(blockedRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action, "resend_confirmation_required");
      assert.equal(requestCount, 1);

      const retried = await runAsync(
        [...commonArgs, "--review-slot-disposition", "retry", "--resend-confirmation-approved"],
        commonOptions,
      );
      assert.equal(retried.status, 0, retried.stderr || retried.stdout);
      const retriedRecord = parseStdout(retried);
      assert.equal(retriedRecord.external_review.source_content_transmission, "sent");
      assert.equal(retriedRecord.review_metadata.audit_manifest.review_slot.retry_count, 1);
      assert.equal(retriedRecord.review_metadata.audit_manifest.review_slot.retry_disposition_required, true);
      assert.equal(retriedRecord.review_metadata.audit_manifest.review_slot.disposition, "retry");
      assert.equal(retriedRecord.review_metadata.audit_manifest.source_packet_policy.source_packet_action, "send_after_resend_confirmation");
      assert.equal(requestCount, 2);
    });
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review lifecycle jsonl emits launch before terminal projection", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const reviewText = substantiveReviewFixture("SOURCE_BODY_SENTINEL_DO_NOT_PERSIST");
  writeFileSync(path.join(cwd, "review.js"), "SOURCE_BODY_SENTINEL_DO_NOT_PERSIST\n");

  await withServer(async (_req, res) => {
    await sleep(100);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-session-lifecycle",
      model: "grok-4.20-fast",
      choices: [{ message: { content: reviewText } }],
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
        CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS: "5",
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lines = parseJsonLines(result);
    assert.ok(lines.length >= 3, result.stdout);
    const [launch] = lines;
    const progress = lines.find((line) => line.event === "external_review_progress");
    const record = lines.at(-1);
    assert.deepEqual(launch, externalReviewLaunchedEvent({
      job_id: launch.job_id,
      target: "grok-web",
    }, launch.external_review));
    assert.equal(progress.job_id, launch.job_id);
    assert.equal(progress.target, "grok-web");
    assert.equal(progress.status, "running");
    assert.equal(progress.heartbeat, 1);
    assert.equal(launch.external_review.provider, "Grok Web");
    assert.equal(launch.external_review.source_content_transmission, "may_be_sent");
    assert.equal(record.event, "external_review_terminal");
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.equal(Object.hasOwn(record, "result"), false);
    assert.equal(Object.hasOwn(record, "runtime_diagnostics"), false);
    assert.doesNotMatch(result.stdout, /SOURCE_BODY_SENTINEL_DO_NOT_PERSIST/);
    assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
  });
});

test("custom-review persisted result redacts selected source body sentinel", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const sourceText = "SOURCE_BODY_SENTINEL_DO_NOT_PERSIST\n";
  const reviewText = substantiveReviewFixture("SOURCE_BODY_SENTINEL_DO_NOT_PERSIST");
  writeFileSync(path.join(cwd, "review.js"), sourceText);

  try {
    await withServer(async (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-web-source-redaction",
        model: "grok-4.20-fast",
        choices: [{ message: { content: reviewText } }],
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
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.doesNotMatch(result.stdout, /SOURCE_BODY_SENTINEL_DO_NOT_PERSIST/);
      const record = parseStdout(result);
      assert.match(record.result, /\[redacted_source_excerpt\]/);

      const persisted = JSON.parse(readFileSync(path.join(dataDir, "jobs", record.job_id, "meta.json"), "utf8"));
      assert.doesNotMatch(JSON.stringify(persisted), /SOURCE_BODY_SENTINEL_DO_NOT_PERSIST/);
      assert.match(persisted.result, /\[redacted_source_excerpt\]/);

      const lookup = run(["result", "--job-id", record.job_id], {
        cwd,
        env: {
          GROK_PLUGIN_DATA: dataDir,
          GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
        },
      });
      assert.equal(lookup.status, 0, lookup.stderr || lookup.stdout);
      assert.doesNotMatch(lookup.stdout, /SOURCE_BODY_SENTINEL_DO_NOT_PERSIST/);
      assert.match(parseStdout(lookup).result, /\[redacted_source_excerpt\]/);
    });
  } finally {
    rmTree(cwd);
    rmTree(dataDir);
  }
});

test("custom-review lifecycle markdown emits launch and terminal cards on success", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const reviewText = substantiveReviewFixture("Markdown lifecycle success marker.");
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  await withServer(async (_req, res) => {
    await sleep(100);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-session-markdown-lifecycle",
      model: "grok-4.20-fast",
      choices: [{ message: { content: reviewText } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--lifecycle-events", "markdown",
      "--prompt", "Check this file.",
    ], {
      cwd,
      env: {
        CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS: "5",
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok((result.stdout.match(/^### EXTERNAL REVIEW/gm) ?? []).length >= 3, result.stdout);
    assert.match(result.stdout, /\| Provider \| Grok Web \|/);
    assert.match(result.stdout, /\| Source \| may_be_sent \|/);
    assert.match(result.stdout, /\| Status \| launched \|/);
    assert.match(result.stdout, /\| Retrieve \| result --job job_[0-9a-f-]+ --cwd [^|]+ \|/);
    assert.match(result.stdout, /\| Panel \| review-panel --workspace [^|]+ \|/);
    assert.match(result.stdout, /\| Status \| running \|/);
    assert.match(result.stdout, /\| Source \| sent \|/);
    assert.match(result.stdout, /\| Status \| completed \|/);
    assert.match(result.stdout, /^### REVIEW FINDINGS$/m);
    assert.match(result.stdout, /Markdown lifecycle success marker\./);
    assert.equal(parseCompactJsonLines(result).some((line) => line.event === "external_review_progress"), false);
    assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
    assert.doesNotMatch(result.stdout, /^\{\n/m);
  });
});

test("custom-review escalates Grok file delimiters when selected source collides", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const reviewText = substantiveReviewFixture("Delimiter marker: delimiter collision handled.");
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
      choices: [{ message: { content: reviewText } }],
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
    assert.equal(record.result, reviewText);
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

test("run renders lifecycle markdown cards before source transmission", () => {
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
      "--lifecycle-events", "markdown",
    ], {
      cwd,
      env: {
        GROK_PLUGIN_DATA: dataDir,
        GROK_WEB_BASE_URL: "http://127.0.0.1:9/api",
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /^### EXTERNAL REVIEW/m);
    assert.match(result.stdout, /\| Provider \| Grok Web \|/);
    assert.match(result.stdout, /\| Source \| not_sent \|/);
    assert.match(result.stdout, /\| Status \| failed \|/);
    assert.match(result.stdout, /\| Error \| bad_args \|/);
    assert.match(result.stdout, /\| Message \| [^|]*prompt is required[^|]*--prompt <focus>[^|]* \|/);
    assert.match(result.stdout, /\| Summary \| [^|]+ \|/);
    assert.match(result.stdout, /\| Action \| Correct the grok-web command arguments and retry\. \|/);
    assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
    assert.doesNotMatch(result.stdout, /^\{/);
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
  const fileSpecs = [
    ["third.js", 220],
    ["largest.js", 250],
    ["second.js", 230],
    ["fifth.js", 190],
    ["smaller.js", 100],
    ["smallest.js", 60],
  ].map(([file, kib], index) => {
    const text = `export const value${index} = "${"x".repeat(kib * 1024)}";\n`;
    writeFileSync(path.join(cwd, file), text);
    return { file, bytes: Buffer.byteLength(text, "utf8") };
  });
  const files = fileSpecs.map((item) => item.file);

  const runOversizedScope = () => run([
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
  const result = runOversizedScope();
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "scope_failed");
  assert.match(record.error_message, /scope_total_too_large/);
  assert.match(record.error_message, /\nfiles:\n/);
  const manifest = record.error_message
    .split("\nfiles:\n")[1]
    .trim()
    .split("\n")
    .filter(Boolean);
  const expectedManifest = [...fileSpecs]
    .sort((a, b) => b.bytes - a.bytes || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, 5)
    .map((item) => `${item.bytes} ${item.file}`);
  assert.deepEqual(manifest, expectedManifest);
  assert.equal(manifest.length, 5);
  assert.equal(manifest.some((line) => line.includes("smallest.js")), false);
  assert.equal(parseStdout(runOversizedScope()).error_message.split("\nfiles:\n")[1], `${manifest.join("\n")}\n`);
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
  assert.equal(record.error_code, "prompt_too_large");
  assert.match(record.error_message, /prompt_too_large:/);
  assert.match(record.suggested_action, /narrower scope|split/i);
  assert.match(record.review_metadata.audit_manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
  assert.equal(record.review_metadata.audit_manifest.selected_source.files.length, 1);
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("Check this file"), false);
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("export const value"), false);
  const recovery = record.runtime_diagnostics?.packet_recovery;
  assert.ok(recovery, "Grok prompt cap failures must include packet_recovery");
  assert.equal(recovery.provider, "grok");
  assert.equal(recovery.mode, "custom-review");
  assert.equal(recovery.reason, "prompt_too_large");
  assert.equal(recovery.source_content_transmission, "not_sent");
  assert.equal(recovery.provider_capabilities.rendered_prompt_budget_chars, 100);
  assert.ok(recovery.actions.some((action) => action.type === "diff_packet"));
  assert.deepEqual(record.review_metadata.audit_manifest.packet_recovery, recovery);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.doesNotMatch(result.stdout, /external_review_launched/);
});

test("rendered prompt over Grok CLI budget names CLI cap, not web tunnel cap", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-cli-prompt-budget-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  try {
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
      defaultTransport: false,
      env: {
        GROK_CLI_MAX_PROMPT_CHARS: "100",
      },
    });
    const lines = parseJsonLines(result);
    assert.equal(result.status, 1);
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "prompt_too_large");
    assert.match(record.error_message, /GROK_CLI_MAX_PROMPT_CHARS=100/);
    assert.match(record.suggested_action, /GROK_CLI_MAX_PROMPT_CHARS/);
    assert.doesNotMatch(record.suggested_action, /GROK_WEB_MAX_PROMPT_CHARS|tunnel/i);
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.doesNotMatch(result.stdout, /external_review_launched/);
  } finally {
    rmTree(cwd);
  }
});

test("concurrent same-provider Grok runs block overlapping source-bearing jobs and retain state", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");
  const runCount = 8;
  let received = 0;

  await withServer(async (req, res) => {
    await readJsonRequest(req);
    received += 1;
    await new Promise((resolve) => setTimeout(resolve, 750));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `grok-web-concurrent-${received}`,
      choices: [{ message: { content: substantiveReviewFixture(`Concurrent marker: ${received}.`) } }],
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
      assert.equal(result.status, record.status === "completed" ? 0 : 1);
      return record;
    });
    const completed = records.filter((record) => record.status === "completed");
    const blocked = records.filter((record) => record.error_code === "provider_workload_blocked");
    assert.equal(completed.length, 1);
    assert.equal(blocked.length, runCount - 1);
    assert.equal(received, 1);
    for (const record of blocked) {
      assert.equal(record.external_review.source_content_transmission, "not_sent");
      assert.equal(record.runtime_diagnostics?.provider_workload?.reason, "active_same_provider_job");
    }

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
      choices: [{ message: { content: substantiveReviewFixture("State marker: stale lock recovered.") } }],
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
      choices: [{ message: { content: substantiveReviewFixture("State marker: stale missing-owner lock recovered.") } }],
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
      choices: [{ message: { content: substantiveReviewFixture("State marker: stale different-host lock recovered.") } }],
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
  const reviewText = substantiveReviewFixture("State marker: malformed state repaired.");
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");
  writeFileSync(path.join(dataDir, "state.json"), "{bad json");

  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/chat/completions");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-session-corrupt-state",
      model: "grok-4.20-fast",
      choices: [{ message: { content: reviewText } }],
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
    assert.equal(persisted.result, reviewText);

    const resultLookup = run(["result", "--job-id", record.job_id], {
      cwd,
      env: { GROK_PLUGIN_DATA: dataDir },
    });
    const lookedUp = parseStdout(resultLookup);
    assert.equal(resultLookup.status, 0);
    assert.equal(lookedUp.job_id, record.job_id);
    assert.equal(lookedUp.result, reviewText);
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
      choices: [{ message: { content: substantiveReviewFixture("State marker: healthy state.") } }],
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
      choices: [{ message: { content: substantiveReviewFixture("State marker: live lock preserved.") } }],
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

test("result and list normalize default data root to git workspace from subdirectories", () => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-cli-subdir-workspace-")));
  const nested = path.join(repo, "nested");
  const authHome = mkdtempSync(path.join(tmpdir(), "grok-cli-subdir-auth-home-"));
  const { binDir, grokPath } = makeFakeGrokCli();
  mkdirSync(nested);
  initGitRepo(repo);
  writeGrokCliAuthFixture(repo, authHome);
  const repoDataRoot = defaultDataRootFor("grok", repo);
  const nestedDataRoot = defaultDataRootFor("grok", nested);

  try {
    const review = run([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Review selected source.",
    ], {
      cwd: nested,
      defaultTransport: false,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_CLI_BINARY: grokPath,
        GROK_CLI_AUTH_HOME: authHome,
      },
    });
    assert.equal(review.status, 0, review.stderr || review.stdout);
    const record = parseStdout(review);

    const result = run(["result", "--job-id", record.job_id, "--cwd", nested], { cwd: nested });
    assert.equal(result.status, 0, result.stdout);
    assert.equal(parseStdout(result).job_id, record.job_id);

    const listResult = run(["list"], { cwd: nested });
    assert.equal(listResult.status, 0, listResult.stdout);
    const listed = parseStdout(listResult);
    assert.equal(listed.ok, true);
    assert.equal(listed.jobs[0].job_id, record.job_id);
  } finally {
    rmTree(repoDataRoot);
    rmTree(nestedDataRoot);
    rmTree(authHome);
    rmTree(repo);
  }
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

test("result not_found includes retrieval guidance", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const jobId = "job_12345678-1234-4234-9234-123456789abc";

  const result = run(["result", "--job-id", jobId], {
    cwd,
    env: { GROK_PLUGIN_DATA: dataDir },
  });
  const parsed = parseStdout(result);
  assert.equal(result.status, 1);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "not_found");
  assert.equal(parsed.job_id, jobId);
  assert.match(parsed.suggested_action, /--cwd <workspace used when the job was launched>/);
});

test("result --cwd resolves workspace-scoped Grok data root", () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-workspace-")));
  const callerCwd = realpathSync(mkdtempSync(path.join(tmpdir(), "grok-web-caller-")));
  const jobId = "job_12345678-1234-4234-9234-123456789abc";
  const slug = path.basename(cwd).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const jobDir = path.join(tmpdir(), "relay", "grok", `${slug}-${hash}`, "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(path.join(jobDir, "meta.json"), JSON.stringify({
    job_id: jobId,
    status: "completed",
    result: "Verdict: APPROVE\nBlocking findings\n- None.",
  }, null, 2));

  const result = run(["result", "--job-id", jobId, "--cwd", cwd], {
    cwd: callerCwd,
  });
  const parsed = parseStdout(result);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parsed.job_id, jobId);
  assert.equal(parsed.status, "completed");
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
  const reviewText = substantiveReviewFixture("Branch diff marker: branch diff reviewed.");

  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/chat/completions");
    const body = await readJsonRequest(req);
    assert.match(body.messages[0].content, /review\.js/);
    assert.doesNotMatch(body.messages[0].content, /extra\.js/);
    assert.doesNotMatch(body.messages[0].content, /export const extra/);
    assert.match(body.messages[0].content, new RegExp(`Base commit: ${mainCommit}`));
    assert.doesNotMatch(body.messages[0].content, new RegExp(`Base commit: ${tagObject}`));
    assert.match(body.messages[0].content, /diff --git a\/review\.js b\/review\.js/);
    assert.match(body.messages[0].content, /export const value = 2/);
    assert.doesNotMatch(body.messages[0].content, /GROK_DIRTY_SELECTED_SECRET/);
    assert.doesNotMatch(body.messages[0].content, /local-config\.txt/);
    assert.doesNotMatch(body.messages[0].content, /GROK_LOCAL_DIRTY_SECRET/);
    assert.doesNotMatch(body.messages[0].content, /untracked-secret\.js/);
    assert.doesNotMatch(body.messages[0].content, /GROK_UNTRACKED_SECRET/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-branch-session",
      choices: [{ message: { content: reviewText } }],
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
    assert.equal(record.result, reviewText);
    assert.equal(existsSync(hostileGitMarker), false);
  });
});

test("branch-diff treats **/ as a path segment glob", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-branch-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-web-data-"));
  const reviewText = substantiveReviewFixture("Glob marker: glob reviewed.");
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
      choices: [{ message: { content: reviewText } }],
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
    assert.equal(record.result, reviewText);
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

test("audit manifest timeout falls back to configured Grok timeout", async () => {
  const { buildReviewMetadata } = await import(`file://${COMPANION}`);
  const metadata = buildReviewMetadata({
    display_name: "Grok Web",
    model: "grok-test",
    timeout_ms: 777777,
  }, {
    scope: "custom",
    scope_base: "HEAD~1",
    scope_paths: ["review.js"],
    files: [{ path: "review.js", text: "export const value = 1;\n" }],
    repository: "owner/repo",
    head_ref: "feature/audit-timeout",
    base_commit: "base-sha",
    head_commit: "head-sha",
  }, {
    prompt: "Review this selected source.",
    parsed: { ok: true, result: "Verdict: no findings." },
    exitCode: 0,
    session_id: "grok-test-session",
  });

  assert.equal(metadata.audit_manifest.request.timeout_ms, 777777);
  assert.equal(metadata.audit_manifest.request.model, "grok-test");
  assert.equal(metadata.audit_manifest.provider_ids.session_id, "grok-test-session");
  assert.equal(JSON.stringify(metadata.audit_manifest).includes("Review this selected source."), false);
  assert.equal(JSON.stringify(metadata.audit_manifest).includes("export const value = 1"), false);
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
      assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 900000);
      assert.match(record.error_summary, /configured_timeout_ms=900000/);
      if (code === "usage_limited") {
        assert.equal(record.error_cause, "cost_quota_usage_limit");
        assert.equal(record.runtime_diagnostics.cost_quota.classification, "usage_limited");
        assert.equal(record.runtime_diagnostics.cost_quota.http_status, status);
        assert.equal(record.runtime_diagnostics.cost_quota.provider_error_code, null);
        assert.equal(record.runtime_diagnostics.cost_quota.provider_error_type, null);
        assert.equal(record.runtime_diagnostics.tunnel_request.configured_timeout_ms, 900000);
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
    assert.equal(record.review_metadata.audit_manifest.request.timeout_ms, 900000);
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
      GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "500",
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "tunnel_unavailable");
  assert.equal(record.review_metadata.audit_manifest, null);
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.match(record.suggested_action, /non-grok2api tunnel|GROK2API_HOME|local Grok web tunnel/i);
  assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
});

test("local tunnel connection failure lifecycle jsonl suppresses launch before tunnel readiness", () => {
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
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "tunnel_unavailable");
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.doesNotMatch(result.stdout, /external_review_launched/);
  assert.doesNotMatch(result.stdout, /secret-cookie-like-token/);
});

test("custom-review fails closed when Grok chat readiness has no runtime tokens", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 42;\n");

  const requests = [];
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/chat/completions") {
      const body = await readJsonRequest(req);
      requests.push({
        method: req.method,
        url: req.url,
        preflight: req.headers["x-relay-grok-readiness-preflight"] === "1",
        prompt: body.messages?.[0]?.content ?? "",
      });
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { message: "No active runtime tokens." } }));
      return;
    }
    if (req.url === "/admin/api/tokens") {
      requests.push({ method: req.method, url: req.url, preflight: false, prompt: null });
      assert.equal(req.method, "GET");
      res.end(JSON.stringify({ tokens: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "unexpected endpoint" } }));
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
    const lines = parseJsonLines(result);
    assert.equal(result.status, 1);
    assert.equal(lines.length, 1);
    const [record] = lines;
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "grok_session_no_runtime_tokens");
    assert.equal(record.external_review.source_content_transmission, "not_sent");
    assert.equal(record.review_metadata.audit_manifest, null);
    assert.match(record.suggested_action, /no active runtime session tokens/i);
    assert.doesNotMatch(result.stdout, /external_review_launched|secret-cookie-like-token/);
    assert.doesNotMatch(JSON.stringify(record), /BEGIN GROK FILE|export const value/);
  }, { autoPreflight: false });
  assert.deepEqual(requests.map((request) => [request.method, request.url, request.preflight]), [
    ["POST", "/api/chat/completions", true],
    ["GET", "/admin/api/tokens", false],
  ]);
  assert.equal(requests[0].prompt, "Return exactly: ok");
  assert.doesNotMatch(requests[0].prompt, /review\.js|BEGIN GROK FILE|export const value/);
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

test("custom-review rejects over-budget source packets before Grok transport launch", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-web-workspace-"));
  const files = [];
  for (let index = 0; index < 3; index += 1) {
    const file = `packet-${index}.js`;
    files.push(file);
    writeFileSync(path.join(cwd, file), `export const value${index} = "${"x".repeat(180 * 1024)}";\n`);
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
      GROK_WEB_MAX_PROMPT_CHARS: "2000000",
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "source_packet_too_large");
  assert.match(record.error_message, /source_packet_too_large:/);
  assert.equal(record.error_cause, "pre_send_source_packet_budget");
  assert.equal(record.external_review.source_content_transmission, "not_sent");
  assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_send_allowed, false);
  assert.equal(record.review_metadata.audit_manifest.source_packet_policy.source_packet_action, "narrow_source_packet");
  const recovery = record.runtime_diagnostics?.packet_recovery;
  assert.ok(recovery, "source packet budget failures must include packet_recovery diagnostics");
  assert.equal(recovery.provider, "grok");
  assert.equal(recovery.mode, "custom-review");
  assert.equal(recovery.reason, "source_packet_too_large");
  assert.equal(recovery.source_content_transmission, "not_sent");
  assert.equal(record.error_code, recovery.reason);
  assert.equal(recovery.provider_capabilities.provider, "grok");
  assert.equal(recovery.provider_capabilities.route_step, "subscription");
  assert.equal(recovery.provider_capabilities.source_packet_budget_bytes, 512 * 1024);
  assert.deepEqual(
    recovery.actions.map((action) => action.type),
    ["diff_packet", "allow_large_source_packet", "switch_provider", "waive_slot"],
  );
  assert.deepEqual(record.review_metadata.audit_manifest.packet_recovery, recovery);
  assert.doesNotMatch(result.stdout, /external_review_launched/);
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
      RELAY_GIT_BINARY: maliciousGit,
    },
  });
  const record = parseStdout(result);

  assert.equal(result.status, 1);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "git_binary_rejected");
  assert.equal(record.error_cause, "git_binary_policy");
  assert.match(record.error_message, /RELAY_GIT_BINARY/);
  assert.match(record.suggested_action, /RELAY_GIT_BINARY|trusted Git/i);
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
  const reviewText = substantiveReviewFixture("Symlink marker: symlinked cwd accepted.");
  writeFileSync(path.join(realWorkspace, "review.js"), "export const value = 42;\n");
  symlinkSync(realWorkspace, linkedWorkspace);

  await withServer(async (req, res) => {
    const body = await readJsonRequest(req);
    assert.match(body.messages[0].content, /BEGIN GROK FILE 1: review\.js/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "grok-web-session-linked-workspace",
      choices: [{ message: { content: reviewText } }],
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
    assert.equal(record.result, reviewText);
  });
});

test("help exposes only subscription-backed Grok commands", () => {
  const parsed = JSON.parse(execFileSync(process.execPath, [COMPANION, "help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.commands, ["doctor", "ping", "repair", "run", "result", "list"]);
  assert.equal(parsed.provider, "grok");
  assert.equal(parsed.default_auth_mode, "subscription_cli");
  assert.equal(parsed.default_transport, "cli");
  assert.equal(parsed.legacy_transport, "web");
  assert.doesNotMatch(JSON.stringify(parsed), /api\.x\.ai/i);

  const legacyParsed = JSON.parse(execFileSync(process.execPath, [COMPANION, "help", "--transport", "web"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }));
  assert.equal(legacyParsed.provider, "grok-web");
  assert.equal(legacyParsed.default_auth_mode, "subscription_web");
  assert.equal(legacyParsed.selected_transport, "web");

  const autoParsed = JSON.parse(execFileSync(process.execPath, [COMPANION, "help", "--transport", "auto"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }));
  assert.equal(autoParsed.provider, "grok");
  assert.equal(autoParsed.default_auth_mode, "subscription_cli");
  assert.equal(autoParsed.selected_transport, "auto");
  assert.equal(autoParsed.default_transport, "cli");
  assert.doesNotMatch(JSON.stringify(autoParsed), /api\.x\.ai/i);
});

test("generic Grok companion entrypoint defaults to CLI transport", () => {
  const parsed = JSON.parse(execFileSync(process.execPath, [COMPANION, "help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.provider, "grok");
  assert.equal(parsed.default_auth_mode, "subscription_cli");
  assert.equal(parsed.default_transport, "cli");
  assert.equal(parsed.legacy_transport, "web");
});

// AC7-AC8 (#106): smoke replay against recorded grok fixtures.
//
// happy-path-review.response.json: recorded under a clean local tunnel
// success — chat endpoint returns a completed review response.
// tunnel-error.response.json: recorded against an unreachable tunnel
// (http_status null, error_code tunnel_unavailable). Replay reproduces the
// same JobRecord shape: status, error_code, http_status, transmission.

const GROK_REPLAY_FIXTURES_ROOT = path.join(REPO_ROOT, "tests", "smoke", "fixtures", "grok");

function readGrokReplayFixture(scenario) {
  const fixturePath = path.join(GROK_REPLAY_FIXTURES_ROOT, `${scenario}.response.json`);
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

test("smoke replay: grok/happy-path-review reproduces recorded JobRecord shape (success)", async () => {
  const fixture = readGrokReplayFixture("happy-path-review");
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-replay-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-replay-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const grok_replay_marker = 1;\n");

  // Capture the request the wrapper sends to the chat endpoint so we can
  // assert that the outgoing payload matches what the recorded fixture
  // implies (model, auth shape, content delivery).
  const chatCaptured = { method: null, authorization: null, body: null };
  await withServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/models") {
      res.end(JSON.stringify({ data: [{ id: "grok-4.20-fast" }] }));
      return;
    }
    if (req.url === "/api/chat/completions") {
      chatCaptured.method = req.method;
      chatCaptured.authorization = req.headers.authorization ?? null;
      chatCaptured.body = await readJsonRequest(req);
      res.end(JSON.stringify({
        choices: [{ message: { content: substantiveReviewFixture("Replay marker: fixture happy path.") } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }, async (baseUrl) => {
    const result = await runAsync([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "review.js",
      "--foreground",
      "--prompt", "Replayed against recorded fixture.",
    ], {
      cwd,
      env: {
        GROK_WEB_BASE_URL: baseUrl,
        GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
        GROK_PLUGIN_DATA: dataDir,
      },
    });
    assert.equal(result.status, fixture.exit_code, result.stderr || result.stdout);
    const replayed = parseStdout(result);
    // Two-axis shape check: subset (every expected key present) plus an
    // internal-state guard (no extra key matches a suspicious internal
    // pattern). See tests/helpers/job-record-shape.mjs.
    assertJobRecordShape(replayed, [...GROK_EXPECTED_KEYS], {
      label: "grok-web replay",
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
    // Request-side: the wrapper actually POSTed to the chat endpoint with
    // Bearer auth, the configured model, and the seed content delivered
    // inside the message body. transmission=sent without delivery is a bug.
    assert.equal(chatCaptured.method, "POST", "wrapper must POST to chat endpoint");
    assert.equal(
      chatCaptured.authorization,
      "Bearer secret-cookie-like-token",
      "wrapper must present Bearer auth with the configured tunnel key",
    );
    assert.ok(chatCaptured.body, "request body must be parsed");
    assert.equal(chatCaptured.body.model, "grok-4.20-fast", "request body must carry the configured model");
    assert.equal(chatCaptured.body.stream, false, "tunnel chat must remain non-streaming");
    assert.ok(Array.isArray(chatCaptured.body.messages) && chatCaptured.body.messages.length >= 1,
      "request body must include at least one message");
    assert.match(
      chatCaptured.body.messages[0].content,
      /grok_replay_marker/,
      "transmission=sent paths must put the selected source content into the request body",
    );
  });
});

test("smoke replay: grok/tunnel-error reproduces recorded JobRecord shape (tunnel unreachable)", async () => {
  const fixture = readGrokReplayFixture("tunnel-error");
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-replay-workspace-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-replay-data-"));
  writeFileSync(path.join(cwd, "review.js"), "export const value = 1;\n");

  // Point at port 1 — fetch will fail with ECONNREFUSED, mirroring the
  // recorded "fetch failed" cause.
  const result = await runAsync([
    "run",
    "--mode", "custom-review",
    "--scope", "custom",
    "--scope-paths", "review.js",
    "--foreground",
    "--prompt", "Replayed against recorded fixture.",
  ], {
    cwd,
    env: {
      GROK_WEB_BASE_URL: "http://127.0.0.1:1/v1",
      GROK_PLUGIN_DATA: dataDir,
    },
  });
  assert.equal(result.status, fixture.exit_code, result.stderr || result.stdout);
  const replayed = parseStdout(result);
  assert.deepEqual(Object.keys(replayed), [...GROK_EXPECTED_KEYS]);
  assert.equal(replayed.schema_version, fixture.schema_version);
  assert.equal(replayed.status, fixture.status);
  assert.equal(replayed.error_code, fixture.error_code);
  assert.equal(replayed.http_status, fixture.http_status);
  assert.equal(replayed.target, fixture.target);
  assert.equal(replayed.provider, fixture.provider);
  assert.equal(replayed.review_metadata.prompt_provider, fixture.review_metadata.prompt_provider);
  assert.equal(
    replayed.external_review.source_content_transmission,
    fixture.external_review.source_content_transmission,
    "transmission must match recorded fixture (security-critical invariant)",
  );
});
