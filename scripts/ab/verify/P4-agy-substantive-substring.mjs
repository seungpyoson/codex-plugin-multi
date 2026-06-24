// P4 — Root 3 "no-single-source": AGY hasSubstantiveReview substring divergence.
//
// CLAIM: AGY-only hasSubstantiveReview requires the literal substring
// "Blocking findings" (case-insensitive) plus a verdict regex; valid reviews
// the SHARED contract accepts get relabeled review_not_completed and nulled.
//
// METHOD:
//  1) Import the REAL shared contract (buildReviewAuditManifest -> qualityFlags)
//     from plugins/agy/scripts/lib/review-prompt.mjs and feed it a review that
//     uses "Blockers:" (a phrasing the shared contract explicitly whitelists).
//  2) Replicate the AGY-local hasSubstantiveReview gate VERBATIM from current
//     HEAD agy-companion.mjs lines 232-233 (function is not exported, so it is
//     copied byte-for-byte and labeled). Run it on the SAME review text.
//  3) Show whether the shared contract accepts it while AGY rejects it.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const reviewPromptPath = resolve(repoRoot, "plugins/agy/scripts/lib/review-prompt.mjs");
const agyCompanionPath = resolve(repoRoot, "plugins/agy/scripts/agy-companion.mjs");

if (!existsSync(reviewPromptPath) || !existsSync(agyCompanionPath)) {
  console.log("SKIPPED: requires AGY plugin (PR #218) — not present on this branch");
  process.exit(0);
}

const { buildReviewAuditManifest } = await import(reviewPromptPath);

// --- VERBATIM copy of AGY-local gate (agy-companion.mjs:231-234, current HEAD).
// Verified below against the real source to guard against drift.
function hasSubstantiveReview(text) {
  return /Verdict:\s*(APPROVE|REQUEST_CHANGES|COMMENT|FAIL|REJECT)/i.test(text)
    && /Blocking findings/i.test(text);
}

// Drift guard: assert the two regexes literally appear in current-HEAD source.
const companionSrc = readFileSync(agyCompanionPath, "utf8");
const verdictReSrc = "/Verdict:\\s*(APPROVE|REQUEST_CHANGES|COMMENT|FAIL|REJECT)/i";
const blockingReSrc = "/Blocking findings/i";
const driftOk = companionSrc.includes(verdictReSrc) && companionSrc.includes(blockingReSrc);
console.log("[drift-guard] AGY-local regexes present in current-HEAD source:", driftOk);
if (!driftOk) {
  console.log("[drift-guard] WARNING: source drifted; copied gate may be stale.");
}

// Padding so the review exceeds the shared contract's 500-char "looks_shallow"
// threshold — this isolates the blocking-phrase variable from the length
// heuristic that both gates share.
const pad = (n) => Array.from({ length: n }, (_, i) =>
  `- src/module${i}.js:${100 + i} — inspected the changed control flow and data handling; ` +
  `confirmed the new branch preserves the invariant and adds no regression. Concrete file/function evidence noted.`
).join("\n");

// A correct, substantive (>500 char) review that phrases its blocking section as
// "Blockers:" and lacks the literal "Blocking findings". Valid verdict present.
const reviewWithBlockers = [
  "Verdict: REQUEST_CHANGES",
  "",
  "Blockers:",
  "- src/auth.js:42 — the token check is bypassed when the header is absent;",
  "  control flow falls through to the authorized branch. Concrete evidence.",
  pad(4),
  "",
  "Non-blocking:",
  "- src/util.js:10 — minor naming nit, residual risk negligible.",
].join("\n");

// Same, phrased as "Must fix:" (shared whitelist: blocker/blockers).
const reviewWithMustFix = [
  "Verdict: REQUEST_CHANGES",
  "",
  "Must fix:",
  "- src/auth.js:42 — token check bypassed; this is a blocker for merge.",
  pad(4),
  "",
  "Non-blocking:",
  "- src/util.js:10 — minor concern only.",
].join("\n");

function sharedContractVerdict(result) {
  const manifest = buildReviewAuditManifest({
    prompt: "review prompt",
    sourceFiles: [],
    result,
    status: "completed",
    errorCode: null,
  });
  const rq = manifest.review_quality ?? {};
  return {
    has_verdict: rq.has_verdict,
    has_blocking_section: rq.has_blocking_section,
    has_non_blocking_section: rq.has_non_blocking_section,
    looks_shallow: rq.looks_shallow,
    semantic_failure_reasons: rq.semantic_failure_reasons,
    failed_review_slot: rq.failed_review_slot,
  };
}

function report(label, text) {
  const shared = sharedContractVerdict(text);
  const agyAccepts = hasSubstantiveReview(text);
  // AGY pipeline (agy-companion.mjs:1213-1224): preliminarilyCompleted requires
  // hasSubstantiveReview; otherwise result is nulled with reason
  // "review_not_completed".
  const agyOutcome = agyAccepts ? "completed (result kept)" : "review_not_completed (result NULLED)";
  console.log(`\n=== ${label} ===`);
  console.log("review text contains literal 'Blocking findings':", /Blocking findings/i.test(text));
  console.log("SHARED contract has_blocking_section:", shared.has_blocking_section);
  console.log("SHARED contract failed_review_slot:", shared.failed_review_slot);
  console.log("SHARED contract semantic_failure_reasons:", JSON.stringify(shared.semantic_failure_reasons));
  console.log("AGY-local hasSubstantiveReview accepts:", agyAccepts);
  console.log("AGY pipeline outcome:", agyOutcome);
  const divergence = (shared.failed_review_slot === false) && (agyAccepts === false);
  console.log("DIVERGENCE (shared accepts, AGY rejects):", divergence);
  return divergence;
}

const d1 = report("Review phrased with 'Blockers:'", reviewWithBlockers);
const d2 = report("Review phrased with 'Must fix:'", reviewWithMustFix);

// Sanity control: a review that DOES use the literal "Blocking findings"
// should pass BOTH gates (proves AGY gate isn't rejecting everything).
const reviewWithLiteral = [
  "Verdict: REQUEST_CHANGES",
  "",
  "Blocking findings:",
  "- src/auth.js:42 — token check bypassed.",
  pad(4),
  "",
  "Non-blocking:",
  "- src/util.js:10 — minor concern.",
].join("\n");
const ctl = sharedContractVerdict(reviewWithLiteral);
console.log("\n=== CONTROL: literal 'Blocking findings:' ===");
console.log("SHARED failed_review_slot:", ctl.failed_review_slot, "| AGY accepts:", hasSubstantiveReview(reviewWithLiteral));

console.log("\n=== SUMMARY ===");
console.log("Any valid review accepted by shared contract but rejected by AGY:", d1 || d2);
