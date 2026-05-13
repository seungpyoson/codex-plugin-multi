import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

test("provider readiness manifest flags message and system prompt persistence", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-prompt-carrier-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-prompt-carrier-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "claude-review.json"), {
    ...reviewRecord({ provider: "claude" }),
    request: {
      messages: [
        { role: "system", content: "full system prompt with source contract" },
        { role: "user", content: "full rendered prompt with selected source" },
      ],
    },
  });
  writeJson(path.join(evidenceDir, "gemini-review.json"), {
    ...reviewRecord({ provider: "gemini" }),
    system_prompt: "full system prompt with selected source",
  });
  writeJson(path.join(evidenceDir, "kimi-review.json"), {
    ...reviewRecord({ provider: "kimi" }),
    rendered_prompt_hash: { algorithm: "sha256", value: "e".repeat(64) },
    result: "The response mentioned a generic content field but persisted no prompt carrier.",
  });

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const rows = Object.fromEntries(manifest.providers.map((row) => [row.provider, row]));
  assert.equal(rows.claude.prompt_persistence_status, "full_prompt_found");
  assert.equal(rows.gemini.prompt_persistence_status, "full_prompt_found");
  assert.equal(rows.kimi.prompt_persistence_status, "hash_only");
  assert.equal(manifest.summary.prompt_persistence_failures, 2);
});

test("provider readiness manifest ignores empty or redacted prompt carriers", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-empty-prompt-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-empty-prompt-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "claude-review.json"), {
    ...reviewRecord({ provider: "claude" }),
    prompt: "",
  });
  writeJson(path.join(evidenceDir, "gemini-review.json"), {
    ...reviewRecord({ provider: "gemini" }),
    system_prompt: null,
  });
  writeJson(path.join(evidenceDir, "kimi-review.json"), {
    ...reviewRecord({ provider: "kimi" }),
    request: {
      messages: [
        { role: "user", content: "" },
      ],
    },
  });

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const rows = Object.fromEntries(manifest.providers.map((row) => [row.provider, row]));
  assert.equal(rows.claude.prompt_persistence_status, "hash_only");
  assert.equal(rows.gemini.prompt_persistence_status, "hash_only");
  assert.equal(rows.kimi.prompt_persistence_status, "hash_only");
  assert.equal(manifest.summary.prompt_persistence_failures, 0);
});

test("provider readiness manifest treats review records without transmission metadata as ambiguous", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-ambiguous-transmission-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-ambiguous-transmission-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  const review = reviewRecord({ provider: "claude" });
  delete review.external_review;
  writeJson(path.join(evidenceDir, "claude-review.json"), review);

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const claude = manifest.providers.find((row) => row.provider === "claude");
  assert.equal(claude.review_status, "completed");
  assert.equal(claude.source_content_transmission, "may_be_sent");
});

test("provider readiness manifest distinguishes missing mutation evidence from no review", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-mutation-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-mutation-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  const review = reviewRecord({ provider: "claude" });
  delete review.mutations;
  writeJson(path.join(evidenceDir, "claude-review.json"), review);

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const rows = Object.fromEntries(manifest.providers.map((row) => [row.provider, row]));
  assert.equal(rows.claude.review_status, "completed");
  assert.equal(rows.claude.mutation_status, "missing");
  assert.equal(rows.gemini.review_status, "not_run");
  assert.equal(rows.gemini.mutation_status, "not_checked");
});

test("provider readiness manifest reports malformed evidence json with file path", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-bad-json-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-bad-json-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  const badJsonPath = path.join(evidenceDir, "claude-doctor.json");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(badJsonPath, "{\"prompt\":\"sensitive-leading-content\"\n", "utf8");

  const res = spawnSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /invalid JSON evidence file/);
  assert.match(res.stderr, /claude-doctor\.json/);
  assert.doesNotMatch(res.stderr, /sensitive-leading-content/);
  assert.doesNotMatch(res.stderr, /prompt/);
});

test("provider readiness manifest prints cli usage", () => {
  const res = spawnSync(process.execPath, [MANIFEST, "--help"], { encoding: "utf8" });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage: npm run readiness:manifest/);
  assert.match(res.stdout, /--fixture-root <git-fixture>/);
  assert.match(res.stdout, /--evidence-dir <dir>/);
});

test("provider readiness manifest reports runtime failures without a stack trace", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-non-git-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-runtime-error-evidence-"));

  const res = spawnSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /provider-readiness-manifest:/);
  assert.doesNotMatch(res.stderr, /\n\s+at\s+/);
  assert.doesNotMatch(res.stderr, /node:internal/);
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
  assert.match(deepseek.next_action, /approval-request/i);
});

test("provider readiness manifest classifies direct api approval-only evidence as missing evidence", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-approval-only-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-approval-only-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "deepseek-approval.json"), {
    event: "external_review_approval_request",
    source_content_transmission: "not_sent",
    denial_action: { source_content_transmission: "not_sent" },
  });

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const deepseek = manifest.providers.find((row) => row.provider === "deepseek");
  assert.equal(deepseek.doctor_status, "not_run");
  assert.equal(deepseek.approval_status, "not_sent");
  assert.equal(deepseek.review_status, "not_run");
  assert.equal(deepseek.failure_class, "missing_evidence");
  assert.match(deepseek.next_action, /Run the provider doctor/i);
});

