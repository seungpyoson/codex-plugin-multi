// scope.mjs — "what content does the target CLI see?" (spec §21.4). Strictly
// orthogonal to containment.mjs: this file does not create / destroy
// directories; it only populates the directory the caller provides.
//
// Five scope values (spec §21.4):
//
//   "working-tree" — tracked + untracked (excluding .gitignore'd) from the
//                    live source tree. Lets review see the dirty state the
//                    user is actually working on (M6 finding #4).
//   "staged"       — the git index contents; modified-unstaged lines are
//                    left out.
//   "branch-diff"  — files touched between a base ref (default "main") and
//                    HEAD. The files are copied at HEAD content.
//   "head"         — a real `git worktree add HEAD` (registers with source
//                    repo; populate writes `_scopeHeadOf` on the containment
//                    handle so cleanup can unregister).
//   "custom"       — caller-supplied globs via runtimeInputs.scopePaths.
//
// When containment=none, the targetPath IS sourceCwd and populateScope is a
// no-op. The caller (claude-companion.executeRun) always calls
// setupContainment first and populateScope second; this module trusts that
// order.
//
// All git subprocess calls scrub inherited git env vars — if the companion
// was launched from inside a pre-commit hook, GIT_DIR etc. would otherwise
// hijack every `git -C <path>` into the parent repo. Same discipline as the
// pre-T7.2 setupWorktree helper.

import { execFileSync } from "node:child_process";
import {
  mkdirSync, copyFileSync, writeFileSync, existsSync,
  statSync, lstatSync, symlinkSync, readlinkSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const VALID_SCOPES = new Set(["working-tree", "staged", "branch-diff", "head", "custom"]);

function cleanGitEnv() {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) {
    delete env[k];
  }
  return env;
}

function git(sourceCwd, args, opts = {}) {
  return execFileSync("git", ["-C", sourceCwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", opts.stderrInherit ? "inherit" : "pipe"],
    env: cleanGitEnv(),
    maxBuffer: 1024 * 1024 * 64,
    ...opts,
  });
}

// Copy file `rel` from sourceCwd's live filesystem into targetPath/rel,
// preserving symlinks. Parent dirs are created on demand.
function copyLiveFile(sourceCwd, targetPath, rel) {
  const src = path.join(sourceCwd, rel);
  const dst = path.join(targetPath, rel);
  let lst;
  // lstat (not stat) so symlinks report as symlinks rather than whatever
  // they point to.
  try { lst = lstatSync(src); }
  catch { return; } // raced away; skip
  mkdirSync(path.dirname(dst), { recursive: true });
  if (lst.isSymbolicLink()) {
    try {
      symlinkSync(readlinkSync(src), dst);
    } catch {
      // Fall back to content copy if the symlink target resolves; drop it
      // if the link is dangling.
      try {
        const resolved = statSync(src);
        if (resolved.isFile()) copyFileSync(src, dst);
      } catch { /* dangling */ }
    }
    return;
  }
  if (lst.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    return;
  }
  copyFileSync(src, dst);
}

function listLiveWorkingTreeFiles(sourceCwd) {
  const out = [];
  function walk(absDir, relDir = "") {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === ".git") continue;
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const abs = path.join(absDir, ent.name);
      let lst;
      try { lst = lstatSync(abs); }
      catch { continue; }
      if (lst.isDirectory()) {
        walk(abs, rel);
      } else {
        out.push(rel);
      }
    }
  }
  walk(sourceCwd);
  return out;
}

function scopeWorkingTree(sourceCwd, targetPath) {
  // Spec §21.4 says working-tree is everything in the user's tree, including
  // ignored files. `git ls-files -c` preserves tracked path knowledge while the
  // live filesystem walk adds ignored/untracked files that git would hide.
  const trackedRaw = git(sourceCwd, ["ls-files", "-c", "-z"]);
  const files = [...new Set([
    ...trackedRaw.split("\0").filter(Boolean),
    ...listLiveWorkingTreeFiles(sourceCwd),
  ])];
  for (const rel of files) copyLiveFile(sourceCwd, targetPath, rel);
}

function scopeStaged(sourceCwd, targetPath) {
  // checkout-index --all populates the tree matching the INDEX under prefix.
  // Trailing slash on prefix is required — git treats the last path-segment
  // as a filename otherwise.
  const prefix = targetPath.endsWith(path.sep) ? targetPath : targetPath + path.sep;
  mkdirSync(targetPath, { recursive: true });
  git(sourceCwd, ["checkout-index", "-a", "-f", `--prefix=${prefix}`]);
}

