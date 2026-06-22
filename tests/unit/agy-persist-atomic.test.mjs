import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/agy/scripts/agy-companion.mjs");

function readRepoFile(file) {
  return readFileSync(path.join(REPO_ROOT, file), "utf8");
}

function persistRecordBlock() {
  const source = readFileSync(COMPANION, "utf8");
  const match = /function persistRecord[\s\S]*?\n}\n\nfunction executionForRecord/.exec(source);
  assert.ok(match, "agy-companion.mjs must define persistRecord before executionForRecord");
  return match[0];
}

test("AGY persistRecord commits meta and state through the atomic state primitive", () => {
  const source = readFileSync(COMPANION, "utf8");
  const block = persistRecordBlock();

  assert.match(
    source,
    /import\s*\{[\s\S]*\bcommitJobRecord\b[\s\S]*\}\s*from "\.\/lib\/state\.mjs";/,
    "AGY companion must import commitJobRecord from its state module",
  );
  assert.match(
    block,
    /commitJobRecord\(workspaceRoot,\s*record\.job_id,\s*record\)/,
    "persistRecord must use commitJobRecord so meta.json and state.json update under one state lock",
  );
  assert.doesNotMatch(
    block,
    /writeJobFile\(workspaceRoot,\s*record\.job_id,\s*record\)[\s\S]*upsertJob\(workspaceRoot,\s*record\)/,
    "persistRecord must not revive the legacy non-atomic writeJobFile()+upsertJob() pair",
  );
  assert.match(
    block,
    /isGitBinaryPolicyError\(error\)[\s\S]*writeJobRecordToFile\(fallbackJobFile,\s*record\)/,
    "the git-binary-policy fallback must still write the pre-resolved terminal record git-free",
  );
});

test("AGY state exposes the atomic commit primitive used by persistRecord", () => {
  const stateSource = readRepoFile("plugins/agy/scripts/lib/state.mjs");
  assert.match(stateSource, /export function commitJobRecord\(cwd,\s*jobId,\s*record\)/);
  assert.match(stateSource, /updateState\(cwd,\s*\(state\) => \{/);
  assert.match(stateSource, /writeJobFile\(cwd,\s*jobId,\s*record\)/);
  assert.match(stateSource, /applyJobUpsertToState\(state,\s*record\)/);
});
