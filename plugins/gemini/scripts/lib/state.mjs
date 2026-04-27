// Ported from openai/codex-plugin-cc (MIT) at commit 807e03a.
// See ./UPSTREAM.md for synced SHA and re-sync procedure.
//
// Parametrization (this plugin = gemini):
//   - Env var for a host-provided plugin-data dir:  GEMINI_PLUGIN_DATA (set by
//     the host if provided; when running inside Codex this is typically unset,
//     so the fallback state dir is always taken).
//   - Env var for capturing a session UUID from caller: GEMINI_COMPANION_SESSION_ID
//   - Fallback state root dir:  <tmpdir>/gemini-companion
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
const STATE_LOCK_DIR_NAME = ".state.lock";
const STATE_LOCK_TIMEOUT_MS = 5000;
const STATE_LOCK_POLL_MS = 25;
const STATE_LOCK_STALE_MS = 30000;
const STATE_LOCK_OWNER_FILE = "owner.json";
const MAX_JOBS = 50;
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const STATE_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const HELD_STATE_LOCKS = new Set();

// Mutable module config. Defaults to the gemini port values; other targets
// MUST call configureState() before any state read/write to override.
const CONFIG = {
  pluginDataEnv: "GEMINI_PLUGIN_DATA",
  fallbackStateRootDir: path.join(os.tmpdir(), "gemini-companion"),
  sessionIdEnv: "GEMINI_COMPANION_SESSION_ID",
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

function isActiveJob(job) {
  return ACTIVE_JOB_STATUSES.has(job?.status);
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
  let terminalCount = 0;
  return withIndex
    .filter(({ job }) => {
      if (isActiveJob(job)) return true;
      if (terminalCount >= MAX_JOBS) return false;
      terminalCount += 1;
      return true;
    })
    .map(({ job }) => job);
}

// UUID v4 pattern (accepted by both target CLIs' --session-id semantics). We also allow the
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
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

function sleepSync(ms) {
  Atomics.wait(STATE_LOCK_SLEEP, 0, 0, ms);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function readLockOwner(lockDir) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, STATE_LOCK_OWNER_FILE), "utf8"));
    return owner && typeof owner === "object" && !Array.isArray(owner) ? owner : null;
  } catch {
    return null;
  }
}

function lockAgeMs(lockDir, owner) {
  const startedAt = owner?.startedAt ? Date.parse(owner.startedAt) : NaN;
  if (Number.isFinite(startedAt)) return Date.now() - startedAt;
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return 0;
  }
}

function writeLockOwner(lockDir) {
  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(lockDir, STATE_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, "utf8");
}

function tryReclaimStaleLock(lockDir) {
  const owner = readLockOwner(lockDir);
  const sameHost = owner?.hostname === os.hostname();
  const ownerDead = sameHost && Number.isInteger(owner?.pid) && !isProcessAlive(owner.pid);
  const tooOld = lockAgeMs(lockDir, owner) > STATE_LOCK_STALE_MS;
  if (!ownerDead && !tooOld) return false;

  const orphanDir = `${lockDir}.orphaned-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lockDir, orphanDir);
    fs.rmSync(orphanDir, { recursive: true, force: true });
    return true;
  } catch (e) {
    if (e?.code === "ENOENT") return true;
    return false;
  }
}

function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const lockDir = path.join(resolveStateDir(cwd), STATE_LOCK_DIR_NAME);
  const lockKey = path.resolve(lockDir);
  if (HELD_STATE_LOCKS.has(lockKey)) {
    throw new Error(`state_lock_reentrant: already holding ${lockDir}`);
  }
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      try {
        writeLockOwner(lockDir);
      } catch (e) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        throw e;
      }
      HELD_STATE_LOCKS.add(lockKey);
      return () => {
        HELD_STATE_LOCKS.delete(lockKey);
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      };
    } catch (e) {
      if (e.code !== "EEXIST") {
        throw new Error(`state_lock_error: could not acquire ${lockDir}: ${e.message}`);
      }
      if (tryReclaimStaleLock(lockDir)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`state_lock_timeout: could not acquire ${lockDir}`);
      }
      sleepSync(STATE_LOCK_POLL_MS);
    }
  }
}

function withStateLock(cwd, fn) {
  const release = acquireStateLock(cwd);
  try {
    return fn();
  } finally {
    release();
  }
}

function mergeActivePreviousJobs(nextJobs, previousJobs) {
  const nextIds = new Set(nextJobs.map((job) => job.id));
  const activePrevious = previousJobs.filter((job) => isActiveJob(job) && !nextIds.has(job.id));
  return [...nextJobs, ...activePrevious];
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const requestedJobs = Array.isArray(state.jobs) ? state.jobs : [];
  const nextJobs = pruneJobs(mergeActivePreviousJobs(requestedJobs, previousJobs));
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
  // on POSIX and prevents readers from observing a partial state.json. The
  // caller holds a per-workspace advisory lock so launcher/worker read-modify
  // writes cannot clobber each other.
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
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const result = mutate(state);
    // Guard against async mutate: state would save before mutation completes,
    // losing writes (audit finding). Contract is sync-only.
    if (result && typeof result.then === "function") {
      throw new Error("updateState mutate must be synchronous; got a thenable");
    }
    return saveStateUnlocked(cwd, state);
  });
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
