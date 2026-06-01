import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { substantiveReviewFixture } from "../helpers/review-fixtures.mjs";
import { buildJobRecord as buildClaudeJobRecord } from "../../plugins/claude/scripts/lib/job-record.mjs";
import { buildJobRecord as buildGeminiJobRecord } from "../../plugins/gemini/scripts/lib/job-record.mjs";
import { buildJobRecord as buildKimiJobRecord } from "../../plugins/kimi/scripts/lib/job-record.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_REVIEWER = path.join(REPO_ROOT, "plugins/api-reviewers/scripts/api-reviewer.mjs");
const GROK_REVIEWER = path.join(REPO_ROOT, "plugins/grok/scripts/grok-companion.mjs");
const SENTINEL = "SOURCE_BODY_SENTINEL_DO_NOT_PERSIST";
const SOURCE_TEXT = `${SENTINEL}\n`;
const QUOTED_SOURCE_TEXT = `${"a".repeat(120)}${SENTINEL}${"b".repeat(220)}\n`;
const OVER_LIMIT_QUOTE = QUOTED_SOURCE_TEXT.slice(80, 330);
const PROMPT_SECRET = "secret-test-value";
const PROMPT_HEAD = `Check ${SOURCE_TEXT} and ${PROMPT_SECRET}`;

