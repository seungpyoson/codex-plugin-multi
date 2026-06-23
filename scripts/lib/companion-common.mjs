// Shared companion helper source.
// Edit scripts/lib/companion-common.mjs, then run
// `node scripts/ci/sync-companion-common.mjs` to update plugin packaging copies.

import fs, { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath, sep } from "node:path";

export const PING_PROMPT =
  "reply with exactly: pong. Do not use any tools, do not read files, and do not explore the workspace.";

function writableOutput(output) {
  return output && typeof output.write === "function" ? output : process.stdout;
}

export function printJson(obj, output = process.stdout) {
  writableOutput(output).write(`${JSON.stringify(obj, null, 2)}\n`);
}

export function printJsonLine(obj, output = process.stdout) {
  writableOutput(output).write(`${JSON.stringify(obj)}\n`);
}

export function consumeJsonSettingsSidecar(file, { unlink = unlinkSync } = {}) {
  if (!existsSync(file)) {
    return {
      value: null,
      cleanup_warning: null,
      cleanup_warning_path: null,
    };
  }
  let value;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    value = null;
  }
  if (value !== null) {
    try {
      unlink(file);
      return {
        value,
        cleanup_warning: null,
        cleanup_warning_path: null,
      };
    } catch {
      return {
        value,
        cleanup_warning: "runtime_options_persisted",
        cleanup_warning_path: file,
      };
    }
  }
  return {
    value: null,
    cleanup_warning: null,
    cleanup_warning_path: null,
  };
}

export function runtimeOptionsSidecarPath(jobsDir, jobId) {
  assertSafeSidecarJobId(jobId);
  return resolvePath(jobsDir, jobId, "runtime-options.json");
}

export function cleanupRuntimeOptionsSidecar(jobsDir, jobId) {
  try {
    consumeJsonSettingsSidecar(runtimeOptionsSidecarPath(jobsDir, jobId));
  } catch {
    // Best-effort cleanup for launcher failure paths where the child process never owns the sidecar.
  }
}

export function parseLifecycleEventsMode(value) {
  if (value == null || value === false) return null;
  if (value === "jsonl") return "jsonl";
  if (value === "markdown") return "markdown";
  throw new Error("--lifecycle-events must be jsonl or markdown");
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function externalReviewFromLifecycle(obj) {
  if (obj?.external_review && typeof obj.external_review === "object") return obj.external_review;
  if (obj?.event !== "external_review_progress") return null;
  const provider = obj?.provider ?? obj?.target ?? "unknown";
  const sourceContentTransmission = sourceContentTransmissionForProgress(obj);
  return {
    marker: "EXTERNAL REVIEW",
    provider,
    run_kind: obj?.run_kind ?? "foreground",
    job_id: obj?.job_id ?? null,
    session_id: null,
    parent_job_id: obj?.parent_job_id ?? null,
    mode: obj?.mode ?? null,
    scope: obj?.scope ?? null,
    scope_base: obj?.scope_base ?? null,
    scope_paths: obj?.scope_paths ?? null,
    source_content_transmission: sourceContentTransmission,
    review_slot: null,
    disclosure: progressDisclosure(provider, sourceContentTransmission),
  };
}

function sourceContentTransmissionForProgress(invocation = {}) {
  return invocation?.source_content_transmission
    ?? invocation?.source_packet_policy?.source_content_transmission
    ?? (invocation?.resume_without_source_resend === true ? "not_sent" : "may_be_sent");
}

function progressDisclosure(provider, sourceContentTransmission) {
  if (sourceContentTransmission === "not_sent") {
    return `Selected source content was not sent to ${provider} for this review step.`;
  }
  if (sourceContentTransmission === "sent") {
    return `Selected source content was sent to ${provider} for external review; the run is in progress.`;
  }
  return `Selected source content may be sent to ${provider} for external review.`;
}

function lifecycleScope(externalReview) {
  const scope = externalReview?.scope ?? "";
  const base = externalReview?.scope_base ?? null;
  const paths = Array.isArray(externalReview?.scope_paths) ? externalReview.scope_paths.join(",") : null;
  return [scope, base, paths].filter(Boolean).join(" ") || "unknown";
}

function lifecycleJobId(obj, externalReview) {
  return externalReview?.job_id ?? obj?.job_id ?? obj?.id ?? null;
}

function lifecycleWorkspace(obj) {
  return obj?.workspace_root ?? obj?.cwd ?? "<workspace>";
}

export function renderLifecycleMarkdown(obj) {
  const externalReview = externalReviewFromLifecycle(obj);
  if (!externalReview) return null;
  const jobId = lifecycleJobId(obj, externalReview);
  const workspace = lifecycleWorkspace(obj);
  const rows = [
    ["Provider", externalReview.provider ?? obj.target ?? "unknown"],
    ["Job", jobId ?? "unknown"],
    ["Session", externalReview.session_id ?? "pending"],
    ["Run", externalReview.run_kind ?? "unknown"],
    ["Mode", externalReview.mode ?? obj.mode ?? "unknown"],
    ["Scope", lifecycleScope(externalReview)],
    ["Source", externalReview.source_content_transmission ?? "unknown"],
    ["Status", obj.status ?? "unknown"],
  ];
  if (jobId) rows.push(["Retrieve", `result --job ${jobId} --cwd ${workspace}`]);
  rows.push(["Panel", `review-panel --workspace ${workspace}`]);
  if (obj.error_code) rows.push(["Error", obj.error_code]);
  if (obj.error_message) rows.push(["Message", obj.error_message]);
  if (obj.error_summary) rows.push(["Summary", obj.error_summary]);
  if (obj.http_status != null) rows.push(["HTTP", obj.http_status]);
  if (obj.suggested_action) rows.push(["Action", obj.suggested_action]);
  if (externalReview.disclosure) rows.push(["Disclosure", externalReview.disclosure]);
  return [
    "### EXTERNAL REVIEW",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([key, value]) => `| ${markdownCell(key)} | ${markdownCell(value)} |`),
    "",
  ].join("\n");
}

