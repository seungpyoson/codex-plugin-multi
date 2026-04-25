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
// no-op. The caller always calls
// setupContainment first and populateScope second; this module trusts that
// order.
//
// All git subprocess calls scrub inherited git env vars — if the companion
// was launched from inside a pre-commit hook, GIT_DIR etc. would otherwise
// hijack every `git -C <path>` into the parent repo. Same discipline as the
// pre-T7.2 setupWorktree helper.
//
// Failure tags emitted by populateScope include: invalid_profile,
// scope_requires_git, scope_base_missing, scope_paths_required,
// unsafe_symlink, and scope_population_failed.

import { execFileSync } from "node:child_process";
import {
  mkdirSync, copyFileSync, chmodSync,
  statSync, lstatSync, realpathSync, unlinkSync,
  readdirSync, openSync, closeSync,
} from "node:fs";
import path from "node:path";

const VALID_SCOPES = new Set(["working-tree", "staged", "branch-diff", "head", "custom"]);
const MAX_GIT_SYMLINK_HOPS = 40;

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
    encoding: null,
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
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function unsafeSymlink(rel, reason) {
  throw new Error(`unsafe_symlink: ${rel} ${reason}`);
}

function scopePopulationFailed(message) {
  throw new Error(`scope_population_failed: ${message}`);
}

function lstatForScope(abs, rel) {
  try {
    return lstatSync(abs);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    scopePopulationFailed(`cannot stat ${rel || "."}: ${err.message}`);
  }
}

function unlinkIfExists(abs, rel) {
  try {
    unlinkSync(abs);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    scopePopulationFailed(`cannot remove ${rel}: ${err.message}`);
  }
}

function chmodGitMode(dst, mode) {
  try {
    if (mode === "100755") chmodSync(dst, 0o755);
    else if (mode === "100644") chmodSync(dst, 0o644);
  } catch (err) {
    scopePopulationFailed(`cannot chmod git blob ${dst}: ${err.message}`);
  }
}

function removePartialGitBlob(dst, objectSpec) {
  try {
    unlinkSync(dst);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    scopePopulationFailed(`cannot remove partial git blob ${objectSpec}: ${err.message}`);
  }
}

function isSafeSnapshotRel(rel) {
  return rel !== "" && rel !== "." && rel !== ".." &&
    !rel.startsWith("../") && !path.posix.isAbsolute(rel);
}

function splitAbsolutePath(absPath) {
  const root = path.parse(absPath).root;
  if (!root) return null;
  return {
    root,
    parts: absPath.slice(root.length).split(/[\\/]+/).filter(Boolean),
  };
}

function startsWithParts(parts, prefix) {
  if (prefix.length > parts.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (parts[i] !== prefix[i]) return false;
  }
  return true;
}

function gitSourcePrefixes(sourceCwd, sourceRoot) {
  const prefixes = [path.resolve(sourceCwd), path.resolve(sourceRoot)];
  try {
    prefixes.push(path.resolve(git(sourceCwd, ["rev-parse", "--show-toplevel"]).trim()));
  } catch {
    // assertGitWorktree runs before git-derived scope population; keep this
    // helper side-effect free if git becomes unavailable mid-population.
  }
  for (const prefix of [...prefixes]) {
    if (prefix.startsWith("/private/")) {
      prefixes.push(prefix.slice("/private".length));
    }
  }
  return [...new Set(prefixes)];
}

function absoluteSnapshotTargetParts(sourcePrefixes, absTarget) {
  if (!path.isAbsolute(absTarget)) return null;
  const target = splitAbsolutePath(absTarget);
  if (!target) return null;

  for (const prefixPath of sourcePrefixes) {
    const prefix = splitAbsolutePath(prefixPath);
    if (!prefix || prefix.root !== target.root) continue;
    if (startsWithParts(target.parts, prefix.parts)) {
      return target.parts.slice(prefix.parts.length);
    }
  }
  return null;
}

