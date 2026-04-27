#!/usr/bin/env node
// Claude-companion entry. Invokes the Claude CLI on behalf of Codex plugin
// commands and manages the per-workspace job store. Target-specific wiring
// lives here; shared machinery lives in ./lib/.
//
// Subcommands (see spec §7.1):
//   run      --mode=review|adversarial-review|rescue [--background|--foreground]
//            [--model ID] [--cwd PATH] [--scope-base REF]
//            [--scope-paths G1,G2,…] [--override-dispose|--no-override-dispose]
//            -- PROMPT
//   status   [--job ID]
//   result   --job ID
//   cancel   --job ID [--force]
//   ping
//   doctor
//
// Containment (where Claude writes) and scope (what Claude sees) are NOT
// user-facing flags — they are per-profile decisions carried by
// lib/mode-profiles.mjs (spec §21.4). `--isolated` / `--dispose` /
// `--no-dispose` are retired. The only escape hatch is
// `--override-dispose <bool>`, intentionally undocumented in command-file
// snippets.
//
// Subcommands below keep foreground/background lifecycle behavior explicit.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";

import { parseArgs } from "./lib/args.mjs";
import { configureState, getStateConfig, resolveJobsDir, resolveJobFile, writeJobFile, upsertJob, listJobs } from "./lib/state.mjs";
import { configureTrackedJobs } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { spawnClaude } from "./lib/claude.mjs";
import { resolveProfile, resolveModelForProfile } from "./lib/mode-profiles.mjs";
import { setupContainment } from "./lib/containment.mjs";
import { populateScope } from "./lib/scope.mjs";
import { newJobId, verifyPidInfo } from "./lib/identity.mjs";
import { buildJobRecord } from "./lib/job-record.mjs";
import { readFileSync as _readFileSync } from "node:fs";

// ——— plugin-root self-resolution (upstream pattern, spec §4.14) ———
const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// Claude-specific parametrization applied once at startup (spec §6.2).
configureState({
  pluginDataEnv: "CLAUDE_PLUGIN_DATA",
  sessionIdEnv: "CLAUDE_COMPANION_SESSION_ID",
});
configureTrackedJobs({ stderrPrefix: "[claude]" });

const MODELS_CONFIG_PATH = resolvePath(PLUGIN_ROOT, "config/models.json");

function loadModels() {
  if (!existsSync(MODELS_CONFIG_PATH)) return { cheap: null, medium: null, default: null };
  return JSON.parse(_readFileSync(MODELS_CONFIG_PATH, "utf8"));
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fail(code, message, details = {}) {
  process.stderr.write(`claude-companion: ${message}\n`);
  printJson({ ok: false, error: code, message, ...details });
  process.exit(1);
}

// Wraps git command; reports failure separately from successful empty output
// so mutation detection can warn instead of silently reporting "clean".
// Uses execFileSync with an argv array (no shell) to prevent command injection
// through the cwd argument (audit HIGH finding, M2 gate).
// Strip inherited git env vars (GIT_DIR, GIT_INDEX_FILE, ...) so subprocess
// git invocations aren't hijacked by a parent git-hook's repo context. Same
// discipline applies in lib/containment.mjs and lib/scope.mjs.
function cleanGitEnv() {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) {
    delete env[k];
  }
  return env;
}

function tryGit(args, cwd) {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanGitEnv(),
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error };
  }
}

function mutationDetectionFailure(error) {
  const stderr = String(error?.stderr ?? "").trim().split("\n").find(Boolean);
  const message = stderr ?? String(error?.message || error).split("\n").find(Boolean) ?? "unknown error";
  return `mutation_detection_failed: ${message}`;
}

// setupWorktree was deleted in T7.2. Containment lives in
// lib/containment.mjs; scope population lives in lib/scope.mjs. Both are
// per-profile decisions (spec §21.4).

// ——— invocation helpers (T7.4, spec §21.3) ———
//
// `invocation` is the frozen subset of a JobRecord that exists at cmdRun/
// cmdContinue entry — before Claude runs. It carries identity + invocation +
// prompt_head fields, and nothing else. Feeding it to buildJobRecord
// (execution=null) produces the queued record we persist pre-run. Feeding
// it again post-run with the execution tuple produces the terminal record.

// Project an invocation out of a JobRecord (used by the background worker
// when it re-enters executeRun). Only the invocation-phase fields are
// carried — lifecycle/result fields get re-derived from the fresh execution.
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

