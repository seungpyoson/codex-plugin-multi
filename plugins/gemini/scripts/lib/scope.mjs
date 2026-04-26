// scope.mjs — "what content does the target CLI see?" (spec §21.4). Strictly
// orthogonal to containment.mjs: this file does not create / destroy
// directories; it only populates the directory the caller provides.
//
// Five scope values (spec §21.4):
//
//   "working-tree" — tracked + untracked + ignored files from the live
//                    source tree. Lets review see the dirty state the user
//                    is actually working on (M6 finding #4).
//   "staged"       — raw git object content from the git index; modified-
//                    unstaged lines are left out.
//   "branch-diff"  — files touched between a base ref (default "main") and
//                    HEAD. The files are copied as raw HEAD object content.
//   "head"         — raw HEAD object content, rooted at sourceCwd.
//   "custom"       — caller-supplied globs via runtimeInputs.scopePaths.
//
// Git-derived scopes (staged, branch-diff, head) are object-pure: regular
// blobs are streamed directly from INDEX/HEAD, 120000 symlink blobs are
// resolved only through INDEX/HEAD metadata, and checkout filters, attributes,
// LFS smudge, textconv, hooks, replace refs, grafts, and config-defined shell
// commands are not run or honored.
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
// scope_requires_git, scope_requires_head, scope_base_missing, scope_paths_required,
// unsafe_symlink, and scope_population_failed.

import { execFileSync } from "node:child_process";
import {
  mkdirSync, copyFileSync, chmodSync,
  statSync, lstatSync, realpathSync, unlinkSync, openSync, closeSync,
  readdirSync, rmSync,
} from "node:fs";
import path from "node:path";

const VALID_SCOPES = new Set(["working-tree", "staged", "branch-diff", "head", "custom"]);
const MAX_GIT_SYMLINK_HOPS = 40;
const OBJECT_PURE_GIT_CONFIG = [
  "--no-replace-objects",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.gvfs=false",
  "-c", "core.virtualFilesystem=false",
];

function cleanGitEnv() {
  const env = {
    ...process.env,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const k of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX",
    "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_REPLACE_REF_BASE",
    "GIT_ATTR_SOURCE",
    "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_PAGER_IN_USE", "PAGER",
  ]) {
    delete env[k];
  }
  for (const k of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  }
  return env;
}

function git(sourceCwd, args, opts = {}) {
  return execFileSync("git", [...OBJECT_PURE_GIT_CONFIG, "-C", sourceCwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", opts.stderrInherit ? "inherit" : "pipe"],
    env: cleanGitEnv(),
    maxBuffer: 1024 * 1024 * 64,
    ...opts,
  });
}

