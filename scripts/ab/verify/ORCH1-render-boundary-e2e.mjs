// ORCH-1 end-to-end render-boundary proof (model-independent).
//
// CLAIM: on a COMPLETED foreground `--lifecycle-events markdown` review run, the
// terminal stdout the orchestrator receives must include both the metadata card
// and the model's findings from record.result. This guards against regressions
// where an orchestrator faithfully rendering the foreground markdown stdout
// reports a real, finding-bearing review as "no findings produced."
//
// This drives the REAL emission code (printLifecycleJson markdown ->
// renderLifecycleMarkdown) through the shared render path and asserts the fix.
// The render path is model-independent, so no live model / provider auth is
// needed to observe exactly what the orchestrator's stdout would be.

import { printLifecycleJson, renderLifecycleMarkdown } from "../../lib/companion-common.mjs";

const FINDINGS = [
  "Verdict: REQUEST_CHANGES",
  "",
  "Blocking findings",
  "- src/auth.js:12 requireRole(role, user) reversed the argument order; every caller",
  "  passing (user, role) now silently denies access. Concrete auth regression.",
  "",
  "Non-blocking concerns",
  "- Add a typed wrapper so the argument order is compiler-checked.",
].join("\n");

const SENTINEL = "requireRole(role, user) reversed the argument order"; // unique findings text

// A COMPLETED terminal record: CLI exited 0 and produced a parsed, ok review with findings.
const record = {
  event: "external_review_terminal",
  id: "job-ORCH1",
  job_id: "job-ORCH1",
  target: "agy",
  provider: "AGY",
  mode: "review",
  cwd: "/tmp",
  workspace_root: "/tmp",
  status: "completed",
  result: FINDINGS,
  external_review: {
    marker: "EXTERNAL REVIEW",
    provider: "AGY",
    run_kind: "foreground",
    job_id: "job-ORCH1",
    session_id: "session-ORCH1",
    parent_job_id: null,
    mode: "review",
    scope: "branch-diff",
    scope_base: "origin/main",
    scope_paths: null,
    source_content_transmission: "sent",
    disclosure: "Selected source content was sent to AGY for external review.",
  },
};

console.log("=== the completed record the companion holds ===");
console.log("  record.status                :", record.status);
console.log("  record.result present?       :", typeof record.result === "string" && record.result.length > 0);
console.log("  record.result has findings?  :", String(record.result).includes(SENTINEL), "  (this is what `result --job` prints)");
console.log("  record.external_review set?  :", !!record.external_review);

// ---- The REAL foreground markdown terminal emission ----
let captured = "";
const sink = { write: (s) => { captured += s; } };
printLifecycleJson(record, "markdown", sink);

console.log("\n=== EXACT foreground stdout the orchestrator receives (markdown) ===");
console.log(captured.trimEnd());

const cardHasFindings = captured.includes(SENTINEL);
const recordHasFindings = String(record.result).includes(SENTINEL);

// Does the render even fall through to a path that would include the full record?
const cardOnly = renderLifecycleMarkdown(record) !== null; // truthy => printJsonLine fallback never reached

console.log("\n=== VERDICT ===");
console.log("  record carries the findings (retrievable via result --job):", recordHasFindings);
console.log("  foreground markdown card CONTAINS the findings            :", cardHasFindings);
console.log("  renderLifecycleMarkdown returns a card (so fallback skipped):", cardOnly);

const fixed = recordHasFindings && cardHasFindings && cardOnly;
console.log("\nRESULT:", fixed
  ? "FIXED — completed review findings are present in the foreground markdown stdout after the metadata card."
  : "NOT FIXED — completed review findings are still missing from the foreground markdown stdout.");
process.exit(fixed ? 0 : 1);