// Copy file `rel` from sourceCwd's live filesystem into targetPath/rel.
// Symlinks are never preserved in the target snapshot.
function copyLiveFile(sourceCwd, targetPath, rel, sourceRoot) {
  const src = path.join(sourceCwd, rel);
  const dst = path.join(targetPath, rel);
  // lstat (not stat) so symlinks report as symlinks rather than whatever
  // they point to.
  const lst = lstatForScope(src, rel);
  if (!lst) return; // raced away before we could inspect it
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
    let resolvedStat;
    try {
      resolvedStat = statSync(resolved);
    } catch (err) {
      scopePopulationFailed(`cannot stat ${rel}: ${err.message}`);
    }
    if (!resolvedStat.isFile()) {
      unsafeSymlink(rel, "does not resolve to a regular file");
    }
    try {
      copyFileSync(resolved, dst);
    } catch (err) {
      scopePopulationFailed(`cannot copy ${rel}: ${err.message}`);
    }
    return;
  }
  if (lst.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    return;
  }
  try {
    copyFileSync(src, dst);
  } catch (err) {
    scopePopulationFailed(`cannot copy ${rel}: ${err.message}`);
  }
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

function isTreeGitMode(mode) {
  return mode === "040000";
}

function headBlob(sourceCwd, rel) {
  return gitBuffer(sourceCwd, ["show", `HEAD:${rel}`]);
}

function indexBlob(sourceCwd, rel) {
  return gitBuffer(sourceCwd, ["show", `:${rel}`]);
}

function headPathPrefixExists(sourceCwd, rel) {
  if (!isSafeSnapshotRel(rel)) return false;
  return git(sourceCwd, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", `${rel}/`]) !== "";
}

function indexPathPrefixExists(sourceCwd, rel) {
  if (!isSafeSnapshotRel(rel)) return false;
  return git(sourceCwd, ["ls-files", "-z", "--", `${rel}/`]) !== "";
}

function parseGitEntryList(raw) {
  return raw.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    if (tab === -1) return null;
    const meta = entry.slice(0, tab).split(/\s+/);
    return { mode: meta[0], rel: entry.slice(tab + 1) };
  }).filter(Boolean);
}

function indexSymlinkEntries(sourceCwd) {
  return parseGitEntryList(git(sourceCwd, ["ls-files", "-s", "-z"]))
    .filter((entry) => entry.mode === "120000")
    .map((entry) => entry.rel);
}

function headSymlinkEntries(sourceCwd) {
  return parseGitEntryList(git(sourceCwd, ["ls-tree", "-r", "-z", "HEAD"]))
    .filter((entry) => entry.mode === "120000")
    .map((entry) => entry.rel);
}

function writeGitBlobToFile(sourceCwd, objectSpec, dst, mode = null) {
  mkdirSync(path.dirname(dst), { recursive: true });
  const fd = openSync(dst, "w");
  let execError = null;
  let closeError = null;
  try {
    execFileSync("git", ["-C", sourceCwd, "show", objectSpec], {
      stdio: ["ignore", fd, "pipe"],
      env: cleanGitEnv(),
    });
  } catch (err) {
    execError = err;
  }
  try {
    closeSync(fd);
  } catch (err) {
    closeError = err;
  }
  if (execError) {
    removePartialGitBlob(dst, objectSpec);
    scopePopulationFailed(`cannot copy git blob ${objectSpec}: ${execError.message}`);
  }
  if (closeError) {
    removePartialGitBlob(dst, objectSpec);
    scopePopulationFailed(`cannot close git blob ${objectSpec}: ${closeError.message}`);
  }
  try {
    chmodGitMode(dst, mode);
  } catch (err) {
    removePartialGitBlob(dst, objectSpec);
    throw err;
  }
}

function writeHeadBlobToPath(sourceCwd, rel, dst, mode = null) {
  writeGitBlobToFile(sourceCwd, `HEAD:${rel}`, dst, mode);
}

