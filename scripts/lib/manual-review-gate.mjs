export const MANUAL_REVIEW_MARKER = "codex-plugin-multi:manual-external-adversarial-review";

export const DEFAULT_MANUAL_REVIEW_REQUIREMENTS = Object.freeze({
  requiredReviewers: Object.freeze(["claude", "gemini", "kimi", "deepseek", "glm"]),
});

const REVIEWER_ALIASES = new Map([
  ["claude", "claude"],
  ["claude code", "claude"],
  ["gemini", "gemini"],
  ["gemini cli", "gemini"],
  ["kimi", "kimi"],
  ["kimi code", "kimi"],
  ["kimi code cli", "kimi"],
  ["deepseek", "deepseek"],
  ["deepseek api", "deepseek"],
  ["glm", "glm"],
  ["zai", "glm"],
  ["zai glm", "glm"],
]);

function compareText(a, b) {
  return a.localeCompare(b);
}

function sortReviewers(reviewers) {
  return [...reviewers].sort(compareText);
}

export function validateGitSha(value) {
  const sha = String(value ?? "");
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error("manual review gate requires a 40-character git SHA");
  }
  return sha;
}

function normalizeReviewer(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return REVIEWER_ALIASES.get(key) ?? null;
}

function extractField(body, name) {
  const pattern = new RegExp(String.raw`^\s*${name}\s*:\s*(.+?)\s*$`, "im");
  return body.match(pattern)?.[1]?.trim() ?? "";
}

function normalizeVerdict(value) {
  const verdict = String(value ?? "").trim().toUpperCase();
  if (verdict === "PASS") return "APPROVE";
  if (verdict === "FAIL") return "REQUEST CHANGES";
  return verdict;
}

function parseManualReviewEvidence(item) {
  const body = String(item?.body ?? "");
  if (!body.includes(MANUAL_REVIEW_MARKER)) return null;
  const reviewer = normalizeReviewer(extractField(body, "Reviewer"));
  if (!reviewer) return null;
  const verdict = normalizeVerdict(extractField(body, "Verdict"));
  return {
    reviewer,
    verdict,
    head: extractField(body, "Head"),
    url: item?.url ?? null,
    author: item?.author ?? null,
  };
}

export function evaluateManualReviewEvidence({
  headSha,
  items,
  requirements = DEFAULT_MANUAL_REVIEW_REQUIREMENTS,
}) {
  const currentHeadSha = validateGitSha(headSha);
  const requiredReviewers = sortReviewers(requirements.requiredReviewers);
  const approved = new Set();
  const stale = new Set();
  const blocking = new Set();
  const parsed = [];

  for (const item of items ?? []) {
    const evidence = parseManualReviewEvidence(item);
    if (!evidence) continue;
    parsed.push(evidence);
    if (evidence.head !== currentHeadSha) {
      stale.add(evidence.reviewer);
      continue;
    }
    stale.delete(evidence.reviewer);
    if (evidence.verdict === "APPROVE") {
      approved.add(evidence.reviewer);
      blocking.delete(evidence.reviewer);
    } else if (evidence.verdict === "REQUEST CHANGES") {
      blocking.add(evidence.reviewer);
      approved.delete(evidence.reviewer);
    }
  }

  const approvedReviewers = sortReviewers(approved);
  const blockingReviewers = sortReviewers(blocking);
  const missingReviewers = requiredReviewers.filter((reviewer) =>
    !approved.has(reviewer) && !blocking.has(reviewer));
  const staleReviewers = requiredReviewers.filter((reviewer) =>
    stale.has(reviewer) && !approved.has(reviewer) && !blocking.has(reviewer));

  return {
    ok: requiredReviewers.every((reviewer) => approved.has(reviewer)) &&
      blockingReviewers.length === 0,
    headSha: currentHeadSha,
    parsed,
    approvedReviewers,
    approvedReviewersSet: approved,
    staleReviewers: sortReviewers(staleReviewers),
    blockingReviewers,
    missingReviewers,
  };
}

export function evidenceItemsFromGithubRecords({ comments = [], reviews = [] } = {}) {
  return [
    ...comments.map((comment) => ({
      author: comment?.user?.login ?? null,
      body: String(comment?.body ?? ""),
      createdAt: comment?.created_at ?? null,
      source: "issue_comment",
      url: comment?.html_url ?? null,
    })),
    ...reviews
      .filter((review) => String(review?.state ?? "").toUpperCase() !== "DISMISSED")
      .map((review) => ({
        author: review?.user?.login ?? null,
        body: String(review?.body ?? ""),
        createdAt: review?.submitted_at ?? null,
        source: "pull_request_review",
        url: review?.html_url ?? null,
      })),
  ].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt ?? "");
    const rightTime = Date.parse(right.createdAt ?? "");
    const leftOrder = Number.isNaN(leftTime) ? 0 : leftTime;
    const rightOrder = Number.isNaN(rightTime) ? 0 : rightTime;
    return leftOrder - rightOrder;
  });
}

export function githubEventContext(event) {
  if (event?.pull_request) {
    return {
      shouldRun: true,
      prNumber: event.pull_request.number ?? null,
      headSha: event.pull_request.head?.sha ?? null,
      needsPullRequestFetch: false,
    };
  }
  if (event?.issue?.pull_request) {
    return {
      shouldRun: true,
      prNumber: event.issue.number ?? null,
      headSha: null,
      needsPullRequestFetch: true,
    };
  }
  return {
    shouldRun: false,
    prNumber: null,
    headSha: null,
    needsPullRequestFetch: false,
  };
}

export function statusPayloadForManualReviewResult(result, {
  context = "manual-review-gate",
  targetUrl = "",
} = {}) {
  const state = result.ok ? "success" : "failure";
  const description = result.ok
    ? `Manual external adversarial reviews approved: ${result.approvedReviewers.join(", ")}`
    : manualReviewFailureDescription(result);
  return {
    context,
    state,
    target_url: targetUrl,
    description: description.slice(0, 140),
  };
}

function manualReviewFailureDescription(result) {
  const parts = [];
  if (result.missingReviewers.length) parts.push(`missing ${result.missingReviewers.join(", ")}`);
  if (result.blockingReviewers.length) parts.push(`request changes ${result.blockingReviewers.join(", ")}`);
  if (result.staleReviewers.length) parts.push(`stale ${result.staleReviewers.join(", ")}`);
  return `Manual reviews incomplete: ${parts.join("; ")}`;
}
