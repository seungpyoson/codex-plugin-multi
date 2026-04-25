// scope.mjs — "what content does the target CLI see?" (spec §21.4). Strictly
// orthogonal to containment.mjs: this file does not create / destroy
// directories; it only populates the directory the caller provides.
//
// Five scope values (spec §21.4):
//
//   "working-tree" — tracked + untracked + ignored files from the live
//                    source tree. Lets review see the dirty state the user
//                    is actually working on (M6 finding #4).
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
  mkdirSync, copyFileSync, writeFileSync,
  statSync, lstatSync, realpathSync, readlinkSync, unlinkSync,
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

function gitBuffer(sourceCwd, args, opts = {}) {
  return execFileSync("git", ["-C", sourceCwd, ...args], {
    stdio: ["ignore", "pipe", opts.stderrInherit ? "inherit" : "pipe"],
    env: cleanGitEnv(),
    maxBuffer: 1024 * 1024 * 64,
    ...opts,
  });
}

function assertGitWorktree(sourceCwd) {
  try {
    const inside = git(sourceCwd, ["rev-parse", "--is-inside-work-tree"]).trim();
    if (inside === "true") return;
  } catch {
    // Fall through to the stable, scope-level error below.
  }
  throw new Error(`scope_requires_git: scope requires a git worktree at ${sourceCwd}`);
}

function isInsidePath(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function unsafeSymlink(rel, reason) {
  throw new Error(`unsafe_symlink: ${rel} ${reason}`);
}

function realpathExistingPrefix(candidate) {
  const suffix = [];
  let current = candidate;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.normalize(candidate);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

// Copy file `rel` from sourceCwd's live filesystem into targetPath/rel.
// Symlinks are never preserved in the target snapshot.
function copyLiveFile(sourceCwd, targetPath, rel, sourceRoot = realpathSync(sourceCwd)) {
  const src = path.join(sourceCwd, rel);
  const dst = path.join(targetPath, rel);
  let lst;
  // lstat (not stat) so symlinks report as symlinks rather than whatever
  // they point to.
  try { lst = lstatSync(src); }
  catch { return; } // raced away; skip
  mkdirSync(path.dirname(dst), { recursive: true });
  if (lst.isSymbolicLink()) {
    let resolved;
    try {
      resolved = realpathSync(src);
    } catch {
      unsafeSymlink(rel, "cannot be resolved");
    }
    if (!isInsidePath(sourceRoot, resolved)) {
      unsafeSymlink(rel, "resolves outside source root");
    }
    const resolvedStat = statSync(resolved);
    if (!resolvedStat.isFile()) {
      unsafeSymlink(rel, "does not resolve to a regular file");
    }
    copyFileSync(resolved, dst);
    return;
  }
  if (lst.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    return;
  }
  copyFileSync(src, dst);
}

function headEntryMode(sourceCwd, rel) {
  const entry = git(sourceCwd, ["ls-tree", "-z", "HEAD", "--", rel]);
  if (!entry) return null;
  return entry.slice(0, entry.indexOf(" ")); // mode from "<mode> <type> <object>\t<path>"
}

function indexEntryMode(sourceCwd, rel) {
  const entries = git(sourceCwd, ["ls-files", "-s", "-z", "--", rel]).split("\0").filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const entryPath = entry.slice(tab + 1);
    if (entryPath !== rel) continue;
    return entry.slice(0, entry.indexOf(" ")); // mode from "<mode> <object> <stage>\t<path>"
  }
  return null;
}

function isRegularGitFileMode(mode) {
  return mode === "100644" || mode === "100755";
}

function headBlob(sourceCwd, rel) {
  return gitBuffer(sourceCwd, ["show", `HEAD:${rel}`]);
}

function indexBlob(sourceCwd, rel) {
  return gitBuffer(sourceCwd, ["show", `:${rel}`]);
}

function writeHeadBlob(sourceCwd, targetPath, rel) {
  const dst = path.join(targetPath, rel);
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, headBlob(sourceCwd, rel));
}

function resolveGitSnapshotSymlinkTarget(sourceCwd, rel, linkTarget, sourceRoot, entryMode, snapshotName) {
  const baseDir = path.join(sourceRoot, ...path.posix.dirname(rel).split("/").filter(Boolean));
  const targetAbs = path.isAbsolute(linkTarget)
    ? realpathExistingPrefix(linkTarget)
    : path.resolve(baseDir, linkTarget);
  if (!isInsidePath(sourceRoot, targetAbs)) {
    unsafeSymlink(rel, "resolves outside source root");
  }
  const targetRel = path.relative(sourceRoot, targetAbs).split(path.sep).join("/");
  if (targetRel === "") {
    unsafeSymlink(rel, `does not resolve to a regular file in ${snapshotName}`);
  }
  const targetMode = entryMode(sourceCwd, targetRel);
  if (targetMode === null) {
    unsafeSymlink(rel, `is dangling in ${snapshotName}`);
  }
  if (!isRegularGitFileMode(targetMode)) {
    unsafeSymlink(rel, `does not resolve to a regular file in ${snapshotName}`);
  }
  return targetRel;
}

