import { ensureGitRepository } from "./git.mjs";
import { GIT_BINARY_ENV } from "./git-binary.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch (err) {
    if (err instanceof Error && err.message.includes(GIT_BINARY_ENV)) throw err;
    return cwd;
  }
}
