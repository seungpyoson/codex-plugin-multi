// containment.mjs — "where does Claude write, and how do I clean up that
// space?" (spec §21.4). Strictly orthogonal to scope.mjs: this file does NOT
// decide what content to populate; it only creates / owns the writable space.
//
// Two containment values are valid today (spec §21.4):
//
//   "none"     — Claude runs directly in the user's cwd. No tempdir, no
//                cleanup. Used by rescue (the user WANTS writes to land in
//                their tree) and by ping (nothing to contain).
//   "worktree" — a fresh empty directory under os.tmpdir(); Claude writes
//                there; cleanup removes it. Used by review /
//                adversarial-review (read-only modes that still want a
//                sandbox in case the model ignores the flag and tries).
//
// Contract:
//
//   setupContainment(profile, sourceCwd) -> { path, cleanup, disposed }
//
//   `path`      — the directory Claude's --add-dir should point at. For
//                 containment=none this IS sourceCwd.
//   `cleanup()` — idempotent. Removes the tempdir (containment=worktree) or
//                 is a no-op (containment=none). Also tries `git worktree
//                 remove` if populateScope later registered the path with
//                 the source repo (scope=head), but that call is
//                 best-effort — if git has never heard of the path we just
//                 fall through to rmSync.
//   `disposed`  — true when cleanup() did real work (caller uses this to
//                 record a `worktree_cleaned` flag on the job record).
//
// This module intentionally has NO dependency on git. populateScope may
// invoke `git worktree add` (scope=head), which registers the path; cleanup
// handles both shapes by trying worktree-remove against every plausible
// source repo and falling back to rmSync. populateScope communicates the
// "this path is now a git worktree of <sourceCwd>" fact by storing
// `_scopeHeadOf` on the containment object.

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";

const VALID = new Set(["none", "worktree"]);

function cleanGitEnv() {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) {
    delete env[k];
  }
  return env;
}

export function setupContainment(profile, sourceCwd) {
  if (!profile || typeof profile !== "object" || typeof profile.containment !== "string") {
    throw new Error("invalid_profile: profile.containment is required");
  }
  if (!VALID.has(profile.containment)) {
    throw new Error(`invalid_profile: unknown containment ${JSON.stringify(profile.containment)} (expected: ${[...VALID].join(", ")})`);
  }

  if (profile.containment === "none") {
    return {
      path: sourceCwd,
      cleanup() { /* no-op — never remove the user's cwd */ },
      disposed: false,
    };
  }

  // containment === "worktree"
  const dir = mkdtempSync(path.join(tmpdir(), "claude-worktree-"));
  const state = { removed: false, scopeHeadOf: null };
  const handle = {
    path: dir,
    disposed: true,
    // Set by populateScope when scope=head registered the path as a git
    // worktree of this source repo. Cleanup uses this to call
    // `git worktree remove` before rmSync.
    set _scopeHeadOf(v) { state.scopeHeadOf = v; },
    get _scopeHeadOf() { return state.scopeHeadOf; },
    cleanup() {
      if (state.removed) return; // idempotent
      state.removed = true;
      if (state.scopeHeadOf) {
        try {
          execFileSync("git", ["-C", state.scopeHeadOf, "worktree", "remove", "--force", dir], {
            stdio: ["ignore", "pipe", "ignore"],
            env: cleanGitEnv(),
          });
        } catch {
          // Source repo gone or worktree already detached. rmSync below
          // handles the dir on disk; the registration entry will be
          // reaped on the source repo's next `git worktree list --porcelain`
          // prune cycle.
        }
      }
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    },
  };
  return handle;
}