export function externalReviewLaunchedEvent(invocation, externalReview) {
  return {
    event: "external_review_launched",
    job_id: invocation.job_id,
    target: invocation.target,
    status: "launched",
    external_review: externalReview,
  };
}

export function externalReviewProgressEvent(invocation, { sequence, elapsedMs }) {
  return {
    event: "external_review_progress",
    job_id: invocation.job_id,
    target: invocation.target,
    status: "running",
    mode: invocation.mode ?? null,
    run_kind: invocation.run_kind ?? "foreground",
    heartbeat: sequence,
    elapsed_ms: Math.max(0, Math.trunc(elapsedMs ?? 0)),
  };
}

function externalReviewProgressMarkdownEvent(invocation, progress) {
  const provider = invocation.review_prompt_provider ?? invocation.provider ?? invocation.target ?? progress.target ?? "unknown";
  const sourceContentTransmission = sourceContentTransmissionForProgress(invocation);
  return {
    ...progress,
    cwd: invocation.cwd ?? null,
    workspace_root: invocation.workspace_root ?? null,
    scope: invocation.scope ?? null,
    scope_base: invocation.scope_base ?? null,
    scope_paths: invocation.scope_paths ?? null,
    source_content_transmission: sourceContentTransmission,
    external_review: {
      marker: "EXTERNAL REVIEW",
      provider,
      run_kind: invocation.run_kind ?? "foreground",
      job_id: invocation.job_id ?? progress.job_id ?? null,
      session_id: null,
      parent_job_id: invocation.parent_job_id ?? null,
      mode: invocation.mode ?? progress.mode ?? null,
      scope: invocation.scope ?? null,
      scope_base: invocation.scope_base ?? null,
      scope_paths: invocation.scope_paths ?? null,
      source_content_transmission: sourceContentTransmission,
      review_slot: null,
      disclosure: progressDisclosure(provider, sourceContentTransmission),
    },
  };
}

