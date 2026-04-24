#!/usr/bin/env node
// Claude-companion entry. Invokes the Claude CLI on behalf of Codex plugin
// commands and manages the per-workspace job store. Target-specific wiring
// lives here; shared machinery lives in ./lib/.
//
// Subcommands (see spec §7.1):
//   run      --mode=review|adversarial-review|rescue [--background|--foreground]
//            [--model ID] [--cwd PATH] [--isolated] [--dispose] -- PROMPT
//   status   [--job ID]
//   result   --job ID
//   cancel   --job ID [--force]
//   ping
//   doctor
//
// Only `run --foreground` is implemented at M2; later milestones extend.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";

import { parseArgs } from "./lib/args.mjs";
import { configureState, getStateConfig, resolveJobsDir, resolveJobFile, writeJobFile, upsertJob, listJobs } from "./lib/state.mjs";
import { configureTrackedJobs } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { spawnClaude } from "./lib/claude.mjs";
import { resolveProfile, resolveModelForProfile } from "./lib/mode-profiles.mjs";
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
// reason `setupWorktree` uses a clean env (see below).
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

// Creates an isolated git worktree off the source repo's current HEAD.
// Returns {path, cleanup}. Cleanup removes the worktree via `git worktree
// remove --force` with an rmSync fallback for cases where the source repo is
// gone (tests). Callers are responsible for calling cleanup when `dispose` is
// true — executeRun owns that contract.
function setupWorktree(sourceCwd) {
  const isGit = tryGit(["rev-parse", "--is-inside-work-tree"], sourceCwd).trim() === "true";
  if (!isGit) {
    throw new Error(`--isolated requires a git repository at ${sourceCwd}`);
  }
  const worktreePath = mkdtempSync(`${tmpdir()}/claude-worktree-`);
  // Scrub inherited git env — if the companion was spawned from inside a
  // pre-commit hook (or any repo-scoped git operation), GIT_DIR/GIT_INDEX_FILE
  // leak in and hijack our worktree command with "fatal: .git/index: Not a
  // directory". Spec §4.10 calls this out; upstream Codex port hit the same.
  const cleanEnv = cleanGitEnv();
  // --detach: no branch ref; worktree stays disposable. HEAD: point at current
  // commit so the reviewer sees exactly the state the caller is in.
  execFileSync("git", ["-C", sourceCwd, "worktree", "add", "--detach", worktreePath, "HEAD"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv,
  });
  return {
    path: worktreePath,
    cleanup() {
      try {
        execFileSync("git", ["-C", sourceCwd, "worktree", "remove", "--force", worktreePath], {
          stdio: ["ignore", "pipe", "ignore"],
          env: cleanEnv,
        });
      } catch {
        // Source repo gone or worktree already detached — fall back to plain rm.
      }
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

// ——— subcommand: run ———
async function cmdRun(rest) {
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["mode", "model", "cwd", "schema", "binary"],
    booleanOptions: ["background", "foreground", "isolated", "dispose", "no-dispose"],
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
  const isolated = Boolean(options.isolated);
  // Dispose default lives in the profile (§21.2 field `dispose_default`).
  // `--no-dispose` overrides to false; explicit `--dispose` wins otherwise.
  const dispose = options["no-dispose"] ? false : (options.dispose ?? profile.dispose_default);

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail("bad_args", "prompt is required (pass after -- separator)");
  }

  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();

  // Provisional record — marks status=running so parallel `status` can see it.
  // NOTE: we persist `mode` (the profile NAME), not the resolved profile object
  // itself. executeRun / cmdContinue re-resolves at execution time so spec
  // changes to the profile table propagate to in-flight jobs on reread.
  const baseRecord = {
    id: sessionId,
    target: "claude",
    mode,
    mode_profile_name: profile.name,
    status: options.background ? "queued" : "running",
    pid: process.pid,
    startedAt,
    cwd,
    workspaceRoot,
    isolated,
    disposed: dispose,
    model,
    session_id: sessionId,
    prompt_head: prompt.slice(0, 200),
    prompt,
    binary: options.binary ?? process.env.CLAUDE_BINARY ?? "claude",
    schema: options.schema ?? null,
    schema_version: 1,
  };
  writeJobFile(workspaceRoot, sessionId, baseRecord);
  upsertJob(workspaceRoot, baseRecord);

  if (options.background) {
    // Detach a worker process that will execute the run and overwrite the
    // terminal-state meta when done (spec §7.3 / M4).
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "_run-worker",
      "--cwd", cwd,
      "--job", sessionId,
    ], {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const launchedRecord = { ...baseRecord, pid: child.pid ?? null };
    writeJobFile(workspaceRoot, sessionId, launchedRecord);
    upsertJob(workspaceRoot, launchedRecord);
    printJson({
      event: "launched",
      job_id: sessionId,
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
  const { id: sessionId, mode, model, cwd, workspaceRoot, isolated, prompt, disposed } = baseRecord;

  // Re-resolve the profile from the persisted mode NAME (spec §21.2 — the
  // table is the single source of truth; we don't clone it onto records).
  const profile = resolveProfile(baseRecord.mode_profile_name ?? mode);

  // Isolation: spin up a detached git worktree off HEAD so the review sees a
  // pristine copy, not the live working tree.
  let worktree = null;
  if (isolated) {
    try {
      worktree = setupWorktree(cwd);
    } catch (e) {
      const errorRecord = { ...baseRecord, status: "failed", pid: null,
        errorMessage: e.message, exit_code: null, ended_at: new Date().toISOString() };
      writeJobFile(workspaceRoot, sessionId, errorRecord);
      upsertJob(workspaceRoot, errorRecord);
      if (foreground) fail("isolation_failed", e.message, { job_id: sessionId });
      process.exit(2);
    }
  }
  const childCwd = worktree ? worktree.path : cwd;
  const addDir = worktree ? worktree.path : cwd;

  // Pre-snapshot for review-style paths (§10 post-hoc mutation detection).
  // Profile-driven: plan-mode paths are supposed to be read-only, so we
  // snapshot before/after and warn on drift. Rescue (acceptEdits) intentionally
  // writes, so no snapshot.
  const checkMutations = profile.permission_mode === "plan";
  let gitStatusBefore = null;
  if (checkMutations) {
    gitStatusBefore = tryGit(["status", "-s", "--untracked-files=all"], cwd);
    if (gitStatusBefore || gitStatusBefore === "") {
      writeSidecar(workspaceRoot, sessionId, "git-status-before.txt", gitStatusBefore);
    }
  }

  let execution;
  try {
    execution = await spawnClaude(profile, {
      model,
      promptText: prompt,
      sessionId,
      addDirPath: addDir,
      cwd: childCwd,
      binary: baseRecord.binary,
      jsonSchema: baseRecord.schema ?? null,
      resumeId: baseRecord.resume_id ?? null,
      timeoutMs: 0,
    });
  } catch (e) {
    const errorRecord = { ...baseRecord, status: "failed", pid: null, errorMessage: e.message,
      exit_code: null, ended_at: new Date().toISOString() };
    writeJobFile(workspaceRoot, sessionId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (worktree && disposed) worktree.cleanup();
    if (foreground) fail("spawn_failed", e.message, { job_id: sessionId });
    process.exit(2);
  }

  // Post-snapshot for mutation detection.
  let gitStatusAfter = null;
  let mutations = [];
  if (checkMutations && gitStatusBefore !== null) {
    gitStatusAfter = tryGit(["status", "-s", "--untracked-files=all"], cwd);
    writeSidecar(workspaceRoot, sessionId, "git-status-after.txt", gitStatusAfter);
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
  const finalRecord = {
    ...baseRecord,
    status: completedStatus,
    pid: null,
    exit_code: execution.exitCode,
    ended_at: new Date().toISOString(),
    cost_usd: execution.parsed.costUsd,
    usage: execution.parsed.usage,
  };
  writeJobFile(workspaceRoot, sessionId, finalRecord);
  upsertJob(workspaceRoot, finalRecord);

  // Write stdout/stderr to sidecar logs (tests + operator can inspect).
  writeSidecar(workspaceRoot, sessionId, "stdout.log", execution.stdout);
  writeSidecar(workspaceRoot, sessionId, "stderr.log", execution.stderr);

  // Dispose worktree after run — review paths default ON, rescue default OFF
  // (callers may override via --no-dispose). Kept AFTER sidecar writes so any
  // failure traces survive.
  if (worktree && disposed) {
    worktree.cleanup();
    writeJobFile(workspaceRoot, sessionId, { ...finalRecord, worktree_cleaned: true });
  } else if (worktree) {
    // Persist worktree path for operator debugging when dispose is off.
    writeJobFile(workspaceRoot, sessionId, { ...finalRecord, worktree_path: worktree.path });
  }

  if (foreground) {
    printJson({
      ok: completedStatus === "completed",
      job_id: sessionId,
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
  const baseRecord = { ...meta, status: "running", pid: process.pid };
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
  const resumeId = prior.session_id;
  if (!resumeId) fail("bad_args", `prior job ${options.job} has no session_id to resume`);
  const newSessionId = randomUUID();
  const model = options.model ?? prior.model;
  // Re-resolve the profile from the prior job's mode name, not from a
  // persisted profile blob. This keeps behavior fresh against spec changes
  // in the profile table — see §21.2.
  const priorModeName = prior.mode_profile_name ?? prior.mode;
  const priorProfile = resolveProfile(priorModeName);
  const baseRecord = {
    id: newSessionId,
    target: "claude",
    mode: priorModeName,
    mode_profile_name: priorProfile.name,
    status: options.background ? "queued" : "running",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd,
    workspaceRoot,
    isolated: Boolean(prior.isolated),
    disposed: Boolean(prior.disposed),
    model,
    session_id: newSessionId,
    parent_job_id: options.job,
    resume_id: resumeId,
    prompt_head: prompt.slice(0, 200),
    prompt,
    binary: options.binary ?? process.env.CLAUDE_BINARY ?? "claude",
    schema: prior.schema ?? null,
    schema_version: 1,
  };
  writeJobFile(workspaceRoot, newSessionId, baseRecord);
  upsertJob(workspaceRoot, baseRecord);

  if (options.background) {
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "_run-worker",
      "--cwd", cwd,
      "--job", newSessionId,
    ], { cwd, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    const launched = { ...baseRecord, pid: child.pid ?? null };
    writeJobFile(workspaceRoot, newSessionId, launched);
    upsertJob(workspaceRoot, launched);
    printJson({ event: "launched", job_id: newSessionId, target: "claude", mode: prior.mode,
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
  const sessionId = randomUUID();
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
  if (!job.pid) {
    printJson({ ok: false, status: "no_pid", detail: "job record has no pid; cannot signal" });
    return;
  }
  // PID-liveness check (upstream pattern — guard against PID reuse).
  try {
    // 0 means "check, don't signal"
    process.kill(job.pid, 0);
  } catch {
    printJson({ ok: true, status: "already_dead", job_id: options.job, pid: job.pid });
    return;
  }
  const signal = options.force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(job.pid, signal);
  } catch (e) {
    fail("signal_failed", e.message, { pid: job.pid, signal });
  }
  printJson({ ok: true, status: "signaled", signal, job_id: options.job, pid: job.pid });
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
