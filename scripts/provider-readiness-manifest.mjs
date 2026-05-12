#!/usr/bin/env node
// Builds a six-provider readiness manifest from doctor, review, and approval
// evidence JSON files. See `npm run readiness:manifest -- --help`.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_GIT_BINARY, gitEnv } from "../plugins/api-reviewers/scripts/lib/git-binary.mjs";
import { cleanGitEnv } from "../plugins/api-reviewers/scripts/lib/git-env.mjs";

const SCHEMA_VERSION = 1;
const PROVIDERS = Object.freeze(["claude", "gemini", "kimi", "grok", "deepseek", "glm"]);
const DIRECT_API_PROVIDERS = new Set(["deepseek", "glm"]);
const TRANSMISSION_VALUES = new Set(["not_sent", "may_be_sent", "sent"]);
const TRUSTED_GIT_ENV = gitEnv(cleanGitEnv());
const USAGE = `Usage: npm run readiness:manifest -- --fixture-root <git-fixture> --evidence-dir <dir> [--out <manifest.json>]

Builds a six-provider readiness manifest for claude, gemini, kimi, grok, deepseek, and glm.
Evidence files are named <provider>-doctor.json, <provider>-review.json, and <provider>-approval.json.
Direct API approval evidence must prove source_content_transmission="not_sent" before source-bearing reviews count as valid.
`;

function parseArgs(argv) {
  const args = Object.create(null);
  if (argv.includes("--help") || argv.includes("-h")) {
    args.help = true;
    return args;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const key = token.slice(2);
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`unsupported option ${token}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    args[key] = value;
  }
  if (!args["fixture-root"]) throw new Error("--fixture-root is required");
  if (!args["evidence-dir"]) throw new Error("--evidence-dir is required");
  return args;
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON evidence file ${file}: ${reason}`);
  }
}

function runGit(cwd, args) {
  return execFileSync(DEFAULT_GIT_BINARY, ["-C", cwd, ...args], { encoding: "utf8", env: TRUSTED_GIT_ENV, timeout: 15000 }).trim();
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fixtureSummary(fixtureRoot) {
  const headSha = runGit(fixtureRoot, ["rev-parse", "HEAD"]);
  const status = runGit(fixtureRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const trackedRaw = execFileSync(DEFAULT_GIT_BINARY, ["-C", fixtureRoot, "ls-files", "-z"], {
    encoding: "utf8",
    env: TRUSTED_GIT_ENV,
    timeout: 15000,
  });
  const selectedFiles = trackedRaw
    .split("\0")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({
      path: file,
      content_hash: sha256File(join(fixtureRoot, file)),
    }));
  return {
    path: fixtureRoot,
    head_sha: headSha,
    status_porcelain: status ? status.split("\n") : [],
    selected_files: selectedFiles,
  };
}

function valueAt(obj, path, fallback = null) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || !(key in cur)) return fallback;
    cur = cur[key];
  }
  return cur;
}

function normalizeTransmission(value) {
  return TRANSMISSION_VALUES.has(value) ? value : "may_be_sent";
}

function containsFullPromptKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsFullPromptKey(item));
  return Object.entries(value).some(([key, child]) => {
    if (/^(prompt|rendered_prompt|renderedPrompt|prompt_text|promptText)$/.test(key)) return true;
    return containsFullPromptKey(child);
  });
}

function hasRenderedPromptHash(value) {
  return Boolean(
    valueAt(value, ["review_metadata", "audit_manifest", "rendered_prompt_hash"], null)
      ?? valueAt(value, ["rendered_prompt_hash"], null),
  );
}

function promptPersistenceStatus(evidence) {
  if (evidence.some((item) => containsFullPromptKey(item))) return "full_prompt_found";
  if (evidence.some((item) => hasRenderedPromptHash(item))) {
    return "hash_only";
  }
  return "not_checked";
}

function doctorStatus(doctor) {
  if (!doctor) return "not_run";
  return doctor.ready === true ? "ready" : "not_ready";
}

function reviewStatus(review) {
  if (!review) return "not_run";
  if (review.status === "completed") return "completed";
  if (review.status === "failed") return "failed";
  return typeof review.status === "string" ? review.status : "failed";
}

function approvalStatus(provider, approval) {
  if (!DIRECT_API_PROVIDERS.has(provider)) return "not_required";
  if (!approval) return "missing";
  if (approval.source_content_transmission === "not_sent"
    && valueAt(approval, ["denial_action", "source_content_transmission"], null) === "not_sent") {
    return "not_sent";
  }
  return "invalid";
}

function errorCode(doctor, review) {
  return review?.error_code
    ?? review?.errorCode
    ?? doctor?.error_code
    ?? doctor?.errorCode
    ?? null;
}