export function externalReviewBackgroundLaunchedEvent(invocation, pid, externalReview) {
  return {
    event: "launched",
    job_id: invocation.job_id,
    target: invocation.target,
    status: "launched",
    ...(invocation.parent_job_id == null ? {} : { parent_job_id: invocation.parent_job_id }),
    mode: invocation.mode,
    pid: pid ?? null,
    workspace_root: invocation.workspace_root,
    external_review: externalReview,
  };
}

const TERMINAL_EXTERNAL_REVIEW_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);

function isTerminalExternalReviewRecord(obj) {
  if (!obj?.external_review || typeof obj.external_review !== "object") return false;
  if (obj.event === "external_review_launched" || obj.event === "external_review_progress" || obj.event === "launched") {
    return false;
  }
  return TERMINAL_EXTERNAL_REVIEW_STATUSES.has(obj.status) || obj.result != null || obj.error_code != null;
}

function reviewMetadataProjection(obj) {
  const manifest = obj?.review_metadata?.audit_manifest;
  if (!manifest || typeof manifest !== "object") {
    return obj?.review_metadata && typeof obj.review_metadata === "object" ? { audit_manifest: null } : null;
  }
  const projection = {};
  for (const key of [
    "rendered_prompt_hash",
    "selected_source",
    "scope_resolution",
    "request",
    "selected_route",
    "fallback_reason",
    "approval_scope",
    "source_content_transmission",
    "source_send_approval_required",
    "source_send_approval_state",
    "source_packet_policy",
    "packet_recovery",
  ]) {
    if (manifest[key] !== undefined) projection[key] = manifest[key];
  }
  return Object.keys(projection).length > 0 ? { audit_manifest: projection } : null;
}

function runtimeDiagnosticsProjection(obj) {
  const diagnostics = obj?.runtime_diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const projection = {};
  for (const key of ["source_packet_policy", "packet_recovery"]) {
    if (diagnostics[key] !== undefined) projection[key] = diagnostics[key];
  }
  return Object.keys(projection).length > 0 ? projection : null;
}

function terminalLifecycleProjection(obj) {
  const projection = {
    event: "external_review_terminal",
    id: obj.id ?? obj.job_id ?? null,
    job_id: obj.job_id ?? obj.id ?? null,
    target: obj.target ?? null,
    provider: obj.provider ?? obj.external_review?.provider ?? null,
    mode: obj.mode ?? obj.external_review?.mode ?? null,
    cwd: obj.cwd ?? null,
    workspace_root: obj.workspace_root ?? obj.cwd ?? null,
    prompt_head: obj.prompt_head ?? null,
    status: obj.status ?? "unknown",
    started_at: obj.started_at ?? null,
    ended_at: obj.ended_at ?? null,
    exit_code: obj.exit_code ?? null,
    error_code: obj.error_code ?? null,
    error_message: obj.error_message ?? null,
    error_summary: obj.error_summary ?? null,
    suggested_action: obj.suggested_action ?? null,
    http_status: obj.http_status ?? null,
    external_review: obj.external_review,
  };
  if (obj.disclosure_note != null) projection.disclosure_note = obj.disclosure_note;
  if (obj.review_quality && typeof obj.review_quality === "object") {
    projection.review_quality = {
      failed_review_slot: obj.review_quality.failed_review_slot ?? null,
      reason: obj.review_quality.reason ?? null,
    };
  } else if (obj.review_metadata?.audit_manifest?.review_quality) {
    projection.review_quality = {
      failed_review_slot: obj.review_metadata.audit_manifest.review_quality.failed_review_slot ?? null,
      reason: null,
    };
  }
  const reviewMetadata = reviewMetadataProjection(obj);
  if (reviewMetadata) projection.review_metadata = reviewMetadata;
  const runtimeDiagnostics = runtimeDiagnosticsProjection(obj);
  if (runtimeDiagnostics) projection.runtime_diagnostics = runtimeDiagnostics;
  return projection;
}

function lifecycleJsonlObject(obj) {
  return isTerminalExternalReviewRecord(obj) ? terminalLifecycleProjection(obj) : obj;
}

