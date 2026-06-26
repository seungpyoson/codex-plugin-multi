import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function assertSourceMatches(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

test("api-reviewer source-bearing admission uses canonical stateless facts and fail-loud lease invariant", () => {
  const source = readFileSync(path.join(REPO_ROOT, "plugins/api-reviewers/scripts/api-reviewer.mjs"), "utf8");

  assertSourceMatches(source, /CONCURRENCY_FACTS/, "missing CONCURRENCY_FACTS import/use");
  assertSourceMatches(source, /resolveConcurrencyAdmission/, "missing resolveConcurrencyAdmission import/use");
  assertSourceMatches(source, /direct_api/, "missing direct_api route admission");
  assertSourceMatches(source, /CONCURRENCY_FACTS\[[^\]]+\]\?\.\[[^\]]+\]/, "missing fail-closed fact lookup");
  assertSourceMatches(source, /providerWorkloadBlockedExecution/, "missing providerWorkloadBlockedExecution failure path");
  assertSourceMatches(source, /acquireProviderWorkloadLease\(\{\s*\.\.\.admissionContext/s, "missing admission context spread into lease");
  assertSourceMatches(source, /workloadAdmission\.ok[\s\S]{0,100}workloadAdmission\.lease\s*==\s*null/, "missing null-lease invariant");
  assertSourceMatches(source, /source-bearing admission returned no workload lease/, "missing fail-loud invariant message");
});

test("reviewer terminal record builders are importable for disclosure-boundary tests", () => {
  const apiSource = readFileSync(path.join(REPO_ROOT, "plugins/api-reviewers/scripts/api-reviewer.mjs"), "utf8");
  const grokSource = readFileSync(path.join(REPO_ROOT, "plugins/grok/scripts/grok-web-reviewer.mjs"), "utf8");

  assertSourceMatches(apiSource, /async function runCli\(\)/, "api-reviewer must expose a guarded CLI wrapper");
  // runCli() must be invoked only behind an entry-point guard (never unconditionally at module
  // top level), so importing the module for disclosure-boundary tests does not execute the CLI.
  assertSourceMatches(
    apiSource,
    /if\s*\([^{]*\{\s*await runCli\(\)/,
    "api-reviewer must invoke runCli() only behind an entry-point guard, not unconditionally",
  );
  // The guard must detect direct invocation by comparing the spawned argv against this module's URL
  // (realpath-robust, so a symlinked /tmp spawn path still resolves to the same file).
  assertSourceMatches(
    apiSource,
    /process\.argv\[1\][\s\S]*fileURLToPath\(import\.meta\.url\)/,
    "api-reviewer entry guard must compare argv[1] against import.meta.url",
  );
  assertSourceMatches(apiSource, /export\s*\{[\s\S]*\bbuildRecord\b/, "api-reviewer must export buildRecord");
  assertSourceMatches(grokSource, /export\s*\{[\s\S]*\bbuildRecord\b/, "grok reviewer must export buildRecord");
});
