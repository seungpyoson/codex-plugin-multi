import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureGit, fixtureSeedRepo } from "../helpers/fixture-git.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = path.join(REPO_ROOT, "scripts", "provider-readiness-manifest.mjs");

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function reviewRecord({
  provider,
  status = "completed",
  errorCode = null,
  transmission = "sent",
  failedReviewSlot = false,
  mutations = [],
} = {}) {
  return {
    schema_version: 1,
    provider,
    target: provider,
    status,
    error_code: errorCode,
    result: status === "completed" ? "Verdict: APPROVE\nBlocking findings\n- None.\nNon-blocking concerns\n- None.\nChecklist:\n- PASS selected source inspected." : null,
    external_review: {
      source_content_transmission: transmission,
    },
    review_metadata: {
      raw_output: { elapsed_ms: 42 },
      audit_manifest: {
        rendered_prompt_hash: {
          algorithm: "sha256",
          value: "a".repeat(64),
        },
        selected_source: {
          files: [{ path: "fixtures/smoke.js", content_hash: "b".repeat(64), bytes: 45, lines: 3 }],
        },
        review_quality: {
          failed_review_slot: failedReviewSlot,
          semantic_failure_reasons: failedReviewSlot ? ["shallow_output", "missing_verdict"] : [],
        },
      },
    },
    mutations,
  };
}

test("provider readiness manifest normalizes six provider evidence rows", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-evidence-"));
  const outPath = path.join(evidenceDir, "manifest.json");

  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export function add(a, b) {\n  return a + b;\n}\n",
    message: "add smoke fixture",
  });
  const fixtureHead = fixtureGit(fixtureRoot, ["rev-parse", "HEAD"]).stdout.trim();

  writeJson(path.join(evidenceDir, "claude-doctor.json"), { provider: "claude", ready: true, status: "ok" });
  writeJson(path.join(evidenceDir, "claude-review.json"), reviewRecord({ provider: "claude" }));
  writeJson(path.join(evidenceDir, "gemini-doctor.json"), { provider: "gemini", ready: true, status: "ok" });
  writeJson(path.join(evidenceDir, "gemini-review.json"), reviewRecord({ provider: "gemini", mutations: ["?? review-artifact.json"] }));
  writeJson(path.join(evidenceDir, "kimi-doctor.json"), { provider: "kimi", ready: true, status: "ok" });
  writeJson(path.join(evidenceDir, "kimi-review.json"), reviewRecord({
    provider: "kimi",
    status: "failed",
    errorCode: "review_not_completed",
    failedReviewSlot: true,
  }));
  writeJson(path.join(evidenceDir, "grok-doctor.json"), {
    provider: "grok-web",
    ready: false,
    status: "ok",
    error_code: "grok_session_no_runtime_tokens",
  });
  writeJson(path.join(evidenceDir, "deepseek-doctor.json"), { provider: "deepseek", ready: true, status: "ok" });
  writeJson(path.join(evidenceDir, "deepseek-approval.json"), {
    event: "external_review_approval_request",
    source_content_transmission: "not_sent",
    approval_question: "Allow sending 1 selected file?",
    rendered_prompt_hash: { algorithm: "sha256", value: "c".repeat(64) },
    denial_action: { source_content_transmission: "not_sent" },
  });
  writeJson(path.join(evidenceDir, "deepseek-review.json"), reviewRecord({ provider: "deepseek" }));
  writeJson(path.join(evidenceDir, "glm-doctor.json"), { provider: "glm", ready: true, status: "ok" });
  writeJson(path.join(evidenceDir, "glm-approval.json"), {
    event: "external_review_approval_request",
    source_content_transmission: "not_sent",
    approval_question: "Allow sending 1 selected file?",
    rendered_prompt_hash: { algorithm: "sha256", value: "d".repeat(64) },
    denial_action: { source_content_transmission: "not_sent" },
  });

  execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
    "--out", outPath,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.fixture.path, fixtureRoot);
  assert.equal(manifest.fixture.head_sha, fixtureHead);
  assert.equal(manifest.providers.length, 6);
  assert.deepEqual(manifest.providers.map((row) => row.provider), ["claude", "gemini", "kimi", "grok", "deepseek", "glm"]);

  const rows = Object.fromEntries(manifest.providers.map((row) => [row.provider, row]));
  assert.equal(rows.claude.failure_class, "none");
  assert.equal(rows.claude.review_status, "completed");
  assert.equal(rows.claude.source_content_transmission, "sent");
  assert.equal(rows.claude.failed_review_slot, false);
  assert.equal(rows.claude.prompt_persistence_status, "hash_only");

  assert.equal(rows.gemini.mutation_status, "dirty");
  assert.equal(rows.kimi.failure_class, "review_quality");
  assert.equal(rows.kimi.failed_review_slot, true);
  assert.equal(rows.grok.failure_class, "session_tokens");
  assert.equal(rows.grok.review_status, "not_run");
  assert.equal(rows.deepseek.approval_status, "not_sent");
  assert.equal(rows.deepseek.source_content_transmission, "sent");
  assert.equal(rows.glm.approval_status, "not_sent");
  assert.equal(rows.glm.review_status, "not_run");
  assert.equal(rows.glm.failure_class, "approval_gate");
  assert.equal(rows.glm.prompt_persistence_status, "hash_only");

  assert.equal(manifest.summary.providers_total, 6);
  assert.equal(manifest.summary.prompt_persistence_failures, 0);
  assert.equal(manifest.summary.review_quality_failures, 1);
  assert.equal(JSON.stringify(manifest).includes("export function add"), false);
});