function writeIndexBlobToPath(sourceCwd, rel, dst, mode = null) {
  writeGitBlobToFile(sourceCwd, `:${rel}`, dst, mode);
}

function writeHeadBlob(sourceCwd, targetPath, rel, mode = null) {
  writeHeadBlobToPath(sourceCwd, rel, path.join(targetPath, rel), mode);
}

function snapshotTargetComponents(sourcePrefixes, currentRel, linkTarget) {
  if (path.isAbsolute(linkTarget)) {
    return absoluteSnapshotTargetParts(sourcePrefixes, linkTarget);
  }
  const baseDir = path.posix.dirname(currentRel);
  const base = baseDir === "." ? [] : baseDir.split("/");
  return [...base, ...linkTarget.split("/")];
}

function resolveGitSnapshotSymlinkTarget(sourceCwd, rel, linkTarget, sourcePrefixes, entryMode, blob, hasPathPrefix, snapshotName) {
  let pending = snapshotTargetComponents(sourcePrefixes, rel, linkTarget);
  if (!pending) unsafeSymlink(rel, "resolves outside source root");
  const resolved = [];
  const visited = new Set();
  let hops = 1;
  while (pending.length > 0) {
    const part = pending.shift();
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) unsafeSymlink(rel, "resolves outside source root");
      resolved.pop();
      continue;
    }
    const targetRel = [...resolved, part].join("/");
    if (!isSafeSnapshotRel(targetRel)) unsafeSymlink(rel, "resolves outside source root");
    const targetMode = entryMode(sourceCwd, targetRel);
    if (targetMode === "120000") {
      if (visited.has(targetRel)) unsafeSymlink(rel, `cycle in ${snapshotName}`);
      if (hops >= MAX_GIT_SYMLINK_HOPS) {
        unsafeSymlink(rel, `exceeds symlink depth limit in ${snapshotName}`);
      }
      visited.add(targetRel);
      hops += 1;
      let nextTarget;
      try {
        nextTarget = blob(sourceCwd, targetRel).toString("utf8");
      } catch {
        unsafeSymlink(rel, `cannot be read in ${snapshotName}`);
      }
      const nextPending = snapshotTargetComponents(sourcePrefixes, targetRel, nextTarget);
      if (!nextPending) unsafeSymlink(rel, "resolves outside source root");
      pending = [...nextPending, ...pending];
      resolved.length = 0;
      continue;
    }
    if (isRegularGitFileMode(targetMode)) {
      if (pending.length > 0) {
        unsafeSymlink(rel, `does not resolve to a regular file in ${snapshotName}`);
      }
      return { rel: targetRel, mode: targetMode };
    }
    if (isTreeGitMode(targetMode)) {
      if (pending.length === 0) {
        unsafeSymlink(rel, `does not resolve to a regular file in ${snapshotName}`);
      }
      resolved.push(part);
      continue;
    }
    if (targetMode === null) {
      if (pending.length === 0) {
        if (hasPathPrefix(sourceCwd, targetRel)) {
          unsafeSymlink(rel, `does not resolve to a regular file in ${snapshotName}`);
        }
        unsafeSymlink(rel, `is dangling in ${snapshotName}`);
      }
      if (!hasPathPrefix(sourceCwd, targetRel)) {
        unsafeSymlink(rel, `is dangling in ${snapshotName}`);
      }
      resolved.push(part);
      continue;
    }
    unsafeSymlink(rel, `does not resolve to a regular file in ${snapshotName}`);
  }
  unsafeSymlink(rel, `does not resolve to a regular file in ${snapshotName}`);
}

function materializeHeadSymlink(sourceCwd, targetPath, rel, sourceRoot) {
  const linkTarget = headBlob(sourceCwd, rel).toString("utf8");
  const sourcePrefixes = gitSourcePrefixes(sourceCwd, sourceRoot);
  const target = resolveGitSnapshotSymlinkTarget(
    sourceCwd, rel, linkTarget, sourcePrefixes, headEntryMode, headBlob, headPathPrefixExists, "HEAD"
  );
  const dst = path.join(targetPath, rel);
  writeHeadBlobToPath(sourceCwd, target.rel, dst, target.mode);
}

