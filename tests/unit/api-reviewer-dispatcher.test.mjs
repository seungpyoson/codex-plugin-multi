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