function makeInvocation(overrides = {}) {
  return {
    job_id: "550e8400-e29b-41d4-a716-446655440000",
    target: "claude",
    parent_job_id: null,
    resume_chain: [],
    mode_profile_name: "review",
    mode: "review",
    model: "claude-opus-4-7",
    cwd: "/tmp/src",
    workspace_root: "/tmp/src",
    containment: "worktree",
    scope: "custom",
    run_kind: "foreground",
    dispose_effective: true,
    scope_base: null,
    scope_paths: ["seed.txt"],
    prompt_head: "privacy matrix",
    review_prompt_contract_version: 1,
    review_prompt_provider: "Claude Code",
    schema_spec: null,
    binary: "claude",
    started_at: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

function makePidInfo(argv0 = "reviewer") {
  return { pid: 12345, starttime: "Thu May 21 00:00:00 2026", argv0 };
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function mockResponse(model, content) {
  return JSON.stringify({
    id: `chatcmpl-${createHash("sha256").update(model).digest("hex").slice(0, 8)}`,
    object: "chat.completion",
    model,
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  });
}

function makeWorkspace(prefix, fileName = "seed.txt") {
  const cwd = mkdtempSync(path.join(tmpdir(), prefix));
  writeFileSync(path.join(cwd, fileName), SOURCE_TEXT, "utf8");
  return cwd;
}

function apiReviewerMetaPath(dataDir, jobId) {
  const candidate = path.join(dataDir, "jobs", jobId, "meta.json");
  assert.equal(existsSync(candidate), true, `missing ${candidate}`);
  return candidate;
}

function runNode(script, args, { cwd, env }) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function runNodeAsync(script, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function withServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        resolve(await handler.callback(`http://127.0.0.1:${port}`));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test("provider privacy matrix redacts selected source body sentinel across provider families", async () => {
  const companionSecretName = "RELAY_TEST_API_KEY";
  const oldCompanionSecret = process.env[companionSecretName];
  process.env[companionSecretName] = PROMPT_SECRET;
  const companionProviders = [
    {
      name: "claude",
      build: buildClaudeJobRecord,
      invocation: makeInvocation({ prompt_head: PROMPT_HEAD }),
      pid: makePidInfo("claude"),
    },
    {
      name: "gemini",
      build: buildGeminiJobRecord,
      invocation: makeInvocation({
        target: "gemini",
        binary: "gemini",
        model: "gemini-3.1-pro-preview",
        review_prompt_provider: "Gemini CLI",
        prompt_head: PROMPT_HEAD,
      }),
      pid: makePidInfo("gemini"),
    },
    {
      name: "kimi",
      build: buildKimiJobRecord,
      invocation: makeInvocation({
        target: "kimi",
        binary: "kimi",
        model: "kimi-code/kimi-for-coding",
        review_prompt_provider: "Kimi Code",
        prompt_head: PROMPT_HEAD,
      }),
      pid: makePidInfo("kimi"),
    },
  ];

  try {
    for (const provider of companionProviders) {
      const record = provider.build(provider.invocation, {
        exitCode: 0,
        parsed: {
          ok: true,
          result: substantiveReviewFixture(SENTINEL),
          structured: null,
          denials: [],
        },
        pidInfo: provider.pid,
        sourceFilesForRedaction: [{ path: "seed.txt", content: SOURCE_TEXT }],
        stdout: "",
        stderr: "",
      }, []);

      assert.doesNotMatch(JSON.stringify(record), new RegExp(SENTINEL), provider.name);
      assert.match(record.result, /\[redacted_source_excerpt\]/, provider.name);
      assert.match(record.prompt_head, /\[redacted_source_excerpt\]/, provider.name);
      assert.match(record.prompt_head, /\[REDACTED\]/, provider.name);
    }
  } finally {
    if (oldCompanionSecret == null) delete process.env[companionSecretName];
    else process.env[companionSecretName] = oldCompanionSecret;
  }

  for (const provider of [
    { name: "deepseek", model: "deepseek-v4-pro", env: { DEEPSEEK_API_KEY: PROMPT_SECRET } },
    { name: "glm", model: "glm-5.1", env: { ZAI_API_KEY: PROMPT_SECRET } },
  ]) {
    const cwd = makeWorkspace("privacy-api-");
    const dataDir = mkdtempSync(path.join(tmpdir(), "privacy-api-data-"));
    try {
      const result = runNode(API_REVIEWER, [
        "run",
        "--provider", provider.name,
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--foreground",
        "--prompt", PROMPT_HEAD,
      ], {
        cwd,
        env: {
          ...provider.env,
          API_REVIEWERS_DISABLE_ENV_CACHE: "1",
          API_REVIEWERS_PLUGIN_DATA: dataDir,
          API_REVIEWERS_MOCK_RESPONSE: mockResponse(provider.model, substantiveReviewFixture(SENTINEL)),
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.doesNotMatch(result.stdout, new RegExp(SENTINEL), provider.name);
      const record = parseJson(result.stdout);
      const persisted = JSON.parse(readFileSync(apiReviewerMetaPath(dataDir, record.job_id), "utf8"));
      assert.doesNotMatch(JSON.stringify(persisted), new RegExp(SENTINEL), provider.name);
      assert.match(record.result, /\[redacted_source_excerpt\]/, provider.name);
      assert.match(persisted.result, /\[redacted_source_excerpt\]/, provider.name);
      assert.match(record.prompt_head, /\[redacted_source_excerpt\]/, provider.name);
      assert.match(persisted.prompt_head, /\[redacted_source_excerpt\]/, provider.name);
      assert.match(record.prompt_head, /\[REDACTED\]/, provider.name);
      assert.match(persisted.prompt_head, /\[REDACTED\]/, provider.name);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  const grokCwd = makeWorkspace("privacy-grok-", "review.js");
  const grokData = mkdtempSync(path.join(tmpdir(), "privacy-grok-data-"));
  try {
    await withServer(Object.assign((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-privacy-matrix",
        model: "grok-4.20-fast",
        choices: [{ message: { content: substantiveReviewFixture(SENTINEL) } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }));
    }, {
      async callback(baseUrl) {
        const result = await runNodeAsync(GROK_REVIEWER, [
          "run",
          "--mode", "custom-review",
          "--scope", "custom",
          "--scope-paths", "review.js",
          "--foreground",
          "--prompt", PROMPT_HEAD.replace(PROMPT_SECRET, "secret-cookie-like-token"),
        ], {
          cwd: grokCwd,
          env: {
            GROK_TRANSPORT: "web",
            GROK_WEB_BASE_URL: baseUrl,
            GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
            GROK_PLUGIN_DATA: grokData,
          },
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.doesNotMatch(result.stdout, new RegExp(SENTINEL));
        const record = parseJson(result.stdout);
        const persisted = JSON.parse(readFileSync(path.join(grokData, "jobs", record.job_id, "meta.json"), "utf8"));
        assert.doesNotMatch(JSON.stringify(persisted), new RegExp(SENTINEL));
        assert.match(record.result, /\[redacted_source_excerpt\]/);
        assert.match(persisted.result, /\[redacted_source_excerpt\]/);
        assert.match(record.prompt_head, /\[redacted_source_excerpt\]/);
        assert.match(persisted.prompt_head, /\[redacted_source_excerpt\]/);
        assert.match(record.prompt_head, /\[REDACTED\]/);
        assert.match(persisted.prompt_head, /\[REDACTED\]/);
      },
    }));
  } finally {
    rmSync(grokCwd, { recursive: true, force: true });
    rmSync(grokData, { recursive: true, force: true });
  }
});

test("provider privacy matrix redacts over-limit selected source quotes across provider families", async () => {
  assert.equal(OVER_LIMIT_QUOTE.length > 200, true);
  const companionProviders = [
    { name: "claude", build: buildClaudeJobRecord, invocation: makeInvocation(), pid: makePidInfo("claude") },
    {
      name: "gemini",
      build: buildGeminiJobRecord,
      invocation: makeInvocation({
        target: "gemini",
        binary: "gemini",
        model: "gemini-3.1-pro-preview",
        review_prompt_provider: "Gemini CLI",
      }),
      pid: makePidInfo("gemini"),
    },
    {
      name: "kimi",
      build: buildKimiJobRecord,
      invocation: makeInvocation({
        target: "kimi",
        binary: "kimi",
        model: "kimi-code/kimi-for-coding",
        review_prompt_provider: "Kimi Code",
      }),
      pid: makePidInfo("kimi"),
    },
  ];

  for (const provider of companionProviders) {
    const record = provider.build(provider.invocation, {
      exitCode: 0,
      parsed: {
        ok: true,
        result: substantiveReviewFixture(OVER_LIMIT_QUOTE),
        structured: null,
        denials: [],
      },
      pidInfo: provider.pid,
      sourceFilesForRedaction: [{ path: "seed.txt", content: QUOTED_SOURCE_TEXT }],
      stdout: "",
      stderr: "",
    }, []);

    assert.doesNotMatch(JSON.stringify(record), new RegExp(SENTINEL), provider.name);
    assert.match(record.result, /\[redacted_source_excerpt\]/, provider.name);
  }

  for (const provider of [
    { name: "deepseek", model: "deepseek-v4-pro", env: { DEEPSEEK_API_KEY: PROMPT_SECRET } },
    { name: "glm", model: "glm-5.1", env: { ZAI_API_KEY: PROMPT_SECRET } },
  ]) {
    const cwd = mkdtempSync(path.join(tmpdir(), "privacy-api-quote-"));
    const dataDir = mkdtempSync(path.join(tmpdir(), "privacy-api-quote-data-"));
    try {
      writeFileSync(path.join(cwd, "seed.txt"), QUOTED_SOURCE_TEXT, "utf8");
      const result = runNode(API_REVIEWER, [
        "run",
        "--provider", provider.name,
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "seed.txt",
        "--foreground",
        "--prompt", "Check this file.",
      ], {
        cwd,
        env: {
          ...provider.env,
          API_REVIEWERS_DISABLE_ENV_CACHE: "1",
          API_REVIEWERS_PLUGIN_DATA: dataDir,
          API_REVIEWERS_MOCK_RESPONSE: mockResponse(provider.model, substantiveReviewFixture(OVER_LIMIT_QUOTE)),
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.doesNotMatch(result.stdout, new RegExp(SENTINEL), provider.name);
      const record = parseJson(result.stdout);
      const persisted = JSON.parse(readFileSync(apiReviewerMetaPath(dataDir, record.job_id), "utf8"));
      assert.doesNotMatch(JSON.stringify(persisted), new RegExp(SENTINEL), provider.name);
      assert.match(record.result, /\[redacted_source_excerpt\]/, provider.name);
      assert.match(persisted.result, /\[redacted_source_excerpt\]/, provider.name);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  const grokCwd = mkdtempSync(path.join(tmpdir(), "privacy-grok-quote-"));
  const grokData = mkdtempSync(path.join(tmpdir(), "privacy-grok-quote-data-"));
  try {
    writeFileSync(path.join(grokCwd, "review.js"), QUOTED_SOURCE_TEXT, "utf8");
    await withServer(Object.assign((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "grok-privacy-quote-matrix",
        model: "grok-4.20-fast",
        choices: [{ message: { content: substantiveReviewFixture(OVER_LIMIT_QUOTE) } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }));
    }, {
      async callback(baseUrl) {
        const result = await runNodeAsync(GROK_REVIEWER, [
          "run",
          "--mode", "custom-review",
          "--scope", "custom",
          "--scope-paths", "review.js",
          "--foreground",
          "--prompt", "Check this file.",
        ], {
          cwd: grokCwd,
          env: {
            GROK_TRANSPORT: "web",
            GROK_WEB_BASE_URL: baseUrl,
            GROK_WEB_TUNNEL_API_KEY: "secret-cookie-like-token",
            GROK_PLUGIN_DATA: grokData,
          },
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.doesNotMatch(result.stdout, new RegExp(SENTINEL));
        const record = parseJson(result.stdout);
        const persisted = JSON.parse(readFileSync(path.join(grokData, "jobs", record.job_id, "meta.json"), "utf8"));
        assert.doesNotMatch(JSON.stringify(persisted), new RegExp(SENTINEL));
        assert.match(record.result, /\[redacted_source_excerpt\]/);
        assert.match(persisted.result, /\[redacted_source_excerpt\]/);
      },
    }));
  } finally {
    rmSync(grokCwd, { recursive: true, force: true });
    rmSync(grokData, { recursive: true, force: true });
  }
});
