#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import { spawnAgy } from "./lib/agy.mjs";
import { writePromptSidecar, consumePromptSidecar } from "./lib/companion-common.mjs";
import { buildJobRecord } from "./lib/job-record.mjs";
import { sanitizeTargetEnv } from "./lib/provider-env.mjs";

const PROVIDER_DISPLAY = "Google Antigravity CLI";
const DEFAULT_TIMEOUT_MS = 900000;

function parseArgs(argv) {
  const options = { _: [] };
  let promptMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (promptMode) {
      options._.push(arg);
      continue;
    }
    if (arg === "--") {
      promptMode = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function commandBinary(options) {
  return typeof options.binary === "string" && options.binary ? options.binary : (process.env.AGY_BINARY || "agy");
}

function commandCwd(options) {
  return resolvePath(typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd());
}

function doctor(rest) {
  const options = parseArgs(rest);
  const binary = commandBinary(options);
  const cwd = commandCwd(options);
  const env = sanitizeTargetEnv(process.env);
  const result = spawnSync(binary, ["models"], { cwd, env, encoding: "utf8", timeout: 30000 });
  if (result.error) {
    writeJson({
      provider: "agy",
      ready: false,
      error_code: "not_found",
      error_message: result.error.message,
      source_content_transmission: "not_sent",
    });
    process.exit(1);
  }
  if (result.status !== 0) {
    writeJson({
      provider: "agy",
      ready: false,
      error_code: "not_ready",
      error_message: String(result.stderr ?? "").trim() || "agy models failed",
      source_content_transmission: "not_sent",
    });
    process.exit(1);
  }
  const models = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  writeJson({
    provider: "agy",
    ready: true,
    status: "ok",
    models,
    source_content_transmission: "not_sent",
  });
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(String(result.stderr ?? "").trim() || `git ${args.join(" ")} failed`);
  }
  return String(result.stdout ?? "");
}

function selectedFilesForBranchDiff(cwd, base) {
  const diffBase = typeof base === "string" && base ? base : "HEAD";
  const names = git(cwd, ["diff", "--name-only", diffBase, "HEAD"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return names.map((filePath) => {
    const absPath = resolvePath(cwd, filePath);
    const content = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
    return {
      path: filePath,
      bytes: Buffer.byteLength(content),
      content_hash: createHash("sha256").update(content).digest("hex"),
      content,
    };
  });
}

function promptFor(userPrompt, selectedFiles) {
  const sourceBlocks = selectedFiles.map((file) => [
    `AGY FILE ${file.path}`,
    "```",
    file.content,
    "```",
  ].join("\n"));
  return [userPrompt, ...sourceBlocks].filter(Boolean).join("\n\n");
}

function hasSubstantiveReview(text) {
  return /Verdict:\s*(APPROVE|REQUEST_CHANGES|COMMENT|FAIL|REJECT)/i.test(text)
    && /Blocking findings/i.test(text);
}

function selectedSourceAudit(selectedFiles) {
  return {
    files: selectedFiles.map(({ path, bytes, content_hash }) => ({ path, bytes, content_hash })),
  };
}

function sourceFilesForRedaction(selectedFiles) {
  return selectedFiles.map(({ path, content }) => ({ path, text: content }));
}

function renderedPromptHash(promptText) {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(promptText).digest("hex"),
  };
}

function jobsDir(cwd) {
  return resolvePath(process.env.AGY_PLUGIN_DATA || resolvePath(cwd, ".relay-agy"), "jobs");
}

function buildInvocation({ jobId, mode, cwd, binary, model, scopeBase, userPrompt, startedAt }) {
  return {
    job_id: jobId,
    target: "agy",
    parent_job_id: null,
    resume_chain: [],
    mode_profile_name: mode,
    mode,
    model: model ?? null,
    cwd,
    workspace_root: cwd,
    containment: "worktree",
    scope: "branch-diff",
    run_kind: "foreground",
    dispose_effective: true,
    scope_base: scopeBase ?? null,
    scope_paths: null,
    prompt_head: userPrompt.slice(0, 200),
    review_prompt_contract_version: 1,
    review_prompt_provider: PROVIDER_DISPLAY,
    schema_spec: null,
    binary,
    started_at: startedAt,
  };
}

function buildAuditManifest({ promptText, selectedFiles, timeoutMs, retryCount, reviewCompleted }) {
  return {
    provider: "agy",
    rendered_prompt_hash: renderedPromptHash(promptText),
    selected_source: selectedSourceAudit(selectedFiles),
    request: { timeout_ms: timeoutMs },
    retry_count: retryCount,
    review_quality: {
      failed_review_slot: !reviewCompleted,
      semantic_failure_reasons: reviewCompleted ? [] : ["missing_verdict"],
    },
  };
}

function externalReview({ jobId, mode, scopeBase, sourceContentTransmission, reviewSlot = null }) {
  return {
    marker: "EXTERNAL REVIEW",
    provider: PROVIDER_DISPLAY,
    run_kind: "foreground",
    job_id: jobId,
    session_id: null,
    parent_job_id: null,
    mode,
    scope: "branch-diff",
    scope_base: scopeBase ?? null,
    scope_paths: null,
    source_content_transmission: sourceContentTransmission,
    review_slot: reviewSlot,
    disclosure: sourceContentTransmission === "sent"
      ? `Selected source content was sent to ${PROVIDER_DISPLAY} for external review.`
      : `Selected source content may be sent to ${PROVIDER_DISPLAY} for external review.`,
  };
}

async function run(rest) {
  const options = parseArgs(rest);
  const mode = options.mode;
  if (!["review", "adversarial-review", "custom-review"].includes(mode)) {
    writeJson({ target: "agy", status: "failed", error_code: "bad_mode", source_content_transmission: "not_sent" });
    process.exit(1);
  }
  const cwd = commandCwd(options);
  const binary = commandBinary(options);
  const timeoutMs = options.timeout_ms ? Number(options.timeout_ms) : DEFAULT_TIMEOUT_MS;
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const userPrompt = options._.join(" ").trim();
  const selectedFiles = selectedFilesForBranchDiff(cwd, options.scope_base);
  const promptText = promptFor(userPrompt, selectedFiles);
  writePromptSidecar(jobsDir(cwd), jobId, promptText);
  const sidecarPrompt = consumePromptSidecar(jobsDir(cwd), jobId) ?? promptText;
  const launch = {
    event: "external_review_launched",
    target: "agy",
    status: "launched",
    job_id: jobId,
    external_review: externalReview({
      jobId,
      mode,
      scopeBase: options.scope_base ?? null,
      sourceContentTransmission: "may_be_sent",
    }),
  };
  if (options.lifecycle_events === "jsonl") writeJson(launch);

  const execution = await spawnAgy(
    { name: mode, sandbox: true, add_dir: true },
    {
      binary,
      cwd,
      env: process.env,
      includeDirPath: cwd,
      model: options.model ?? null,
      promptText: sidecarPrompt,
      timeoutMs,
    },
  );
  const reviewCompleted = execution.parsed.ok
    && execution.exitCode === 0
    && hasSubstantiveReview(execution.parsed.result ?? "");
  const parsed = reviewCompleted
    ? execution.parsed
    : {
      ...execution.parsed,
      ok: false,
      reason: execution.parsed.reason ?? "review_not_completed",
      error: execution.parsed.error ?? "AGY did not produce a substantive review verdict",
      result: null,
    };
  const invocation = buildInvocation({
    jobId,
    mode,
    cwd,
    binary,
    model: options.model ?? null,
    scopeBase: options.scope_base ?? null,
    userPrompt,
    startedAt,
  });
  const record = buildJobRecord(invocation, {
    ...execution,
    parsed,
    reviewAuditManifest: buildAuditManifest({
      promptText: sidecarPrompt,
      selectedFiles,
      timeoutMs,
      retryCount: execution.retryCount ?? 0,
      reviewCompleted,
    }),
    sourceFilesForRedaction: sourceFilesForRedaction(selectedFiles),
    sourceRedactionRequired: true,
  }, []);
  writeJson({ event: "external_review_terminal", ...record });
  process.exit(reviewCompleted ? 0 : 1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "doctor" || command === "setup") {
    doctor(rest);
    return;
  }
  if (command === "run") {
    await run(rest);
    return;
  }
  if (command === "cancel") {
    writeJson({
      target: "agy",
      status: "failed",
      error_code: "not_found",
      source_content_transmission: "not_sent",
    });
    process.exit(1);
  }
  process.stderr.write("Usage: agy-companion.mjs <doctor|run> [options]\n");
  process.exit(1);
}

main().catch((error) => {
  writeJson({
    target: "agy",
    status: "failed",
    error_code: "agy_companion_error",
    error_message: error.message,
    source_content_transmission: "not_sent",
  });
  process.exit(1);
});