function materializeGitSnapshotSymlinks(sourceCwd, targetPath, sourceRoot, entryMode, blob, hasPathPrefix, writeBlob, symlinkEntries, snapshotName) {
  const symlinkRels = new Set(symlinkEntries);
  const sourcePrefixes = gitSourcePrefixes(sourceCwd, sourceRoot);
  function walk(absDir, relDir = "") {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return;
      scopePopulationFailed(`cannot read directory ${relDir || "."}: ${err.message}`);
    }
    for (const ent of entries) {
      if (ent.name === ".git") continue;
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const abs = path.join(absDir, ent.name);
      const lst = lstatForScope(abs, rel);
      if (!lst) continue;
      if (lst.isSymbolicLink()) {
        symlinkRels.add(rel);
      } else if (lst.isDirectory()) {
        walk(abs, rel);
      }
    }
  }
  walk(targetPath);
  for (const rel of [...symlinkRels].sort()) {
    const abs = path.join(targetPath, rel);
    const lst = lstatForScope(abs, rel);
    if (!lst) continue;
    if (lst.isDirectory()) {
      scopePopulationFailed(`cannot replace symlink entry ${rel}: destination is a directory`);
    }
    unlinkIfExists(abs, rel);
  }
  for (const rel of [...symlinkEntries].sort()) {
    let linkTarget;
    try {
      linkTarget = blob(sourceCwd, rel).toString("utf8");
    } catch {
      unsafeSymlink(rel, `cannot be read in ${snapshotName}`);
    }
    const target = resolveGitSnapshotSymlinkTarget(
      sourceCwd, rel, linkTarget, sourcePrefixes, entryMode, blob, hasPathPrefix, snapshotName
    );
    writeBlob(sourceCwd, target.rel, path.join(targetPath, rel), target.mode);
  }
}

function listLiveWorkingTreeFiles(sourceCwd) {
  const out = [];
  function walk(absDir, relDir = "") {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return;
      scopePopulationFailed(`cannot read directory ${relDir || "."}: ${err.message}`);
    }
    for (const ent of entries) {
      if (ent.name === ".git") continue;
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      const abs = path.join(absDir, ent.name);
      const lst = lstatForScope(abs, rel);
      if (!lst) continue;
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
    sourceCwd, targetPath, realpathSync(sourceCwd), indexEntryMode, indexBlob,
    indexPathPrefixExists, writeIndexBlobToPath, indexSymlinkEntries(sourceCwd), "INDEX"
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
    if (mode === "160000") continue; // gitlink/submodule entries have no blob to copy
    if (mode === "120000") {
      materializeHeadSymlink(sourceCwd, targetPath, rel, sourceRoot);
      continue;
    }
    if (!isRegularGitFileMode(mode)) {
      scopePopulationFailed(`unsupported git entry ${rel} mode ${mode}`);
    }
    // Content at HEAD. Stream raw `git show HEAD:<file>` bytes into the
    // snapshot so large or binary files are not buffered or re-encoded.
    writeHeadBlob(sourceCwd, targetPath, rel, mode);
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
    sourceCwd, targetPath, realpathSync(sourceCwd), headEntryMode, headBlob,
    headPathPrefixExists, writeHeadBlobToPath, headSymlinkEntries(sourceCwd), "HEAD"
  );
}

function matchGlob(rel, pattern) {
  // Minimal glob: supports '*' (no /) and '**' (any), '?' (single). Good
  // enough for scope=custom's "<dir>/*.md" and "**/*.js" shapes; we avoid
  // pulling in a full micromatch dep. This is a small supported subset, not a
  // claim of full shell-glob compatibility.
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
