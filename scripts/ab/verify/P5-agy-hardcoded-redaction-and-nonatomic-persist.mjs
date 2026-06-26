// P5 regression guard: AGY completed records must not hardcode
// sourceRedactionRequired:true when selected source has no redaction bodies.
// Empty-source completed records must pass through the real buildJobRecord.

import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const agyJobRecordPath = path.join(REPO, "plugins/agy/scripts/lib/job-record.mjs");
const agyCompanionPath = path.join(REPO, "plugins/agy/scripts/agy-companion.mjs");

if (!existsSync(agyJobRecordPath) || !existsSync(agyCompanionPath)) {
  console.log("SKIPPED: requires AGY plugin (PR #218) - not present on this branch");
  process.exit(0);
}

const { buildJobRecord } = await import(agyJobRecordPath);
const companionSrc = readFileSync(agyCompanionPath, "utf8");

function makeInvocation() {
  return {
    job_id: "job-p5-fixed",
    target: "agy",
    mode: "review",
    mode_profile_name: "review",
    model: "agy-model",
    cwd: "/tmp/p5",
    workspace_root: "/tmp/p5",
    containment: "worktree",
    scope: "branch-diff",
    prompt_head: "review the diff",
    binary: "agy",
    started_at: new Date().toISOString(),
    run_kind: "review",
  };
}

const completedParsed = {
  ok: true,
  result: "Verdict: APPROVE\n\nBlocking findings:\n- None.\n\nNon-blocking concerns:\n- None.",
  structured: null,
  denials: [],
};

function completedRecordWithComputedEmptySource() {
  const redactionFields = {};
  return buildJobRecord(makeInvocation(), {
    exitCode: 0,
    endedAt: new Date().toISOString(),
    parsed: completedParsed,
    pidInfo: null,
    agySessionId: null,
    reviewAuditManifest: null,
    ...redactionFields,
  }, []);
}

const helperPresent = /function\s+redactionFieldsForSelected\s*\(/.test(companionSrc)
  && /sourceRedactionRequired:\s*sourceFilesHaveBodies\(files\)/.test(companionSrc)
  && /sourceFilesForRedaction:\s*files/.test(companionSrc);
const executionForRecordUsesHelper = /function\s+executionForRecord[\s\S]*\.\.\.redactionFieldsForSelected\(selectedFiles\)/.test(companionSrc);
const noHardcodedSelectedPairs = !/sourceFilesForRedaction:\s*sourceFilesForRedaction\(selectedFiles\)[\s\S]{0,120}sourceRedactionRequired:\s*true/.test(companionSrc)
  && !/sourceRedactionRequired:\s*true[\s\S]{0,120}sourceFilesForRedaction:\s*sourceFilesForRedaction\(selectedFiles\)/.test(companionSrc);

let recordStatus = null;
let recordResult = null;
let threw = false;
try {
  const rec = completedRecordWithComputedEmptySource();
  recordStatus = rec.status;
  recordResult = rec.result;
  console.log("CASE fixed empty-source completed record: NO THROW - status=" + rec.status);
} catch (e) {
  threw = true;
  console.log("CASE fixed empty-source completed record: THREW -> " + e.message);
}

console.log("---");
console.log("helper redactionFieldsForSelected present:", helperPresent);
console.log("executionForRecord uses helper:", executionForRecordUsesHelper);
console.log("hardcoded selected-file redaction pairs absent:", noHardcodedSelectedPairs);
console.log("empty-source completed record threw:", threw);
console.log("empty-source completed record status:", recordStatus);

const fixed = helperPresent
  && executionForRecordUsesHelper
  && noHardcodedSelectedPairs
  && !threw
  && recordStatus === "completed"
  && recordResult === completedParsed.result;

console.log("VERDICT: " + (fixed
  ? "FIXED - AGY computes redaction fields and empty-source completed records persist."
  : "NOT-FIXED - see output above."));
process.exit(fixed ? 0 : 3);
