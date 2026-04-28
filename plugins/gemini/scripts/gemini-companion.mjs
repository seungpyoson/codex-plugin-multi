#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { parseArgs } from "./lib/args.mjs";
import { configureState, resolveJobsDir, resolveJobFile, writeJobFile, upsertJob, listJobs } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { resolveProfile, resolveModelForProfile } from "./lib/mode-profiles.mjs";
import { setupContainment } from "./lib/containment.mjs";
import { populateScope } from "./lib/scope.mjs";
import { newJobId } from "./lib/identity.mjs";
import { buildJobRecord } from "./lib/job-record.mjs";
import { spawnGemini } from "./lib/gemini.mjs";

const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_CONFIG_PATH = resolvePath(PLUGIN_ROOT, "config/models.json");
const READ_ONLY_POLICY = resolvePath(PLUGIN_ROOT, "policies/read-only.toml");
const CONTINUABLE_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);

configureState({
  pluginDataEnv: "GEMINI_PLUGIN_DATA",
  sessionIdEnv: "GEMINI_COMPANION_SESSION_ID",
});

function loadModels() {
  if (!existsSync(MODELS_CONFIG_PATH)) return { cheap: null, medium: null, default: null };
  return JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fail(code, message, details = {}) {
  process.stderr.write(`gemini-companion: ${message}\n`);
  printJson({ ok: false, error: code, message, ...details });
  process.exit(1);
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) {
    delete env[k];
  }
  return env;
}

function gitStatus(args, cwd) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanGitEnv(),
  });
}

function mutationDetectionFailure(error, context = null) {
  const stderr = String(error?.stderr ?? "").trim().split("\n").find(Boolean);
  const message = stderr ?? String(error?.message || error).split("\n").find(Boolean) ?? "unknown error";
  return `mutation_detection_failed: ${context ? `${context}: ` : ""}${message}`;
}

