import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";

import * as AgyState from "../../plugins/agy/scripts/lib/state.mjs";

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

function functionBody(source, name) {
  const signature = source.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`));
  assert.ok(signature, `missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  assert.fail(`unterminated function ${name}`);
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

test("AGY persistence writers route through the shared durable atomic helper", () => {
  const companionCommonSource = readRepoFile("scripts/lib/companion-common.mjs");
  const stateSource = readRepoFile("plugins/agy/scripts/lib/state.mjs");
  const companionSource = readFileSync(COMPANION, "utf8");

  assert.match(companionCommonSource, /export function writeFileAtomicDurable\(/);
  assert.match(
    stateSource,
    /import\s*\{[\s\S]*\bwriteFileAtomicDurable\b[\s\S]*\}\s*from "\.\/companion-common\.mjs";/,
    "AGY state must import the shared durable writer",
  );
  for (const name of ["saveStateUnlocked", "writeJobFile", "writeJobRecordToFile"]) {
    assert.match(
      functionBody(stateSource, name),
      /writeFileAtomicDurable\(/,
      `${name} must use the shared durable writer`,
    );
  }

  assert.match(
    companionSource,
    /import\s*\{[\s\S]*\bwriteFileAtomicDurable\b[\s\S]*\}\s*from "\.\/lib\/companion-common\.mjs";/,
    "AGY companion must import the shared durable writer for sidecars",
  );
  for (const name of ["writeRuntimeOptionsSidecar", "writeSidecar"]) {
    const body = functionBody(companionSource, name);
    assert.match(body, /writeFileAtomicDurable\(/, `${name} must use the shared durable writer`);
    assert.doesNotMatch(body, /\bwriteFileSync\(/, `${name} must not keep an ad-hoc tmp writer`);
    assert.doesNotMatch(body, /\brenameSync\(/, `${name} must not keep an ad-hoc rename`);
  }
});

test("AGY exported state writers fsync durable records before rename", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-durable-state-"));
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  const fsyncCalls = [];
  let renamedBeforeFsync = false;
  try {
    process.env.AGY_DURABLE_STATE_TEST_DATA = dir;
    AgyState.configureState({
      pluginDataEnv: "AGY_DURABLE_STATE_TEST_DATA",
      fallbackStateRootDir: path.join(dir, "fallback"),
    });
    fs.fsyncSync = function patchedFsync(fd) {
      fsyncCalls.push(fd);
      return originalFsync.call(this, fd);
    };
    fs.renameSync = function patchedRename(from, to) {
      if (String(to).endsWith("meta.json")) {
        renamedBeforeFsync = fsyncCalls.length === 0;
      }
      return originalRename.call(this, from, to);
    };
    syncBuiltinESMExports();

    const jobFile = AgyState.writeJobFile(dir, "durable-job", { id: "durable-job", ok: true });
    AgyState.writeJobRecordToFile(jobFile, { id: "durable-job", ok: false });

    assert.equal(renamedBeforeFsync, false, "meta.json must not be renamed before fsync");
    assert.ok(fsyncCalls.length >= 2, "both AGY job-record writers must fsync through the helper");

    const renameError = new Error("forced durable job rename failure");
    fs.renameSync = function patchedFailingRename() {
      throw renameError;
    };
    assert.throws(
      () => AgyState.writeJobRecordToFile(path.join(dir, "state", "jobs", "failed", "meta.json"), { id: "failed" }),
      (err) => err === renameError,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(dir, "state", "jobs", "failed")).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.fsyncSync = originalFsync;
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    delete process.env.AGY_DURABLE_STATE_TEST_DATA;
    AgyState.configureState({
      pluginDataEnv: "AGY_PLUGIN_DATA",
      fallbackStateRootDir: path.join(tmpdir(), "agy-companion"),
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
