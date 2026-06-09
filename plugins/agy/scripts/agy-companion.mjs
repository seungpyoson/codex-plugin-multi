#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { spawnAgy } from "./lib/agy.mjs";
import {
  consumePromptSidecar,
  externalReviewLaunchedEvent,
  parseLifecycleEventsMode,
  parseScopePathsOption,
  printJson,
  printLifecycleJson,
  scopeBaseForOptions,
  writePromptSidecar,
} from "./lib/companion-common.mjs";
import { buildJobRecord, externalReviewForInvocation } from "./lib/job-record.mjs";
import { sanitizeTargetEnv } from "./lib/provider-env.mjs";
import {
  REVIEW_PROMPT_CONTRACT_VERSION,
  buildReviewAuditManifest,
  buildReviewPrompt,
  buildSelectedSourcePromptBlock,
  scopeResolutionReason,
} from "./lib/review-prompt.mjs";

const PROVIDER_DISPLAY = "Google Antigravity CLI";
const DEFAULT_TIMEOUT_MS = 900000;

function commandBinary(options) {
  return typeof options.binary === "string" && options.binary ? options.binary : (process.env.AGY_BINARY || "agy");
}

function commandCwd(options) {
  return resolvePath(typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd());
}

function doctor(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["binary", "cwd"] });
  const binary = commandBinary(options);
  const cwd = commandCwd(options);
  const env = sanitizeTargetEnv(process.env);
  const result = spawnSync(binary, ["models"], { cwd, env, encoding: "utf8", timeout: 30000 });
  if (result.error) {
    printJson({
      provider: "agy",
      ready: false,
      error_code: "not_found",
      error_message: result.error.message,
      source_content_transmission: "not_sent",
    });
    process.exit(1);
  }
  if (result.status !== 0) {
    printJson({
      provider: "agy",
      ready: false,
      error_code: "not_ready",
      error_message: String(result.stderr ?? "").trim() || "agy models failed",
      source_content_transmission: "not_sent",
    });
    process.exit(1);
  }
  const models = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  printJson({
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
      text: content,
    };
  });
}

function assertScopedRelativePath(cwd, filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("scope_paths_required: custom-review requires explicit --scope-paths");
  }
  if (isAbsolute(filePath)) {
    throw new Error(`scope_base_invalid: custom scope path must be relative: ${filePath}`);
  }
  const absPath = resolvePath(cwd, filePath);
  const relPath = relative(cwd, absPath);
  if (!relPath || relPath === ".." || relPath.startsWith(`..${"/"}`) || isAbsolute(relPath)) {
    throw new Error(`scope_base_invalid: custom scope path escapes workspace: ${filePath}`);
  }
  return absPath;
}

function selectedFilesForCustomScope(cwd, scopePaths) {
  if (!Array.isArray(scopePaths) || scopePaths.length === 0) {
    throw new Error("scope_paths_required: custom-review requires explicit --scope-paths");
  }
  return scopePaths.map((filePath) => {
    const absPath = assertScopedRelativePath(cwd, filePath);
    if (!existsSync(absPath)) {
      throw new Error(`scope_empty: custom scope path does not exist: ${filePath}`);
    }
    const content = readFileSync(absPath, "utf8");
    return {
      path: filePath,
      bytes: Buffer.byteLength(content),
      content_hash: createHash("sha256").update(content).digest("hex"),
      text: content,
    };
  });
}

function resolveReviewScope({ mode, requestedScope, scopeBase, scopePaths, cwd }) {
  const scope = mode === "custom-review" || requestedScope === "custom" ? "custom" : "branch-diff";
  if (scope === "custom") {
    return {
      scope,
      scopeBase: null,
      scopePaths,
      selectedFiles: selectedFilesForCustomScope(cwd, scopePaths),
    };
  }
  return {
    scope,
    scopeBase,
    scopePaths: null,
    selectedFiles: selectedFilesForBranchDiff(cwd, scopeBase),
  };
}

function promptFor({ userPrompt, selectedFiles, mode, cwd, scope, scopeBase, scopePaths }) {
  const contractPrompt = buildReviewPrompt({
    provider: PROVIDER_DISPLAY,
    mode,
    repository: cwd,
    baseRef: scopeBase,
    scope,
    scopePaths,
    userPrompt,
  });
  const selectedSource = buildSelectedSourcePromptBlock(selectedFiles, {
    title: "Selected source",
    delimiterPrefix: "AGY FILE",
  });
  return [contractPrompt, selectedSource].filter(Boolean).join("\n\n");
}

function hasSubstantiveReview(text) {
  return /Verdict:\s*(APPROVE|REQUEST_CHANGES|COMMENT|FAIL|REJECT)/i.test(text)
    && /Blocking findings/i.test(text);
}

function sourceFilesForRedaction(selectedFiles) {
  return selectedFiles.map(({ path, text }) => ({ path, text }));
}

function jobsDir(cwd) {
  return resolvePath(process.env.AGY_PLUGIN_DATA || resolvePath(cwd, ".relay-agy"), "jobs");
}

function buildInvocation({ jobId, mode, cwd, binary, model, scope, scopeBase, scopePaths, userPrompt, startedAt }) {
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
    scope,
    run_kind: "foreground",
    dispose_effective: true,
    scope_base: scopeBase ?? null,
    scope_paths: Array.isArray(scopePaths) ? scopePaths : null,
    prompt_head: userPrompt.slice(0, 200),
    review_prompt_contract_version: 1,
    review_prompt_provider: PROVIDER_DISPLAY,
    schema_spec: null,
    binary,
    started_at: startedAt,
  };
}