function gitBuffer(sourceCwd, args, opts = {}) {
  return execFileSync("git", [...OBJECT_PURE_GIT_CONFIG, "-C", sourceCwd, ...args], {
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

function assertGitHead(ctx, sourceCwd) {
  try {
    git(ctx.gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return;
  } catch {
    throw new Error(`scope_requires_head: scope requires a committed HEAD at ${sourceCwd}`);
  }
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
    else scopePopulationFailed(`unsupported git file mode ${mode} for ${dst}`);
  } catch (err) {
    scopePopulationFailed(`cannot chmod git file ${dst}: ${err.message}`);
  }
}

function isSafeSnapshotRel(rel) {
  if (rel === "" || path.posix.isAbsolute(rel)) return false;
  return rel.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"
  );
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

function gitScopeContext(sourceCwd) {
  const sourceRoot = realpathSync(sourceCwd);
  const gitRoot = path.resolve(git(sourceCwd, ["rev-parse", "--show-toplevel"]).trim());
  const rawPrefix = git(sourceCwd, ["rev-parse", "--show-prefix"]).trim();
  const sourcePrefix = rawPrefix.replace(/\/+$/, "");
  return {
    gitRoot,
    sourceRoot,
    sourcePrefix,
    sourcePrefixes: gitSourcePrefixes(sourceCwd, sourceRoot),
  };
}

function toGitRel(ctx, snapshotRel) {
  return ctx.sourcePrefix ? `${ctx.sourcePrefix}/${snapshotRel}` : snapshotRel;
}

function toSnapshotRel(ctx, gitRel) {
  if (!ctx.sourcePrefix) return gitRel;
  if (gitRel === ctx.sourcePrefix) return "";
  const prefix = `${ctx.sourcePrefix}/`;
  if (!gitRel.startsWith(prefix)) return null;
  return gitRel.slice(prefix.length);
}

function isRegularGitFileMode(mode) {
  return mode === "100644" || mode === "100755";
}

function isTreeGitMode(mode) {
  return mode === "040000";
}

function parseGitEntryList(raw) {
  return raw.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    if (tab === -1) return null;
    const meta = entry.slice(0, tab).split(/\s+/);
    if (meta[1] === "blob" || meta[1] === "tree" || meta[1] === "commit") {
      return { mode: meta[0], type: meta[1], object: meta[2], stage: null, rel: entry.slice(tab + 1) };
    }
    return { mode: meta[0], object: meta[1], stage: meta[2], rel: entry.slice(tab + 1) };
  }).filter(Boolean);
}

function indexEntries(sourceCwd) {
  return parseGitEntryList(git(sourceCwd, ["ls-files", "-s", "-z"]));
}

function indexSymlinkEntries(sourceCwd) {
  return indexEntries(sourceCwd)
    .filter((entry) => entry.stage === "0")
    .filter((entry) => entry.mode === "120000")
    .map((entry) => entry.rel);
}

function headEntries(sourceCwd) {
  return parseGitEntryList(git(sourceCwd, ["ls-tree", "-r", "-z", "HEAD"]));
}

function headSymlinkEntries(sourceCwd) {
  return headEntries(sourceCwd)
    .filter((entry) => entry.mode === "120000")
    .map((entry) => entry.rel);
}

function scopedGitEntries(ctx, entries) {
  const out = [];
  for (const entry of entries) {
    const snapshotRel = toSnapshotRel(ctx, entry.rel);
    if (!snapshotRel) continue;
    if (!isSafeSnapshotRel(snapshotRel)) {
      scopePopulationFailed(`unsafe git entry path ${snapshotRel}`);
    }
    out.push({ ...entry, snapshotRel });
  }
  return out;
}

function assertNoUnmergedIndexEntries(ctx, entries) {
  for (const entry of entries) {
    if (entry.stage === "0") continue;
    const snapshotRel = toSnapshotRel(ctx, entry.rel);
    if (snapshotRel && isSafeSnapshotRel(snapshotRel)) {
      scopePopulationFailed(`unmerged index entry ${snapshotRel}`);
    }
  }
}

function entryMap(entries) {
  return new Map(entries.map((entry) => [entry.snapshotRel, entry]));
}

function snapshotAccess(ctx, entriesByRel) {
  return {
    entryMode: (_sourceCwd, rel) => entriesByRel.get(rel)?.mode ?? null,
    blob: (_sourceCwd, rel) => {
      const entry = entriesByRel.get(rel);
      if (!entry?.object) throw new Error(`missing object for ${rel}`);
      return gitBuffer(ctx.gitRoot, ["cat-file", "blob", entry.object]);
    },
    hasPathPrefix: (_sourceCwd, rel) => {
      if (!isSafeSnapshotRel(rel)) return false;
      const prefix = `${rel}/`;
      for (const key of entriesByRel.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    },
    writeObject: (_sourceCwd, object, dst, mode, rel) => writeGitBlobToFile(ctx.gitRoot, object, dst, mode, rel),
  };
}

function writeGitBlobToFile(sourceCwd, objectSpec, dst, mode, rel = objectSpec) {
  try {
    mkdirSync(path.dirname(dst), { recursive: true });
  } catch (err) {
    scopePopulationFailed(`cannot create git blob directory ${rel}: ${err.message}`);
  }
  let fd;
  try {
    fd = openSync(dst, "w");
  } catch (err) {
    scopePopulationFailed(`cannot open git blob ${rel}: ${err.message}`);
  }
  let copyFailed = false;
  try {
    execFileSync("git", [...OBJECT_PURE_GIT_CONFIG, "-C", sourceCwd, "cat-file", "blob", objectSpec], {
      stdio: ["ignore", fd, "pipe"],
      env: cleanGitEnv(),
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    copyFailed = true;
    unlinkIfExists(dst, rel);
    scopePopulationFailed(`cannot copy git blob ${rel}: ${err.message}`);
  } finally {
    try {
      closeSync(fd);
    } catch (err) {
      if (!copyFailed) {
        unlinkIfExists(dst, rel);
        scopePopulationFailed(`cannot close git blob ${rel}: ${err.message}`);
      }
    }
  }
  try {
    chmodGitMode(dst, mode);
  } catch (err) {
    unlinkIfExists(dst, rel);
    throw err;
  }
}

function prepareGitSnapshotTarget(sourceCwd, targetPath) {
  if (path.resolve(sourceCwd) === path.resolve(targetPath)) return;
  try {
    rmSync(targetPath, { recursive: true, force: true });
    mkdirSync(targetPath, { recursive: true });
  } catch (err) {
    scopePopulationFailed(`cannot prepare git snapshot target: ${err.message}`);
  }
}

function cleanupGitSnapshotTarget(sourceCwd, targetPath) {
  if (path.resolve(sourceCwd) === path.resolve(targetPath)) return;
  rmSync(targetPath, { recursive: true, force: true });
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

function materializeHeadSymlink(ctx, targetPath, rel, access, entriesByRel) {
  const linkTarget = access.blob(ctx.gitRoot, rel).toString("utf8");
  const target = resolveGitSnapshotSymlinkTarget(
    ctx.gitRoot, rel, linkTarget, ctx.sourcePrefixes,
    access.entryMode, access.blob, access.hasPathPrefix, "HEAD"
  );
  const targetEntry = entriesByRel.get(target.rel);
  if (!targetEntry?.object) unsafeSymlink(rel, "cannot be read in HEAD");
  const dst = path.join(targetPath, rel);
  access.writeObject(ctx.gitRoot, targetEntry.object, dst, target.mode, target.rel);
}

function materializeGitSnapshotSymlinks(ctx, targetPath, entryMode, blob, hasPathPrefix, writeObject, symlinkEntries, entriesByRel, snapshotName) {
  const symlinkRels = new Set(symlinkEntries);
  function walk(absDir, relDir = "") {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return;
      scopePopulationFailed(`cannot read directory ${relDir || "."}: ${err.message}`);
    }
    for (const ent of entries) {
      if (ent.name.toLowerCase() === ".git") continue;
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
      linkTarget = blob(ctx.gitRoot, rel).toString("utf8");
    } catch {
      unsafeSymlink(rel, `cannot be read in ${snapshotName}`);
    }
    const target = resolveGitSnapshotSymlinkTarget(
      ctx.gitRoot, rel, linkTarget, ctx.sourcePrefixes, entryMode, blob, hasPathPrefix, snapshotName
    );
    const targetEntry = entriesByRel.get(target.rel);
    if (!targetEntry?.object) unsafeSymlink(rel, `cannot be read in ${snapshotName}`);
    writeObject(ctx.gitRoot, targetEntry.object, path.join(targetPath, rel), target.mode, target.rel);
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
      if (ent.name.toLowerCase() === ".git") continue;
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
  const ctx = gitScopeContext(sourceCwd);
  const entries = indexEntries(ctx.gitRoot);
  assertNoUnmergedIndexEntries(ctx, entries);
  const unsupported = scopedGitEntries(ctx, entries)
    .filter((entry) => entry.stage === "0")
    .find((entry) => !isRegularGitFileMode(entry.mode) && entry.mode !== "120000" && entry.mode !== "160000");
  if (unsupported) {
    scopePopulationFailed(`unsupported git entry ${unsupported.snapshotRel} mode ${unsupported.mode}`);
  }
  const scopedEntries = scopedGitEntries(ctx, entries)
    .filter((entry) => entry.stage === "0")
    .filter((entry) => isRegularGitFileMode(entry.mode) || entry.mode === "120000");
  const entriesByRel = entryMap(scopedEntries);
  const access = snapshotAccess(ctx, entriesByRel);
  prepareGitSnapshotTarget(sourceCwd, targetPath);
  try {
    const symlinkSnapshotRels = scopedGitEntries(ctx, indexSymlinkEntries(ctx.gitRoot).map((rel) => ({ rel })))
      .map((entry) => entry.snapshotRel);
    for (const entry of scopedEntries) {
      if (entry.mode === "120000") continue;
      access.writeObject(ctx.gitRoot, entry.object, path.join(targetPath, entry.snapshotRel), entry.mode, entry.snapshotRel);
    }
    materializeGitSnapshotSymlinks(
      ctx, targetPath, access.entryMode, access.blob, access.hasPathPrefix,
      access.writeObject, symlinkSnapshotRels, entriesByRel, "INDEX"
    );
  } catch (err) {
    cleanupGitSnapshotTarget(sourceCwd, targetPath);
    throw err;
  }
}

function scopeBranchDiff(sourceCwd, targetPath, scopeBase) {
  assertGitWorktree(sourceCwd);
  const ctx = gitScopeContext(sourceCwd);
  assertGitHead(ctx, sourceCwd);
  const base = scopeBase ?? "main";
  // Verify base exists. `rev-parse --verify` exits non-zero if not.
  try {
    git(ctx.gitRoot, ["rev-parse", "--verify", "--quiet", base]);
  } catch {
    throw new Error(`scope_base_missing: base ref ${JSON.stringify(base)} does not exist in ${sourceCwd}`);
  }
  // Files changed between base..HEAD. Use merge-base range to avoid picking
  // up files that moved on the base side only.
  let mergeBase;
  try {
    mergeBase = git(ctx.gitRoot, ["merge-base", base, "HEAD"]).trim();
  } catch {
    throw new Error(`scope_base_missing: base ref ${JSON.stringify(base)} has no merge-base with HEAD in ${sourceCwd}`);
  }
  prepareGitSnapshotTarget(sourceCwd, targetPath);
  const raw = git(ctx.gitRoot, ["diff", "--name-only", "-z", `${mergeBase}..HEAD`]);
  const files = [];
  for (const gitRel of raw.split("\0").filter(Boolean)) {
    const snapshotRel = toSnapshotRel(ctx, gitRel);
    if (!snapshotRel) continue;
    if (!isSafeSnapshotRel(snapshotRel)) {
      scopePopulationFailed(`unsafe git entry path ${snapshotRel}`);
    }
    files.push({ gitRel, snapshotRel });
  }
  if (files.length === 0) return;
  const materializations = [];
  const entriesByRel = entryMap(scopedGitEntries(ctx, headEntries(ctx.gitRoot)));
  const access = snapshotAccess(ctx, entriesByRel);
  for (const { gitRel, snapshotRel } of files) {
    const entry = entriesByRel.get(snapshotRel);
    const mode = entry?.mode ?? null;
    if (mode === null || mode === "160000") {
      materializations.push({ gitRel, snapshotRel, mode });
      continue;
    }
    if (mode === "120000") {
      const linkTarget = access.blob(ctx.gitRoot, snapshotRel).toString("utf8");
      const target = resolveGitSnapshotSymlinkTarget(
        ctx.gitRoot, snapshotRel, linkTarget, ctx.sourcePrefixes,
        access.entryMode, access.blob, access.hasPathPrefix, "HEAD"
      );
      materializations.push({ gitRel, snapshotRel, mode, target });
      continue;
    }
    if (!isRegularGitFileMode(mode)) {
      scopePopulationFailed(`unsupported git entry ${snapshotRel} mode ${mode}`);
    }
    materializations.push({ gitRel, snapshotRel, mode });
  }
  try {
    for (const { snapshotRel, mode } of materializations) {
      if (mode === null) continue; // deleted in HEAD vs base — nothing to copy
      if (mode === "160000") continue; // gitlink/submodule entries have no blob to copy
      if (mode === "120000") {
        materializeHeadSymlink(ctx, targetPath, snapshotRel, access, entriesByRel);
        continue;
      }
      const entry = entriesByRel.get(snapshotRel);
      if (!entry?.object) scopePopulationFailed(`cannot find HEAD object for ${snapshotRel}`);
      access.writeObject(ctx.gitRoot, entry.object, path.join(targetPath, snapshotRel), mode, snapshotRel);
    }
  } catch (err) {
    cleanupGitSnapshotTarget(sourceCwd, targetPath);
    throw err;
  }
}

function scopeHead(sourceCwd, targetPath, containmentHandle) {
  assertGitWorktree(sourceCwd);
  const ctx = gitScopeContext(sourceCwd);
  assertGitHead(ctx, sourceCwd);
  const entries = headEntries(ctx.gitRoot);
  const unsupported = scopedGitEntries(ctx, entries)
    .find((entry) => !isRegularGitFileMode(entry.mode) && entry.mode !== "120000" && entry.mode !== "160000");
  if (unsupported) {
    scopePopulationFailed(`unsupported git entry ${unsupported.snapshotRel} mode ${unsupported.mode}`);
  }
  const scopedEntries = scopedGitEntries(ctx, entries)
    .filter((entry) => isRegularGitFileMode(entry.mode) || entry.mode === "120000");
  const entriesByRel = entryMap(scopedEntries);
  const access = snapshotAccess(ctx, entriesByRel);
  prepareGitSnapshotTarget(sourceCwd, targetPath);
  try {
    const symlinkSnapshotRels = scopedGitEntries(ctx, headSymlinkEntries(ctx.gitRoot).map((rel) => ({ rel })))
      .map((entry) => entry.snapshotRel);
    for (const entry of scopedEntries) {
      if (entry.mode === "120000") continue;
      access.writeObject(ctx.gitRoot, entry.object, path.join(targetPath, entry.snapshotRel), entry.mode, entry.snapshotRel);
    }
    materializeGitSnapshotSymlinks(
      ctx, targetPath, access.entryMode, access.blob, access.hasPathPrefix,
      access.writeObject, symlinkSnapshotRels, entriesByRel, "HEAD"
    );
  } catch (err) {
    cleanupGitSnapshotTarget(sourceCwd, targetPath);
    throw err;
  }
  if (containmentHandle) containmentHandle._scopeHeadOf = null;
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
