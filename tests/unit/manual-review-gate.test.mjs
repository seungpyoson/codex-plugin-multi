import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import {
  DEFAULT_MANUAL_REVIEW_REQUIREMENTS,
  evidenceItemsFromGithubRecords,
  evaluateManualReviewEvidence,
  githubEventContext,
  statusPayloadForManualReviewResult,
  validateGitSha,
} from "../../scripts/lib/manual-review-gate.mjs";

const HEAD = "01674a30c4b523f29b5084fdb2088f719473428a";
const OLD_HEAD = "14d3fb638b400290e9c8c9bf8718dc7add46c878";

function evidence(author, body) {
  return {
    author,
    body,
    url: `https://example.test/${author}`,
  };
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function runNodeScript(args, options, { timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let timedOut = false;
    const timeout = timeoutMs === null ? null : setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (timeout) clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

test("manual review gate passes only when every required reviewer approves the exact head", () => {
  const result = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Claude
        Verdict: APPROVE
      `),
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Gemini
        Verdict: APPROVE
      `),
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Kimi
        Verdict: APPROVE
      `),
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: DeepSeek
        Verdict: APPROVE
      `),
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: GLM
        Verdict: APPROVE
      `),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual([...result.approvedReviewers].sort(), [...DEFAULT_MANUAL_REVIEW_REQUIREMENTS.requiredReviewers].sort());
  assert.deepEqual(result.missingReviewers, []);
});

test("manual review gate rejects stale-head and request-changes evidence", () => {
  const result = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${OLD_HEAD}
        Reviewer: Claude
        Verdict: APPROVE
      `),
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Gemini
        Verdict: REQUEST CHANGES
      `),
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.approvedReviewers, []);
  assert.deepEqual(result.staleReviewers, ["claude"]);
  assert.deepEqual(result.blockingReviewers, ["gemini"]);
  assert.deepEqual(result.missingReviewers, ["claude", "deepseek", "glm", "kimi"]);
});

test("manual review gate treats PASS and FAIL relay verdicts as exact-head approval and blocking evidence", () => {
  const pass = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Claude
        Verdict: PASS
      `),
    ],
    requirements: { requiredReviewers: ["claude"] },
  });

  assert.equal(pass.ok, true);
  assert.deepEqual(pass.approvedReviewers, ["claude"]);
  assert.deepEqual(pass.missingReviewers, []);

  const fail = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Claude
        Verdict: FAIL
      `),
    ],
    requirements: { requiredReviewers: ["claude"] },
  });

  assert.equal(fail.ok, false);
  assert.deepEqual(fail.blockingReviewers, ["claude"]);
  assert.deepEqual(fail.missingReviewers, []);
});

test("manual review gate treats line-broken REQUEST CHANGES relay verdicts as blocking evidence", () => {
  const result = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Claude
        Verdict: REQUEST
          CHANGES
      `),
    ],
    requirements: { requiredReviewers: ["claude"] },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.blockingReviewers, ["claude"]);
  assert.deepEqual(result.missingReviewers, []);
});

test("manual review gate rejects all-stale required evidence", () => {
  const result = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: DEFAULT_MANUAL_REVIEW_REQUIREMENTS.requiredReviewers.map((reviewer) =>
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${OLD_HEAD}
        Reviewer: ${reviewer}
        Verdict: APPROVE
      `)),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.approvedReviewers, []);
  assert.deepEqual(result.blockingReviewers, []);
  assert.deepEqual(result.staleReviewers, ["claude", "deepseek", "gemini", "glm", "kimi"]);
  assert.deepEqual(result.missingReviewers, ["claude", "deepseek", "gemini", "glm", "kimi"]);
});

test("manual review gate does not report stale evidence once a current-head verdict exists", () => {
  const result = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${OLD_HEAD}
        Reviewer: Claude
        Verdict: APPROVE
      `),
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Claude
        Verdict: APPROVE
      `),
    ],
    requirements: { requiredReviewers: ["claude"] },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.approvedReviewers, ["claude"]);
  assert.deepEqual(result.staleReviewers, []);
  assert.deepEqual(result.missingReviewers, []);
});

test("manual review gate ignores unmarked comments even when they mention approve", () => {
  const result = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `
        Head: ${HEAD}
        Reviewer: Claude
        Verdict: APPROVE
      `),
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.approvedReviewers, []);
  assert.deepEqual(result.missingReviewers, ["claude", "deepseek", "gemini", "glm", "kimi"]);
});

test("manual review gate lets later exact-head evidence replace an earlier reviewer verdict", () => {
  const result = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Claude
        Verdict: REQUEST CHANGES
      `),
      evidence("operator", `
        <!-- codex-plugin-multi:manual-external-adversarial-review -->
        Head: ${HEAD}
        Reviewer: Claude
        Verdict: APPROVE
      `),
    ],
    requirements: { requiredReviewers: ["claude"] },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.approvedReviewers, ["claude"]);
  assert.deepEqual(result.blockingReviewers, []);
  assert.deepEqual(result.missingReviewers, []);
});