test("provider readiness manifest flags persisted full prompt keys", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-prompt-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-prompt-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "claude-doctor.json"), { ready: true, status: "ok" });
  writeJson(path.join(evidenceDir, "claude-review.json"), {
    ...reviewRecord({ provider: "claude" }),
    prompt: "full rendered prompt with selected source",
  });

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const claude = manifest.providers.find((row) => row.provider === "claude");
  assert.equal(claude.prompt_persistence_status, "full_prompt_found");
  assert.equal(manifest.summary.prompt_persistence_failures, 1);
});

test("provider readiness manifest classifies direct api doctor-only evidence as approval gate", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-direct-api-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-direct-api-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "deepseek-doctor.json"), { ready: true, status: "ok" });

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const deepseek = manifest.providers.find((row) => row.provider === "deepseek");
  assert.equal(deepseek.approval_status, "missing");
  assert.equal(deepseek.review_status, "not_run");
  assert.equal(deepseek.failure_class, "approval_gate");
});

test("provider readiness manifest classifies direct api review without approval proof as approval gate", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-missing-approval-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-missing-approval-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "deepseek-doctor.json"), { ready: true, status: "ok" });
  writeJson(path.join(evidenceDir, "deepseek-review.json"), reviewRecord({ provider: "deepseek" }));

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const deepseek = manifest.providers.find((row) => row.provider === "deepseek");
  assert.equal(deepseek.approval_status, "missing");
  assert.equal(deepseek.review_status, "completed");
  assert.equal(deepseek.failure_class, "approval_gate");
});

test("provider readiness manifest does not resolve git through caller PATH", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-safe-git-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-safe-git-evidence-"));
  const fakeBin = mkdtempSync(path.join(tmpdir(), "provider-readiness-fake-bin-"));
  const marker = path.join(fakeBin, "called");
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });
  writeJson(path.join(evidenceDir, "claude-doctor.json"), { ready: true, status: "ok" });
  writeFileSync(path.join(fakeBin, "git"), `#!/bin/sh\ntouch "${marker}"\nexit 99\n`, "utf8");
  chmodSync(path.join(fakeBin, "git"), 0o700);

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
  });

  const manifest = JSON.parse(stdout);
  assert.equal(manifest.fixture.selected_files[0].path, "fixtures/smoke.js");
  assert.equal(existsSync(marker), false);
});
