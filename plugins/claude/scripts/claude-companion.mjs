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
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { parseArgs } from "./lib/args.mjs";
import { configureState, getStateConfig, resolveJobsDir, resolveJobFile, writeJobFile, upsertJob, listJobs } from "./lib/state.mjs";
import { configureTrackedJobs } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { spawnClaude } from "./lib/claude.mjs";
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
function tryGit(args, cwd) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return ""; }
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
  if (options.background) {
    fail("not_implemented", "run --background lands in M4");
  }

  const models = loadModels();
  const model = options.model ?? models[mode === "rescue" ? "default" : "default"] ?? null;
  if (!model) {
    fail("no_model", "no model resolved; pass --model or populate config/models.json");
  }

  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const isolated = Boolean(options.isolated);
  // Spec §10: --dispose default-ON for review paths, off for rescue.
  const disposeDefault = mode !== "rescue";
  const dispose = options["no-dispose"] ? false : (options.dispose ?? disposeDefault);

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    fail("bad_args", "prompt is required (pass after -- separator)");
  }

  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();

  // Provisional record — marks status=running so parallel `status` can see it.
  const baseRecord = {
    id: sessionId,
    target: "claude",
    mode,
    status: "running",
    pid: process.pid,
    startedAt,
    cwd,
    workspaceRoot,
    isolated,
    disposed: dispose,
    model,
    session_id: sessionId,
    prompt_head: prompt.slice(0, 200),
    schema_version: 1,
  };
  writeJobFile(workspaceRoot, sessionId, baseRecord);
  upsertJob(workspaceRoot, baseRecord);

  // Pre-snapshot for review paths (§10 post-hoc detection).
  let gitStatusBefore = null;
  if (mode !== "rescue") {
    gitStatusBefore = tryGit(["status", "-s", "--untracked-files=all"], cwd);
    if (gitStatusBefore || gitStatusBefore === "") {
      writeSidecar(workspaceRoot, sessionId, "git-status-before.txt", gitStatusBefore);
    }
  }

  // Dispatch. M5 will add --dispose worktree; M2 runs directly against cwd.
  const childCwd = isolated ? "/tmp" : cwd;
  let execution;
  try {
    execution = await spawnClaude({
      mode,
      model,
      promptText: prompt,
      sessionId,
      addDir: isolated ? null : cwd,
      cwd: childCwd,
      binary: options.binary ?? process.env.CLAUDE_BINARY ?? "claude",
      jsonSchema: options.schema ?? null,
      timeoutMs: 0,
    });
  } catch (e) {
    const errorRecord = { ...baseRecord, status: "failed", pid: null, errorMessage: e.message,
      exit_code: null, ended_at: new Date().toISOString() };
    writeJobFile(workspaceRoot, sessionId, errorRecord);
    upsertJob(workspaceRoot, errorRecord);
    fail("spawn_failed", e.message, { job_id: sessionId });
  }

  // Post-snapshot for mutation detection.
  let gitStatusAfter = null;
  let mutations = [];
  if (mode !== "rescue" && gitStatusBefore !== null) {
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
  process.exit(completedStatus === "completed" ? 0 : 2);
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
  const models = loadModels();
  const model = options.model ?? models.cheap;
  if (!model) fail("no_model", "no model resolved for ping; pass --model or populate config/models.json");
  const binary = options.binary ?? process.env.CLAUDE_BINARY ?? "claude";
  const timeoutMs = Number(options["timeout-ms"] ?? 15000);
  const sessionId = randomUUID();
  let execution;
  try {
    execution = await spawnClaude({
      mode: "rescue",            // lightest flag stack; we only care that auth works
      model,
      promptText: "reply with exactly: pong",
      sessionId,
      stripContext: true,
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
    case "continue":
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