function materializeHeadSymlink(sourceCwd, targetPath, rel, sourceRoot) {
  const linkTarget = headBlob(sourceCwd, rel).toString("utf8");
  const targetRel = resolveGitSnapshotSymlinkTarget(
    sourceCwd, rel, linkTarget, sourceRoot, headEntryMode, "HEAD"
  );
  const dst = path.join(targetPath, rel);
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, headBlob(sourceCwd, targetRel));
}

function materializeGitSnapshotSymlinks(sourceCwd, targetPath, sourceRoot, entryMode, blob, snapshotName) {
  const symlinks = [];
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
      if (lst.isSymbolicLink()) {
        symlinks.push({ abs, rel, linkTarget: readlinkSync(abs) });
      } else if (lst.isDirectory()) {
        walk(abs, rel);
      }
    }
  }
  walk(targetPath);
  for (const { abs } of symlinks) {
    unlinkSync(abs);
  }
  for (const { abs, rel, linkTarget } of symlinks) {
    const targetRel = resolveGitSnapshotSymlinkTarget(
      sourceCwd, rel, linkTarget, sourceRoot, entryMode, snapshotName
    );
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, blob(sourceCwd, targetRel));
  }
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
  // Spec §21.4 says working-tree is everything in the user's live tree,
  // including tracked, untracked, and ignored files. A filesystem walk also
  // supports ordinary non-git directories.
  const sourceRoot = realpathSync(sourceCwd);
  for (const rel of listLiveWorkingTreeFiles(sourceCwd)) {
    copyLiveFile(sourceCwd, targetPath, rel, sourceRoot);
  }
}

function scopeStaged(sourceCwd, targetPath) {
  assertGitWorktree(sourceCwd);
  // checkout-index --all populates the tree matching the INDEX under prefix.
  // Trailing slash on prefix is required — git treats the last path-segment
  // as a filename otherwise.
  const prefix = targetPath.endsWith(path.sep) ? targetPath : targetPath + path.sep;
  mkdirSync(targetPath, { recursive: true });
  git(sourceCwd, ["checkout-index", "-a", "-f", `--prefix=${prefix}`]);
  materializeGitSnapshotSymlinks(
    sourceCwd, targetPath, realpathSync(sourceCwd), indexEntryMode, indexBlob, "INDEX"
  );
}

function scopeBranchDiff(sourceCwd, targetPath, scopeBase) {
  assertGitWorktree(sourceCwd);
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
  const sourceRoot = realpathSync(sourceCwd);
  for (const rel of files) {
    const mode = headEntryMode(sourceCwd, rel);
    if (mode === null) continue; // deleted in HEAD vs base — nothing to copy
    if (mode === "120000") {
      materializeHeadSymlink(sourceCwd, targetPath, rel, sourceRoot);
      continue;
    }
    // Content at HEAD. `git show HEAD:<file>` emits raw bytes; we must use
    // buffer mode (encoding: null) to avoid mangling binary files.
    try {
      writeHeadBlob(sourceCwd, targetPath, rel);
    } catch {
      continue; // deleted in HEAD vs base — nothing to copy
    }
  }
}

function scopeHead(sourceCwd, targetPath, containmentHandle) {
  assertGitWorktree(sourceCwd);
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
  materializeGitSnapshotSymlinks(
    sourceCwd, targetPath, realpathSync(sourceCwd), headEntryMode, headBlob, "HEAD"
  );
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
  // Custom is filesystem-backed like working-tree, then narrowed by globs.
  const all = listLiveWorkingTreeFiles(sourceCwd);
  const matched = all.filter((rel) => scopePaths.some((g) => matchGlob(rel, g)));
  const sourceRoot = realpathSync(sourceCwd);
  for (const rel of matched) copyLiveFile(sourceCwd, targetPath, rel, sourceRoot);
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
    case "working-tree": scopeWorkingTree(sourceCwd, targetPath); break;
    case "staged":       scopeStaged(sourceCwd, targetPath); break;
    case "branch-diff":  scopeBranchDiff(sourceCwd, targetPath, runtimeInputs.scopeBase); break;
    case "head":         scopeHead(sourceCwd, targetPath, containmentHandle); break;
    case "custom":       scopeCustom(sourceCwd, targetPath, runtimeInputs.scopePaths); break;
    default:
      // Defensive: VALID_SCOPES check above makes this unreachable.
      throw new Error(`invalid_profile: scope ${profile.scope}`);
  }
}