export function printLifecycleJson(obj, lifecycleEvents, output = process.stdout) {
  if (lifecycleEvents === "jsonl") printJsonLine(lifecycleJsonlObject(obj), output);
  else if (lifecycleEvents === "markdown") {
    const markdown = renderLifecycleMarkdown(obj);
    if (markdown) output.write(markdown);
    else printJsonLine(obj, output);
  }
  else printJson(obj, output);
}

export function externalReviewHeartbeatIntervalMs(env = process.env) {
  const raw = env.CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS;
  if (raw === undefined || raw === null || raw === "") return 30000;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 30000;
}

export function startExternalReviewHeartbeat(
  invocation,
  lifecycleEvents,
  { intervalMs = externalReviewHeartbeatIntervalMs(), output = process.stdout, now = Date.now } = {},
) {
  if (lifecycleEvents !== "jsonl" && lifecycleEvents !== "markdown") return () => {};
  const interval = Number.isSafeInteger(intervalMs) && intervalMs > 0 ? intervalMs : externalReviewHeartbeatIntervalMs();
  const started = now();
  let sequence = 0;
  const timer = setInterval(() => {
    sequence += 1;
    const progress = externalReviewProgressEvent(invocation, {
      sequence,
      elapsedMs: now() - started,
    });
    printLifecycleJson(
      lifecycleEvents === "markdown" ? externalReviewProgressMarkdownEvent(invocation, progress) : progress,
      lifecycleEvents,
      output,
    );
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function effectiveProfileForOptions(profile, options) {
  if ((profile.name === "review" || profile.name === "custom-review") && scopeBaseForOptions(options) !== null) {
    return Object.freeze({ ...profile, scope: "branch-diff" });
  }
  return profile;
}

export function scopeBaseForOptions(options) {
  const value = options["scope-base"];
  if (value == null) return null;
  return String(value).trim() === "" ? null : String(value);
}

export function cancelUnverifiableSuggestedAction(pid) {
  return (
    "Retry cancel from a less restricted shell where process inspection works. " +
    `If you manually inspect pid ${pid} and confirm ownership matches this job, ` +
    "terminate it outside the sandbox; otherwise leave it running and use status/result after it exits."
  );
}

export function cancelNoPidInfoSuggestedAction() {
  return "Use status/result to refresh the job record. Do not signal manually unless you can independently verify process ownership.";
}

export function parseScopePathsOption(value) {
  return value
    ? String(value).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
}

export function comparePathStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function summarizeScopeDirectory(root) {
  const files = [];
  let byteCount = 0;
  function walk(absDir, relDir = "") {
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      const abs = resolvePath(absDir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!ent.isFile()) continue;
      files.push(rel);
      byteCount += statSync(abs).size;
    }
  }
  if (existsSync(root)) walk(root);
  files.sort(comparePathStrings);
  return { files, file_count: files.length, byte_count: byteCount };
}

export function gitStatusLines(output) {
  return output.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

export function runKindFromRecord(record) {
  if (record.external_review?.run_kind) return record.external_review.run_kind;
  return "unknown";
}

const SAFE_JOB_ID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

function assertSafeSidecarJobId(jobId) {
  if (typeof jobId !== "string" || !SAFE_JOB_ID.test(jobId)) {
    throw new Error(`Unsafe jobId: ${JSON.stringify(jobId)}`);
  }
}

function enforcePrivateMode(target, mode) {
  try {
    chmodSync(target, mode);
  } catch (err) {
    if (process.platform === "win32") return;
    throw err;
  }
  if (process.platform === "win32") return;
  const actual = statSync(target).mode & 0o777;
  if (actual !== mode) {
    throw new Error(`${target} mode ${actual.toString(8)} != ${mode.toString(8)}`);
  }
}

export function realpathOrResolve(target) {
  try {
    return realpathSync.native(target);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return resolvePath(target);
    }
    throw err;
  }
}

function fsyncDirectoryBestEffort(dir) {
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // Directory fsync is platform/filesystem dependent. The data file fsync
    // above is mandatory; parent directory durability is best-effort.
  }
}

export function writeFileAtomicDurable(targetPath, data, { mode } = {}) {
  const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  try {
    if (mode === undefined) {
      fs.writeFileSync(tmpFile, data);
    } else {
      fs.writeFileSync(tmpFile, data, { mode });
    }
    const fd = fs.openSync(tmpFile, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (mode !== undefined) {
      fs.chmodSync(tmpFile, mode);
    }
    fs.renameSync(tmpFile, targetPath);
    renamed = true;
    fsyncDirectoryBestEffort(dirname(targetPath));
  } catch (err) {
    if (!renamed) {
      try { fs.unlinkSync(tmpFile); } catch { /* preserve original */ }
    }
    throw err;
  }
}

export function assertRealJobDirectory(jobsDir, dir) {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new Error(`${dir} is not a real directory inside jobsDir`);
  }
  if (!stat.isDirectory()) {
    const err = new Error(`${dir} is not a directory inside jobsDir`);
    err.code = "ENOTDIR";
    throw err;
  }
  const jobsReal = realpathOrResolve(jobsDir);
  const dirReal = realpathOrResolve(dir);
  const jobsPrefix = jobsReal.endsWith(sep) ? jobsReal : `${jobsReal}${sep}`;
  if (!dirReal.startsWith(jobsPrefix)) {
    throw new Error(`${dir} is not a real directory inside jobsDir`);
  }
}

export function promptSidecarPath(jobsDir, jobId) {
  assertSafeSidecarJobId(jobId);
  return resolvePath(jobsDir, jobId, "prompt.txt");
}

function promptSidecarCleanupUncertain(jobId, originalError, cleanupError) {
  const error = new Error(`cleanup_uncertain: prompt sidecar write cleanup failed for ${jobId}`);
  error.code = "cleanup_uncertain";
  error.cause = originalError;
  error.cleanup_error = cleanupError?.message ?? String(cleanupError);
  return error;
}

export function writePromptSidecar(jobsDir, jobId, prompt) {
  assertSafeSidecarJobId(jobId);
  const dir = resolvePath(jobsDir, jobId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertRealJobDirectory(jobsDir, dir);
  enforcePrivateMode(dir, 0o700);
  const p = promptSidecarPath(jobsDir, jobId);
  const tmpFile = `${p}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  try {
    writeFileSync(tmpFile, prompt, { mode: 0o600, encoding: "utf8" });
    enforcePrivateMode(tmpFile, 0o600);
    renameSync(tmpFile, p);
    renamed = true;
    enforcePrivateMode(p, 0o600);
  } catch (err) {
    try {
      unlinkSync(renamed ? p : tmpFile);
    } catch (cleanupErr) {
      if (cleanupErr?.code !== "ENOENT") {
        throw promptSidecarCleanupUncertain(jobId, err, cleanupErr);
      }
    }
    throw err;
  }
}

export function consumePromptSidecar(jobsDir, jobId) {
  assertSafeSidecarJobId(jobId);
  try {
    assertRealJobDirectory(jobsDir, resolvePath(jobsDir, jobId));
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
  const p = promptSidecarPath(jobsDir, jobId);
  let prompt;
  try {
    prompt = readFileSync(p, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
  try {
    unlinkSync(p);
  } catch (err) {
    const error = new Error(`cleanup_uncertain: prompt sidecar cleanup failed for ${jobId}`);
    error.code = "cleanup_uncertain";
    error.cause = err;
    throw error;
  }
  return prompt;
}

export function preflightDisclosure(target) {
  return (
    `Preflight only: ${target} was not spawned, and no selected scope content ` +
    "was sent to the target CLI or external provider. A later successful " +
    `external review still sends the selected files to ${target}.`
  );
}

export function preflightSafetyFields() {
  return {
    target_spawned: false,
    selected_scope_sent_to_provider: false,
    requires_external_provider_consent: true,
  };
}

export function credentialNameDiagnostics(providerApiKeyEnv, env = process.env) {
  const ignored = providerApiKeyEnv.filter((key) => env[key]);
  if (ignored.length === 0) return {};
  return {
    ignored_env_credentials: ignored,
    auth_policy: "api_key_env_ignored",
  };
}
