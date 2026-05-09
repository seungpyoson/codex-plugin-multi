import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

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
      source: "issue_comment",
      url: "https://github.test/comment/1",
    },
    {
      author: "gemini-code-assist",
      body: `<!-- codex-plugin-multi:manual-external-adversarial-review -->\nHead: ${HEAD}\nReviewer: Gemini\nVerdict: APPROVE`,
      source: "pull_request_review",
      url: "https://github.test/review/1",
    },
  ]);
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