// Prompt handoff for background jobs. The full prompt is NEVER part of the
// JobRecord (§21.3.1). The detached worker does need it to re-invoke claude,
// so we write it to a private sidecar file `<job>/prompt.txt` with mode 0600
// and DELETE it after the worker reads it. This is a handoff buffer, not a
// persistent store — it lives only for the window between launcher exit and
// worker start, typically milliseconds.
//
// Design choice — sidecar vs stdin: stdio piping would avoid the disk
// round-trip but requires keeping child.stdin open until the worker calls
// readFileSync(0). Node's `detached: true` + `stdio: "ignore"` pattern is
// the stable way to background-launch on macOS/Linux; mixing in an inherited
// stdin complicates orphan cleanup and makes the worker's --version/--help
// debug path harder to test. The 0600 sidecar is simpler, auditable (one
// well-known path), and the worker can be re-run for diagnosis by re-seeding
// the file. The "full prompt text doesn't reach disk" invariant is preserved
// by the unlink-after-read: at no point is the prompt persisted alongside
// the record.
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

// Read-and-delete. Returns null if the sidecar is missing (e.g., foreground
// rerun of a stale queued record, or a pre-T7.4 meta).
function consumePromptSidecar(workspaceRoot, jobId) {
  const p = promptSidecarPath(workspaceRoot, jobId);
  if (!existsSync(p)) return null;
  const prompt = _readFileSync(p, "utf8");
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
    claudeSessionId: null,
    errorMessage: message,
  }, []);
  writeJobFile(workspaceRoot, invocation.job_id, errorRecord);
  upsertJob(workspaceRoot, errorRecord);
  fail("spawn_failed", message, { error_code: error?.code ?? null });
}

// ——— subcommand: run ———
async function cmdRun(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["mode", "model", "cwd", "schema", "binary", "scope-base", "scope-paths", "override-dispose"],
    booleanOptions: ["background", "foreground"],
    aliasMap: {},
  });

  const mode = options.mode;
  if (!mode || !["review", "adversarial-review", "rescue"].includes(mode)) {
    fail("bad_args", `--mode must be one of review|adversarial-review|rescue; got ${JSON.stringify(mode)}`);
  }
  if (options.background && options.foreground) {
    fail("bad_args", "--background and --foreground are mutually exclusive");
  }

  // Mode → profile, resolved EXACTLY ONCE at entry (spec §21.2). No downstream
  // code branches on `mode` to pick a flag — everything flows from `profile`.
  const profile = resolveProfile(mode);

  // Model resolution goes through the profile's tier — the historical
  // ternary that branched on mode but returned "default" on both sides
  // (silent Opus billing, Claude-review finding C2) is gone. `--model`
  // override still wins.
  const model = options.model ?? resolveModelForProfile(profile, loadModels()) ?? null;
  if (!model) {
    fail("no_model", "no model resolved; pass --model or populate config/models.json");
  }

  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // Dispose default lives in the profile (§21.2 field `dispose_default`).
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

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail("bad_args", "prompt is required (pass after -- separator)");
  }

  const jobId = newJobId();
  const startedAt = new Date().toISOString();

  // The single invocation object — frozen, passed unchanged through the
  // pre-run and post-run buildJobRecord calls. No downstream code mutates
  // invocation; adding new invocation fields is a one-place change.
  const invocation = Object.freeze({
    job_id: jobId,
    target: "claude",
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
    prompt_head: prompt.slice(0, 200),          // §21.3.1 — no full prompt
    schema_spec: options.schema ?? null,
    binary: options.binary ?? process.env.CLAUDE_BINARY ?? "claude",
    started_at: startedAt,
  });

  // Pre-run record: status=queued. Goes to disk + state before any child
  // process is launched, so a concurrent `status` can see the new job.
  const queuedRecord = buildJobRecord(invocation, null, []);
  writeJobFile(workspaceRoot, jobId, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);

  if (options.background) {
    // Write prompt to private sidecar (§21.3.1 handoff buffer). Worker reads
    // and deletes — prompt text does NOT live on the JobRecord.
    writePromptSidecar(workspaceRoot, jobId, prompt);

    // Detach a worker process that will execute the run and overwrite the
    // terminal-state meta when done (spec §7.3 / M4).
    const { child, error } = await spawnDetachedWorker(cwd, jobId);
    if (error) failBackgroundWorkerSpawn(workspaceRoot, invocation, error);
    printJson({
      event: "launched",
      job_id: jobId,
      target: "claude",
      mode,
      pid: child.pid ?? null,
      workspace_root: workspaceRoot,
    });
    process.exit(0);
  }

  await executeRun(invocation, prompt, { foreground: true });
}

