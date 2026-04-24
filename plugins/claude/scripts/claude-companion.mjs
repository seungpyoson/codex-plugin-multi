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
import { writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";

import { parseArgs } from "./lib/args.mjs";
import { configureState, getStateConfig, resolveJobsDir, resolveJobFile, writeJobFile, upsertJob, listJobs } from "./lib/state.mjs";
import { configureTrackedJobs } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { spawnClaude } from "./lib/claude.mjs";
import { resolveProfile, resolveModelForProfile } from "./lib/mode-profiles.mjs";
import { setupContainment } from "./lib/containment.mjs";
import { populateScope } from "./lib/scope.mjs";
import { newJobId, verifyPidInfo, capturePidInfo } from "./lib/identity.mjs";
import { buildJobRecord } from "./lib/job-record.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
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

  // T7.8 / §21: write a running-state record so cmdCancel can discover the
  // live owner process and signal it. Owner is `process.pid` — the worker
  // (background) or the companion itself (foreground). cmdCancel reads
  // pid_info from this record, verifies it with verifyPidInfo, and calls
  // terminateProcessTree(pidInfo.pid).
  //
  // Pre-T7.8 the companion never wrote status=running; every cmdCancel hit
  // the "already_terminal" gate immediately and no live job could be stopped.
  try {
    const ownerPidInfo = capturePidInfo(process.pid);
    const runningRecord = buildJobRecord(invocation, {
      runningMarker: true,
      pidInfo: ownerPidInfo,
      claudeSessionId: null,
    }, []);
    writeJobFile(workspaceRoot, jobId, runningRecord);
    upsertJob(workspaceRoot, runningRecord);
  } catch {
    // capturePidInfo platform error or disk write failure — proceed without
    // the running record. Cancel will see status=queued and report
    // "already_terminal". Degraded but not unsafe.
  }

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

  // T7.8 / §10 post-hoc mutation detection. Plan-mode profiles are supposed
  // to be read-only; we observe whether Claude held to that by committing a
  // baseline of childCwd BEFORE the run, then reading `git status` after.
  //
  // Detection runs in childCwd (where Claude actually writes under worktree
  // containment), NOT cwd (sourceCwd). Pre-T7.8 code looked at cwd, which
  // could never see changes Claude made inside its sandbox.
  //
  // For scope=head childCwd is already a registered worktree with its own
  // HEAD — skip init, diff against that. For every other scope, populateScope
  // leaves a bare directory copy with no git metadata; init + add -A + commit
  // sets up a baseline so post-run `git status` shows exactly what Claude
  // touched across all three classes (add / edit / delete).
  const checkMutations = profile.permission_mode === "plan";
  let baselineReady = false;
  if (checkMutations) {
    const isRepo =
      tryGit(["rev-parse", "--is-inside-work-tree"], childCwd).trim() === "true";
    if (isRepo) {
      baselineReady = true;
    } else {
      try {
        execFileSync("git", ["-C", childCwd, "init", "-q", "-b", "claude-baseline"],
          { stdio: ["ignore", "pipe", "ignore"], env: cleanGitEnv() });
        execFileSync("git", ["-C", childCwd, "add", "-A"],
          { stdio: ["ignore", "pipe", "ignore"], env: cleanGitEnv() });
        execFileSync("git", ["-C", childCwd,
          "-c", "user.email=claude-companion@local",
          "-c", "user.name=claude-companion",
          "-c", "commit.gpgsign=false",
          "commit", "-q", "--allow-empty", "-m", "claude-baseline"],
          { stdio: ["ignore", "pipe", "ignore"], env: cleanGitEnv() });
        baselineReady = true;
      } catch { /* baseline setup failed; mutations[] stays [] */ }
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
    });
  } catch (e) {
    const errorRecord = buildJobRecord(invocation, {
      exitCode: null, parsed: null, pidInfo: null, claudeSessionId: null,
      errorMessage: e.message,
    }, []);
    writeJobFile(workspaceRoot, jobId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    if (disposeEffective) containment.cleanup();
    if (foreground) {
      printJson(errorRecord);
      process.exit(2);
    }
    process.exit(2);
  }

  // Post-run mutation read. `git status -s --untracked-files=all` in childCwd
  // shows everything diverged from the baseline commit — each line preserves
  // its 2-char XY prefix (e.g., "?? foo.md", " M seed.txt", " D old.txt") so
  // consumers can distinguish add / edit / delete without re-parsing.
  //
  // `tryGit` (defined at top of this file, uses cleanGitEnv helper at :~76)
  // returns "" on any failure, but guard with `|| ""` regardless so a
  // future refactor of that helper can't silently NPE this call site.
  let mutations = [];
  if (checkMutations && baselineReady) {
    const gitStatusAfter =
      tryGit(["status", "-s", "--untracked-files=all"], childCwd) || "";
    writeSidecar(workspaceRoot, jobId, "git-status-after.txt", gitStatusAfter);
    mutations = gitStatusAfter.split("\n").filter(Boolean);
  }

  // ONE buildJobRecord call — spec §21.3.2 convergence. Foreground prints
  // what we persist; cmdResult reads the same file; skill renders the same
  // schema. No hand-assembly anywhere.
  //
  // §21.1 identity invariant: claude_session_id comes from Claude's echo,
  // never from a fallback. When Claude returned no parseable session_id
  // (parse error, garbage stdout, crash), null MUST propagate — aliasing
  // `resumeId` or `jobId` fabricated identity and was the finding #1 / H1
  // regression class. The T7.8 bypass-guard tests in tests/smoke/
  // invariants.test.mjs enforce this at the static + runtime layers.
  const finalRecord = buildJobRecord(invocation, {
    exitCode: execution.exitCode,
    parsed: execution.parsed,
    pidInfo: execution.pidInfo,
    claudeSessionId: execution.claudeSessionId,
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
//
// T7.8 / §21: --cwd is FORBIDDEN on continue. The caller (Codex) does not
// pick the execution cwd — the prior record does. Accepting --cwd invited
// a class of bug where Codex's cwd diverged from the original run's cwd,
// which silently broke Claude's session context. The new invocation's cwd
// comes from `prior.cwd`; process.cwd() is only used to locate the prior
// record (which is a workspace-lookup concern, not a session concern).
async function cmdContinue(rest) {
  // Explicit rejection of --cwd: parseArgs would otherwise ignore unknown
  // flags silently, and we want a loud error if a caller tries this.
  if (rest.some((t) => t === "--cwd" || t.startsWith("--cwd="))) {
    fail("bad_args",
      "continue does not accept --cwd; cwd is inherited from the prior record. " +
      "If you need to change execution cwd, start a fresh `run` instead.");
  }
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["job", "model", "binary"],
    booleanOptions: ["background", "foreground"],
  });
  if (!options.job) fail("bad_args", "--job <id> is required");
  // Workspace lookup: use process.cwd() to find the prior record. The prior
  // record then authoritatively supplies the execution cwd.
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  let prior;
  try {
    const jobFile = resolveJobFile(workspaceRoot, options.job);
    if (!existsSync(jobFile)) fail("not_found", `no meta.json for job ${options.job}`);
    prior = JSON.parse(_readFileSync(jobFile, "utf8"));
  } catch (e) {
    fail("bad_args", e.message);
  }
  if (!prior.cwd) {
    fail("bad_state",
      `prior job ${options.job} has no cwd field; cannot inherit execution cwd`);
  }
  const cwd = prior.cwd;
  const prompt = positionals.join(" ").trim();
  if (!prompt) fail("bad_args", "prompt is required (pass after -- separator)");
  // §21.1: read the PRIOR `claude_session_id`. Legacy `session_id` fallback
  // covers pre-T7.3 records; first-gen resumes work, resume-from-resume on
  // legacy records hits a dead UUID.
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
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "_run-worker",
      "--cwd", cwd,
      "--job", newJobId_,
    ], { cwd, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
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
// T7.8 / §21 cancel flow (Design A — upstream parity with codex-plugin-cc):
//
//   1. Load the prior record. Refuse if not status=running.
//   2. verifyPidInfo re-reads ps/proc and compares {starttime, argv0} to
//      the saved tuple. Mismatch / process_gone → stale-repair: write a
//      status=stale record and exit. The §21.1 ownership proof (finding #7).
//   3. On a live match, terminateProcessTree signals the process group
//      (detached bg worker → kills worker + claude child together). If the
//      group-kill reports not-delivered (fg companion not a group leader),
//      fall back to a direct process.kill.
//   4. Write a status=cancelled record AFTER signaling. cmdCancel is the
//      authoritative writer; the signaled worker dies before it can
//      overwrite with a terminal completed/failed record.
async function cmdCancel(rest) {
  const { options } = parseArgs(rest, {
    valueOptions: ["job", "cwd"],
    booleanOptions: ["force"],
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
  if (prior.status !== "running") {
    printJson({ ok: true, status: "already_terminal", job_status: prior.status, job_id: options.job });
    return;
  }
  const pidInfo = prior.pid_info ?? null;
  if (!pidInfo || !Number.isInteger(pidInfo.pid)) {
    printJson({
      ok: false,
      status: "no_pid_info",
      detail: "job has no pid_info; cannot safely signal (legacy record or race)",
      job_id: options.job,
    });
    return;
  }

  const check = verifyPidInfo(pidInfo);
  if (!check.match) {
    // Stale-repair: the record says running but the owner is gone or replaced.
    // Write a status=stale record so subsequent queries see the truth. For
    // process_gone keep the legacy "already_dead" reply shape so ops tooling
    // keeps parsing it. invocationFromRecord is inside the try: a malformed
    // prior record would otherwise escape unhandled.
    try {
      const priorInvocation = invocationFromRecord(prior);
      const staleRecord = buildJobRecord(priorInvocation, {
        staleMarker: true,
        pidInfo,
        claudeSessionId: prior.claude_session_id ?? null,
        errorMessage: `stale_pid: ${check.reason}`,
      }, Array.isArray(prior.mutations) ? prior.mutations : []);
      writeJobFile(workspaceRoot, options.job, staleRecord);
      upsertJob(workspaceRoot, staleRecord);
    } catch { /* best-effort; reply still reflects the stale state */ }

    if (check.reason === "process_gone") {
      printJson({ ok: true, status: "already_dead", job_id: options.job, pid: pidInfo.pid });
      return;
    }
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

  // Live match — terminate the owner's process tree. Track actual delivery
  // separately so the response truthfully reports null when both attempts
  // ESRCH'd out (process exited in the window between verifyPidInfo and
  // the signal — cancel still completes via the cancelled record write).
  let deliveryMethod = null;
  const tree = terminateProcessTree(pidInfo.pid);
  if (tree.delivered) {
    deliveryMethod = tree.method;
  } else {
    // Group-kill couldn't reach anything (foreground companion isn't a group
    // leader). Fall back to a direct signal.
    try {
      process.kill(pidInfo.pid, "SIGTERM");
      deliveryMethod = "process-direct";
    } catch (e) {
      if (e.code !== "ESRCH") fail("signal_failed", e.message, { pid: pidInfo.pid });
      // ESRCH — process exited between verifyPidInfo and this kill. Leave
      // deliveryMethod=null so the response reflects reality.
    }
  }
  if (options.force) {
    // Escalate to SIGKILL for both group and direct pid. Best-effort.
    try { process.kill(-pidInfo.pid, "SIGKILL"); } catch { /* */ }
    try { process.kill(pidInfo.pid, "SIGKILL"); } catch { /* */ }
  }

  // Authoritative cancelled record. Worker process may already be dead or
  // dying; this write is how observers learn the outcome.
  // invocationFromRecord inside the try: a malformed prior (race-written
  // partial JSON) would otherwise escape and leave the job stuck in running.
  try {
    const priorInvocation = invocationFromRecord(prior);
    const cancelledRecord = buildJobRecord(priorInvocation, {
      cancelMarker: true,
      pidInfo,
      claudeSessionId: prior.claude_session_id ?? null,
      errorMessage: "cancelled by user via claude-companion cancel",
    }, Array.isArray(prior.mutations) ? prior.mutations : []);
    writeJobFile(workspaceRoot, options.job, cancelledRecord);
    upsertJob(workspaceRoot, cancelledRecord);
  } catch (e) {
    fail("cancel_write_failed", e.message, { job_id: options.job });
  }

  printJson({
    ok: true,
    status: "cancelled",
    job_id: options.job,
    pid: pidInfo.pid,
    method: deliveryMethod,
  });
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