test("manual review gate converts GitHub comments and reviews into evidence items", () => {
  const items = evidenceItemsFromGithubRecords({
    comments: [{
      body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Claude\nVerdict: APPROVE`,
      html_url: "https://github.test/comment/1",
      user: { login: "spson" },
    }],
    reviews: [{
      body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Gemini\nVerdict: APPROVE`,
      html_url: "https://github.test/review/1",
      user: { login: "gemini-code-assist" },
      state: "COMMENTED",
    }],
  });

  assert.deepEqual(items, [
    {
      author: "spson",
      body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Claude\nVerdict: APPROVE`,
      createdAt: null,
      source: "issue_comment",
      url: "https://github.test/comment/1",
    },
    {
      author: "gemini-code-assist",
      body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Gemini\nVerdict: APPROVE`,
      createdAt: null,
      source: "pull_request_review",
      url: "https://github.test/review/1",
    },
  ]);
});

test("manual review gate orders mixed GitHub comments and PR reviews chronologically before applying latest evidence", () => {
  const items = evidenceItemsFromGithubRecords({
    comments: [{
      body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Claude\nVerdict: APPROVE`,
      created_at: "2026-05-10T10:00:00Z",
      html_url: "https://github.test/comment/latest",
      user: { login: "spson" },
    }],
    reviews: [{
      body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Claude\nVerdict: REQUEST CHANGES`,
      html_url: "https://github.test/review/earlier",
      submitted_at: "2026-05-10T09:00:00Z",
      user: { login: "claude-relay" },
      state: "CHANGES_REQUESTED",
    }],
  });
  const result = evaluateManualReviewEvidence({
    headSha: HEAD,
    items,
    requirements: { requiredReviewers: ["claude"] },
  });

  assert.deepEqual(items.map((item) => item.url), [
    "https://github.test/review/earlier",
    "https://github.test/comment/latest",
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.approvedReviewers, ["claude"]);
  assert.deepEqual(result.blockingReviewers, []);
});

test("manual review gate ignores dismissed GitHub PR review evidence", () => {
  const items = evidenceItemsFromGithubRecords({
    reviews: [
      {
        body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Claude\nVerdict: APPROVE`,
        html_url: "https://github.test/review/dismissed",
        user: { login: "claude-relay" },
        state: "DISMISSED",
      },
      {
        body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Gemini\nVerdict: APPROVE`,
        html_url: "https://github.test/review/current",
        user: { login: "gemini-relay" },
        state: "COMMENTED",
      },
    ],
  });

  assert.deepEqual(items, [{
    author: "gemini-relay",
    body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Gemini\nVerdict: APPROVE`,
    createdAt: null,
    source: "pull_request_review",
    url: "https://github.test/review/current",
  }]);
});

test("manual review gate resolves pull_request and issue_comment event context", () => {
  assert.deepEqual(githubEventContext({
    pull_request: {
      number: 136,
      head: { sha: HEAD },
    },
  }), {
    shouldRun: true,
    prNumber: 136,
    headSha: HEAD,
    needsPullRequestFetch: false,
  });

  assert.deepEqual(githubEventContext({
    issue: {
      number: 136,
      pull_request: { url: "https://api.github.test/pulls/136" },
    },
  }), {
    shouldRun: true,
    prNumber: 136,
    headSha: null,
    needsPullRequestFetch: true,
  });

  assert.deepEqual(githubEventContext({
    issue: { number: 12 },
  }), {
    shouldRun: false,
    prNumber: null,
    headSha: null,
    needsPullRequestFetch: false,
  });
});

test("manual review gate CLI evaluates fixture evidence from env", () => {
  const passing = spawnSync(process.execPath, ["scripts/ci/check-manual-review-gate.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MANUAL_REVIEW_GATE_HEAD_SHA: HEAD,
      MANUAL_REVIEW_GATE_ITEMS_JSON: JSON.stringify([
        evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Claude\nVerdict: APPROVE`),
        evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Gemini\nVerdict: APPROVE`),
        evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Kimi\nVerdict: APPROVE`),
        evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: DeepSeek\nVerdict: APPROVE`),
        evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: GLM\nVerdict: APPROVE`),
      ]),
    },
  });
  assert.equal(passing.status, 0, passing.stderr || passing.stdout);
  assert.match(passing.stdout, /manual review gate passed/i);

  const failing = spawnSync(process.execPath, ["scripts/ci/check-manual-review-gate.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MANUAL_REVIEW_GATE_HEAD_SHA: HEAD,
      MANUAL_REVIEW_GATE_ITEMS_JSON: JSON.stringify([
        evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Claude\nVerdict: APPROVE`),
      ]),
    },
  });
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /manual review gate failed/i);
  assert.match(failing.stderr, /missing reviewers: deepseek, gemini, glm, kimi/i);

  const invalidHead = spawnSync(process.execPath, ["scripts/ci/check-manual-review-gate.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MANUAL_REVIEW_GATE_HEAD_SHA: "../main",
      MANUAL_REVIEW_GATE_ITEMS_JSON: "[]",
    },
  });
  assert.equal(invalidHead.status, 1);
  assert.match(invalidHead.stderr, /40-character git SHA/);
});

test("manual review gate CLI follows paginated GitHub comments and reviews", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "manual-review-gate-"));
  try {
    const eventPath = join(tempDir, "event.json");
    await writeFile(eventPath, JSON.stringify({
      pull_request: {
        number: 136,
        head: { sha: HEAD },
      },
    }));
    const relayBodies = [
      ["Claude", "APPROVE"],
      ["Gemini", "APPROVE"],
      ["Kimi", "APPROVE"],
      ["DeepSeek", "APPROVE"],
      ["GLM", "APPROVE"],
    ].map(([reviewer, verdict]) => `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: ${reviewer}\nVerdict: ${verdict}`);

    await withServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/repos/owner/repo/issues/136/comments") {
        if (url.searchParams.get("page") === "2") {
          response.end(JSON.stringify(relayBodies.slice(0, 3).map((body, index) => ({
            body,
            html_url: `https://github.test/comment/${index + 1}`,
            user: { login: "manual-relay" },
          }))));
          return;
        }
        response.setHeader("link", `</repos/owner/repo/issues/136/comments?per_page=100&page=2>; rel="next"`);
        response.end("[]");
        return;
      }
      if (url.pathname === "/repos/owner/repo/pulls/136/reviews") {
        if (url.searchParams.get("page") === "2") {
          response.end(JSON.stringify(relayBodies.slice(3).map((body, index) => ({
            body,
            html_url: `https://github.test/review/${index + 1}`,
            user: { login: "manual-relay" },
            state: "COMMENTED",
          }))));
          return;
        }
        response.setHeader("link", `</repos/owner/repo/pulls/136/reviews?per_page=100&page=2>; rel="next"`);
        response.end("[]");
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
    }, async (apiUrl) => {
      const result = await runNodeScript(["scripts/ci/check-manual-review-gate.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_API_URL: apiUrl,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_TOKEN: "test-token",
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /manual review gate passed/i);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manual review gate CLI fails closed on self-referential pagination links", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "manual-review-gate-"));
  try {
    const eventPath = join(tempDir, "event.json");
    await writeFile(eventPath, JSON.stringify({
      pull_request: {
        number: 136,
        head: { sha: HEAD },
      },
    }));

    await withServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/repos/owner/repo/issues/136/comments") {
        response.setHeader("link", `<${url.pathname}${url.search}>; rel="next"`);
        response.end("[]");
        return;
      }
      if (url.pathname === "/repos/owner/repo/pulls/136/reviews") {
        response.end("[]");
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
    }, async (apiUrl) => {
      const result = await runNodeScript(["scripts/ci/check-manual-review-gate.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_API_URL: apiUrl,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_TOKEN: "test-token",
        },
      }, { timeoutMs: 1000 });

      assert.equal(result.timedOut, false, "manual review gate should fail before the test timeout");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /pagination/i);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manual review gate builds commit status payloads for branch protection", () => {
  const passing = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Claude\nVerdict: APPROVE`),
      evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Gemini\nVerdict: APPROVE`),
      evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Kimi\nVerdict: APPROVE`),
      evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: DeepSeek\nVerdict: APPROVE`),
      evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: GLM\nVerdict: APPROVE`),
    ],
  });
  assert.deepEqual(statusPayloadForManualReviewResult(passing, {
    context: "manual-review-gate",
    targetUrl: "https://github.test/run/1",
  }), {
    context: "manual-review-gate",
    state: "success",
    target_url: "https://github.test/run/1",
    description: "Manual external adversarial reviews approved: claude, deepseek, gemini, glm, kimi",
  });

  const failing = evaluateManualReviewEvidence({
    headSha: HEAD,
    items: [
      evidence("operator", `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${OLD_HEAD}\nReviewer: Claude\nVerdict: APPROVE`),
    ],
  });
  assert.deepEqual(statusPayloadForManualReviewResult(failing, {
    context: "manual-review-gate",
    targetUrl: "",
  }), {
    context: "manual-review-gate",
    state: "failure",
    target_url: "",
    description: "Manual reviews incomplete: missing claude, deepseek, gemini, glm, kimi; stale claude",
  });
});

test("manual review gate validates head SHA values before URL/status use", () => {
  assert.equal(validateGitSha(HEAD), HEAD);
  assert.throws(() => validateGitSha("../main"), /40-character git SHA/);
  assert.throws(() => validateGitSha("abc"), /40-character git SHA/);
  assert.throws(() => evaluateManualReviewEvidence({ headSha: "../main", items: [] }), /40-character git SHA/);
});
