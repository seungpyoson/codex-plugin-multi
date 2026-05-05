import { constants, accessSync, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const GIT_BINARY_ENV = "CODEX_PLUGIN_MULTI_GIT_BINARY";
export const DEFAULT_GIT_BINARY = "/usr/bin/git";
export const GIT_SAFE_PATH = "/usr/bin:/bin";

const resolvedGitCache = new Map();

function isInsidePath(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function hasNodeModulesBinSegment(candidate) {
  const parts = candidate.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === "node_modules" && parts[index + 1] === ".bin") {
      return true;
    }
  }
  return false;
}

function nearestWorkspaceBoundary(cwd) {
  if (!cwd) return null;
  let current;
  try {
    current = realpathSync.native(cwd);
  } catch {
    current = path.resolve(cwd);
  }
  const start = current;
  let found = null;
  for (;;) {
    if (existsSync(path.join(current, ".git"))) found = current;
    const parent = path.dirname(current);
    if (parent === current) return found ?? (start === current ? null : start);
    current = parent;
  }
}

export function resolveGitBinary(options = {}) {
  const env = options.env ?? process.env;
  const override = env[GIT_BINARY_ENV];
  if (!override) return DEFAULT_GIT_BINARY;

  if (!path.isAbsolute(override)) {
    throw new Error(`${GIT_BINARY_ENV} must be an absolute path to a Git executable.`);
  }

  const workspaceRoot = options.workspaceRoot ?? nearestWorkspaceBoundary(options.cwd);
  const cacheKey = `${override}\0${options.cwd ?? ""}\0${workspaceRoot ?? ""}`;
  const cached = resolvedGitCache.get(cacheKey);
  if (cached) return cached;

  let realGit;
  try {
    realGit = realpathSync.native(override);
    const stat = statSync(realGit);
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
    accessSync(realGit, constants.X_OK);
  } catch {
    throw new Error(`${GIT_BINARY_ENV} must point to an executable regular file.`);
  }

  if (workspaceRoot) {
    let realWorkspace = null;
    try {
      realWorkspace = realpathSync.native(workspaceRoot);
    } catch {
      realWorkspace = path.resolve(workspaceRoot);
    }
    if (isInsidePath(realWorkspace, realGit)) {
      throw new Error(`${GIT_BINARY_ENV} must not point inside the current workspace.`);
    }
  }

  if (hasNodeModulesBinSegment(realGit)) {
    throw new Error(`${GIT_BINARY_ENV} must not point inside node_modules/.bin.`);
  }

  resolvedGitCache.set(cacheKey, realGit);
  return realGit;
}

export function gitEnv(baseEnv = process.env) {
  return { ...baseEnv, PATH: GIT_SAFE_PATH };
}