function gitStatusLines(output) {
  return output.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

function invocationFromRecord(record) {
  return {
    job_id: record.job_id,
    target: record.target,
    parent_job_id: record.parent_job_id ?? null,
    resume_chain: record.resume_chain ?? [],
    mode_profile_name: record.mode_profile_name,
    mode: record.mode,
    model: record.model,
    cwd: record.cwd,
    workspace_root: record.workspace_root,
    containment: record.containment,
    scope: record.scope,
    dispose_effective: record.dispose_effective ?? false,
    scope_base: record.scope_base ?? null,
    scope_paths: record.scope_paths ?? null,
    prompt_head: record.prompt_head,
    schema_spec: record.schema_spec ?? null,
    binary: record.binary,
    started_at: record.started_at,
  };
}

function promptSidecarPath(workspaceRoot, jobId) {
  return `${resolveJobsDir(workspaceRoot)}/${jobId}/prompt.txt`;
}

function writePromptSidecar(workspaceRoot, jobId, prompt) {
  const dir = `${resolveJobsDir(workspaceRoot)}/${jobId}`;
  mkdirSync(dir, { recursive: true });
  const p = promptSidecarPath(workspaceRoot, jobId);
  writeFileSync(p, prompt, { mode: 0o600, encoding: "utf8" });
  try { chmodSync(p, 0o600); } catch { /* best-effort on non-POSIX */ }
}

function consumePromptSidecar(workspaceRoot, jobId) {
  const p = promptSidecarPath(workspaceRoot, jobId);
  if (!existsSync(p)) return null;
  const prompt = readFileSync(p, "utf8");
  try { unlinkSync(p); } catch { /* already gone */ }
  return prompt;
}

async function spawnDetachedWorker(cwd, jobId) {
  let child;
  try {
    child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "_run-worker",
      "--cwd", cwd,
      "--job", jobId,
    ], {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    return { child: null, error };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      child.off("spawn", onSpawn);
      child.off("error", onError);
      if (!result.error) child.unref();
      resolve(result);
    };
    const onSpawn = () => settle({ child, error: null });
    const onError = (error) => settle({ child, error });
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function failBackgroundWorkerSpawn(workspaceRoot, invocation, error) {
  consumePromptSidecar(workspaceRoot, invocation.job_id);
  const message = `background worker spawn failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`;
  const errorRecord = buildJobRecord(invocation, {
    exitCode: null,
    parsed: null,
    pidInfo: null,
    geminiSessionId: null,
    errorMessage: message,
  }, []);
  writeJobFile(workspaceRoot, invocation.job_id, errorRecord);
  upsertJob(workspaceRoot, errorRecord);
  fail("spawn_failed", message, { error_code: error?.code ?? null });
}

async function cmdRun(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["mode", "model", "cwd", "binary", "scope-base", "scope-paths", "override-dispose"],
    booleanOptions: ["background", "foreground"],
  });
  const mode = options.mode;
  if (!mode || !["review", "adversarial-review", "rescue"].includes(mode)) {
    fail("bad_args", `--mode must be one of review|adversarial-review|rescue; got ${JSON.stringify(mode)}`);
  }
  if (options.background && options.foreground) {
    fail("bad_args", "--background and --foreground are mutually exclusive");
  }
  const profile = resolveProfile(mode);
  const model = options.model ?? resolveModelForProfile(profile, loadModels()) ?? null;
  if (!model) fail("no_model", "no model resolved; pass --model or populate config/models.json");

  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const prompt = positionals.join(" ").trim();
  if (!prompt) fail("bad_args", "prompt is required (pass after -- separator)");

  const disposeEffective = (() => {
    if (options["override-dispose"] === undefined) return profile.dispose_default;
    const v = String(options["override-dispose"]).toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return profile.dispose_default;
  })();
  const scopePaths = options["scope-paths"]
    ? String(options["scope-paths"]).split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const jobId = newJobId();
  const invocation = Object.freeze({
    job_id: jobId,
    target: "gemini",
    parent_job_id: null,
    resume_chain: [],
    mode_profile_name: profile.name,
    mode,
    model,
    cwd,
    workspace_root: workspaceRoot,
    containment: profile.containment,
    scope: profile.scope,
    dispose_effective: disposeEffective,
    scope_base: options["scope-base"] ?? null,
    scope_paths: scopePaths,
    prompt_head: prompt.slice(0, 200),
    schema_spec: null,
    binary: options.binary ?? process.env.GEMINI_BINARY ?? "gemini",
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeJobFile(workspaceRoot, jobId, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);

  if (options.background) {
    writePromptSidecar(workspaceRoot, jobId, prompt);
    const { child, error } = await spawnDetachedWorker(cwd, jobId);
    if (error) failBackgroundWorkerSpawn(workspaceRoot, invocation, error);
    printJson({
      event: "launched",
      job_id: jobId,
      target: "gemini",
      mode,
      pid: child.pid ?? null,
      workspace_root: workspaceRoot,
    });
    process.exit(0);
  }

  await executeRun(invocation, prompt, { foreground: true });
}

async function executeRun(invocation, prompt, { foreground }) {
  const { job_id: jobId, model, cwd, workspace_root: workspaceRoot, dispose_effective: disposeEffective } = invocation;
  const profile = resolveProfile(invocation.mode_profile_name);
  let containment = null;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: invocation.scope_base,
      scopePaths: invocation.scope_paths,
    }, containment);
  } catch (e) {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
      errorMessage: e.message,
    }, []);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (foreground) printJson(errorRecord);
    process.exit(2);
  }

  const checkMutations = profile.permission_mode === "plan";
  let gitStatusBefore = null;
  let neutralCwd = null;
  const mutations = [];
  if (checkMutations) {
    try {
      neutralCwd = mkdtempSync(joinPath(tmpdir(), "gemini-neutral-cwd-"));
    } catch (e) {
      mutations.push(mutationDetectionFailure(e, "neutral cwd setup failed"));
    }
    try {
      gitStatusBefore = gitStatus(["status", "-s", "--untracked-files=all"], cwd);
      writeSidecar(workspaceRoot, jobId, "git-status-before.txt", gitStatusBefore);
    } catch (e) {
      mutations.push(mutationDetectionFailure(e));
    }
  }

  const resumeId = invocation.resume_chain && invocation.resume_chain.length > 0
    ? invocation.resume_chain[invocation.resume_chain.length - 1]
    : null;

  let execution;
  try {
    execution = await spawnGemini(profile, {
      model,
      promptText: prompt,
      policyPath: profile.permission_mode === "plan" ? READ_ONLY_POLICY : null,
      includeDirPath: containment.path,
      cwd: neutralCwd ?? containment.path,
      binary: invocation.binary,
      resumeId,
      onSpawn: (pidInfo) => {
        const runningRecord = buildJobRecord(invocation, {
          status: "running",
          exitCode: null,
          parsed: null,
          pidInfo,
          geminiSessionId: null,
        }, mutations);
        writeJobFile(workspaceRoot, jobId, runningRecord);
        upsertJob(workspaceRoot, runningRecord);
      },
    });
  } catch (e) {
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
      errorMessage: e.message,
    }, mutations);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
    if (disposeEffective) containment.cleanup();
    if (foreground) printJson(errorRecord);
    process.exit(2);
  }

  // ——— finalization (#16 follow-up 1) ————————————————————————————————
  // See claude-companion.mjs for the three-tier persistence policy.
  // Briefly: meta + state are contractual (fatal on failure with a
  // best-effort failed-fallback record so onSpawn's running entry doesn't
  // persist forever), sidecars are diagnostic (stderr warning, never
  // changes the terminal status).

  if (checkMutations && gitStatusBefore !== null) {
    let gitStatusAfter;
    try {
      gitStatusAfter = gitStatus(["status", "-s", "--untracked-files=all"], cwd);
      try { writeSidecar(workspaceRoot, jobId, "git-status-after.txt", gitStatusAfter); }
      catch (e) { process.stderr.write(`gemini-companion: warning: sidecar git-status-after.txt write failed: ${e.message}\n`); }
    } catch (e) {
      mutations.push(mutationDetectionFailure(e));
      gitStatusAfter = null;
    }
    if (gitStatusAfter && gitStatusAfter !== gitStatusBefore) {
      const beforeLines = new Set(gitStatusLines(gitStatusBefore));
      mutations.push(...gitStatusLines(gitStatusAfter).filter((line) => !beforeLines.has(line)));
    }
  }

  const finalRecord = buildJobRecord(invocation, {
    exitCode: execution.exitCode,
    parsed: execution.parsed,
    pidInfo: execution.pidInfo,
    geminiSessionId: execution.geminiSessionId,
  }, mutations);

  let metaError = null;
  let stateError = null;
  try { writeJobFile(workspaceRoot, jobId, finalRecord); }
  catch (e) { metaError = e; }
  try { upsertJob(workspaceRoot, finalRecord); }
  catch (e) { stateError = e; }

  for (const [name, contents] of [
    ["stdout.log", execution.stdout],
    ["stderr.log", execution.stderr],
  ]) {
    try { writeSidecar(workspaceRoot, jobId, name, contents); }
    catch (e) {
      process.stderr.write(`gemini-companion: warning: sidecar ${name} write failed: ${e.message}\n`);
    }
  }

  if (metaError || stateError) {
    const detail = [
      metaError && `meta=${metaError.message}`,
      stateError && `state=${stateError.message}`,
    ].filter(Boolean).join("; ");
    let fallbackRecord = null;
    try {
      fallbackRecord = buildJobRecord(invocation, {
        exitCode: execution.exitCode,
        parsed: execution.parsed,
        pidInfo: execution.pidInfo,
        geminiSessionId: execution.geminiSessionId ?? null,
        errorMessage: `finalization_failed: ${detail}`,
      }, mutations);
    } catch { /* defense in depth */ }
    if (fallbackRecord) {
      try { writeJobFile(workspaceRoot, jobId, fallbackRecord); } catch { /* exhausted */ }
      try { upsertJob(workspaceRoot, fallbackRecord); } catch { /* exhausted */ }
    }
    if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
    if (containment.disposed && disposeEffective) {
      try { containment.cleanup(); } catch { /* best-effort */ }
    }
    fail("finalization_failed", detail, {
      error_code: (metaError ?? stateError)?.code ?? null,
    });
  }

  if (neutralCwd) rmSync(neutralCwd, { recursive: true, force: true });
  if (containment.disposed && disposeEffective) containment.cleanup();
  if (foreground) printJson(finalRecord);
  process.exit(finalRecord.status === "completed" ? 0 : 2);
}

