// #16 follow-up 9 — test-isolation helper.
//
// Every fixture-side `git` invocation must:
//   (1) be cwd-pinned to the temp fixture directory (never inherits the
//       caller's process.cwd()),
//   (2) scrub inherited GIT_* env vars so a test running inside a
//       pre-commit hook context cannot have its fixture writes hijacked
//       into the caller checkout (the bug class that produced
//       "branch changed to feature, commits like seed/main appeared,
//       fixture files foo.md/old.md/seed.txt deleted from the caller
//       worktree" — #16 addendum),
//   (3) use core.hooksPath=/dev/null so the caller's hook scripts cannot
//       run from the fixture's git invocations,
//   (4) carry deterministic author/committer identity so commits succeed
//       regardless of the caller's global git config.
//
// The strip list itself lives in plugins/{claude,gemini}/scripts/lib/git-env.mjs
// — the same canonical list every plugin/runner uses. PR #21's adversarial
// review caught that the OLD strip list missed GIT_CONFIG_GLOBAL etc., letting
// a malicious parent env override init.defaultBranch into the fixture; folding
// this onto the shared module makes the next gap a one-place fix.

import { spawnSync } from "node:child_process";
import { cleanGitEnv as scrubGitEnv } from "../../plugins/claude/scripts/lib/git-env.mjs";

/**
 * Build a sanitized environment for fixture git invocations. Always returns
 * a fresh object — callers may add more vars if they want, e.g.,
 *   const env = { ...fixtureGitEnv(), GIT_AUTHOR_DATE: "..." };
 */
export function fixtureGitEnv(extra = {}) {
  const env = scrubGitEnv(process.env);
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_AUTHOR_NAME = env.GIT_AUTHOR_NAME ?? "t";
  env.GIT_AUTHOR_EMAIL = env.GIT_AUTHOR_EMAIL ?? "t@t";
  env.GIT_COMMITTER_NAME = env.GIT_COMMITTER_NAME ?? "t";
  env.GIT_COMMITTER_EMAIL = env.GIT_COMMITTER_EMAIL ?? "t@t";
  return { ...env, ...extra };
}

/**
 * Run `git -C <cwd> -c core.hooksPath=/dev/null <args...>` with a
 * sanitized fixture env. Returns the spawnSync result; callers can
 * choose to throw on non-zero status.
 */
export function fixtureGit(cwd, args, opts = {}) {
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("fixtureGit: cwd must be a non-empty string");
  }
  return spawnSync(
    "git",
    ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      ...opts,
      env: fixtureGitEnv(opts.env ?? undefined),
    },
  );
}

/**
 * Initialise a temp git repo at cwd with a single seed commit.
 * Used by smoke tests that need a workspace whose target CLI run will
 * find a git worktree.
 */
export function fixtureSeedRepo(cwd, {
  branch = "main",
  fileName = "seed.txt",
  fileContents = "seed\n",
  message = "seed",
} = {}) {
  const init = fixtureGit(cwd, ["init", "-q", "-b", branch]);
  if (init.status !== 0) {
    throw new Error(`fixtureSeedRepo: git init failed: ${init.stderr ?? ""}`);
  }
  // Use bash so callers can keep the existing one-shot pattern without
  // importing fs. Bash inherits the sanitized env via spawnSync.
  const seed = spawnSync("bash", [
    "-c",
    `printf %s ${JSON.stringify(fileContents)} > ${JSON.stringify(fileName)} && ` +
    `git -c core.hooksPath=/dev/null add ${JSON.stringify(fileName)} && ` +
    `git -c core.hooksPath=/dev/null commit -q -m ${JSON.stringify(message)}`,
  ], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    env: fixtureGitEnv(),
  });
  if (seed.status !== 0) {
    throw new Error(`fixtureSeedRepo: seed failed: ${seed.stderr ?? ""}`);
  }
}
