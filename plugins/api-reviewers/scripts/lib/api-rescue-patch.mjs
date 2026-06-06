import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const API_RESCUE_PATCH_SCHEMA_VERSION = 1;
export const MAX_RESCUE_PATCH_BYTES = 512 * 1024;

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function proposalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pathSegments(value) {
  return String(value).split(/[\\/]+/).filter(Boolean);
}

function hasUnsafePathSyntax(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return true;
  if (relPath.includes("\0") || /[\u0000-\u001f\u007f]/u.test(relPath)) return true;
  if (relPath.includes("\\")) return true;
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || relPath.startsWith("//")) return true;
  if (relPath.includes(".git")) return true;
  return pathSegments(relPath).includes("..");
}

function isDeniedRuntimePath(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) return true;
  if (normalized.startsWith("plugins/api-reviewers/")) return true;
  if (normalized.startsWith("plugins/relay-deepseek/")) return true;
  if (normalized.startsWith("plugins/relay-glm/")) return true;
  if (normalized.startsWith("relay/relay-deepseek/")) return true;
  if (normalized.startsWith("relay/relay-glm/")) return true;
  if (normalized.startsWith("scripts/")) return true;
  if (normalized === "package.json" || normalized.endsWith("/package.json")) return true;
  if (/^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.toml|Cargo\.lock|Makefile|makefile|Justfile|justfile)$/.test(normalized)) return true;
  if (/^plugins\/[^/]+\/(?:commands|skills|agents|config|policies)\//.test(normalized)) return true;
  if (/^relay\/[^/]+\/(?:commands|skills|agents|config|policies)\//.test(normalized)) return true;
  return false;
}

function assertInsideWorkspace(realWorkspaceRoot, candidateRealPath, relPath) {
  const realRel = relative(realWorkspaceRoot, candidateRealPath);
  if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
    throw proposalError("rescue_patch_unsafe_path", `rescue patch path escapes workspace: ${relPath}`);
  }
}

function assertParentInsideWorkspace(realWorkspaceRoot, candidateRealPath, relPath) {
  const realRel = relative(realWorkspaceRoot, candidateRealPath);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw proposalError("rescue_patch_unsafe_path", `rescue patch path escapes workspace: ${relPath}`);
  }
}

async function nearestExistingParent(pathname) {
  let current = dirname(pathname);
  for (;;) {
    try {
      const stat = await lstat(current);
      return { path: current, stat };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const next = dirname(current);
      if (next === current) throw error;
      current = next;
    }
  }
}

async function validateWorkspacePath(workspaceRoot, relPath) {
  if (hasUnsafePathSyntax(relPath)) {
    throw proposalError("rescue_patch_unsafe_path", `unsafe rescue patch path: ${relPath}`);
  }
  if (isDeniedRuntimePath(relPath)) {
    throw proposalError("rescue_patch_unsafe_path", `rescue patch path is denied by policy: ${relPath}`);
  }
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const abs = resolve(workspaceRoot, relPath);
  const normalizedRel = relative(workspaceRoot, abs);
  if (normalizedRel === "" || normalizedRel.startsWith("..") || isAbsolute(normalizedRel)) {
    throw proposalError("rescue_patch_unsafe_path", `unsafe rescue patch path: ${relPath}`);
  }
  try {
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) {
      throw proposalError("rescue_patch_unsafe_path", `rescue patch targets symlink: ${relPath}`);
    }
    assertInsideWorkspace(realWorkspaceRoot, await realpath(abs), relPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = await nearestExistingParent(abs);
    if (parent.stat.isSymbolicLink()) {
      throw proposalError("rescue_patch_unsafe_path", `rescue patch parent is symlink: ${relPath}`);
    }
    assertParentInsideWorkspace(realWorkspaceRoot, await realpath(parent.path), relPath);
  }
}