function writeSidecar(workspaceRoot, jobId, name, contents) {
  const dir = `${resolveJobsDir(workspaceRoot)}/${jobId}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${name}`;
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpFile, contents ?? "", "utf8");
    renameSync(tmpFile, file);
  } catch (e) {
    try { unlinkSync(tmpFile); } catch { /* already gone */ }
    throw e;
  }
}

async function cmdRunWorker(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["cwd", "job"],
    booleanOptions: [],
  });
  if (!options.cwd || !options.job) {
    fail("bad_args", "_run-worker requires --cwd and --job");
  }

  const workspaceRoot = resolveWorkspaceRoot(options.cwd);
  let meta;
  try {
    const jobFile = resolveJobFile(workspaceRoot, options.job);
    if (!existsSync(jobFile)) fail("not_found", `no meta.json for job ${options.job}`);
    meta = JSON.parse(readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }

  if (["completed", "failed", "cancelled", "stale"].includes(meta.status)) {
    fail("bad_state", `_run-worker refuses terminal job ${options.job}`);
  }

  const prompt = consumePromptSidecar(workspaceRoot, options.job);
  if (!prompt) {
    const errorRecord = buildJobRecord(invocationFromRecord(meta), {
      exitCode: null, parsed: null, pidInfo: null, geminiSessionId: null,
      errorMessage: "worker: prompt sidecar missing; job cannot resume",
    }, []);
    writeJobFile(workspaceRoot, options.job, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("bad_state", "prompt sidecar missing for job " + options.job);
  }

  const invocation = invocationFromRecord(meta);
  await executeRun(invocation, prompt, { foreground: false });
}

async function cmdContinue(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["job", "cwd", "model", "binary"],
    booleanOptions: ["background", "foreground"],
  });
  if (!options.job) fail("bad_args", "--job <id> is required");
  if (options.background && options.foreground) {
    fail("bad_args", "--background and --foreground are mutually exclusive");
  }

  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let prior;
  try {
    const jobFile = resolveJobFile(workspaceRoot, options.job);
    if (!existsSync(jobFile)) fail("not_found", `no meta.json for job ${options.job}`);
    prior = JSON.parse(readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }

  if (!CONTINUABLE_STATUSES.has(prior.status)) {
    fail("bad_state", `cannot continue job in status ${JSON.stringify(prior.status)}; wait for terminal status or cancel first`);
  }

  const prompt = positionals.join(" ").trim();
  if (!prompt) fail("bad_args", "prompt is required (pass after -- separator)");

  const priorGeminiSessionId = prior.gemini_session_id ?? null;
  if (!priorGeminiSessionId) {
    fail("bad_args", `prior job ${options.job} has no gemini_session_id to resume`);
  }

  const newJobId_ = newJobId();
  const model = options.model ?? prior.model;
  const priorModeName = prior.mode_profile_name ?? prior.mode;
  const priorProfile = resolveProfile(priorModeName);
  const priorResumeChain = Array.isArray(prior.resume_chain) ? prior.resume_chain : [];
  const invocation = Object.freeze({
    job_id: newJobId_,
    target: "gemini",
    parent_job_id: options.job,
    resume_chain: [...priorResumeChain, priorGeminiSessionId],
    mode_profile_name: priorProfile.name,
    mode: priorModeName,
    model,
    cwd,
    workspace_root: workspaceRoot,
    containment: priorProfile.containment,
    scope: priorProfile.scope,
    dispose_effective: prior.dispose_effective ?? priorProfile.dispose_default,
    scope_base: prior.scope_base ?? null,
    scope_paths: prior.scope_paths ?? null,
    prompt_head: prompt.slice(0, 200),
    schema_spec: prior.schema_spec ?? null,
    binary: options.binary ?? process.env.GEMINI_BINARY ?? "gemini",
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeJobFile(workspaceRoot, newJobId_, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);

  if (options.background) {
    writePromptSidecar(workspaceRoot, newJobId_, prompt);
    const { child, error } = await spawnDetachedWorker(cwd, newJobId_);
    if (error) failBackgroundWorkerSpawn(workspaceRoot, invocation, error);
    printJson({
      event: "launched",
      job_id: newJobId_,
      target: "gemini",
      mode: priorModeName,
      parent_job_id: options.job,
      pid: child.pid ?? null,
      workspace_root: workspaceRoot,
    });
    process.exit(0);
  }

  await executeRun(invocation, prompt, { foreground: true });
}

async function cmdStatus(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["job", "cwd"], booleanOptions: ["all"] });
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  if (options.job) {
    const match = jobs.find((j) => j.id === options.job);
    if (!match) fail("not_found", `no job with id ${options.job} in workspace ${workspaceRoot}`);
    printJson(match);
    return;
  }
  const filtered = options.all
    ? jobs
    : jobs.filter((j) => j.status === "running" || j.status === "completed" || j.status === "failed");
  printJson({ workspace_root: workspaceRoot, jobs: filtered });
}

