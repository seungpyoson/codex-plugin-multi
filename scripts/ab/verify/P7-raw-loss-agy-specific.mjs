// P7 verification: is discarded raw output AGY-SPECIFIC, or a shared job-record behavior?
//
// CORRECTION UNDER TEST: the nulling of parsed.result is AGY-SPECIFIC (AGY companion
// nulls result before record construction), while gemini/kimi/claude store result when
// present AND write stdout/stderr sidecars — so raw-output recovery exists for non-AGY
// providers but not AGY.
//
// Strategy: import the REAL buildJobRecord from agy + gemini job-record.mjs. Feed an
// IDENTICAL execution where the CLI DID produce a non-empty result/stdout, but the run
// is treated as a review FAILURE. Apply each provider's companion-specific transform to
// `parsed` exactly as the real companion does on the failure path, then call the real
// buildJobRecord and inspect the persisted `result`. Separately, check whether each
// provider's companion writes stdout.log/stderr.log sidecars (the recovery path).

import { buildJobRecord as buildGeminiRecord } from "../../../plugins/gemini/scripts/lib/job-record.mjs";
import { existsSync, readFileSync } from "node:fs";

const agyJobRecordUrl = new URL("../../../plugins/agy/scripts/lib/job-record.mjs", import.meta.url);
if (!existsSync(agyJobRecordUrl)) {
  console.log("SKIPPED: requires AGY plugin (PR #218) — not present on this branch");
  process.exit(0);
}
const { buildJobRecord: buildAgyRecord } = await import(agyJobRecordUrl);

const C = (s) => `\x1b[36m${s}\x1b[0m`;
function line() { console.log("-".repeat(72)); }

// ---- Shared, identical raw execution output (the CLI DID produce content) ----
const RAW_STDOUT = '{"ok":true,"result":"REVIEW BODY: 3 findings, see below ...."}';
const RAW_RESULT = "REVIEW BODY: 3 findings, see below ....";

function makeInvocation() {
  return {
    job_id: "job-P7",
    target: "tgt",
    mode: "review",
    mode_profile_name: "default",
    model: "m",
    cwd: "/tmp",
    workspace_root: "/tmp",
    containment: { kind: "none" },
    scope: "repo",
    prompt_head: "p",
    binary: "/bin/true",
    started_at: new Date().toISOString(),
    run_kind: "background",
  };
}

// Execution as it exists at finalize time: CLI succeeded shape-wise, result present.
function makeExecution(parsedOverride) {
  return {
    exitCode: 0,
    endedAt: new Date().toISOString(),
    stdout: RAW_STDOUT,
    stderr: "",
    parsed: parsedOverride,
  };
}

// ---- AGY companion failure-path transform (agy-companion.mjs lines ~1216-1267) ----
// On a review-not-completed / mutation / policy failure, AGY rebuilds `parsed` with
//   result: null   BEFORE calling buildJobRecord.
function agyCompanionFailureTransform(execParsed) {
  return {
    ...execParsed,
    ok: false,
    reason: execParsed.reason ?? "review_not_completed",
    error: execParsed.error ?? "AGY did not produce a substantive review verdict",
    result: null, // <-- the AGY-specific nulling
  };
}

// ---- Gemini companion finalize (gemini-companion.mjs buildGeminiFinalRecord ~1749) ----
// Passes parsed: execution.parsed UNMODIFIED. No result nulling on review failure.
function geminiCompanionFinalizeTransform(execParsed) {
  return execParsed; // pass-through; result retained
}

console.log(C("\n=== P7: AGY-specific raw-output loss vs non-AGY retention ===\n"));

// 1) AGY path
const agyParsed = agyCompanionFailureTransform({ ok: true, result: RAW_RESULT });
const agyRecord = buildAgyRecord(makeInvocation(), makeExecution(agyParsed), []);
console.log(C("AGY companion (failure path) -> buildJobRecord:"));
console.log(`  parsed.result fed in (post-transform): ${JSON.stringify(agyParsed.result)}`);
console.log(`  persisted record.result            : ${JSON.stringify(agyRecord.result)}`);
console.log(`  raw stdout that existed             : ${JSON.stringify(RAW_STDOUT.slice(0, 40))}...`);
line();

// 2) Gemini path (SAME raw execution, treated as the SAME kind of run)
const gemParsed = geminiCompanionFinalizeTransform({ ok: true, result: RAW_RESULT });
const gemRecord = buildGeminiRecord(makeInvocation(), makeExecution(gemParsed), []);
console.log(C("Gemini companion (finalize) -> buildJobRecord:"));
console.log(`  parsed.result fed in (pass-through): ${JSON.stringify(gemParsed.result)}`);
console.log(`  persisted record.result            : ${JSON.stringify(gemRecord.result)}`);
line();

// 3) Sidecar recovery presence: grep the REAL companion sources for stdout.log/stderr.log writes.
function companionWritesRawSidecar(path) {
  const src = readFileSync(path, "utf8");
  return /\[\s*"stdout\.log"\s*,\s*execution\.stdout\s*\]/.test(src)
    || /"stdout\.log"\s*,\s*\w+\.stdout/.test(src);
}
const base = "../../../plugins";
const sidecarTable = [
  ["agy",    new URL(`${base}/agy/scripts/agy-companion.mjs`, import.meta.url)],
  ["gemini", new URL(`${base}/gemini/scripts/gemini-companion.mjs`, import.meta.url)],
  ["kimi",   new URL(`${base}/kimi/scripts/kimi-companion.mjs`, import.meta.url)],
  ["claude", new URL(`${base}/claude/scripts/claude-companion.mjs`, import.meta.url)],
];
console.log(C("Raw stdout/stderr sidecar (recovery path) written by companion?"));
const sidecarResults = {};
for (const [name, url] of sidecarTable) {
  const has = companionWritesRawSidecar(url);
  sidecarResults[name] = has;
  console.log(`  ${name.padEnd(7)} writes stdout.log sidecar: ${has}`);
}
line();

// ---- Verdict ----
const agyLostResult = agyRecord.result === null;
const gemRetainedResult = gemRecord.result === RAW_RESULT;
const agyNoSidecar = sidecarResults.agy === false;
const othersHaveSidecar = sidecarResults.gemini && sidecarResults.kimi && sidecarResults.claude;

console.log(C("VERDICT"));
console.log(`  AGY nulled result in persisted record   : ${agyLostResult}`);
console.log(`  Gemini retained result (same raw input) : ${gemRetainedResult}`);
console.log(`  AGY lacks raw stdout sidecar recovery   : ${agyNoSidecar}`);
console.log(`  gemini+kimi+claude HAVE sidecar recovery: ${othersHaveSidecar}`);

const asymmetryHolds = agyLostResult && gemRetainedResult && agyNoSidecar && othersHaveSidecar;
console.log(`\n  ASYMMETRY HOLDS (AGY loses raw output, non-AGY recoverable): ${asymmetryHolds}`);
process.exit(asymmetryHolds ? 0 : 1);
