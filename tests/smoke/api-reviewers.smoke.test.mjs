import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { externalReviewLaunchedEvent } from "../../scripts/lib/companion-common.mjs";
import { assertJobRecordShape } from "../helpers/job-record-shape.mjs";
import { substantiveReviewFixture } from "../helpers/review-fixtures.mjs";

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
    execFile(process.execPath, [companion, ...finalArgs], {
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

function parseJsonLines(stdout) {
  return stdout.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
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
  const tempScriptsDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-module-"));
  const source = readFileSync(COMPANION, "utf8");
  const footer = `try {
  await main();
} catch (e) {
  printJson({ ok: false, error: e.message });
  process.exit(1);
}
`;
  assert.match(source, /async function readUtf8ScopeFileWithinLimit/);
  assert.match(source, /try \{\n  await main\(\);/);
  const testSource = source.replace(footer, "export { buildRecord, readUtf8ScopeFileWithinLimit, sameFileIdentity };\n");
  assert.notEqual(testSource, source);
  cpSync(path.join(REPO_ROOT, "plugins/api-reviewers/scripts/lib"), path.join(tempScriptsDir, "lib"), { recursive: true });
  const modulePath = path.join(tempScriptsDir, "api-reviewer.mjs");
  writeFileSync(modulePath, testSource);
  try {
    return await import(pathToFileURL(modulePath).href);
  } finally {
    rmSync(tempScriptsDir, { recursive: true, force: true });
  }
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

function writeSingleProviderConfig(pluginRoot, provider, cfg) {
  writeFileSync(path.join(pluginRoot, "config", "providers.json"), JSON.stringify({
    [provider]: cfg,
  }, null, 2));
}

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

test("doctor reports GLM compatibility alias without leaking value", async () => {
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
      env_keys: ["ZAI_API_KEY", "ZAI_GLM_API_KEY"],
      base_url: `http://127.0.0.1:${port}`,
      model: "glm-5.1",
    });
    const result = await run(["doctor", "--provider", "glm"], {
      companion: path.join(pluginRoot, "scripts", "api-reviewer.mjs"),
      env: { ZAI_API_KEY: "", ZAI_GLM_API_KEY: "secret-test-value" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJson(result.stdout);
    assert.equal(parsed.provider, "glm");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.credential_ref, "ZAI_GLM_API_KEY");
    assert.equal(parsed.endpoint, `http://127.0.0.1:${port}`);
    assert.equal(parsed.provider_probe.status, "ok");
    assert.equal(parsed.provider_probe.source_content_transmission, "not_sent");
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
  assert.deepEqual(parsed.commands, ["doctor", "ping", "approval-request", "run"]);
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

test("direct API reviewer concurrent runs retain every completed job in state", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const runCount = 8;

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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      API_REVIEWERS_STATE_LOCK_TIMEOUT_MS: "5000",
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
      CODEX_PLUGIN_MULTI_GIT_BINARY: maliciousGit,
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "git_binary_rejected");
  assert.equal(record.error_cause, "git_binary_policy");
  assert.match(record.error_message, /CODEX_PLUGIN_MULTI_GIT_BINARY/);
  assert.match(record.suggested_action, /CODEX_PLUGIN_MULTI_GIT_BINARY|trusted Git/i);
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
      CODEX_PLUGIN_MULTI_GIT_BINARY: maliciousGit,
    },
  });

  assert.equal(result.status, 1);
  const record = parseJson(result.stdout);
  assert.equal(record.ok, false);
  assert.equal(record.provider, "deepseek");
  assert.equal(record.error_code, "git_binary_rejected");
  assert.match(record.error_message, /CODEX_PLUGIN_MULTI_GIT_BINARY/);
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
    env: { ZAI_API_KEY: "secret-test-value", ZAI_GLM_API_KEY: "" },
    envKeys: ["ZAI_API_KEY", "ZAI_GLM_API_KEY"],
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
  assert.notEqual(
    record.review_metadata.audit_manifest.prompt_builder.plugin_commit,
    record.review_metadata.audit_manifest.git_identity.head_sha,
    "plugin_commit must identify the plugin source, not the reviewed repository head"
  );
  assert.equal(record.review_metadata.audit_manifest.provider_ids.session_id, "chatcmpl-test");
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("Check this file"), false);
  assert.equal(JSON.stringify(record.review_metadata.audit_manifest).includes("hello from selected scope"), false);
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
        API_REVIEWERS_TIMEOUT_MS: "20",
        DEEPSEEK_API_KEY: "secret-test-value",
      },
    });
    assert.equal(result.status, 1);
    assert.notEqual(result.stdout, "", result.stderr);
    const record = parseJson(result.stdout);
    assert.equal(record.error_code, "timeout");
    assert.match(record.error_summary, /timeout after \d+ms/i);
    assert.match(record.error_summary, /configured_timeout_ms=20/);
    assert.match(record.error_summary, /selected_files=1/);
    assert.match(record.error_summary, /selected_bytes=\d+/);
    assert.match(record.error_summary, /prompt_chars=\d+/);
    assert.match(record.error_summary, /estimated_tokens=\d+/);
    const promptChars = Number(/prompt_chars=(\d+)/.exec(record.error_summary)?.[1]);
    const estimatedTokens = Number(/estimated_tokens=(\d+)/.exec(record.error_summary)?.[1]);
    assert.equal(estimatedTokens, Math.ceil(promptChars / 4));
    assert.match(record.error_message, /This operation was aborted|aborted/i);
    assert.match(record.suggested_action, /timeout/i);
    assert.match(record.suggested_action, /API_REVIEWERS_TIMEOUT_MS/);
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
    assert.doesNotMatch(result.stdout, /secret-test-value/);
  } finally {
    server.close();
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
  const server = await startChatServer((req, res) => {
    req.resume();
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
  const server = await startChatServer((req, res) => {
    req.resume();
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
  const server = await startChatServer((req, res) => {
    req.resume();
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
  const server = await startChatServer((req, res) => {
    req.resume();
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
  const server = await startChatServer((req, res) => {
    req.resume();
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
    assert.doesNotMatch(record.suggested_action, /network_access = true/);
    assert.doesNotMatch(record.suggested_action, /outside sandbox/);
  } finally {
    server.close();
  }
});

test("direct API HTTP provider_unavailable with transport-looking wording still does not recommend sandbox access", async () => {
  const cwd = makeWorkspace();
  const dataDir = mkdtempSync(path.join(tmpdir(), "api-reviewers-data-"));
  const pluginRoot = makeInstalledApiReviewersRoot();
  const server = await startChatServer((req, res) => {
    req.resume();
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
      API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES: "committed feature change",
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

test("direct API reviewers lifecycle jsonl emits launch before terminal record", async () => {
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
      API_REVIEWERS_MOCK_RESPONSE: mockResponse("deepseek-v4-pro"),
      DEEPSEEK_API_KEY: "secret-test-value",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.length, 2);
  const [launch, record] = lines;
  assert.deepEqual(launch, externalReviewLaunchedEvent({
    job_id: launch.job_id,
    target: "deepseek",
  }, launch.external_review));
  assert.equal(launch.external_review.provider, "DeepSeek");
  assert.equal(launch.external_review.source_content_transmission, "may_be_sent");
  assert.equal(record.status, "completed");
  assert.equal(record.external_review.source_content_transmission, "sent");
  assert.doesNotMatch(result.stdout, /secret-test-value/);
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
  assert.equal(record.error_code, "scope_failed");
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
        GLM_API_KEY: "secret-test-value",
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
      "request",
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
    assert.equal(approval.rendered_prompt_hash.value, auditManifest.rendered_prompt_hash.value);
    assert.equal(approval.request.timeout_ms, 234567);
    assert.equal(approval.request.max_tokens, 7777);
    assert.equal(approval.request.max_steps_per_turn, null);
    assert.equal(approval.request.temperature, 0);
    assert.equal(approval.request.stream, false);
    assert.equal(JSON.stringify(approval).includes(sourceText.trim()), false);
    assert.equal(JSON.stringify(approval).includes("secret-test-value"), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(path.dirname(path.dirname(pluginRoot)), { recursive: true, force: true });
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
    assert.equal(record.status, "failed");
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
  assert.equal(parsed.status, "scope_failed");
  assert.equal(parsed.error_code, "scope_failed");
  assert.match(parsed.error_message, /prompt_too_large:/);
  assert.doesNotMatch(result.stdout, /external_review_approval_request/);
  assert.doesNotMatch(result.stdout, /hello from selected scope/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
});

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
    env: { GLM_API_KEY: "secret-test-value" },
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
    env: { GLM_API_KEY: "secret-test-value" },
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
      env: { GLM_API_KEY: "secret-test-value" },
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
      captured.url = req.url;
      captured.method = req.method;
      captured.authorization = req.headers.authorization ?? null;
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) raw += chunk;
      try { captured.body = JSON.parse(raw); } catch { captured.body = raw; }
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
