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
//   "head"         — files from HEAD, rooted at sourceCwd.
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
  mkdirSync, copyFileSync, chmodSync, writeFileSync,
  statSync, lstatSync, realpathSync, readFileSync, readlinkSync, symlinkSync, unlinkSync,
  readdirSync, mkdtempSync, rmSync, existsSync,
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
    scopePopulationFailed(`cannot chmod git file ${dst}: ${err.message}`);
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
  return entries.map((entry) => ({
    ...entry,
    snapshotRel: toSnapshotRel(ctx, entry.rel),
  })).filter((entry) => entry.snapshotRel && isSafeSnapshotRel(entry.snapshotRel));
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

function indexAccess(ctx) {
  return {
    entryMode: (_sourceCwd, rel) => indexEntryMode(ctx.gitRoot, toGitRel(ctx, rel)),
    blob: (_sourceCwd, rel) => indexBlob(ctx.gitRoot, toGitRel(ctx, rel)),
    hasPathPrefix: (_sourceCwd, rel) => indexPathPrefixExists(ctx.gitRoot, toGitRel(ctx, rel)),
  };
}

function headAccess(ctx) {
  return {
    entryMode: (_sourceCwd, rel) => headEntryMode(ctx.gitRoot, toGitRel(ctx, rel)),
    blob: (_sourceCwd, rel) => headBlob(ctx.gitRoot, toGitRel(ctx, rel)),
    hasPathPrefix: (_sourceCwd, rel) => headPathPrefixExists(ctx.gitRoot, toGitRel(ctx, rel)),
  };
}

function checkoutBase(ctx, checkoutRoot) {
  if (!ctx.sourcePrefix) return checkoutRoot;
  return path.join(checkoutRoot, ...ctx.sourcePrefix.split("/"));
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function attributeGitRelCandidates(gitRel) {
  const parts = gitRel.split("/");
  const out = [".gitattributes"];
  for (let i = 1; i < parts.length; i++) {
    out.push(`${parts.slice(0, i).join("/")}/.gitattributes`);
  }
  return out;
}

function checkoutGitRelsWithAttributes(ctx, snapshotRels, entryMode) {
  const gitRels = uniqueSorted(snapshotRels.map((rel) => toGitRel(ctx, rel)));
  const attrs = uniqueSorted(gitRels.flatMap(attributeGitRelCandidates))
    .filter((rel) => isRegularGitFileMode(entryMode(ctx.gitRoot, rel)));
  return uniqueSorted([...attrs, ...gitRels]);
}

function tempCheckoutDir(targetPath, label) {
  return mkdtempSync(path.join(path.dirname(targetPath), `${path.basename(targetPath)}-${label}-`));
}

function writeIndexAttributeFiles(ctx, checkoutRoot, attrs) {
  for (const rel of attrs) {
    const dst = path.join(checkoutRoot, rel);
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      writeFileSync(dst, gitBuffer(ctx.gitRoot, ["show", `:${rel}`]));
    } catch (err) {
      scopePopulationFailed(`cannot checkout INDEX attributes ${rel}: ${err.message}`);
    }
  }
}

function gitPath(sourceCwd, rel) {
  const raw = git(sourceCwd, ["rev-parse", "--git-path", rel]).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(sourceCwd, raw);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function absolutizeRelativeFilterCommand(command, sourceRoot) {
  const match = command.match(/^(\s*)(\.{1,2}\/\S+)(.*)$/);
  if (!match) return command;
  return `${match[1]}${shellQuote(path.resolve(sourceRoot, match[2]))}${match[3]}`;
}

function rewriteRelativeFilterCommands(configPath, sourceRoot) {
  if (!existsSync(configPath)) return;
  const lines = readFileSync(configPath, "utf8").split("\n");
  let inFilterSection = false;
  const rewritten = lines.map((line) => {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inFilterSection = section[1].trim().startsWith("filter ");
      return line;
    }
    if (!inFilterSection) return line;
    const eq = line.indexOf("=");
    if (eq === -1) return line;
    const key = line.slice(0, eq).trim();
    if (!new Set(["clean", "smudge", "process"]).has(key)) return line;
    return `${line.slice(0, eq + 1)}${absolutizeRelativeFilterCommand(line.slice(eq + 1), sourceRoot)}`;
  }).join("\n");
  writeFileSync(configPath, rewritten);
}

