// Executable reproduction for Root 2 (silent-lossy timeout-discard race).
//
// CLAIM: A run that produced a COMPLETE valid parsed review but also timed out
// is discarded as a timeout failure. classifyCompanionExecution returns
// failed/timeout BEFORE the success branch that inspects execution.parsed; and
// parseGeminiResult is called without any timedOut argument, so a fully-parsed
// APPROVE review coexists with timedOut:true on the same execution object.
//
// This script imports the REAL repo modules (no mocks of the units under test)
// and exercises the exact scenario. PINNED if the parsed APPROVE review is
// discarded as a timeout; REFUTED if it survives as completed.

import { parseGeminiResult } from "../../../plugins/gemini/scripts/lib/gemini.mjs";
import { classifyCompanionExecution } from "../../../scripts/lib/external-model-failure-core.mjs";

function line(s = "") { process.stdout.write(s + "\n"); }

// ---------------------------------------------------------------------------
// Step 1: Produce a COMPLETE valid parsed review via the REAL gemini parser.
// This is exactly what gemini.mjs does at `parseGeminiResult(stdout, stderr)`
// on child 'close' -- it parses whatever stdout was captured, with NO timedOut
// argument. We hand it a well-formed Gemini JSON whose `response` is a full
// APPROVE verdict and which carries no `error`.
// ---------------------------------------------------------------------------
const fullApproveReview =
  "Verdict: APPROVE\n\n" +
  "Summary: The change correctly handles the timeout-finalization path. " +
  "All acceptance criteria are met. No blocking issues found.\n\n" +
  "Details:\n- Correctness: PASS\n- Tests: PASS\n- Security: PASS";

const geminiStdout = JSON.stringify({
  session_id: "sess-abc-123",
  response: fullApproveReview,
  structured_output: { verdict: "APPROVE" },
  stats: { tokens: 1234 },
  total_cost_usd: 0.04,
  // NOTE: no `error` field -> parsed.ok must be true
});

const parsed = parseGeminiResult(geminiStdout, "");

line("=== Step 1: real parseGeminiResult output ===");
line("parsed.ok            = " + parsed.ok);
line("parsed.result (head) = " + JSON.stringify((parsed.result || "").slice(0, 24)) + " ...");
line("contains APPROVE     = " + /Verdict:\s*APPROVE/.test(parsed.result || ""));
line("");

if (parsed.ok !== true) {
  line("PRECONDITION FAILED: parser did not yield ok:true; scenario invalid.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Step 2: Build the execution object EXACTLY as gemini.mjs resolves it on
// 'close' when the timeout watchdog already fired: exitCode from SIGTERM kill
// (143/null), timedOut:true, AND the fully-parsed APPROVE review attached.
// This mirrors the resolve({ exitCode, signal, timedOut, parsed, ... }) shape.
// ---------------------------------------------------------------------------
const execution = {
  // When the watchdog SIGTERMs the child, close fires with a signal; exitCode
  // is commonly null. We also test exitCode:0 below to be maximally fair.
  exitCode: null,
  signal: "SIGTERM",
  timedOut: true,
  endedAt: new Date().toISOString(),
  stdout: geminiStdout,
  stderr: "",
  status: "completed",
  errorMessage: null,
  parsed, // <-- the COMPLETE valid APPROVE review survives onto the object
};

line("=== Step 2: execution object handed to classifier ===");
line("execution.timedOut       = " + execution.timedOut);
line("execution.parsed.ok      = " + execution.parsed.ok);
line("execution.parsed APPROVE = " + /Verdict:\s*APPROVE/.test(execution.parsed.result || ""));
line("");

// ---------------------------------------------------------------------------
// Step 3: Run the REAL classifier.
// ---------------------------------------------------------------------------
const result = classifyCompanionExecution(execution, { catchallCode: "provider_error" });

line("=== Step 3: real classifyCompanionExecution result ===");
line(JSON.stringify(result, null, 2));
line("");

// ---------------------------------------------------------------------------
// Control arm: identical parsed APPROVE review but timedOut:false, exitCode:0.
// This is the placebo -- proves the discard is caused by timedOut, not by the
// parsed payload being defective.
// ---------------------------------------------------------------------------
const controlExecution = { ...execution, timedOut: false, exitCode: 0, signal: null };
const controlResult = classifyCompanionExecution(controlExecution, { catchallCode: "provider_error" });
line("=== Control (same parsed review, timedOut:false, exitCode:0) ===");
line(JSON.stringify(controlResult, null, 2));
line("");

// Also test the maximally-fair timeout variant: exitCode:0 BUT timedOut:true,
// to rule out the verdict being an artifact of exitCode:null.
const timeoutButZeroExit = { ...execution, exitCode: 0, signal: null };
const timeoutButZeroExitResult = classifyCompanionExecution(timeoutButZeroExit, { catchallCode: "provider_error" });
line("=== Timeout variant (parsed review, timedOut:true, exitCode:0) ===");
line(JSON.stringify(timeoutButZeroExitResult, null, 2));
line("");

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const discarded =
  result.status !== "completed" && result.error_code === "timeout";
const controlSurvives = controlResult.status === "completed";
const timeoutZeroExitDiscarded =
  timeoutButZeroExitResult.status !== "completed" && timeoutButZeroExitResult.error_code === "timeout";

line("=== VERDICT ===");
line("timed-out run discarded as timeout?        " + discarded);
line("control (no timeout) survives as completed? " + controlSurvives);
line("timeout+exit0 also discarded?               " + timeoutZeroExitDiscarded);

if (discarded && controlSurvives) {
  line("");
  line("RESULT: PINNED -- a complete valid APPROVE review is discarded as a");
  line("timeout failure. The ONLY differing input vs the surviving control is");
  line("timedOut:true, confirming the timeout branch shadows the parsed-success");
  line("branch (silent-lossy discard).");
  process.exit(0);
} else {
  line("");
  line("RESULT: REFUTED -- the parsed review was not discarded due to timeout.");
  process.exit(1);
}