function buildAuditManifest({ promptText, selectedFiles, timeoutMs, invocation, result, status, errorCode }) {
  return buildReviewAuditManifest({
    prompt: promptText,
    sourceFiles: selectedFiles,
    request: {
      provider: "agy",
      model: invocation.model,
      timeoutMs,
    },
    promptBuilder: {
      contractVersion: REVIEW_PROMPT_CONTRACT_VERSION,
    },
    scope: {
      name: invocation.scope,
      base: invocation.scope_base,
      paths: invocation.scope_paths,
      reason: scopeResolutionReason({
        scope: invocation.scope,
        scope_base: invocation.scope_base,
        scope_paths: invocation.scope_paths,
      }),
    },
    route: {
      providerId: "agy",
      mode: invocation.mode,
      selectedRoute: "companion_cli",
      routeStep: "agy_print",
      sourceSendApprovalRequired: false,
    },
    result,
    status,
    errorCode,
  });
}

async function run(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: [
      "mode", "model", "cwd", "binary", "scope", "scope-base", "scope-paths",
      "timeout-ms", "lifecycle-events",
    ],
    booleanOptions: ["foreground", "background"],
  });
  const mode = options.mode;
  if (!["review", "adversarial-review", "custom-review"].includes(mode)) {
    printJson({ target: "agy", status: "failed", error_code: "bad_mode", source_content_transmission: "not_sent" });
    process.exit(1);
  }
  const cwd = commandCwd(options);
  const binary = commandBinary(options);
  const timeoutMs = options["timeout-ms"] ? Number(options["timeout-ms"]) : DEFAULT_TIMEOUT_MS;
  const scopeBase = scopeBaseForOptions(options);
  const scopePaths = parseScopePathsOption(options["scope-paths"]);
  const lifecycleEvents = parseLifecycleEventsMode(options["lifecycle-events"]);
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const userPrompt = positionals.join(" ").trim();
  const {
    scope,
    selectedFiles,
  } = resolveReviewScope({
    mode,
    requestedScope: options.scope ?? null,
    scopeBase,
    scopePaths,
    cwd,
  });
  const invocation = buildInvocation({
    jobId,
    mode,
    cwd,
    binary,
    model: options.model ?? null,
    scope,
    scopeBase,
    scopePaths,
    userPrompt,
    startedAt,
  });
  const promptText = promptFor({
    userPrompt,
    selectedFiles,
    mode,
    cwd,
    scope,
    scopeBase,
    scopePaths,
  });
  writePromptSidecar(jobsDir(cwd), jobId, promptText);
  const sidecarPrompt = consumePromptSidecar(jobsDir(cwd), jobId) ?? promptText;
  printLifecycleJson(
    externalReviewLaunchedEvent(invocation, externalReviewForInvocation(invocation, null)),
    lifecycleEvents,
  );

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
  const preliminarilyCompleted = execution.parsed.ok
    && execution.exitCode === 0
    && hasSubstantiveReview(execution.parsed.result ?? "");
  let parsed = preliminarilyCompleted
    ? execution.parsed
    : {
      ...execution.parsed,
      ok: false,
      reason: execution.parsed.reason ?? "review_not_completed",
      error: execution.parsed.error ?? "AGY did not produce a substantive review verdict",
      result: null,
    };
  let recordStatus = preliminarilyCompleted ? "completed" : "failed";
  let recordErrorCode = preliminarilyCompleted ? null : (parsed.reason ?? execution.parsed.reason ?? "review_not_completed");
  let reviewAuditManifest = buildAuditManifest({
    promptText: sidecarPrompt,
    selectedFiles,
    timeoutMs,
    invocation,
    result: preliminarilyCompleted ? (parsed.result ?? "") : "",
    status: recordStatus,
    errorCode: recordErrorCode,
  });
  const reviewCompleted = preliminarilyCompleted
    && reviewAuditManifest.review_quality?.failed_review_slot !== true;
  if (!reviewCompleted) {
    parsed = {
      ...parsed,
      ok: false,
      reason: parsed.reason ?? "review_not_completed",
      error: parsed.error ?? "AGY did not produce a usable review under the shared review-quality contract",
      result: null,
    };
    recordStatus = "failed";
    recordErrorCode = parsed.reason ?? "review_not_completed";
    reviewAuditManifest = buildAuditManifest({
      promptText: sidecarPrompt,
      selectedFiles,
      timeoutMs,
      invocation,
      result: "",
      status: recordStatus,
      errorCode: recordErrorCode,
    });
  }
  const record = buildJobRecord(invocation, {
    ...execution,
    parsed,
    reviewAuditManifest,
    sourceFilesForRedaction: sourceFilesForRedaction(selectedFiles),
    sourceRedactionRequired: true,
  }, []);
  printLifecycleJson(record, lifecycleEvents);
  process.exit(record.status === "completed" ? 0 : 1);
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
    printJson({
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
  printJson({
    target: "agy",
    status: "failed",
    error_code: "agy_companion_error",
    error_message: error.message,
    source_content_transmission: "not_sent",
  });
  process.exit(1);
});