async function cmdResult(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["job", "cwd"], booleanOptions: [] });
  if (!options.job) fail("bad_args", "--job <id> is required");
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let jobFile;
  try { jobFile = resolveJobFile(workspaceRoot, options.job); }
  catch (e) { fail("bad_args", e.message); }
  if (!existsSync(jobFile)) fail("not_found", `no meta.json for job ${options.job}`);
  printJson(JSON.parse(readFileSync(jobFile, "utf8")));
}

async function cmdPing(rest) {
  const { options } = parseArgs(rest, { valueOptions: ["model", "binary", "timeout-ms"], booleanOptions: [] });
  const profile = resolveProfile("ping");
  const model = options.model ?? resolveModelForProfile(profile, loadModels());
  if (!model) fail("no_model", "no model resolved for ping; pass --model or populate config/models.json");
  try {
    const execution = await spawnGemini(profile, {
      model,
      promptText: "reply with exactly: pong",
      policyPath: READ_ONLY_POLICY,
      cwd: "/tmp",
      binary: options.binary ?? process.env.GEMINI_BINARY ?? "gemini",
      timeoutMs: Number(options["timeout-ms"] ?? 15000),
    });
    if (execution.parsed.ok) {
      printJson({ status: "ok", model, session_id: execution.geminiSessionId, usage: execution.parsed.usage });
      process.exit(0);
    }
    printJson({ status: "error", detail: execution.stderr.trim().slice(0, 500) });
    process.exit(2);
  } catch (e) {
    if (e.code === "ENOENT") {
      printJson({ status: "not_found", detail: "gemini binary not found on PATH (or GEMINI_BINARY override)",
        install_url: "https://github.com/google-gemini/gemini-cli" });
      process.exit(2);
    }
    printJson({ status: "error", detail: e.message });
    process.exit(2);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "run": return cmdRun(rest);
    case "_run-worker": return cmdRunWorker(rest);
    case "ping": return cmdPing(rest);
    case "status": return cmdStatus(rest);
    case "result": return cmdResult(rest);
    case "continue": return cmdContinue(rest);
    case "cancel":
    case "doctor":
      return fail("not_implemented", `'${sub}' lands in a later milestone`);
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write("gemini-companion: see docs/superpowers/specs/ §7 for subcommand surface.\n");
      process.exit(0);
    default:
      fail("bad_args", `unknown subcommand ${JSON.stringify(sub)}`);
  }
}

main().catch((e) => {
  process.stderr.write(`gemini-companion: unhandled: ${e.stack ?? e.message ?? e}\n`);
  process.exit(1);
});