// Shared execution body. Foreground path calls this directly with the live
// prompt; background worker calls it after reading the prompt sidecar.
// EXACTLY ONE buildJobRecord call per terminal state — §21.3.2 convergence.
async function executeRun(invocation, prompt, { foreground }) {
  const {
    job_id: jobId, mode, model, cwd, workspace_root: workspaceRoot,
    dispose_effective: disposeEffective,
  } = invocation;

  // Re-resolve the profile from the persisted mode NAME (spec §21.2).
  const profile = resolveProfile(invocation.mode_profile_name);

  // T7.2: containment + scope are two independent per-profile decisions.
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
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
      errorMessage: e.message,
    }, []);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (foreground) {
      printJson(errorRecord);
      process.exit(2);
    }
    process.exit(2);
  }
  const childCwd = containment.path;
  const addDir = containment.path;

  // Pre-snapshot for review-style paths (§10 post-hoc mutation detection).
  // Profile-driven: plan-mode paths are supposed to be read-only, so we
  // snapshot before/after and surface drift via record.mutations.
  const checkMutations = profile.permission_mode === "plan";
  let gitStatusBefore = null;
  const mutations = [];
  if (checkMutations) {
    const before = tryGit(["status", "-s", "--untracked-files=all"], cwd);
    if (before.ok) {
      gitStatusBefore = before.stdout;
      writeSidecar(workspaceRoot, jobId, "git-status-before.txt", gitStatusBefore);
    } else {
      mutations.push(mutationDetectionFailure(before.error));
    }
  }

  // Resume is carried on invocation.resume_chain[last] via cmdContinue. For
  // fresh runs this is null and sessionId=jobId is passed instead.
  const resumeId = invocation.resume_chain && invocation.resume_chain.length > 0
    ? invocation.resume_chain[invocation.resume_chain.length - 1]
    : null;

  let execution;
  try {
    execution = await spawnClaude(profile, {
      model,
      promptText: prompt,
      sessionId: jobId,
      addDirPath: addDir,
      cwd: childCwd,
      binary: invocation.binary,
      jsonSchema: invocation.schema_spec,
      resumeId,
      timeoutMs: 0,
      onSpawn: (pidInfo) => {
        const runningRecord = buildJobRecord(invocation, {
          status: "running",
          exitCode: null,
          parsed: null,
          pidInfo,
          claudeSessionId: null,
        }, mutations);
        writeJobFile(workspaceRoot, jobId, runningRecord);
        upsertJob(workspaceRoot, runningRecord);
      },
    });
  } catch (e) {
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
      errorMessage: e.message,
    }, mutations);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (disposeEffective) containment.cleanup();
    if (foreground) {
      printJson(errorRecord);
      process.exit(2);
    }
    process.exit(2);
  }

  // Post-snapshot for mutation detection.
  if (checkMutations && gitStatusBefore !== null) {
    const after = tryGit(["status", "-s", "--untracked-files=all"], cwd);
    if (after.ok) {
      const gitStatusAfter = after.stdout;
      writeSidecar(workspaceRoot, jobId, "git-status-after.txt", gitStatusAfter);
      if (gitStatusAfter && gitStatusAfter !== gitStatusBefore) {
        const beforeLines = new Set(
          gitStatusBefore.split("\n").map((l) => l.trim()).filter(Boolean)
        );
        mutations.push(...gitStatusAfter.split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !beforeLines.has(l)));
      }
    } else {
      mutations.push(mutationDetectionFailure(after.error));
    }
  }

  // ONE buildJobRecord call — spec §21.3.2 convergence. Foreground prints
  // what we persist; cmdResult reads the same file; skill renders the same
  // schema. No hand-assembly anywhere.
  const finalRecord = buildJobRecord(invocation, {
    exitCode: execution.exitCode,
    parsed: execution.parsed,
    pidInfo: execution.pidInfo,
    claudeSessionId: execution.claudeSessionId ?? null,
  }, mutations);
  writeJobFile(workspaceRoot, jobId, finalRecord);
  upsertJob(workspaceRoot, finalRecord);

  // Sidecar logs (not part of JobRecord — operator diagnostics).
  writeSidecar(workspaceRoot, jobId, "stdout.log", execution.stdout);
  writeSidecar(workspaceRoot, jobId, "stderr.log", execution.stderr);

  // Dispose containment after run (§10 / profile.dispose_default). Kept
  // AFTER sidecar writes so failure traces survive.
  if (containment.disposed && disposeEffective) {
    containment.cleanup();
  }
  // Note: `containment_path` / `containment_cleaned` were legacy sidechannel
  // fields on the record that pre-dated the JobRecord schema. Containment
  // state is now either "disposed" (path gone from disk) or derivable from
  // workspace inspection; not part of the schema.

  if (foreground) {
    printJson(finalRecord);
  }
  process.exit(finalRecord.status === "completed" ? 0 : 2);
}

