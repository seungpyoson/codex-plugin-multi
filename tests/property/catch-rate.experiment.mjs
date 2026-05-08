// Catch-rate experiment for the sanitization property tests.
//
// The contract verification gate (docs/contracts/sanitization-invariants.md)
// requires: for each prior finding, the corresponding property test must
// be demonstrably capable of catching the bug from random generation
// within 1000 runs — without seeding the specific bug value.
//
// This script reverts each prior fix on an in-memory copy of
// fixture-sanitization.mjs, dynamic-imports the broken module, runs the
// relevant property, and asserts the property fails within 1000 runs.
// If a property fails to catch a bug, the contract is incomplete or the
// generator is too narrow — both are merge-blockers.
//
// Run:  node tests/property/catch-rate.experiment.mjs
// Exits 0 on success (every prior finding caught), 1 on any failure.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import fc from "fast-check";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, "..", "..", "scripts", "lib", "fixture-sanitization.mjs");

const FAILED = [];
const PASSED = [];

async function loadBrokenModule(label, transformSource) {
  const source = await fs.readFile(SOURCE, "utf8");
  const broken = transformSource(source);
  if (broken === source) {
    throw new Error(`catch-rate: revert for "${label}" did not change source`);
  }
  const tmp = path.join(os.tmpdir(), `sanitize-broken-${label.replaceAll(/[^a-z0-9]+/gi, "-")}-${Date.now()}.mjs`);
  await fs.writeFile(tmp, broken, "utf8");
  const mod = await import(url.pathToFileURL(tmp).href);
  return { mod, tmp };
}

// Run a property and return:
//   { caught: true,  shrunk: <counterexample> }   if the property fails (good — we want it to fail on broken)
//   { caught: false, runs: 1000 }                 if 1000 runs pass (bad — property didn't catch)
function runProperty(property, { numRuns = 1000 } = {}) {
  try {
    fc.assert(property, { numRuns });
    return { caught: false, runs: numRuns };
  } catch (err) {
    return { caught: true, error: err.message.split("\n")[0] };
  }
}

function record(label, result) {
  if (result.caught) {
    PASSED.push({ label, error: result.error });
    process.stdout.write(`  ✔ ${label}: caught\n`);
  } else {
    FAILED.push({ label, runs: result.runs });
    process.stdout.write(`  ✖ ${label}: NOT caught after ${result.runs} runs\n`);
  }
}

const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------
// Prior finding 1 — Bearer greedy \S+ ate trailing JSON delimiters.
// Fix: cf56d4c   /Bearer\s+\S+/gi  →  /Bearer\s+[^\s"',}\]\\]+/gi
// Property to catch: I10/I4 (or I4) — surrounding-syntax preservation.
// ---------------------------------------------------------------------

