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
  const parts = candidate.split(path.sep).filter(Boolean).map((part) => part.toLowerCase());
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === "node_modules" && parts[index + 1] === ".bin") {
      return true;
    }
  }
  return false;
}

function outermostWorkspaceBoundaryFrom(cwd) {
  if (!cwd) return null;
  let current = path.resolve(cwd);
  let found = null;
  for (;;) {
    if (existsSync(path.join(current, ".git"))) found = current;
    const parent = path.dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

function workspaceBoundaryCandidates(cwd) {
  const candidates = [];
  const logicalBoundary = outermostWorkspaceBoundaryFrom(cwd);
  if (logicalBoundary) candidates.push(logicalBoundary);
  try {
    const realCwd = realpathSync.native(cwd);
    const realBoundary = outermostWorkspaceBoundaryFrom(realCwd);
    if (realBoundary) candidates.push(realBoundary);
  } catch {
    // If cwd itself cannot be resolved, the logical walk above is the only
    // safe boundary evidence available.
  }
  return [...new Set(candidates)];
}

export function resolveGitBinary(options = {}) {
  const env = options.env ?? process.env;
  const override = env[GIT_BINARY_ENV];
  if (!override) return DEFAULT_GIT_BINARY;

  if (!path.isAbsolute(override)) {
    throw new Error(`${GIT_BINARY_ENV} must be an absolute path to a Git executable.`);
  }

  const boundaryCandidates = options.workspaceRoot
    ? [...new Set([options.workspaceRoot, ...workspaceBoundaryCandidates(options.cwd)])]
    : workspaceBoundaryCandidates(options.cwd);
  if (boundaryCandidates.length === 0) {
    throw new Error(`${GIT_BINARY_ENV} requires a workspace boundary; run from inside a Git workspace before using an override.`);
  }
  const cacheKey = `${override}\0${boundaryCandidates.map((candidate) => path.resolve(candidate)).join("\0")}`;
  const cached = resolvedGitCache.get(cacheKey);
  if (cached) return cached;

  const literalGit = path.resolve(override);
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

  for (const candidateRoot of boundaryCandidates) {
    const logicalWorkspace = path.resolve(candidateRoot);
    let realWorkspace;
    try {
      realWorkspace = realpathSync.native(candidateRoot);
    } catch {
      realWorkspace = logicalWorkspace;
    }
    for (const workspace of new Set([logicalWorkspace, realWorkspace])) {
      for (const gitPath of new Set([literalGit, realGit])) {
        if (isInsidePath(workspace, gitPath)) {
          throw new Error(`${GIT_BINARY_ENV} must not point inside the current workspace.`);
        }
      }
    }
  }

  if (hasNodeModulesBinSegment(literalGit) || hasNodeModulesBinSegment(realGit)) {
    throw new Error(`${GIT_BINARY_ENV} must not point inside node_modules/.bin.`);
  }

  resolvedGitCache.set(cacheKey, realGit);
  return realGit;
}

export function gitEnv(baseEnv = process.env) {
  return { ...baseEnv, PATH: GIT_SAFE_PATH };
}

export function isGitBinaryPolicyError(error) {
  return error instanceof Error && error.message.startsWith(`${GIT_BINARY_ENV} `);
}
