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
// Only `run --foreground` is implemented at M2; later milestones extend.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
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

// Wraps git command; returns "" on error so we never crash on non-git cwds.
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
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: cleanGitEnv(),
    });
  } catch { return ""; }
}

// setupWorktree was deleted in T7.2. Containment lives in
// lib/containment.mjs; scope population lives in lib/scope.mjs. Both are
// per-profile decisions (spec §21.4).

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
  // --override-dispose is an advanced escape hatch (operators debugging a
  // failed review want to keep the worktree); it's deliberately not mentioned
  // in command-file snippets. Accepts "true"/"false"; anything else is the
  // profile default.
  const disposeEffective = (() => {
    if (options["override-dispose"] === undefined) return profile.dispose_default;
    const v = String(options["override-dispose"]).toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return profile.dispose_default;
  })();

  // Scope knobs carried through executeRun → populateScope.
  const scopePaths = options["scope-paths"]
    ? String(options["scope-paths"]).split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail("bad_args", "prompt is required (pass after -- separator)");
  }

  const jobId = newJobId();
  const startedAt = new Date().toISOString();

  // Provisional record — marks status=running so parallel `status` can see it.
  //
  // §21.1 identity types: the record stores FOUR distinct identities —
  //   job_id            (companion UUID, this invocation)
  //   claude_session_id (populated from stdout after run; null while pending)
  //   resume_chain      ([] on first run; grown by cmdContinue)
  //   pid_info          ({pid, starttime, argv0} — populated on spawn)
  //
  // `id` is an alias for job_id kept for upstream job-store APIs. NO
  // `session_id` field is written — that was the legacy conflation §21.1
  // forbids.
  const baseRecord = {
    id: jobId,
    job_id: jobId,
    target: "claude",
    mode,
    mode_profile_name: profile.name,
    status: options.background ? "queued" : "running",
    startedAt,
    cwd,
    workspaceRoot,
    containment: profile.containment,
    scope: profile.scope,
    dispose_effective: disposeEffective,
    scope_base: options["scope-base"] ?? null,
    scope_paths: scopePaths,
    model,
    // §21.1 identity types — four separate fields.
    claude_session_id: null,       // set post-run from parsed.session_id
    resume_chain: [],              // grown by cmdContinue
    pid_info: null,                // set by executeRun post-spawn
    prompt_head: prompt.slice(0, 200),
    prompt,
    binary: options.binary ?? process.env.CLAUDE_BINARY ?? "claude",
    schema: options.schema ?? null,
    schema_version: 1,
  };
  writeJobFile(workspaceRoot, jobId, baseRecord);
  upsertJob(workspaceRoot, baseRecord);

  if (options.background) {
    // Detach a worker process that will execute the run and overwrite the
    // terminal-state meta when done (spec §7.3 / M4). The worker's own
    // pid_info is captured when spawnClaude runs inside the worker; here we
    // only record the launcher pid for diagnostics.
    const child = spawn(process.execPath, [
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
    child.unref();
    const launchedRecord = { ...baseRecord, launcher_pid: child.pid ?? null };
    writeJobFile(workspaceRoot, jobId, launchedRecord);
    upsertJob(workspaceRoot, launchedRecord);
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

  await executeRun(baseRecord, { foreground: true });
}

// Shared execution body: foreground path calls this directly, background
// worker re-invokes it after reading meta.json. Terminal meta + sidecars are
// written by this function; emits the final JSON only when foreground.
async function executeRun(baseRecord, { foreground }) {
  const { id: jobId, mode, model, cwd, workspaceRoot, prompt } = baseRecord;
  const disposeEffective = baseRecord.dispose_effective ?? false;

  // Re-resolve the profile from the persisted mode NAME (spec §21.2 — the
  // table is the single source of truth; we don't clone it onto records).
  const profile = resolveProfile(baseRecord.mode_profile_name ?? mode);

  // T7.2: containment + scope are two independent per-profile decisions
  // (spec §21.4). setupContainment owns "where does Claude write"; populateScope
  // owns "what content does Claude see". Neither branches on mode directly.
  let containment = null;
  try {
    containment = setupContainment(profile, cwd);
    populateScope(profile, cwd, containment.path, {
      scopeBase: baseRecord.scope_base,
      scopePaths: baseRecord.scope_paths,
    }, containment);
  } catch (e) {
    if (containment) { try { containment.cleanup(); } catch { /* best-effort */ } }
    const errorRecord = { ...baseRecord, status: "failed",
      errorMessage: e.message, exit_code: null, ended_at: new Date().toISOString() };
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (foreground) fail("scope_setup_failed", e.message, { job_id: jobId });
    process.exit(2);
  }
  const childCwd = containment.path;
  const addDir = containment.path;

  // Pre-snapshot for review-style paths (§10 post-hoc mutation detection).
  // Profile-driven: plan-mode paths are supposed to be read-only, so we
  // snapshot before/after and warn on drift. Rescue (acceptEdits) intentionally
  // writes, so no snapshot.
  const checkMutations = profile.permission_mode === "plan";
  let gitStatusBefore = null;
  if (checkMutations) {
    gitStatusBefore = tryGit(["status", "-s", "--untracked-files=all"], cwd);
    if (gitStatusBefore || gitStatusBefore === "") {
      writeSidecar(workspaceRoot, jobId, "git-status-before.txt", gitStatusBefore);
    }
  }

  let execution;
  try {
    execution = await spawnClaude(profile, {
      model,
      promptText: prompt,
      // §21.1: pass job_id as the --session-id on fresh runs. Claude echoes
      // this back as parsed.session_id, which we then store as
      // claude_session_id (below). On resumes, baseRecord.resume_id is set
      // and spawnClaude uses --resume instead; --session-id is omitted.
      sessionId: jobId,
      addDirPath: addDir,
      cwd: childCwd,
      binary: baseRecord.binary,
      jsonSchema: baseRecord.schema ?? null,
      resumeId: baseRecord.resume_id ?? null,
      timeoutMs: 0,
    });
  } catch (e) {
    const errorRecord = { ...baseRecord, status: "failed", errorMessage: e.message,
      exit_code: null, ended_at: new Date().toISOString() };
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (disposeEffective) containment.cleanup();
    if (foreground) fail("spawn_failed", e.message, { job_id: jobId });
    process.exit(2);
  }

  // Post-snapshot for mutation detection.
  let gitStatusAfter = null;
  let mutations = [];
  if (checkMutations && gitStatusBefore !== null) {
    gitStatusAfter = tryGit(["status", "-s", "--untracked-files=all"], cwd);
    writeSidecar(workspaceRoot, jobId, "git-status-after.txt", gitStatusAfter);
    if (gitStatusAfter && gitStatusAfter !== gitStatusBefore) {
      // Line-set diff, not substring diff (audit finding): a new "M foo.js"
      // line shouldn't be considered pre-existing just because "foo" appeared
      // in some other line earlier.
      const beforeLines = new Set(
        gitStatusBefore.split("\n").map((l) => l.trim()).filter(Boolean)
      );
      mutations = gitStatusAfter.split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !beforeLines.has(l));
    }
  }

  const completedStatus = execution.exitCode === 0 && execution.parsed.ok ? "completed" : "failed";
  // §21.1: claude_session_id is read from Claude's stdout, not minted here.
  // Fall back to what we sent (job_id on fresh run, resume_id on resume) if
  // the CLI didn't echo — preserves downstream resume-chain behavior.
  const claudeSessionIdObserved =
    execution.claudeSessionId ?? baseRecord.resume_id ?? jobId;
  const finalRecord = {
    ...baseRecord,
    status: completedStatus,
    claude_session_id: claudeSessionIdObserved,
    pid_info: execution.pidInfo ?? null,
    exit_code: execution.exitCode,
    ended_at: new Date().toISOString(),
    cost_usd: execution.parsed.costUsd,
    usage: execution.parsed.usage,
  };
  writeJobFile(workspaceRoot, jobId, finalRecord);
  upsertJob(workspaceRoot, finalRecord);

  // Write stdout/stderr to sidecar logs (tests + operator can inspect).
  writeSidecar(workspaceRoot, jobId, "stdout.log", execution.stdout);
  writeSidecar(workspaceRoot, jobId, "stderr.log", execution.stderr);

  // Dispose containment after run — review/adversarial-review default ON via
  // profile.dispose_default; rescue default OFF. `--override-dispose` is the
  // only escape hatch. Kept AFTER sidecar writes so any failure traces
  // survive. For containment=none, `disposed` is always false and cleanup is
  // a no-op; no branch needed.
  if (containment.disposed && disposeEffective) {
    containment.cleanup();
    writeJobFile(workspaceRoot, jobId, { ...finalRecord, containment_cleaned: true });
  } else if (containment.disposed) {
    // Non-disposed worktree — persist path for operator debugging.
    writeJobFile(workspaceRoot, jobId, { ...finalRecord, containment_path: containment.path });
  }

  if (foreground) {
    printJson({
      ok: completedStatus === "completed",
      job_id: jobId,
      mode,
      model,
      workspace_root: workspaceRoot,
      result: execution.parsed.result,
      structured_output: execution.parsed.structured,
      permission_denials: execution.parsed.denials,
      ...(mutations.length > 0 ? { warning: "mutation_detected", mutated_files: mutations } : {}),
    });
  }
  process.exit(completedStatus === "completed" ? 0 : 2);
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
  // Worker marks status=running; pid_info for the actual claude CLI child
  // is captured by spawnClaude inside executeRun. No `pid: process.pid`
  // — that was the legacy conflation where the worker PID pretended to be
  // the CLI's PID, defeating the point of ownership verification.
  const baseRecord = { ...meta, status: "running" };
  writeJobFile(workspaceRoot, options.job, baseRecord);
  upsertJob(workspaceRoot, baseRecord);
  await executeRun(baseRecord, { foreground: false });
}

// ——— subcommand: continue (resume a prior session with --resume) ———
async function cmdContinue(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["job", "cwd", "model", "binary"],
    booleanOptions: ["background", "foreground"],
  });
  if (!options.job) fail("bad_args", "--job <id> is required");
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
  // §21.1: read the PRIOR `claude_session_id` (the UUID Claude actually ran
  // under), NOT `prior.session_id` (which was the companion-minted job_id on
  // legacy records — a different UUID that was never passed to Claude).
  //
  // Fallback: legacy records from pre-T7.3 only have `session_id` and it
  // happened to equal the --session-id the companion sent, so for FIRST
  // generation resumes that fallback still names a live session. For chained
  // resumes on legacy records the fallback points at a dead intermediate
  // UUID — that's the pre-existing bug, not worth an error here because the
  // bug only manifests on resume-from-resume. We prefer the correct field
  // whenever it's available.
  const priorClaudeSessionId = prior.claude_session_id ?? prior.session_id ?? null;
  if (!priorClaudeSessionId) {
    fail("bad_args",
      `prior job ${options.job} has no claude_session_id to resume; ` +
      `pre-T7.3 records missing this field cannot be chained.`);
  }
  const newJobId_ = newJobId();
  const model = options.model ?? prior.model;
  // Re-resolve the profile from the prior job's mode name, not from a
  // persisted profile blob. This keeps behavior fresh against spec changes
  // in the profile table — see §21.2.
  const priorModeName = prior.mode_profile_name ?? prior.mode;
  const priorProfile = resolveProfile(priorModeName);
  // §21.1: resume_chain grows newest-last. A second `continue` off this job
  // will read the new record's claude_session_id (populated post-run), so
  // this chain always reflects the actual session history.
  const priorResumeChain = Array.isArray(prior.resume_chain) ? prior.resume_chain : [];
  const baseRecord = {
    id: newJobId_,
    job_id: newJobId_,
    target: "claude",
    mode: priorModeName,
    mode_profile_name: priorProfile.name,
    status: options.background ? "queued" : "running",
    startedAt: new Date().toISOString(),
    cwd,
    workspaceRoot,
    // T7.2: inherit containment/scope from the profile freshly — not from
    // prior (which may have been recorded under the old `isolated` schema).
    // dispose_effective carries from prior so a --no-override-dispose on the
    // original run persists across resumes.
    containment: priorProfile.containment,
    scope: priorProfile.scope,
    dispose_effective: prior.dispose_effective ?? priorProfile.dispose_default,
    scope_base: prior.scope_base ?? null,
    scope_paths: prior.scope_paths ?? null,
    model,
    // §21.1 identity types.
    claude_session_id: null,                             // set post-run
    resume_chain: [...priorResumeChain, priorClaudeSessionId],
    pid_info: null,                                      // set post-spawn
    parent_job_id: options.job,
    resume_id: priorClaudeSessionId,                     // passed as --resume
    prompt_head: prompt.slice(0, 200),
    prompt,
    binary: options.binary ?? process.env.CLAUDE_BINARY ?? "claude",
    schema: prior.schema ?? null,
    schema_version: 1,
  };
  writeJobFile(workspaceRoot, newJobId_, baseRecord);
  upsertJob(workspaceRoot, baseRecord);

  if (options.background) {
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "_run-worker",
      "--cwd", cwd,
      "--job", newJobId_,
    ], { cwd, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    const launched = { ...baseRecord, launcher_pid: child.pid ?? null };
    writeJobFile(workspaceRoot, newJobId_, launched);
    upsertJob(workspaceRoot, launched);
    printJson({ event: "launched", job_id: newJobId_, target: "claude", mode: prior.mode,
      parent_job_id: options.job, pid: child.pid ?? null, workspace_root: workspaceRoot });
    process.exit(0);
  }
  await executeRun(baseRecord, { foreground: true });
}

function writeSidecar(workspaceRoot, jobId, name, contents) {
  const jobsDir = resolveJobsDir(workspaceRoot);
  const dir = `${jobsDir}/${jobId}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}`, contents ?? "", "utf8");
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
    printJson({ status: "ok", model, session_id: execution.sessionId,
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
