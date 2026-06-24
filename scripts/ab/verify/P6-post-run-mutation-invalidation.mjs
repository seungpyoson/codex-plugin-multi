// P6: Post-run mutation invalidation reproduction.
//
// CLAIM: A good (substantive, exit-0) review is forced to failed_review_slot when
// the provider (or unrelated workspace activity) writes a NEW untracked file during
// the run. AGY snapshots `git status -s --untracked-files=all` before, diffs it after,
// and withMutationReviewFailure() converts any new non-`mutation_detection_failed:`
// status line into source_mutation_detected + failed_review_slot + status:"failed".
//
// This script imports the REAL gitStatusLines() from the repo, replays the REAL
// recordPostRunMutations() set-difference, and runs the REAL withMutationReviewFailure()
// source extracted verbatim from agy-companion.mjs at HEAD. It then asserts the outcome.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const agyCompanionPath = join(repoRoot, "relay", "relay-agy", "scripts", "agy-companion.mjs");
const companionCommonPath = join(repoRoot, "relay", "relay-agy", "scripts", "lib", "companion-common.mjs");
if (!existsSync(companionCommonPath) || !existsSync(agyCompanionPath)) {
  console.log("SKIPPED: requires AGY plugin (PR #218) — not present on this branch");
  process.exit(0);
}

// 1. Import the REAL gitStatusLines (no top-level side effects in companion-common).
const { gitStatusLines } = await import(companionCommonPath);

// 2. Extract the REAL withMutationReviewFailure source verbatim from HEAD.
//    (agy-companion.mjs calls main() at top level and doesn't export it, so we
//     can't import it directly; we lift the exact bytes instead.)
const companionSrc = readFileSync(agyCompanionPath, "utf8");
const fnStart = companionSrc.indexOf("function withMutationReviewFailure(");
if (fnStart < 0) throw new Error("withMutationReviewFailure not found at HEAD");
// Walk braces to capture the whole function body.
const openBrace = companionSrc.indexOf("{", fnStart);
if (openBrace < 0) throw new Error("opening brace for withMutationReviewFailure not found at HEAD");
let depth = 0, i = openBrace, end = -1;
for (; i < companionSrc.length; i++) {
  const c = companionSrc[i];
  if (c === "{") depth++;
  else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSource = companionSrc.slice(fnStart, end);
console.log("=== withMutationReviewFailure source extracted from HEAD ===");
console.log(fnSource);
console.log("===========================================================\n");

// Materialize the real function.
const withMutationReviewFailure = new Function(`${fnSource}; return withMutationReviewFailure;`)();

// 3. Simulate recordPostRunMutations() set-difference exactly (lines 442-444 of agy-companion.mjs).
function diffMutations(before, after) {
  if (!after || after === before) return [];
  const beforeLines = new Set(gitStatusLines(before));
  return gitStatusLines(after).filter((line) => !beforeLines.has(line));
}

// 4. A GOOD review manifest (substantive verdict, exit 0, completed).
function goodManifest() {
  return {
    status: "completed",
    review_quality: {
      failed_review_slot: false,
      semantic_failure_reasons: [],
    },
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name} ${extra}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// --- Scenario A: provider wrote a benign untracked cache file during the run ---
{
  const before = " M relay/relay-agy/scripts/agy-companion.mjs\n";
  // Provider/runtime created an untracked cache + session artifact. Same tracked diff.
  const after =
    " M relay/relay-agy/scripts/agy-companion.mjs\n" +
    "?? .agy/cache/session-abc123.json\n" +
    "?? .agy/generated/last-review.tmp\n";

  const mutations = diffMutations(before, after);
  console.log("\n[A] benign provider-written untracked files");
  console.log("    diffMutations() =>", JSON.stringify(mutations));

  const out = withMutationReviewFailure(goodManifest(), mutations);
  console.log("    manifest.status                       =>", out.status);
  console.log("    review_quality.failed_review_slot     =>", out.review_quality.failed_review_slot);
  console.log("    review_quality.semantic_failure_reasons =>", JSON.stringify(out.review_quality.semantic_failure_reasons));

  check("A1 benign untracked files are treated as mutations", mutations.length === 2);
  check("A2 good review forced to status=failed", out.status === "failed");
  check("A3 failed_review_slot forced true", out.review_quality.failed_review_slot === true);
  check("A4 reason is source_mutation_detected",
    out.review_quality.semantic_failure_reasons.includes("source_mutation_detected"));
}

// --- Scenario B: ONLY mutation_detection_failed: entries => NOT a source mutation (control) ---
{
  const mutations = ["mutation_detection_failed: fatal: not a git repository"];
  const out = withMutationReviewFailure(goodManifest(), mutations);
  console.log("\n[B] only diagnostic mutation_detection_failed entries (control)");
  console.log("    manifest.status                   =>", out.status);
  console.log("    review_quality.failed_review_slot =>", out.review_quality.failed_review_slot);
  check("B1 diagnostic-only does NOT force failure (status preserved)", out.status === "completed");
  check("B2 diagnostic-only leaves failed_review_slot unchanged",
    out.review_quality.failed_review_slot === false);
}

// --- Scenario C: no workspace change at all (control: clean good review survives) ---
{
  const before = " M relay/relay-agy/scripts/agy-companion.mjs\n";
  const after = " M relay/relay-agy/scripts/agy-companion.mjs\n";
  const mutations = diffMutations(before, after);
  const out = withMutationReviewFailure(goodManifest(), mutations);
  console.log("\n[C] no workspace change (control)");
  console.log("    diffMutations() =>", JSON.stringify(mutations));
  console.log("    manifest.status =>", out.status);
  check("C1 no mutation => good review preserved", out.status === "completed" && mutations.length === 0);
}

// --- Scenario D: prove there is NO allowlist for cache/session/generated paths ---
{
  // A wide variety of clearly-benign provider/runtime artifact paths.
  const benignPaths = [
    "?? .agy/cache/x.json",
    "?? node_modules/.cache/y",
    "?? .DS_Store",
    "?? coverage/lcov.info",
    "?? .agy/sessions/s1.log",
    "?? tmp/agy-scratch.txt",
  ];
  const before = "";
  const after = benignPaths.join("\n") + "\n";
  const mutations = diffMutations(before, after);
  const out = withMutationReviewFailure(goodManifest(), mutations);
  console.log("\n[D] allowlist probe across benign artifact paths");
  console.log("    mutations counted =>", mutations.length, "of", benignPaths.length);
  console.log("    status            =>", out.status);
  check("D1 every benign artifact path counts as a mutation (no allowlist)",
    mutations.length === benignPaths.length && out.status === "failed");
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 2);