function prepareIndexCheckoutGitDir(ctx, checkoutRoot) {
  const gitDir = path.join(checkoutRoot, ".git");
  mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
  mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/snapshot\n");
  copyFileSync(gitPath(ctx.gitRoot, "index"), path.join(gitDir, "index"));
  const configPath = gitPath(ctx.gitRoot, "config");
  if (existsSync(configPath)) {
    copyFileSync(configPath, path.join(gitDir, "config"));
  } else {
    writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
  }
  rewriteRelativeFilterCommands(path.join(gitDir, "config"), ctx.gitRoot);
  const worktreeConfigPath = gitPath(ctx.gitRoot, "config.worktree");
  if (existsSync(worktreeConfigPath)) {
    copyFileSync(worktreeConfigPath, path.join(gitDir, "config.worktree"));
    rewriteRelativeFilterCommands(path.join(gitDir, "config.worktree"), ctx.gitRoot);
  }
  writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${gitPath(ctx.gitRoot, "objects")}\n`);
  return gitDir;
}

function checkoutIndexToTemp(ctx, targetPath, gitRels) {
  const checkoutRoot = tempCheckoutDir(targetPath, "index");
  try {
    if (gitRels.length > 0) {
      const gitDir = prepareIndexCheckoutGitDir(ctx, checkoutRoot);
      const attrs = gitRels.filter((rel) => rel === ".gitattributes" || rel.endsWith("/.gitattributes"));
      if (attrs.length > 0) {
        writeIndexAttributeFiles(ctx, checkoutRoot, attrs);
      }
      execFileSync("git", ["-c", "core.attributesFile=/dev/null", "checkout-index", "-f", "--", ...gitRels], {
        cwd: ctx.gitRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...cleanGitEnv(),
          GIT_DIR: gitDir,
          GIT_WORK_TREE: checkoutRoot,
          GIT_ATTR_NOSYSTEM: "1",
        },
        maxBuffer: 1024 * 1024 * 64,
      });
    }
    return checkoutRoot;
  } catch (err) {
    rmSync(checkoutRoot, { recursive: true, force: true });
    scopePopulationFailed(`cannot checkout INDEX: ${err.message}`);
  }
}

function checkoutHeadToTemp(ctx, targetPath, gitRels) {
  const checkoutRoot = tempCheckoutDir(targetPath, "head");
  try {
    execFileSync("git", ["-C", ctx.gitRoot, "worktree", "add", "--detach", "--no-checkout", "--force", checkoutRoot, "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanGitEnv(),
    });
    if (gitRels.length > 0) {
      execFileSync("git", ["-C", checkoutRoot, "checkout", "--force", "HEAD", "--", ...gitRels], {
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
      });
    }
    return checkoutRoot;
  } catch (err) {
    removeHeadCheckout(ctx, checkoutRoot);
    scopePopulationFailed(`cannot checkout HEAD: ${err.message}`);
  }
}

function removeHeadCheckout(ctx, checkoutRoot) {
  try {
    execFileSync("git", ["-C", ctx.gitRoot, "worktree", "remove", "--force", checkoutRoot], {
      stdio: ["ignore", "pipe", "ignore"],
      env: cleanGitEnv(),
    });
  } catch {
    // Fall through to rmSync; the registration will be pruned by git later if needed.
  }
  rmSync(checkoutRoot, { recursive: true, force: true });
}

function copyCheckoutTreeToTarget(ctx, checkoutRoot, targetPath) {
  const srcRoot = checkoutBase(ctx, checkoutRoot);
  try {
    rmSync(targetPath, { recursive: true, force: true });
    mkdirSync(targetPath, { recursive: true });
  } catch (err) {
    scopePopulationFailed(`cannot prepare checkout target: ${err.message}`);
  }
  if (!lstatForScope(srcRoot, ".")) return;
  function copyEntry(src, dst, rel) {
    const lst = lstatForScope(src, rel);
    if (!lst) return;
    if (lst.isSymbolicLink()) {
      try {
        mkdirSync(path.dirname(dst), { recursive: true });
        symlinkSync(readlinkSync(src), dst);
      } catch (err) {
        scopePopulationFailed(`cannot copy checkout symlink ${rel}: ${err.message}`);
      }
      return;
    }
    if (lst.isDirectory()) {
      try {
        mkdirSync(dst, { recursive: true });
      } catch (err) {
        scopePopulationFailed(`cannot create checkout directory ${rel}: ${err.message}`);
      }
      let entries;
      try {
        entries = readdirSync(src, { withFileTypes: true });
      } catch (err) {
        if (err?.code === "ENOENT") return;
        scopePopulationFailed(`cannot read checkout directory ${rel || "."}: ${err.message}`);
      }
      for (const ent of entries) {
        if (ent.name === ".git") continue;
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        copyEntry(path.join(src, ent.name), path.join(dst, ent.name), childRel);
      }
      return;
    }
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    } catch (err) {
      scopePopulationFailed(`cannot copy checkout file ${rel}: ${err.message}`);
    }
  }
  let entries;
  try {
    entries = readdirSync(srcRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return;
    scopePopulationFailed(`cannot read checkout directory .: ${err.message}`);
  }
  for (const ent of entries) {
    if (ent.name === ".git") continue;
    copyEntry(path.join(srcRoot, ent.name), path.join(targetPath, ent.name), ent.name);
  }
}

function writeCheckoutFile(ctx, checkoutRoot, rel, dst, mode = null) {
  const src = path.join(checkoutBase(ctx, checkoutRoot), rel);
  const lst = lstatForScope(src, rel);
  if (!lst) scopePopulationFailed(`cannot copy checkout file ${rel}: missing from checkout`);
  if (!lst.isFile()) scopePopulationFailed(`cannot copy checkout file ${rel}: checkout entry is not a regular file`);
  try {
    mkdirSync(path.dirname(dst), { recursive: true });
  } catch (err) {
    scopePopulationFailed(`cannot create checkout file directory ${rel}: ${err.message}`);
  }
  try {
    copyFileSync(src, dst);
  } catch (err) {
    unlinkIfExists(dst, rel);
    scopePopulationFailed(`cannot copy checkout file ${rel}: ${err.message}`);
  }
  try {
    chmodGitMode(dst, mode);
  } catch (err) {
    unlinkIfExists(dst, rel);
    throw err;
  }
}

function indexAccessFromCheckout(ctx, checkoutRoot) {
  const access = indexAccess(ctx);
  return {
    ...access,
    writeBlob: (_sourceCwd, rel, dst, mode) => writeCheckoutFile(ctx, checkoutRoot, rel, dst, mode),
  };
}

function headAccessFromCheckout(ctx, checkoutRoot) {
  const access = headAccess(ctx);
  return {
    ...access,
    writeBlob: (_sourceCwd, rel, dst, mode) => writeCheckoutFile(ctx, checkoutRoot, rel, dst, mode),
  };
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

function materializeHeadSymlink(ctx, targetPath, rel, access) {
  const linkTarget = access.blob(ctx.gitRoot, rel).toString("utf8");
  const target = resolveGitSnapshotSymlinkTarget(
    ctx.gitRoot, rel, linkTarget, ctx.sourcePrefixes,
    access.entryMode, access.blob, access.hasPathPrefix, "HEAD"
  );
  const dst = path.join(targetPath, rel);
  access.writeBlob(ctx.gitRoot, target.rel, dst, target.mode);
}

function materializeGitSnapshotSymlinks(ctx, targetPath, entryMode, blob, hasPathPrefix, writeBlob, symlinkEntries, snapshotName) {
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
      linkTarget = blob(ctx.gitRoot, rel).toString("utf8");
    } catch {
      unsafeSymlink(rel, `cannot be read in ${snapshotName}`);
    }
    const target = resolveGitSnapshotSymlinkTarget(
      ctx.gitRoot, rel, linkTarget, ctx.sourcePrefixes, entryMode, blob, hasPathPrefix, snapshotName
    );
    writeBlob(ctx.gitRoot, target.rel, path.join(targetPath, rel), target.mode);
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
  const checkoutRoot = checkoutIndexToTemp(
    ctx,
    targetPath,
    checkoutGitRelsWithAttributes(ctx, scopedEntries.map((entry) => entry.snapshotRel), indexEntryMode),
  );
  try {
    copyCheckoutTreeToTarget(ctx, checkoutRoot, targetPath);
    const access = indexAccessFromCheckout(ctx, checkoutRoot);
    materializeGitSnapshotSymlinks(
      ctx, targetPath, access.entryMode, access.blob, access.hasPathPrefix,
      access.writeBlob, scopedGitEntries(ctx, indexSymlinkEntries(ctx.gitRoot).map((rel) => ({ rel }))).map((entry) => entry.snapshotRel), "INDEX"
    );
  } finally {
    rmSync(checkoutRoot, { recursive: true, force: true });
  }
}

function scopeBranchDiff(sourceCwd, targetPath, scopeBase) {
  assertGitWorktree(sourceCwd);
  const ctx = gitScopeContext(sourceCwd);
  const base = scopeBase ?? "main";
  // Verify base exists. `rev-parse --verify` exits non-zero if not.
  try {
    git(ctx.gitRoot, ["rev-parse", "--verify", "--quiet", base]);
  } catch {
    throw new Error(`scope_base_missing: base ref ${JSON.stringify(base)} does not exist in ${sourceCwd}`);
  }
  // Files changed between base..HEAD. Use merge-base range to avoid picking
  // up files that moved on the base side only.
  const mergeBase = git(ctx.gitRoot, ["merge-base", base, "HEAD"]).trim();
  const raw = git(ctx.gitRoot, ["diff", "--name-only", "-z", `${mergeBase}..HEAD`]);
  const files = raw.split("\0").filter(Boolean)
    .map((gitRel) => ({ gitRel, snapshotRel: toSnapshotRel(ctx, gitRel) }))
    .filter((entry) => entry.snapshotRel && isSafeSnapshotRel(entry.snapshotRel));
  if (files.length === 0) return;
  const access = headAccess(ctx);
  const materializations = [];
  const checkoutSnapshotRels = [];
  for (const { gitRel, snapshotRel } of files) {
    const mode = headEntryMode(ctx.gitRoot, gitRel);
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
      checkoutSnapshotRels.push(target.rel);
      materializations.push({ gitRel, snapshotRel, mode, target });
      continue;
    }
    if (!isRegularGitFileMode(mode)) {
      scopePopulationFailed(`unsupported git entry ${snapshotRel} mode ${mode}`);
    }
    checkoutSnapshotRels.push(snapshotRel);
    materializations.push({ gitRel, snapshotRel, mode });
  }
  const checkoutRoot = checkoutHeadToTemp(
    ctx,
    targetPath,
    checkoutGitRelsWithAttributes(ctx, checkoutSnapshotRels, headEntryMode),
  );
  try {
    const checkoutAccess = headAccessFromCheckout(ctx, checkoutRoot);
    for (const { gitRel, snapshotRel, mode } of materializations) {
      if (mode === null) continue; // deleted in HEAD vs base — nothing to copy
      if (mode === "160000") continue; // gitlink/submodule entries have no blob to copy
      if (mode === "120000") {
        materializeHeadSymlink(ctx, targetPath, snapshotRel, checkoutAccess);
        continue;
      }
      checkoutAccess.writeBlob(ctx.gitRoot, snapshotRel, path.join(targetPath, snapshotRel), mode);
    }
  } finally {
    removeHeadCheckout(ctx, checkoutRoot);
  }
}

function scopeHead(sourceCwd, targetPath, containmentHandle) {
  assertGitWorktree(sourceCwd);
  const ctx = gitScopeContext(sourceCwd);
  const unsupported = scopedGitEntries(ctx, headEntries(ctx.gitRoot))
    .find((entry) => !isRegularGitFileMode(entry.mode) && entry.mode !== "120000" && entry.mode !== "160000");
  if (unsupported) {
    scopePopulationFailed(`unsupported git entry ${unsupported.snapshotRel} mode ${unsupported.mode}`);
  }
  const scopedEntries = scopedGitEntries(ctx, headEntries(ctx.gitRoot))
    .filter((entry) => isRegularGitFileMode(entry.mode) || entry.mode === "120000");
  const checkoutRoot = checkoutHeadToTemp(
    ctx,
    targetPath,
    checkoutGitRelsWithAttributes(ctx, scopedEntries.map((entry) => entry.snapshotRel), headEntryMode),
  );
  try {
    copyCheckoutTreeToTarget(ctx, checkoutRoot, targetPath);
    const access = headAccessFromCheckout(ctx, checkoutRoot);
    materializeGitSnapshotSymlinks(
      ctx, targetPath, access.entryMode, access.blob, access.hasPathPrefix,
      access.writeBlob, scopedGitEntries(ctx, headSymlinkEntries(ctx.gitRoot).map((rel) => ({ rel }))).map((entry) => entry.snapshotRel), "HEAD"
    );
  } finally {
    removeHeadCheckout(ctx, checkoutRoot);
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
