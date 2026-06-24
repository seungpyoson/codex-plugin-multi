// P3: Does a contract-compliant "Verdict: NOT_REVIEWED" survive downstream parsing?
//
// The prompt contract (scripts/lib/review-prompt.mjs) instructs the model to emit
// the first line as EXACTLY one of:
//   "Verdict: APPROVE", "Verdict: REQUEST_CHANGES", or "Verdict: NOT_REVIEWED".
//
// This script imports the REAL repo modules and runs:
//   (A) buildReviewSlotDisposition() from scripts/lib/provider-route-policy.mjs
//       (drives the private resultVerdict() parser) on a NOT_REVIEWED review.
//   (B) the REAL hasSubstantiveReview() regex from plugins/agy/scripts/agy-companion.mjs,
//       extracted live from the source file (not hand-copied), on the same review.
// For control, it also runs APPROVE and REQUEST_CHANGES through both paths.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildReviewSlotDisposition } from "../../lib/provider-route-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

// --- (B) Extract the REAL hasSubstantiveReview regex literal from companion source ---
const companionPath = resolve(repoRoot, "plugins/agy/scripts/agy-companion.mjs");
if (!existsSync(companionPath)) {
  console.log("SKIPPED: requires AGY plugin (PR #218) — not present on this branch");
  process.exit(0);
}
const companionSrc = readFileSync(companionPath, "utf8");
// Grab the body of `function hasSubstantiveReview(text) { ... }`
const fnStart = companionSrc.indexOf("function hasSubstantiveReview");
if (fnStart < 0) {
  console.error("FATAL: function hasSubstantiveReview not found in AGY companion source (renamed?).");
  process.exit(2);
}
const fnBody = companionSrc.slice(fnStart, fnStart + 400);
// Reconstruct the function from the real source so we test the real predicate.
// We isolate the two regex literals + the boolean combinator exactly as written.
const m = fnBody.match(/return\s+(\/[^\n]*\.test\(text\))\s*\n\s*&&\s*(\/[^\n]*\.test\(text\));/);
if (!m) {
  console.error("FATAL: could not extract hasSubstantiveReview body. Raw:\n" + fnBody);
  process.exit(2);
}
const realPredicateSource = `(text) => ${m[1]} && ${m[2]}`;
console.log("Extracted hasSubstantiveReview predicate from real source:");
console.log("  " + realPredicateSource.replace(/\n\s*/g, " "));
// eslint-disable-next-line no-eval
const hasSubstantiveReview = eval(realPredicateSource);

// A review body that exactly follows the contract for NOT_REVIEWED, with a real reason
// and the "Blocking findings" section the AGY predicate also requires.
const notReviewedBody = [
  "Verdict: NOT_REVIEWED",
  "",
  "Reason: required outside tooling was unavailable in the granted sandbox, so",
  "src/foo.js could not be inspected. Treating missing tools as NOT REVIEWED per contract.",
  "",
  "Blocking findings: none observed in the supplied selected source.",
  "",
  "Checklist: refs PASS, scope PASS, correctness NOT REVIEWED, runtime completeness NOT REVIEWED.",
].join("\n");

const approveBody = [
  "Verdict: APPROVE",
  "",
  "Blocking findings: none. Reviewed src/foo.js end to end.",
].join("\n");

const requestChangesBody = [
  "Verdict: REQUEST_CHANGES",
  "",
  "Blocking findings: src/foo.js line 12 dereferences null.",
].join("\n");

function runCase(label, body) {
  const slot = buildReviewSlotDisposition({
    provider: "agy",
    mode: "review",
    stage: "final",
    status: "completed",
    sourceState: "sent",
    result: body,
    reviewedHeadSha: "abc123",
    currentHeadSha: "abc123",
  });
  const substantive = hasSubstantiveReview(body);
  console.log(`\n=== ${label} ===`);
  console.log("  first line:        ", JSON.stringify(body.split("\n")[0]));
  console.log("  route-policy verdict:", slot.verdict);
  console.log("  failed_slot_reason:  ", slot.failed_slot_reason);
  console.log("  not_counted_reason:  ", slot.not_counted_reason);
  console.log("  AGY hasSubstantiveReview:", substantive);
  // Mirror agy-companion.mjs lines 1213-1226 to show downstream disposition.
  const parsedOk = true;       // execution.parsed.ok
  const exitCodeZero = true;   // execution.exitCode === 0
  const preliminarilyCompleted = parsedOk && exitCodeZero && substantive;
  const recordStatus = preliminarilyCompleted ? "completed" : "failed";
  const recordErrorCode = preliminarilyCompleted ? null : "review_not_completed";
  const resultPreserved = preliminarilyCompleted ? "PRESERVED" : "DROPPED (result: null)";
  console.log("  -> AGY recordStatus:", recordStatus,
              "| errorCode:", recordErrorCode,
              "| review body:", resultPreserved);
  return { slot, substantive, recordStatus, recordErrorCode, resultPreserved };
}

console.log("Repo root:", repoRoot);
const nr = runCase("NOT_REVIEWED (contract-compliant)", notReviewedBody);
runCase("APPROVE (control)", approveBody);
runCase("REQUEST_CHANGES (control)", requestChangesBody);

console.log("\n----- ADJUDICATION -----");
const droppedByAgy = nr.recordStatus === "failed";
const verdictMissing = nr.slot.verdict === "missing";
if (droppedByAgy && verdictMissing) {
  console.log("RESULT: A contract-compliant NOT_REVIEWED is NOT preserved as a not-reviewed slot.");
  console.log("  - route-policy maps it to verdict =", JSON.stringify(nr.slot.verdict),
              "(failed_slot_reason =", JSON.stringify(nr.slot.failed_slot_reason) + ")");
  console.log("  - AGY companion records status=failed, errorCode=review_not_completed,");
  console.log("    error 'AGY did not produce a substantive review verdict', and DROPS the body (result:null).");
  console.log("  => Codex is RIGHT: the grammar is asymmetric; NOT_REVIEWED is dropped/failed.");
} else {
  console.log("RESULT: NOT_REVIEWED is recognized/preserved. Workflow framing would be right.");
}
