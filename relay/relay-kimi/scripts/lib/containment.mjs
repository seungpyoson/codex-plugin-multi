// containment.mjs — "where does the target CLI write, and how do I clean up that
// space?" (spec §21.4). Strictly orthogonal to scope.mjs: this file does NOT
// decide what content to populate; it only creates / owns the writable space.
//
// Two containment values are valid today (spec §21.4):
//
//   "none"     — the target CLI runs directly in the user's cwd. No tempdir, no
//                cleanup. Used by rescue (the user WANTS writes to land in
//                their tree) and by ping (nothing to contain).
//   "worktree" — a fresh empty directory under os.tmpdir(); the target CLI writes
//                there; cleanup removes it. Used by review /
//                adversarial-review (read-only modes that still want a
//                sandbox in case the model ignores the flag and tries).
//
// Contract:
//
//   setupContainment(profile, sourceCwd) -> { path, cleanup, disposed }
//
//   `path`      — the directory the target CLI's include/add-dir flag should point at. For
//                 containment=none this IS sourceCwd.
//   `cleanup()` — idempotent. Removes the tempdir (containment=worktree) or
//                 is a no-op (containment=none).
//   `disposed`  — true when cleanup() did real work (caller uses this to
//                 record a `worktree_cleaned` flag on the job record).
//
// This module intentionally has no role in deciding scope contents. Current
// scope population writes ordinary files into this tempdir.

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const VALID = new Set(["none", "worktree"]);

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
  const dir = mkdtempSync(path.join(tmpdir(), "kimi-worktree-"));
  const state = { removed: false };
  const handle = {
    path: dir,
    disposed: true,
    cleanup() {
      if (state.removed) return; // idempotent
      state.removed = true;
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    },
  };
  return handle;
}
