// Ported from openai/codex-plugin-cc (MIT) at commit 807e03a.
// See ./UPSTREAM.md for synced SHA and re-sync procedure.
//
// Parametrization (this plugin = claude):
//   - Env var for a host-provided plugin-data dir:  CLAUDE_PLUGIN_DATA (upstream
//     default; valid for this target since Claude Code IS the upstream host, but
//     when running inside Codex no such env var is set, so the fallback is
//     always taken — harmless).
//   - Env var for capturing a session UUID from caller: CLAUDE_COMPANION_SESSION_ID
//   - Fallback state root dir:  <tmpdir>/claude-companion
// To re-use this module for a different target, call configureState() once at
// companion startup.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

// Mutable module config. Defaults to the claude port values; other targets
// MUST call configureState() before any state read/write to override.
const CONFIG = {
  pluginDataEnv: "CLAUDE_PLUGIN_DATA",
  fallbackStateRootDir: path.join(os.tmpdir(), "claude-companion"),
  sessionIdEnv: "CLAUDE_COMPANION_SESSION_ID",
};

export function configureState(next = {}) {
  if (next.pluginDataEnv != null) CONFIG.pluginDataEnv = next.pluginDataEnv;
  if (next.fallbackStateRootDir != null) CONFIG.fallbackStateRootDir = next.fallbackStateRootDir;
  if (next.sessionIdEnv != null) CONFIG.sessionIdEnv = next.sessionIdEnv;
}

export function getStateConfig() {
  return { ...CONFIG };
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[CONFIG.pluginDataEnv];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : CONFIG.fallbackStateRootDir;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    // Guard against tampered state.json containing a non-object root
    // (e.g., null, array, string, number). Spreading a primitive throws.
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaultState();
    }
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  // Treat missing updatedAt as epoch-0 ("") and use a stable secondary key
  // (original index) so legacy entries without timestamps retain deterministic
  // order across repeated saves (audit finding).
  const withIndex = jobs.map((job, originalIndex) => ({ job, originalIndex }));
  withIndex.sort((left, right) => {
    const lt = String(left.job.updatedAt ?? "");
    const rt = String(right.job.updatedAt ?? "");
    if (lt === rt) return left.originalIndex - right.originalIndex;
    return rt.localeCompare(lt); // newest first
  });
  return withIndex.slice(0, MAX_JOBS).map(({ job }) => job);
}

// UUID v4 pattern (what Claude --session-id requires). We also allow the
// upstream "job-<base36>-<rand>" shape emitted by generateJobId() for
// back-compat. Anything else — including path separators or traversal
// segments — is rejected to prevent resolve*()/writeJobFile() from escaping
// the jobs dir.
const SAFE_JOB_ID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

function assertSafeJobId(jobId) {
  if (typeof jobId !== "string" || !SAFE_JOB_ID.test(jobId)) {
    throw new Error(`Unsafe jobId: ${JSON.stringify(jobId)}`);
  }
}

function realpathOrResolve(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isPathWithin(parentDir, candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  // Resolve symlinks before comparing. Upstream's `/tmp` → `/private/tmp`
  // aliasing on macOS would otherwise produce false negatives.
  const parentReal = realpathOrResolve(parentDir);
  const childReal = realpathOrResolve(candidate);
  const parentWithSep = parentReal.endsWith(path.sep) ? parentReal : parentReal + path.sep;
  return childReal === parentReal || childReal.startsWith(parentWithSep);
}

function removeFileIfExists(filePath) {
  if (!filePath) return;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isDirectory()) return; // don't remove directories — tampered state guard
    fs.unlinkSync(filePath);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
}

// Bounded deletion: only remove files that live inside the workspace's
// jobs dir. Defends against a tampered state.json carrying a malicious
// `logFile` path (audit finding, gate-1). Silent no-op when out of scope.
function removeJobLogFileIfSafe(cwd, filePath) {
  if (!filePath) return;
  const jobsDir = resolveJobsDir(cwd);
  if (!isPathWithin(jobsDir, filePath)) return;
  removeFileIfExists(filePath);
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    // job.id coming from a pre-existing state.json: validate before use in
    // resolveJobFile (which would otherwise allow path traversal).
    try {
      assertSafeJobId(job.id);
    } catch {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeJobLogFileIfSafe(cwd, job.logFile);
  }

  // Atomic write: write to a sibling tmp file, then rename. Rename is atomic
  // on POSIX and prevents readers from observing a partial state.json.
  //
  // Limitation (documented): this does NOT provide concurrent-writer safety.
  // Two processes updating state simultaneously will race — the later rename
  // wins and the earlier writer's job additions are lost. Upstream accepts
  // this because the job store is workspace-scoped and the companion
  // contract is single-writer-per-workspace (spec §12). If the contract
  // changes, wrap saveState in a `proper-lockfile`-style advisory lock.
  const stateFile = resolveStateFile(cwd);
  const tmpFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    fs.renameSync(tmpFile, stateFile);
  } catch (e) {
    // If rename failed (cross-device, permissions), clean up the tmp so we
    // don't leak noise in the state dir. Preserve original error.
    try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
    throw e;
  }
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  const result = mutate(state);
  // Guard against async mutate: state would save before mutation completes,
  // losing writes (audit finding). Contract is sync-only.
  if (result && typeof result.then === "function") {
    throw new Error("updateState mutate must be synchronous; got a thenable");
  }
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  assertSafeJobId(jobId);
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  const tmpFile = `${jobFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmpFile, jobFile);
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
    throw e;
  }
  return jobFile;
}

export function readJobFile(jobFile) {
  // Accepts either the absolute path produced by resolveJobFile() or a
  // (cwd, jobId) pair via readJobFileById. For the raw-path form, we
  // cross-check that the resolved path lives inside *some* known state
  // root prefix (the fallback dir). Upstream contract preserved for
  // back-compat while closing arbitrary-file-read surface.
  if (typeof jobFile !== "string" || !jobFile) {
    throw new Error("readJobFile: jobFile must be a non-empty string");
  }
  const resolved = realpathOrResolve(jobFile);
  // Both allowed roots are resolved WITH the "state" suffix — resolveStateDir
  // prepends it when pluginDataDir is set. Without this we'd accidentally
  // allow reads from any sibling of <pluginDataDir>/state (audit finding).
  const fallbackRoot = realpathOrResolve(CONFIG.fallbackStateRootDir);
  const pluginDataDir = process.env[CONFIG.pluginDataEnv];
  const customRoot = pluginDataDir
    ? realpathOrResolve(path.join(pluginDataDir, "state"))
    : null;
  const allowed = [fallbackRoot, customRoot].filter(Boolean);
  const ok = allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) {
    throw new Error(`readJobFile: path outside known state roots: ${jobFile}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

// Convenience alternative: callers with a (cwd, jobId) pair should use this
// instead of the raw-path form. Gated end-to-end by assertSafeJobId.
export function readJobFileById(cwd, jobId) {
  return readJobFile(resolveJobFile(cwd, jobId));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  assertSafeJobId(jobId);
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  assertSafeJobId(jobId);
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
