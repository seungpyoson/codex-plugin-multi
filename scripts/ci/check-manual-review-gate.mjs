#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import {
  evidenceItemsFromGithubRecords,
  evaluateManualReviewEvidence,
  githubEventContext,
  statusPayloadForManualReviewResult,
} from "../lib/manual-review-gate.mjs";

function reportAndExit(result) {
  if (result.ok) {
    process.stdout.write(`manual review gate passed for ${result.headSha}: ${result.approvedReviewers.join(", ")}\n`);
    return 0;
  }
  const parts = [];
  if (result.missingReviewers.length) parts.push(`missing reviewers: ${result.missingReviewers.join(", ")}`);
  if (result.blockingReviewers.length) parts.push(`request changes: ${result.blockingReviewers.join(", ")}`);
  if (result.staleReviewers.length) parts.push(`stale head: ${result.staleReviewers.join(", ")}`);
  process.stderr.write(`manual review gate failed for ${result.headSha}: ${parts.join("; ")}\n`);
  return 1;
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function postJson(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: HTTP ${response.status}`);
  }
  return response.json();
}

function githubApiUrl(apiUrl, pathParts, query = {}) {
  const url = new URL(apiUrl);
  let basePath = url.pathname;
  while (basePath.endsWith("/")) {
    basePath = basePath.slice(0, -1);
  }
  url.pathname = [
    basePath,
    ...pathParts.map((part) => encodeURIComponent(String(part))),
  ].filter(Boolean).join("/");
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function githubRepoParts(repo) {
  const match = String(repo ?? "").match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u);
  if (!match) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  return [match[1], match[2]];
}

async function loadGithubEvidence({ env = process.env } = {}) {
  const eventPath = env.GITHUB_EVENT_PATH;
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
  if (!eventPath || !repo || !token) {
    throw new Error("GITHUB_EVENT_PATH, GITHUB_REPOSITORY, and GITHUB_TOKEN are required outside fixture mode");
  }
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const context = githubEventContext(event);
  if (!context.shouldRun) {
    return { shouldRun: false, headSha: null, items: [] };
  }
  const [owner, repoName] = githubRepoParts(repo);
  const pull = context.needsPullRequestFetch
    ? await getJson(githubApiUrl(apiUrl, ["repos", owner, repoName, "pulls", context.prNumber]), token)
    : event.pull_request;
  const headSha = context.headSha ?? pull.head?.sha;
  const [comments, reviews] = await Promise.all([
    getJson(githubApiUrl(apiUrl, ["repos", owner, repoName, "issues", context.prNumber, "comments"], { per_page: 100 }), token),
    getJson(githubApiUrl(apiUrl, ["repos", owner, repoName, "pulls", context.prNumber, "reviews"], { per_page: 100 }), token),
  ]);
  return {
    shouldRun: true,
    headSha,
    items: evidenceItemsFromGithubRecords({ comments, reviews }),
  };
}

async function main() {
  if (process.env.MANUAL_REVIEW_GATE_ITEMS_JSON) {
    const result = evaluateManualReviewEvidence({
      headSha: process.env.MANUAL_REVIEW_GATE_HEAD_SHA,
      items: JSON.parse(process.env.MANUAL_REVIEW_GATE_ITEMS_JSON),
    });
    return reportAndExit(result);
  }

  const evidence = await loadGithubEvidence();
  if (!evidence.shouldRun) {
    process.stdout.write("manual review gate skipped: event is not a pull request\n");
    return 0;
  }
  const result = evaluateManualReviewEvidence({
    headSha: evidence.headSha,
    items: evidence.items,
  });
  if (process.env.MANUAL_REVIEW_GATE_STATUS_CONTEXT) {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
    if (!repo || !token) {
      throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to post manual-review status");
    }
    const [owner, repoName] = githubRepoParts(repo);
    await postJson(githubApiUrl(apiUrl, ["repos", owner, repoName, "statuses", result.headSha]), token, statusPayloadForManualReviewResult(result, {
      context: process.env.MANUAL_REVIEW_GATE_STATUS_CONTEXT,
      targetUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "",
    }));
  }
  return reportAndExit(result);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`manual review gate failed: ${error.message}\n`);
  process.exitCode = 1;
}