function failureClass({ provider, doctor, review, failedReviewSlot, approvalState }) {
  const code = errorCode(doctor, review);
  if (code === "approval_required") return "approval_gate";
  if (failedReviewSlot === true || code === "review_not_completed" || review?.error_cause === "review_quality") return "review_quality";
  if (code === "sandbox_blocked") return "sandbox";
  if (["not_authed", "oauth_inference_rejected", "auth_not_configured", "session_expired"].includes(code)) return "auth";
  if (["tunnel_unavailable", "grok2api_start_failed", "tunnel_error"].includes(code)) return "tunnel";
  if ([
    "grok_session_no_runtime_tokens",
    "grok_session_malformed_active_token",
    "grok_session_runtime_admin_divergence",
  ].includes(code)) return "session_tokens";
  if (["spawn_failed", "provider_unavailable", "rate_limited", "usage_limited", "timeout", "claude_error", "gemini_error", "kimi_error"].includes(code)) return "provider";
  if (DIRECT_API_PROVIDERS.has(provider)) {
    const doctorReady = doctorStatus(doctor) === "ready";
    if ((doctorReady && !review) || (review && approvalState !== "not_sent")) return "approval_gate";
  }
  if (doctorStatus(doctor) === "not_run" && !review) return "cache_install";
  if (review && reviewStatus(review) !== "completed") return "provider";
  if (doctor && doctorStatus(doctor) !== "ready" && !review) return "provider";
  return "none";
}

function sourceTransmission(review, approval) {
  const reviewValue = valueAt(review, ["external_review", "source_content_transmission"], null);
  if (reviewValue) return normalizeTransmission(reviewValue);
  const approvalValue = approval?.source_content_transmission ?? null;
  if (approvalValue) return normalizeTransmission(approvalValue);
  return "not_sent";
}

function rowFor(provider, evidenceDir) {
  const doctorPath = join(evidenceDir, `${provider}-doctor.json`);
  const reviewPath = join(evidenceDir, `${provider}-review.json`);
  const approvalPath = join(evidenceDir, `${provider}-approval.json`);
  const doctor = readJsonIfExists(doctorPath);
  const review = readJsonIfExists(reviewPath);
  const approval = readJsonIfExists(approvalPath);
  const evidence = [doctor, review, approval].filter(Boolean);
  const failedReviewSlot = valueAt(review, ["review_metadata", "audit_manifest", "review_quality", "failed_review_slot"], null);
  const approvalState = approvalStatus(provider, approval);
  const mutations = Array.isArray(review?.mutations) ? review.mutations : null;
  return {
    provider,
    doctor_status: doctorStatus(doctor),
    review_status: reviewStatus(review),
    approval_status: approvalState,
    failure_class: failureClass({ provider, doctor, review, failedReviewSlot, approvalState }),
    source_content_transmission: sourceTransmission(review, approval),
    failed_review_slot: typeof failedReviewSlot === "boolean" ? failedReviewSlot : null,
    mutation_status: mutations === null ? "not_checked" : (mutations.length === 0 ? "clean" : "dirty"),
    prompt_persistence_status: promptPersistenceStatus(evidence),
    elapsed_ms: valueAt(review, ["review_metadata", "raw_output", "elapsed_ms"], null),
    evidence_path: review ? reviewPath : (approval ? approvalPath : (doctor ? doctorPath : null)),
  };
}

function buildManifest({ fixtureRoot, evidenceDir }) {
  const providers = PROVIDERS.map((provider) => rowFor(provider, evidenceDir));
  const summary = {
    providers_total: providers.length,
    ready_doctors: providers.filter((row) => row.doctor_status === "ready").length,
    completed_reviews: providers.filter((row) => row.review_status === "completed").length,
    review_quality_failures: providers.filter((row) => row.failed_review_slot === true || row.failure_class === "review_quality").length,
    prompt_persistence_failures: providers.filter((row) => row.prompt_persistence_status === "full_prompt_found").length,
    mutation_dirty: providers.filter((row) => row.mutation_status === "dirty").length,
    failure_classes: providers.reduce((acc, row) => {
      acc[row.failure_class] = (acc[row.failure_class] ?? 0) + 1;
      return acc;
    }, {}),
  };
  return {
    schema_version: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    fixture: fixtureSummary(fixtureRoot),
    providers,
    summary,
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true) {
      process.stdout.write(USAGE);
      return;
    }
    const fixtureRoot = resolve(args["fixture-root"]);
    const evidenceDir = resolve(args["evidence-dir"]);
    const manifest = buildManifest({ fixtureRoot, evidenceDir });
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (args.out) {
      const out = resolve(args.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, text, "utf8");
    } else {
      process.stdout.write(text);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`provider-readiness-manifest: ${reason}\n`);
    process.exitCode = 1;
  }
}

main();
