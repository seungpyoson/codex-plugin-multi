// P7 regression guard: AGY review-failure finalization must retain produced
// result text and provide stdout/stderr sidecar recovery, matching the shared
// sibling-provider contract.

import { buildJobRecord as buildGeminiRecord } from "../../../plugins/gemini/scripts/lib/job-record.mjs";
import { existsSync, readFileSync } from "node:fs";

const agyJobRecordUrl = new URL("../../../plugins/agy/scripts/lib/job-record.mjs", import.meta.url);
const agyCompanionUrl = new URL("../../../plugins/agy/scripts/agy-companion.mjs", import.meta.url);
if (!existsSync(agyJobRecordUrl) || !existsSync(agyCompanionUrl)) {
  console.log("SKIPPED: requires AGY plugin (PR #218) - not present on this branch");
  process.exit(0);
}
const { buildJobRecord: buildAgyRecord } = await import(agyJobRecordUrl);

const C = (s) => `\x1b[36m${s}\x1b[0m`;
function line() { console.log("-".repeat(72)); }

const RAW_STDOUT = '{"ok":true,"result":"REVIEW BODY: 3 findings, see below ...."}';
const RAW_RESULT = "REVIEW BODY: 3 findings, see below ....";

function makeInvocation() {
  return {
    job_id: "job-P7-fixed",
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

function makeExecution(parsedOverride) {
  return {
    exitCode: 0,
    endedAt: new Date().toISOString(),
    stdout: RAW_STDOUT,
    stderr: "",
    parsed: parsedOverride,
  };
}

function retainedReviewFailureParsed(execParsed) {
  return {
    ...execParsed,
    ok: false,
    reason: execParsed.reason ?? "review_not_completed",
    error: execParsed.error ?? "AGY did not produce a usable review under the shared review-quality contract",
    result: execParsed.result ?? "",
  };
}

console.log(C("\n=== P7: AGY raw-output retention and sidecar recovery ===\n"));

const agyParsed = retainedReviewFailureParsed({ ok: true, result: RAW_RESULT });
const agyRecord = buildAgyRecord(makeInvocation(), makeExecution(agyParsed), []);
console.log(C("AGY fixed failure path -> buildJobRecord:"));
console.log(`  parsed.result fed in          : ${JSON.stringify(agyParsed.result)}`);
console.log(`  persisted record.result       : ${JSON.stringify(agyRecord.result)}`);
console.log(`  raw stdout that existed       : ${JSON.stringify(RAW_STDOUT.slice(0, 40))}...`);
line();

const gemParsed = { ok: false, reason: "review_not_completed", error: "review quality failed", result: RAW_RESULT };
const gemRecord = buildGeminiRecord(makeInvocation(), makeExecution(gemParsed), []);
console.log(C("Gemini failure path -> buildJobRecord:"));
console.log(`  parsed.result fed in          : ${JSON.stringify(gemParsed.result)}`);
console.log(`  persisted record.result       : ${JSON.stringify(gemRecord.result)}`);
line();

function companionWritesRawSidecar(path) {
  const src = readFileSync(path, "utf8");
  return /\[\s*"stdout\.log"\s*,\s*execution\.stdout\s*\]/.test(src)
    && /\[\s*"stderr\.log"\s*,\s*execution\.stderr\s*\]/.test(src);
}

const base = "../../../plugins";
const sidecarTable = [
  ["agy", new URL(`${base}/agy/scripts/agy-companion.mjs`, import.meta.url)],
  ["gemini", new URL(`${base}/gemini/scripts/gemini-companion.mjs`, import.meta.url)],
  ["kimi", new URL(`${base}/kimi/scripts/kimi-companion.mjs`, import.meta.url)],
  ["claude", new URL(`${base}/claude/scripts/claude-companion.mjs`, import.meta.url)],
];
console.log(C("Raw stdout/stderr sidecar written by companion?"));
const sidecarResults = {};
for (const [name, url] of sidecarTable) {
  const has = companionWritesRawSidecar(url);
  sidecarResults[name] = has;
  console.log(`  ${name.padEnd(7)} writes stdout/stderr sidecars: ${has}`);
}
line();

const agyRetainedResult = agyRecord.result === RAW_RESULT;
const gemRetainedResult = gemRecord.result === RAW_RESULT;
const agyHasSidecar = sidecarResults.agy === true;
const othersHaveSidecar = sidecarResults.gemini && sidecarResults.kimi && sidecarResults.claude;

console.log(C("VERDICT"));
console.log(`  AGY retained result in persisted record : ${agyRetainedResult}`);
console.log(`  Gemini retained result (same raw input) : ${gemRetainedResult}`);
console.log(`  AGY has raw stdout/stderr sidecars      : ${agyHasSidecar}`);
console.log(`  gemini+kimi+claude have sidecars        : ${othersHaveSidecar}`);

const fixed = agyRetainedResult && gemRetainedResult && agyHasSidecar && othersHaveSidecar;
console.log(`\n  FIXED CONTRACT HOLDS: ${fixed}`);
process.exit(fixed ? 0 : 1);
