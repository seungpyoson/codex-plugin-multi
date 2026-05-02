import { runCommand } from "./process.mjs";
import { cleanGitEnv } from "./git-env.mjs";

// PR #21 review HIGH 5 backside: this lib is called from
// workspace.mjs::resolveWorkspaceRoot, which runs at the start of every
// companion subcommand. Without scrubbing, a parent env exporting
// GIT_DIR=/elsewhere would silently make the companion think its workspace
// root is /elsewhere — same hijack class as the test fixtures. The shared
// cleanGitEnv covers GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_GLOBAL, the trace
// family, and indexed config injection.
function git(cwd, args, options = {}) {
  const env = cleanGitEnv(options.env ?? process.env);
  return runCommand("git", args, { cwd, ...options, env });
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}
