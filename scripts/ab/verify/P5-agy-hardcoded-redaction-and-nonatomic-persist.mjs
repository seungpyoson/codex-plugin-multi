// P5 reproduction: AGY hardcodes sourceRedactionRequired:true at every
// completed-review job-record build, while kimi/gemini compute it via
// sourceFilesHaveBodies(...). Empty-source completed reviews therefore throw
// in buildJobRecord (assertRequiredSourceRedaction) on AGY and never persist,
// whereas kimi-style redaction fields ({} when no source bodies) do not throw.
//
// Imports the REAL repo modules. Read-only; writes nothing to repo source.
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

const { buildJobRecord } = await import(
  path.join(REPO, "plugins/agy/scripts/lib/job-record.mjs")
);

// Minimal valid invocation satisfying assertInvocation's required-field list.
function makeInvocation() {
  return {
    job_id: "job-p5-test",
    target: "agy",
    mode: "review",
    mode_profile_name: "review",
    model: "agy-model",
    cwd: "/tmp/p5",
    workspace_root: "/tmp/p5",
    containment: "worktree",
    scope: "worktree",
    prompt_head: "review the diff",
    binary: "agy",
    started_at: new Date().toISOString(),
    run_kind: "review",
  };
}

// A *completed* parsed result — a real, successful external review.
const completedParsed = { ok: true, result: "LGTM", structured: null, denials: [] };

// ---------------------------------------------------------------------------
// CASE 1: AGY completed-record path. Mirrors agy-companion.mjs line ~1282-1291:
//   buildJobRecord(invocation, { ...execution, sourceFilesForRedaction: <empty>,
//                                sourceRedactionRequired: true }, mutations)
// when the selected source files have NO bodies (empty array). This is the
// empty-source completed-review case.
// ---------------------------------------------------------------------------
function agyCompletedRecordEmptySource() {
  const execution = {
    exitCode: 0,
    endedAt: new Date().toISOString(),
    parsed: completedParsed,
    pidInfo: null,
    agySessionId: null,
    reviewAuditManifest: null,
    // AGY hardcodes BOTH of these on the completed path:
    sourceFilesForRedaction: [], // empty: no source bodies available
    sourceRedactionRequired: true, // <-- hardcoded literal in agy-companion.mjs
  };
  return buildJobRecord(makeInvocation(), execution, []);
}

// ---------------------------------------------------------------------------
// CASE 2: kimi/gemini-style. They spread `...redactionFieldsForPrompt(prompt)`,
// which returns {} when there are no selected source files (so NEITHER
// sourceRedactionRequired NOR sourceFilesForRedaction is present), and returns
// sourceRedactionRequired: sourceFilesHaveBodies(...) otherwise. Reproduce the
// no-source-file completed review: the redaction fields object is {}.
// ---------------------------------------------------------------------------
function siblingCompletedRecordEmptySource() {
  const redactionFields = {}; // kimi redactionFieldsForPrompt(prompt) with no source files
  const execution = {
    exitCode: 0,
    endedAt: new Date().toISOString(),
    parsed: completedParsed,
    pidInfo: null,
    kimiSessionId: null,
    reviewAuditManifest: null,
    ...redactionFields,
  };
  return buildJobRecord(makeInvocation(), execution, []);
}

let agyThrew = false;
let agyErr = null;
try {
  const rec = agyCompletedRecordEmptySource();
  console.log("CASE1 AGY: NO THROW — status=" + rec.status);
} catch (e) {
  agyThrew = true;
  agyErr = e.message;
  console.log("CASE1 AGY: THREW -> " + e.message);
}

let siblingThrew = false;
try {
  const rec = siblingCompletedRecordEmptySource();
  console.log("CASE2 sibling-style: NO THROW — status=" + rec.status);
} catch (e) {
  siblingThrew = true;
  console.log("CASE2 sibling-style: THREW -> " + e.message);
}

console.log("---");
console.log("AGY hardcoded-true completed record threw on empty source: " + agyThrew);
console.log("Sibling computed-redaction completed record threw on empty source: " + siblingThrew);

const pinned =
  agyThrew &&
  agyErr === "source redaction unavailable: selected source bodies missing for required scan" &&
  !siblingThrew;

console.log(
  "VERDICT: " +
    (pinned
      ? "PINNED — AGY completed review with no source bodies throws in buildJobRecord and never persists; kimi-style does not."
      : "NOT-PINNED — see output above.")
);
process.exit(pinned ? 0 : 3);
