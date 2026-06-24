import { ensureGitRepository } from "./git.mjs";
import { isGitBinaryPolicyError } from "./git-binary.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch (err) {
    if (isGitBinaryPolicyError(err)) throw err;
    return cwd;
  }
}