// ——— subcommand: _run-worker (hidden; detached worker for --background) ———
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
    meta = JSON.parse(_readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }
  if (["completed", "failed", "cancelled", "stale"].includes(meta.status)) {
    fail("bad_state", `job ${options.job} is already terminal (${meta.status}); refusing worker re-entry`);
  }

  // Read+delete the prompt sidecar (§21.3.1 handoff buffer). Missing sidecar
  // means either the launcher crashed before writing it, or this is a
  // pre-T7.4 legacy record — either way, we can't run.
  const prompt = consumePromptSidecar(workspaceRoot, options.job);
  if (!prompt) {
    const errorRecord = buildJobRecord(invocationFromRecord(meta), {
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
      errorMessage: "worker: prompt sidecar missing; job cannot resume",
    }, []);
    writeJobFile(workspaceRoot, options.job, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("bad_state", "prompt sidecar missing for job " + options.job);
  }

  const invocation = invocationFromRecord(meta);
  await executeRun(invocation, prompt, { foreground: false });
}

// ——— subcommand: continue (resume a prior session with --resume) ———
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
    prior = JSON.parse(_readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }
  const prompt = positionals.join(" ").trim();
  if (!prompt) fail("bad_args", "prompt is required (pass after -- separator)");
  // §21.1: read the PRIOR `claude_session_id`. Legacy `session_id` fallback
  // covers pre-T7.3 records; same caveat as before — first-gen resumes work,
  // resume-from-resume on legacy records hits a dead UUID.
  const priorClaudeSessionId = prior.claude_session_id ?? prior.session_id ?? null;
  if (!priorClaudeSessionId) {
    fail("bad_args",
      `prior job ${options.job} has no claude_session_id to resume; ` +
      `pre-T7.3 records missing this field cannot be chained.`);
  }
  const newJobId_ = newJobId();
  const model = options.model ?? prior.model;
  const priorModeName = prior.mode_profile_name ?? prior.mode;
  const priorProfile = resolveProfile(priorModeName);
  const priorResumeChain = Array.isArray(prior.resume_chain) ? prior.resume_chain : [];

  // §21.1: resume_chain grows newest-last. The LAST entry is the UUID that
  // executeRun passes to spawnClaude via --resume (see the resumeId
  // derivation in executeRun). Do NOT persist a separate `resume_id` field
  // on the invocation — the chain is the source of truth.
  const invocation = Object.freeze({
    job_id: newJobId_,
    target: "claude",
    parent_job_id: options.job,
    resume_chain: [...priorResumeChain, priorClaudeSessionId],
    mode_profile_name: priorProfile.name,
    mode: priorModeName,
    model,
    cwd,
    workspace_root: workspaceRoot,
    // T7.2: inherit containment/scope from the profile freshly. dispose_effective
    // carries from prior so an --override-dispose on the original run persists.
    containment: priorProfile.containment,
    scope: priorProfile.scope,
    dispose_effective: prior.dispose_effective ?? priorProfile.dispose_default,
    scope_base: prior.scope_base ?? null,
    scope_paths: prior.scope_paths ?? null,
    prompt_head: prompt.slice(0, 200),    // §21.3.1 — no full prompt
    schema_spec: prior.schema_spec ?? prior.schema ?? null,
    binary: options.binary ?? process.env.CLAUDE_BINARY ?? "claude",
    started_at: new Date().toISOString(),
  });

  const queuedRecord = buildJobRecord(invocation, null, []);
  writeJobFile(workspaceRoot, newJobId_, queuedRecord);
  upsertJob(workspaceRoot, queuedRecord);

  if (options.background) {
    writePromptSidecar(workspaceRoot, newJobId_, prompt);
    const { child, error } = await spawnDetachedWorker(cwd, newJobId_);
    if (error) failBackgroundWorkerSpawn(workspaceRoot, invocation, error);
    printJson({ event: "launched", job_id: newJobId_, target: "claude",
      mode: priorModeName, parent_job_id: options.job, pid: child.pid ?? null,
      workspace_root: workspaceRoot });
    process.exit(0);
  }
  await executeRun(invocation, prompt, { foreground: true });
}

