// P2 reproduction: Root 2 silent-lossy mislabel.
// Imports REAL repo modules and exercises the gemini empty-output path
// plus the usage-limit classifier directly.
//
// CLAIM: benign stderr containing "quota" (non-billing) and an empty-stdout
// timeout get mislabeled as usage_limited (or otherwise mask the real failure).
//
// We import the real classifier from scripts/lib/usage-limit.mjs and the real
// gemini parse path from plugins/gemini/scripts/lib/gemini.mjs.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { isUsageLimitDetail, usageLimitMessage } from "../../lib/usage-limit.mjs";
import { parseGeminiResult } from "../../../plugins/gemini/scripts/lib/gemini.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
console.log("repo verify dir:", here);

let pinned = false;
const lines = [];
function note(s) { lines.push(s); console.log(s); }

// ---------------------------------------------------------------------------
// (a) Benign stderr containing the bare word "quota" in a NON-billing context.
// e.g. a filesystem disk-quota warning, or a tool mentioning "quota" generically.
// ---------------------------------------------------------------------------
const benignStderr =
  "warning: /tmp scratch space near disk quota for project files; continuing";

console.log("\n=== (a) benign stderr with 'quota' (non-billing) ===");
note(`isUsageLimitDetail(benign)        = ${isUsageLimitDetail(benignStderr)}`);
note(`usageLimitMessage(benign)         = ${JSON.stringify(usageLimitMessage(benignStderr))}`);

// Drive through the REAL gemini empty-output path: empty stdout + benign stderr.
const resA = parseGeminiResult("", benignStderr);
note(`parseGeminiResult('', benign).reason = ${JSON.stringify(resA.reason)}`);
note(`parseGeminiResult('', benign).error  = ${JSON.stringify(resA.error)}`);
if (resA.reason === "usage_limited") {
  pinned = true;
  note(">>> MISLABEL CONFIRMED: benign 'quota' stderr -> reason=usage_limited (real stderr hidden)");
}

// ---------------------------------------------------------------------------
// Additional benign phrasings that the bare /\bquota\b/i matcher swallows.
// ---------------------------------------------------------------------------
const benignVariants = [
  "INFO: rate quota reset scheduled; no action needed",
  "debug: parsed 'quota' field from tool config schema",
  "Note: your project has plenty of remaining quota headroom",
];
console.log("\n=== benign 'quota' variants ===");
for (const v of benignVariants) {
  const r = parseGeminiResult("", v);
  note(`reason=${JSON.stringify(r.reason)}  <- ${JSON.stringify(v)}`);
  if (r.reason === "usage_limited") pinned = true;
}

// ---------------------------------------------------------------------------
// (b) Empty-stdout timeout. spawnGemini passes only (stdout, stderr) to
// parseGeminiResult and never threads `timedOut` in. Simulate a SIGTERM-killed
// run: empty stdout, empty/near-empty stderr. The timeout is lost.
// ---------------------------------------------------------------------------
console.log("\n=== (b) empty-stdout timeout (timedOut NOT threaded) ===");
const resTimeoutEmpty = parseGeminiResult("", "");
note(`parseGeminiResult('', '').reason  = ${JSON.stringify(resTimeoutEmpty.reason)}`);
note("note: spawnGemini calls parseGeminiResult(stdout, stderr) with NO timedOut arg");
note("      -> a timeout that produced empty stdout is reported as 'empty_stdout',");
note("         masking the real cause (timeout).");

// (b2) Timeout whose partial stderr happens to contain 'quota' -> usage_limited,
// fully hiding the timeout.
console.log("\n=== (b2) timeout with partial stderr containing 'quota' ===");
const resTimeoutQuota = parseGeminiResult(
  "",
  "request aborted after deadline; last server hint mentioned quota lookup",
);
note(`reason = ${JSON.stringify(resTimeoutQuota.reason)}`);
note(`error  = ${JSON.stringify(resTimeoutQuota.error)}`);
if (resTimeoutQuota.reason === "usage_limited") {
  pinned = true;
  note(">>> A timed-out run surfaced as usage_limited (timeout completely hidden)");
}

// ---------------------------------------------------------------------------
// Control: a genuine billing message SHOULD classify as usage_limited.
// ---------------------------------------------------------------------------
console.log("\n=== control: genuine billing stderr ===");
const realBilling = "Error: insufficient_quota: you have exceeded your billing limit";
const rc = parseGeminiResult("", realBilling);
note(`reason = ${JSON.stringify(rc.reason)} (expected usage_limited)`);

console.log("\n=== VERDICT ===");
console.log(pinned ? "PINNED: mechanism fired (benign/timeout mislabeled)" : "REFUTED: no mislabel observed");
process.exitCode = 0;
