// ORCH-1 end-to-end render-boundary proof (model-independent).
//
// CLAIM: on a COMPLETED foreground `--lifecycle-events markdown` review run, the
// terminal stdout the orchestrator receives is a metadata card that does NOT
// contain the model's findings. The findings live on record.result and are only
// reachable via a separate `result --job`. So an orchestrator faithfully
// rendering the card it receives can report a real, finding-bearing review as
// "no findings produced."
//
// This drives the REAL emission code (printLifecycleJson markdown ->
// renderLifecycleMarkdown) on a REAL completed record built by the REAL
// buildJobRecord. The render path is model-independent, so no live model / AGY
// auth is needed to observe exactly what the orchestrator's stdout would be.

import { buildJobRecord } from "../../../plugins/agy/scripts/lib/job-record.mjs";
import { printLifecycleJson, renderLifecycleMarkdown } from "../../../plugins/agy/scripts/lib/companion-common.mjs";

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

function makeInvocation() {
  return {
    job_id: "job-ORCH1",
    target: "agy",
    mode: "review",
    mode_profile_name: "default",
    model: "antigravity",
    cwd: "/tmp",
    workspace_root: "/tmp",
    containment: { kind: "none" },
    scope: "branch-diff",
    prompt_head: "review the diff",
    binary: "/bin/true",
    started_at: new Date().toISOString(),
    run_kind: "foreground",
  };
}

// A COMPLETED execution: CLI exited 0 and produced a parsed, ok review with findings.
function makeCompletedExecution() {
  return {
    exitCode: 0,
    endedAt: new Date().toISOString(),
    stdout: JSON.stringify({ ok: true, result: FINDINGS }),
    stderr: "",
    timedOut: false,
    parsed: { ok: true, result: FINDINGS },
  };
}

const record = buildJobRecord(makeInvocation(), makeCompletedExecution(), []);

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

const pinned = recordHasFindings && !cardHasFindings && cardOnly;
console.log("\nRESULT:", pinned
  ? "PINNED — completed review's findings exist on the record but are DROPPED from the foreground markdown stdout (card only). Orchestrator sees no findings."
  : "NOT PINNED — findings appeared in the card or record lacked them.");
process.exit(pinned ? 0 : 1);