function writeSidecar(workspaceRoot, jobId, name, contents) {
  const jobsDir = resolveJobsDir(workspaceRoot);
  const dir = `${jobsDir}/${jobId}`;
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

async function cmdNotImplemented(name) {
  fail("not_implemented", `'${name}' lands in a later milestone; only 'run --foreground' is wired at M2`);
}

// ——— subcommand: ping (OAuth health probe per spec §7.5) ———
async function cmdPing(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["model", "binary", "timeout-ms"],
    booleanOptions: [],
  });
  const profile = resolveProfile("ping");
  const model = options.model ?? resolveModelForProfile(profile, loadModels());
  if (!model) fail("no_model", "no model resolved for ping; pass --model or populate config/models.json");
  const binary = options.binary ?? process.env.CLAUDE_BINARY ?? "claude";
  const timeoutMs = Number(options["timeout-ms"] ?? 15000);
  // Ping is ephemeral (no durable record), so reuse newJobId() purely for its
  // UUIDv4 guarantee — Claude rejects a non-v4 --session-id. Nothing persists.
  const sessionId = newJobId();
  let execution;
  try {
    execution = await spawnClaude(profile, {
      model,
      promptText: "reply with exactly: pong",
      sessionId,
      cwd: process.cwd(),
      binary,
      timeoutMs,
    });
  } catch (e) {
    if (e.code === "ENOENT") {
      printJson({ status: "not_found", detail: `claude binary not found on PATH (or CLAUDE_BINARY override)`,
        install_url: "https://claude.com/claude-code" });
      process.exit(2);
    }
    printJson({ status: "error", detail: e.message });
    process.exit(2);
  }
  // Classify. Real Claude error texts change per version; match on signals only.
  if (execution.parsed.ok && (execution.parsed.result || execution.parsed.structured)) {
    // T7.4: drop the legacy `.sessionId` alias. Ping uses claudeSessionId
    // (Claude's echo) with sessionIdSent fallback when the mock short-circuits.
    printJson({ status: "ok", model,
      session_id: execution.claudeSessionId ?? execution.sessionIdSent,
      cost_usd: execution.parsed.costUsd, usage: execution.parsed.usage });
    process.exit(0);
  }
  if (execution.exitCode !== 0) {
    const stderr = execution.stderr ?? "";
    if (/rate limit|429|overloaded/i.test(stderr)) {
      printJson({ status: "rate_limited", detail: stderr.trim().slice(0, 500) });
      process.exit(2);
    }
    if (/auth|login|credential|oauth|unauthenticated/i.test(stderr)) {
      printJson({ status: "not_authed", detail: stderr.trim().slice(0, 500),
        hint: "Run `claude` interactively to complete OAuth. Do not set ANTHROPIC_API_KEY." });
      process.exit(2);
    }
    printJson({ status: "error", exit_code: execution.exitCode, detail: stderr.trim().slice(0, 500) });
    process.exit(2);
  }
  printJson({ status: "error", detail: "parsed result missing", raw: execution.parsed.raw });
  process.exit(2);
}

// ——— subcommand: status (list running + recent jobs) ———
async function cmdStatus(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["job", "cwd"],
    booleanOptions: ["all"],
  });
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  if (options.job) {
    const match = jobs.find((j) => j.id === options.job);
    if (!match) fail("not_found", `no job with id ${options.job} in workspace ${workspaceRoot}`);
    printJson(match);
    return;
  }
  const filtered = options.all ? jobs : jobs.filter((j) => j.status === "running" || j.status === "completed" || j.status === "failed");
  printJson({ workspace_root: workspaceRoot, jobs: filtered });
}