async function testFinding_BearerGreedy() {
  const { mod } = await loadBrokenModule("bearer-greedy", (src) =>
    src.replace(
      'const BEARER_TOKEN = /Bearer\\s+[^\\s"\',}\\]\\\\]+/gi;',
      'const BEARER_TOKEN = /Bearer\\s+\\S+/gi;',
    ),
  );
  const property = fc.property(
    fc.string({ minLength: 4, maxLength: 30 })
      .filter((s) => !/[\s"',}\]\\]/.test(s) && !s.includes(REDACTED)),
    fc.constantFrom('"', "'", "}", "]", ",", " ", "\n"),
    (token, delim) => {
      const host = `pre Bearer ${token}${delim}post`;
      const sanitized = mod.sanitize(host, { architecture: "companion", env: {} });
      const expected = `pre Bearer ${REDACTED}${delim}post`;
      return sanitized === expected;
    },
  );
  record("Bearer-greedy \\S+ ate trailing delimiter", runProperty(property));
}

// ---------------------------------------------------------------------
// Prior finding 2 — Naive [^"]* in JSON Authorization regex.
// Fix: 82c5499   /"Authorization"\s*:\s*"[^"]*"/gi
//             →  /"Authorization"\s*:\s*"(?:[^"\\]|\\.)*"/gi
// Property to catch: I3b — Authorization JSON form (with escapes).
// ---------------------------------------------------------------------

async function testFinding_AuthNaiveJSON() {
  const { mod } = await loadBrokenModule("auth-naive-json", (src) =>
    src.replace(
      'const AUTHORIZATION_HEADER_JSON = /"Authorization"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"/gi;',
      'const AUTHORIZATION_HEADER_JSON = /"Authorization"\\s*:\\s*"[^"]*"/gi;',
    ),
  );
  // Generator: body contains a JSON-escaped quote, simulating Digest's
  // realm=\"x\". Without the escape-aware regex, the naive [^"]* stops
  // at the first \", leaking everything after.
  const property = fc.property(
    fc.stringMatching(/^[A-Za-z0-9_.=+/-]{4,15}$/).filter((s) => !s.includes(REDACTED)),
    fc.stringMatching(/^[A-Za-z0-9_.=+/-]{4,20}$/).filter((s) => !s.includes(REDACTED)),
    (head, tail) => {
      // Random body that contains an escaped quote, then "tail" after.
      // Format: "Authorization":"X realm=\"Y\" Z"
      // The naive regex matches up to the first ", which is the \" — and
      // leaks tail.
      const json = `{"Authorization":"head=${head} realm=\\"r\\" tail=${tail}"}`;
      const sanitized = mod.sanitize(json, { architecture: "companion", env: {} });
      // Property: tail is not in the output (real Authorization payload
      // gone). On naive regex, tail leaks.
      return !sanitized.includes(tail);
    },
  );
  record("Naive [^\"]* JSON Authorization (no escape handling)", runProperty(property));
}

// ---------------------------------------------------------------------
// Prior finding 3 — Companion structured session_id leaks PII.
// Fix: dbc0534 — wholesaleRedact recursing into objects, leaking nested
// fields like { user_id, trace_id }.
// Property to catch: I6 — wholesale redaction of any-type session-id.
// ---------------------------------------------------------------------

async function testFinding_StructuredSessionId() {
  const { mod } = await loadBrokenModule("structured-session-id", (src) =>
    src.replace(
      'function wholesaleRedact(value) {\n  return value == null ? null : REDACTED;\n}',
      // Broken version: recurse into objects/arrays, only flatten strings.
      'function wholesaleRedact(value) {\n'
      + '  if (value == null) return null;\n'
      + '  if (typeof value === "string") return REDACTED;\n'
      + '  if (Array.isArray(value)) return value.map((v) => wholesaleRedact(v));\n'
      + '  if (typeof value === "object") {\n'
      + '    const out = {};\n'
      + '    for (const [k, v] of Object.entries(value)) out[k] = wholesaleRedact(v);\n'
      + '    return out;\n'
      + '  }\n'
      + '  return REDACTED;\n'
      + '}',
    ),
  );
  // Property: a non-null value of any type at the session_id key is the
  // string [REDACTED]. Broken version preserves object structure.
  const property = fc.property(
    fc.constantFrom("claude_session_id", "kimiSessionId"),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.string({ minLength: 1, maxLength: 5 }), { maxKeys: 3 })
      .filter((d) => Object.keys(d).length > 0),
    (key, value) => {
      const sanitized = mod.sanitize({ [key]: value }, { architecture: "companion", env: {} });
      return sanitized[key] === REDACTED;
    },
  );
  record("Companion session_id structured-value leaks PII", runProperty(property));
}

// ---------------------------------------------------------------------
// Prior finding 4 — Overlapping env values: short-first redaction left
// suffix tail of long secret exposed.
// Fix: 50c21a0 + reinforced — sort secrets by length descending.
// Property to catch: I13 — permutation invariance.
// ---------------------------------------------------------------------

async function testFinding_OverlappingEnvOrder() {
  const { mod } = await loadBrokenModule("overlap-no-sort", (src) =>
    src.replace(
      "const sortedSecrets = [...secrets].sort((a, b) => b.length - a.length);",
      "const sortedSecrets = [...secrets];", // Skip the sort — insertion order leaks.
    ),
  );
  // Set is iterated in insertion order; if we add the SHORTER one first,
  // the broken redactor processes it first and leaks the suffix of the
  // longer secret. Since we're testing permutation invariance, the
  // property compares two permutations.
  const property = fc.property(
    fc.stringMatching(/^[A-Za-z0-9]{8,15}$/).filter((s) => !s.includes(REDACTED)),
    fc.stringMatching(/^[A-Za-z0-9]{1,5}$/).filter((s) => !s.includes(REDACTED)),
    (longSecret, extraTail) => {
      const longerSecret = longSecret + extraTail;
      const planted = `prefix:${longerSecret}:suffix`;
      // Two env objects, same secrets, different insertion order. With
      // the sort gone, the iteration order matters — and JS Set
      // iterates in insertion order, so the short one consumed first
      // (forward) leaves a different output than the long one consumed
      // first (reverse).
      const a = mod.sanitize(planted, {
        architecture: "companion",
        env: { MY_TOKEN: longSecret, OTHER_TOKEN: longerSecret },
      });
      const b = mod.sanitize(planted, {
        architecture: "companion",
        env: { OTHER_TOKEN: longerSecret, MY_TOKEN: longSecret },
      });
      return a === b
        && !a.includes(longerSecret)
        && !a.includes(longSecret);
    },
  );
  record("Overlapping env values: insertion-order leak of suffix tail", runProperty(property));
}

// ---------------------------------------------------------------------
// Prior finding 5 — macOS-only PATH_SCRUB missed Linux/Windows.
// (Just-now finding, surfaced by I5 panel review.)
// Fix: this PR — PATH_SCRUB_PATTERNS array (macOS + Linux + Windows).
// Property to catch: I5 — cross-platform paths scrubbed.
// ---------------------------------------------------------------------

async function testFinding_PathScrubMacOnly() {
  const { mod } = await loadBrokenModule("path-mac-only", (src) =>
    src.replace(
      /const PATH_SCRUB_PATTERNS = Object\.freeze\(\[[\s\S]*?\]\);/,
      `const PATH_SCRUB_PATTERNS = Object.freeze([
  { regex: /\\/Users\\/[^/\\s\\\\]+/g, replacement: "/Users/<user>" },
]);`,
    ),
  );
  // Generator: emits Linux or Windows path. Without those patterns, the
  // broken redactor leaves them intact.
  const property = fc.property(
    fc.constantFrom("/home/", "C:\\Users\\"),
    fc.stringMatching(/^[A-Za-z0-9_-]{3,15}$/),
    (prefix, username) => {
      const planted = `${prefix}${username}/some/file`;
      const sanitized = mod.sanitize(planted, { architecture: "companion", env: {} });
      return !sanitized.includes(`${prefix}${username}`);
    },
  );
  record("PATH_SCRUB macOS-only (missed Linux/Windows)", runProperty(property));
}

// ---------------------------------------------------------------------
// Run all and report.
// ---------------------------------------------------------------------

const FINDINGS = [
  testFinding_BearerGreedy,
  testFinding_AuthNaiveJSON,
  testFinding_StructuredSessionId,
  testFinding_OverlappingEnvOrder,
  testFinding_PathScrubMacOnly,
];

process.stdout.write("Catch-rate experiment\n");
process.stdout.write("─────────────────────\n");
for (const fn of FINDINGS) {
  await fn();
}
process.stdout.write("─────────────────────\n");
process.stdout.write(`Findings caught: ${PASSED.length}/${PASSED.length + FAILED.length}\n`);
if (FAILED.length > 0) {
  process.stdout.write("\nMissed findings (property test could not catch from random generation):\n");
  for (const f of FAILED) process.stdout.write(`  - ${f.label}\n`);
  process.exit(1);
}
process.exit(0);