function scopeBranchDiff(sourceCwd, targetPath, scopeBase) {
  const base = scopeBase ?? "main";
  // Verify base exists. `rev-parse --verify` exits non-zero if not.
  try {
    git(sourceCwd, ["rev-parse", "--verify", "--quiet", base]);
  } catch {
    throw new Error(`scope_base_missing: base ref ${JSON.stringify(base)} does not exist in ${sourceCwd}`);
  }
  // Files changed between base..HEAD. Use merge-base range to avoid picking
  // up files that moved on the base side only.
  const mergeBase = git(sourceCwd, ["merge-base", base, "HEAD"]).trim();
  const raw = git(sourceCwd, ["diff", "--name-only", "-z", `${mergeBase}..HEAD`]);
  const files = raw.split("\0").filter(Boolean);
  for (const rel of files) {
    // Content at HEAD. `git show HEAD:<file>` emits raw bytes; we must use
    // buffer mode (encoding: null) to avoid mangling binary files.
    let buf;
    try {
      buf = execFileSync("git", ["-C", sourceCwd, "show", `HEAD:${rel}`], {
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
        maxBuffer: 1024 * 1024 * 64,
      });
    } catch {
      continue; // deleted in HEAD vs base — nothing to copy
    }
    const dst = path.join(targetPath, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, buf);
  }
}

function scopeHead(sourceCwd, targetPath, containmentHandle) {
  // `git worktree add` CREATES the target path; it must not pre-exist as a
  // non-empty directory. setupContainment's tempdir is empty — git accepts
  // that (it treats empty dirs the same as not-yet-existing).
  // Use --detach so we don't mint a branch ref; --force to tolerate git's
  // "already exists" complaint if setupContainment's mkdtemp left the dir
  // present.
  execFileSync("git", ["-C", sourceCwd, "worktree", "add", "--detach", "--force", targetPath, "HEAD"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanGitEnv(),
  });
  // Tell the containment handle to also unregister the worktree on cleanup.
  if (containmentHandle) containmentHandle._scopeHeadOf = sourceCwd;
}

function matchGlob(rel, pattern) {
  // Minimal glob: supports '*' (no /) and '**' (any), '?' (single). Good
  // enough for scope=custom's "<dir>/*.md" and "**/*.js" shapes; we avoid
  // pulling in a full micromatch dep.
  // Translate to regex.
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
        // Skip a trailing slash after ** so "**/a" matches "a" at any depth.
        if (pattern[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (".^$+(){}|\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  re += "$";
  return new RegExp(re).test(rel);
}

function scopeCustom(sourceCwd, targetPath, scopePaths) {
  if (!Array.isArray(scopePaths) || scopePaths.length === 0) {
    throw new Error("scope_paths_required: scope=custom needs runtimeInputs.scopePaths (non-empty array of globs)");
  }
  // List ALL tracked+untracked files once, then filter by any glob.
  const raw = git(sourceCwd, ["ls-files", "-co", "--exclude-standard", "-z"]);
  const all = raw.split("\0").filter(Boolean);
  const matched = all.filter((rel) => scopePaths.some((g) => matchGlob(rel, g)));
  for (const rel of matched) copyLiveFile(sourceCwd, targetPath, rel);
}

export function populateScope(profile, sourceCwd, targetPath, runtimeInputs = {}, containmentHandle = null) {
  if (!profile || typeof profile !== "object" || typeof profile.scope !== "string") {
    throw new Error("invalid_profile: profile.scope is required");
  }
  if (!VALID_SCOPES.has(profile.scope)) {
    throw new Error(`invalid_profile: unknown scope ${JSON.stringify(profile.scope)} (expected: ${[...VALID_SCOPES].join(", ")})`);
  }

  // containment=none short-circuits: the target CLI reads directly from sourceCwd,
  // nothing to populate. This check is structural (target === source), not
  // profile-field-based, so the caller's convention of "pass cwd as target
  // when containment=none" is the single source of truth.
  if (targetPath === sourceCwd) return;

  switch (profile.scope) {
    case "working-tree": return scopeWorkingTree(sourceCwd, targetPath);
    case "staged":       return scopeStaged(sourceCwd, targetPath);
    case "branch-diff":  return scopeBranchDiff(sourceCwd, targetPath, runtimeInputs.scopeBase);
    case "head":         return scopeHead(sourceCwd, targetPath, containmentHandle);
    case "custom":       return scopeCustom(sourceCwd, targetPath, runtimeInputs.scopePaths);
    default:
      // Defensive: VALID_SCOPES check above makes this unreachable.
      throw new Error(`invalid_profile: scope ${profile.scope}`);
  }
}