// ——— subcommand: result (render result of a finished job) ———
async function cmdResult(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["job", "cwd"],
    booleanOptions: [],
  });
  if (!options.job) fail("bad_args", "--job <id> is required");
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Validate jobId before resolving to file path (belt + suspenders;
  // resolveJobFile asserts too).
  let jobFile;
  try {
    jobFile = resolveJobFile(workspaceRoot, options.job);
  } catch (e) {
    fail("bad_args", e.message);
  }
  if (!existsSync(jobFile)) fail("not_found", `no meta.json for job ${options.job}`);
  const meta = JSON.parse(_readFileSync(jobFile, "utf8"));
  printJson(meta);
}

// ——— subcommand: cancel (signal a running job) ———
//
// §21.1: signal target is resolved through `pid_info = {pid, starttime, argv0}`,
// not through `pid` alone. The `ps`/`/proc` re-read is both the liveness
// check AND the ownership proof — if starttime or argv0 drift, we refuse
// to signal (`stale_pid`) because the pid has been reused by an unrelated
// process. This is finding #7.
async function cmdCancel(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["job", "cwd"],
    booleanOptions: ["force"],
  });
  if (!options.job) fail("bad_args", "--job <id> is required");
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  const job = jobs.find((j) => j.id === options.job);
  if (!job) fail("not_found", `no job with id ${options.job}`);
  if (job.status !== "running") {
    printJson({ ok: true, status: "already_terminal", job_status: job.status, job_id: options.job });
    return;
  }
  const pidInfo = job.pid_info ?? null;
  if (!pidInfo || !Number.isInteger(pidInfo.pid)) {
    // Legacy records (pre-T7.3) or races where the spawn aborted before
    // pidInfo was persisted. Operators must decide manually; refusing to
    // signal is the safe default — a bare `pid` is not an ownership proof.
    printJson({
      ok: false,
      status: "no_pid_info",
      detail: "job has no pid_info; cannot safely signal (legacy record or race)",
      job_id: options.job,
    });
    return;
  }
  if (pidInfo.capture_error || !pidInfo.starttime || !pidInfo.argv0) {
    printJson({
      ok: false,
      status: "no_pid_info",
      detail: "job has pid but no complete ownership proof; refusing to signal",
      job_id: options.job,
      pid: pidInfo.pid,
      capture_error: pidInfo.capture_error ?? null,
    });
    return;
  }
  // Non-throwing ownership check: compares {starttime, argv0} of the live
  // process against the tuple captured at spawn. Mismatch → refuse.
  const check = verifyPidInfo(pidInfo);
  if (!check.match) {
    if (check.reason === "process_gone") {
      // Nothing alive at that pid — safely terminal. Legacy behavior emitted
      // "already_dead"; preserve so ops tooling keeps parsing.
      printJson({ ok: true, status: "already_dead", job_id: options.job, pid: pidInfo.pid });
      return;
    }
    // starttime_mismatch / argv0_mismatch / invalid — PID reuse or tampering.
    process.stderr.write(
      `claude-companion: stale_pid (${check.reason}) — refusing to signal pid ${pidInfo.pid}\n`
    );
    printJson({
      ok: false,
      status: "stale_pid",
      reason: check.reason,
      job_id: options.job,
      pid: pidInfo.pid,
    });
    process.exit(2);
  }
  const signal = options.force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pidInfo.pid, signal);
  } catch (e) {
    fail("signal_failed", e.message, { pid: pidInfo.pid, signal });
  }
  printJson({ ok: true, status: "signaled", signal, job_id: options.job, pid: pidInfo.pid });
}

// ——— dispatch ———
async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "run":     return cmdRun(rest);
    case "ping":    return cmdPing(rest);
    case "status":  return cmdStatus(rest);
    case "result":  return cmdResult(rest);
    case "cancel":  return cmdCancel(rest);
    case "continue": return cmdContinue(rest);
    case "_run-worker": return cmdRunWorker(rest);
    case "doctor":
      return cmdNotImplemented(sub);
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write("claude-companion: see docs/superpowers/specs/ §7 for subcommand surface.\n");
      process.exit(0);
    default:
      fail("bad_args", `unknown subcommand ${JSON.stringify(sub)}`);
  }
}

main().catch((e) => {
  process.stderr.write(`claude-companion: unhandled: ${e.stack ?? e.message ?? e}\n`);
  process.exit(1);
});