function validateUnifiedDiffText(diff) {
  if (/(?:^|\n)GIT binary patch(?:\n|$)/.test(diff) || /(?:^|\n)Binary files /.test(diff)) {
    throw proposalError("rescue_patch_binary_unsupported", "binary rescue patches are not supported");
  }
  if (/(?:^|\n)(?:old mode|new mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to) /.test(diff)) {
    throw proposalError("rescue_patch_unsupported_file_change", "rescue patches may not change file modes, rename, or copy files");
  }
  if (/(?:^|\n)new file mode (?!100644(?:\n|$))/.test(diff) || /(?:^|\n)index [0-9a-f]+\.\.[0-9a-f]+ 1[0-9]{5}/.test(diff)) {
    throw proposalError("rescue_patch_unsupported_file_change", "rescue patches may not change file modes or gitlinks");
  }
}

function parseJsonProposal(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw proposalError("rescue_patch_parse_failed", "rescue patch proposal is empty");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw proposalError("rescue_patch_parse_failed", `rescue patch proposal is not JSON: ${error.message}`);
  }
}

function normalizeDiffPath(value) {
  if (typeof value !== "string" || value.length === 0 || value === "/dev/null") return null;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

function proposedFilesFromUnifiedDiff(diff) {
  const files = new Set();
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/.exec(line);
      if (match) {
        const nextPath = normalizeDiffPath(`b/${match[2]}`);
        if (nextPath) files.add(nextPath);
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const nextPath = normalizeDiffPath(line.slice(4).trim());
      if (nextPath) files.add(nextPath);
    }
  }
  return [...files].sort();
}

export function parseRescuePatchProposal(text) {
  const proposal = parseJsonProposal(text);
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw proposalError("rescue_patch_parse_failed", "rescue patch proposal must be an object");
  }
  if (proposal.schema_version !== API_RESCUE_PATCH_SCHEMA_VERSION) {
    throw proposalError("rescue_patch_parse_failed", `rescue patch proposal schema_version must be ${API_RESCUE_PATCH_SCHEMA_VERSION}`);
  }
  if (typeof proposal.summary !== "string" || proposal.summary.trim().length === 0) {
    throw proposalError("rescue_patch_parse_failed", "rescue patch proposal summary is required");
  }
  if (typeof proposal.unified_diff !== "string") {
    throw proposalError("rescue_patch_parse_failed", "rescue patch proposal unified_diff must be a string");
  }
  const patchBytes = Buffer.byteLength(proposal.unified_diff, "utf8");
  if (patchBytes === 0) throw proposalError("rescue_patch_empty", "rescue patch proposal unified_diff is empty");
  if (patchBytes > MAX_RESCUE_PATCH_BYTES) {
    throw proposalError("rescue_patch_too_large", `rescue patch proposal unified_diff exceeds ${MAX_RESCUE_PATCH_BYTES} bytes`);
  }
  validateUnifiedDiffText(proposal.unified_diff);
  const verification = Array.isArray(proposal.verification)
    ? proposal.verification.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
  const proposedFiles = proposedFilesFromUnifiedDiff(proposal.unified_diff);
  if (proposedFiles.length === 0) {
    throw proposalError("rescue_patch_parse_failed", "rescue patch proposal has no proposed files");
  }
  return Object.freeze({
    schema_version: API_RESCUE_PATCH_SCHEMA_VERSION,
    summary: proposal.summary,
    unified_diff: proposal.unified_diff,
    verification,
    patch_hash: sha256Hex(proposal.unified_diff),
    proposed_files: Object.freeze(proposedFiles),
    patch_bytes: patchBytes,
  });
}

export async function validateRescuePatchSafety(proposal, { workspaceRoot }) {
  if (!proposal || typeof proposal !== "object") {
    throw proposalError("rescue_patch_parse_failed", "rescue patch proposal is required");
  }
  validateUnifiedDiffText(proposal.unified_diff ?? "");
  for (const relPath of proposal.proposed_files ?? []) {
    await validateWorkspacePath(workspaceRoot, relPath);
  }
  return true;
}