test("provider readiness manifest tells direct api providers to review after valid approval", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-approved-review-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-approved-review-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "deepseek-doctor.json"), { ready: true, status: "ok" });
  writeJson(path.join(evidenceDir, "deepseek-approval.json"), {
    event: "external_review_approval_request",
    source_content_transmission: "not_sent",
    denial_action: { source_content_transmission: "not_sent" },
  });

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const deepseek = manifest.providers.find((row) => row.provider === "deepseek");
  assert.equal(deepseek.doctor_status, "ready");
  assert.equal(deepseek.approval_status, "not_sent");
  assert.equal(deepseek.review_status, "not_run");
  assert.equal(deepseek.failure_class, "approval_gate");
  assert.match(deepseek.next_action, /run the direct API source review/i);
  assert.doesNotMatch(deepseek.next_action, /approval-request/i);
});

test("provider readiness manifest preserves direct api doctor auth and sandbox classes before approval gate", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-direct-api-preflight-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-direct-api-preflight-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "deepseek-doctor.json"), {
    ready: false,
    status: "error",
    error_code: "sandbox_blocked",
  });
  writeJson(path.join(evidenceDir, "glm-doctor.json"), {
    ready: false,
    status: "error",
    error_code: "not_authed",
  });

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const rows = Object.fromEntries(manifest.providers.map((row) => [row.provider, row]));
  assert.equal(rows.deepseek.failure_class, "sandbox");
  assert.match(rows.deepseek.next_action, /sandbox/i);
  assert.equal(rows.glm.failure_class, "auth");
  assert.match(rows.glm.next_action, /auth/i);
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
  assert.match(deepseek.next_action, /approval proof/i);
});

test("provider readiness manifest classifies invalid direct api approval proof as approval gate", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-invalid-approval-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-invalid-approval-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "deepseek-doctor.json"), { ready: true, status: "ok" });
  writeJson(path.join(evidenceDir, "deepseek-approval.json"), {
    event: "external_review_approval_request",
    source_content_transmission: "sent",
    denial_action: { source_content_transmission: "not_sent" },
  });

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  const deepseek = manifest.providers.find((row) => row.provider === "deepseek");
  assert.equal(deepseek.approval_status, "invalid");
  assert.equal(deepseek.failure_class, "approval_gate");
  assert.match(deepseek.next_action, /Regenerate direct API approval proof/i);
});

test("provider readiness manifest classifies Grok cache and token failures with next actions", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-grok-failures-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-grok-failures-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "grok-doctor.json"), {
    provider: "grok-web",
    ready: false,
    status: "error",
    error_code: "grok2api_uv_missing",
  });

  let stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });
  let grok = JSON.parse(stdout).providers.find((row) => row.provider === "grok");
  assert.equal(grok.failure_class, "cache_install");
  assert.match(grok.next_action, /install or expose uv/i);

  writeJson(path.join(evidenceDir, "grok-doctor.json"), {
    provider: "grok-web",
    ready: false,
    status: "error",
    error_code: "grok_session_no_runtime_tokens",
  });

  stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });
  grok = JSON.parse(stdout).providers.find((row) => row.provider === "grok");
  assert.equal(grok.failure_class, "session_tokens");
  assert.match(grok.next_action, /grok:sync-browser-session|GROK2API_HOME/i);
});

test("provider readiness manifest lets a fresh not-ready doctor override stale review errors", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-stale-review-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-stale-review-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "grok-doctor.json"), {
    provider: "grok-web",
    ready: false,
    status: "error",
    error_code: "grok_session_no_runtime_tokens",
  });
  writeJson(path.join(evidenceDir, "grok-review.json"), reviewRecord({
    provider: "grok-web",
    status: "failed",
    errorCode: "timeout",
    transmission: "sent",
  }));

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const grok = JSON.parse(stdout).providers.find((row) => row.provider === "grok");
  assert.equal(grok.failure_class, "session_tokens");
  assert.match(grok.next_action, /runtime session tokens/i);
});

test("provider readiness manifest lets fresh doctor failures override stale failed-review-slot metadata", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-stale-slot-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-stale-slot-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  writeJson(path.join(evidenceDir, "claude-doctor.json"), {
    provider: "claude",
    ready: false,
    status: "error",
    error_code: "sandbox_blocked",
  });
  writeJson(path.join(evidenceDir, "claude-review.json"), reviewRecord({
    provider: "claude",
    status: "failed",
    errorCode: "review_not_completed",
    failedReviewSlot: true,
  }));

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const claude = JSON.parse(stdout).providers.find((row) => row.provider === "claude");
  assert.equal(claude.failure_class, "sandbox");
  assert.match(claude.next_action, /sandbox/i);
});

test("provider readiness manifest classifies absent evidence as missing evidence", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "provider-readiness-missing-evidence-fixture-"));
  const evidenceDir = mkdtempSync(path.join(tmpdir(), "provider-readiness-missing-evidence-"));
  mkdirSync(path.join(fixtureRoot, "fixtures"), { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  fixtureSeedRepo(fixtureRoot, {
    fileName: "fixtures/smoke.js",
    fileContents: "export const value = 1;\n",
  });

  const stdout = execFileSync(process.execPath, [
    MANIFEST,
    "--fixture-root", fixtureRoot,
    "--evidence-dir", evidenceDir,
  ], { encoding: "utf8" });

  const manifest = JSON.parse(stdout);
  assert.deepEqual(
    manifest.providers.map((row) => row.failure_class),
    ["missing_evidence", "missing_evidence", "missing_evidence", "missing_evidence", "missing_evidence", "missing_evidence"],
  );
  assert.deepEqual(
    manifest.providers.map((row) => row.source_content_transmission),
    ["may_be_sent", "may_be_sent", "may_be_sent", "may_be_sent", "may_be_sent", "may_be_sent"],
  );
  assert.match(manifest.providers[0].next_action, /Run the provider doctor/i);
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
