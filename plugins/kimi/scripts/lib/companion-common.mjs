// Shared companion helper source.
// Edit scripts/lib/companion-common.mjs, then run
// `node scripts/ci/sync-companion-common.mjs` to update plugin packaging copies.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";

export const PING_PROMPT =
  "reply with exactly: pong. Do not use any tools, do not read files, and do not explore the workspace.";

export function printJson(obj, output = process.stdout) {
  output.write(`${JSON.stringify(obj, null, 2)}\n`);
}

export function printJsonLine(obj, output = process.stdout) {
  output.write(`${JSON.stringify(obj)}\n`);
}

export function parseLifecycleEventsMode(value) {
  if (value == null || value === false) return null;
  if (value === "jsonl") return "jsonl";
  throw new Error("--lifecycle-events must be jsonl");
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

export function externalReviewBackgroundLaunchedEvent(invocation, pid, externalReview) {
  return {
    event: "launched",
    job_id: invocation.job_id,
    target: invocation.target,
    ...(invocation.parent_job_id == null ? {} : { parent_job_id: invocation.parent_job_id }),
    mode: invocation.mode,
    pid: pid ?? null,
    workspace_root: invocation.workspace_root,
    external_review: externalReview,
  };
}

export function printLifecycleJson(obj, lifecycleEvents, output = process.stdout) {
  if (lifecycleEvents === "jsonl") printJsonLine(obj, output);
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
  if (lifecycleEvents !== "jsonl") return () => {};
  const interval = Number.isSafeInteger(intervalMs) && intervalMs > 0 ? intervalMs : externalReviewHeartbeatIntervalMs();
  const started = now();
  let sequence = 0;
  const timer = setInterval(() => {
    sequence += 1;
    printLifecycleJson(
      externalReviewProgressEvent(invocation, {
        sequence,
        elapsedMs: now() - started,
      }),
      lifecycleEvents,
      output,
    );
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function effectiveProfileForOptions(profile, options) {
  if (profile.name === "review" && options["scope-base"] != null && options["scope-base"] !== "") {
    return Object.freeze({ ...profile, scope: "branch-diff" });
  }
  return profile;
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

function realpathOrResolve(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return resolvePath(target);
  }
}

function assertRealJobDirectory(jobsDir, dir) {
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
    try { unlinkSync(renamed ? p : tmpFile); } catch { /* already gone */ }
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
  } catch { /* best-effort cleanup after the prompt has been read */ }
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
