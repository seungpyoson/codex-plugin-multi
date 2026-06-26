// P4 regression guard: AGY must not require the literal substring
// "Blocking findings" after the shared review-quality gate accepts equivalent
// phrasing such as "Blockers:" or "Must fix:".

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const reviewPromptPath = resolve(repoRoot, "plugins/agy/scripts/lib/review-prompt.mjs");
const agyCompanionPath = resolve(repoRoot, "plugins/agy/scripts/agy-companion.mjs");

if (!existsSync(reviewPromptPath) || !existsSync(agyCompanionPath)) {
  console.log("SKIPPED: requires AGY plugin (PR #218) - not present on this branch");
  process.exit(0);
}

const { buildReviewAuditManifest } = await import(reviewPromptPath);
const companionSrc = readFileSync(agyCompanionPath, "utf8");

const localGateRemoved = !/\bfunction\s+hasSubstantiveReview\b/.test(companionSrc)
  && !/hasSubstantiveReview\(/.test(companionSrc)
  && !/\/Blocking findings\/i/.test(companionSrc);

console.log("[source-guard] AGY-local hasSubstantiveReview gate removed:", localGateRemoved);

const pad = (n) => Array.from({ length: n }, (_, i) => (
  `- src/module${i}.js:${100 + i} inspected concrete control flow, source routing, tests, and security-sensitive behavior with enough detail to exceed the shared review-quality shallow threshold.`
)).join("\n");

const cases = [
  [
    "Blockers:",
    [
      "Verdict: REQUEST_CHANGES",
      "",
      "Blockers:",
      "- src/auth.js:42 auth validation is bypassed when the header is absent; this blocks merge.",
      pad(4),
      "",
      "Non-blocking concerns:",
      "- Residual risk: no additional concern was found after reviewing the selected source packet.",
    ].join("\n"),
  ],
  [
    "Must fix:",
    [
      "Verdict: REQUEST_CHANGES",
      "",
      "Must fix:",
      "- src/auth.js:42 auth validation is bypassed when the header is absent; this is a blocker for merge.",
      pad(4),
      "",
      "Non-blocking concerns:",
      "- Residual risk: no additional concern was found after reviewing the selected source packet.",
    ].join("\n"),
  ],
];

let allAccepted = true;
for (const [label, result] of cases) {
  const manifest = buildReviewAuditManifest({
    prompt: "review prompt",
    sourceFiles: [],
    result,
    status: "completed",
    errorCode: null,
  });
  const rq = manifest.review_quality ?? {};
  const accepted = rq.failed_review_slot === false
    && rq.has_verdict === true
    && rq.has_blocking_section === true
    && !/Blocking findings/i.test(result);
  allAccepted &&= accepted;
  console.log(`\n=== ${label} ===`);
  console.log("contains literal 'Blocking findings':", /Blocking findings/i.test(result));
  console.log("shared has_blocking_section:", rq.has_blocking_section);
  console.log("shared failed_review_slot:", rq.failed_review_slot);
  console.log("shared semantic_failure_reasons:", JSON.stringify(rq.semantic_failure_reasons));
  console.log("fixed behavior accepted:", accepted);
}

const fixed = localGateRemoved && allAccepted;
console.log("\n=== SUMMARY ===");
console.log("AGY uses shared review-quality gate only for substantive phrasing:", fixed);
process.exit(fixed ? 0 : 1);
