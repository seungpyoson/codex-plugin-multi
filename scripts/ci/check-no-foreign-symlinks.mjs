#!/usr/bin/env node
// Repo-hygiene guard: every tracked symlink (git mode 120000) must resolve to a
// path that is itself tracked by this repository.
//
// Model: membership, fail-closed. The committed symlink blob is the same bytes
// on every clone, but a target that is not represented by tracked repo contents
// may be machine-specific, ignored, or absent on a fresh checkout. A tracked
// symlink is accepted only when its non-empty, relative target resolves to a
// tracked file or to a directory prefix containing tracked files. The tracked
// path set from `git ls-files -s -z` is the single source of truth.
//
// Empty and POSIX-absolute targets are explicit early rejects. All other foreign
// forms are rejected by membership instead of by predicting every bad filename
// or platform-specific path spelling.
//
// Why this exists (#247): a `node_modules` symlink whose target was the absolute
// path /Users/.../relay/node_modules was committed to main, because .gitignore's
// `node_modules/` (directory-only) never matched the symlink form. That ignore
// rule is now corrected, but an ignore rule NEVER blocks a path that is
// explicitly `git add`-ed. This check closes the recurrence class for ALL
// symlinks by requiring their targets to resolve to tracked repo contents.
//
// Reads the committed blob (not the working-tree link) so it works on a fresh
// clone where the link target may be absent. Operates on the git repo enclosing
// the current working directory, so it is correct in worktrees and testable
// against a throwaway repo.
//
// Git is invoked via the absolute DEFAULT_GIT_BINARY with a fixed safe PATH
// (the repo-canonical trusted-binary pattern; see provider-readiness-manifest),
// never a $PATH-resolved bare name. `ls-files -s -z` is NUL-delimited and not
// C-quoted, so paths with special bytes are preserved verbatim (no quoting
// bypass of the escape check).
//
// Run in CI via `npm run lint`.

import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_GIT_BINARY, gitEnv } from "../../plugins/api-reviewers/scripts/lib/git-binary.mjs";
import { cleanGitEnv } from "../../plugins/api-reviewers/scripts/lib/git-env.mjs";

const TRUSTED_GIT_ENV = gitEnv(cleanGitEnv());

// isTrackedPath: (repoRelativePosixPath) => boolean
function classifyForeignTarget(linkPath, target, isTrackedPath) {
  if (target === "") {
    return "empty target";
  }
  // MUST stay explicit and BEFORE the join: posix.join(".", "/plugins/x") strips the
  // leading "/", which would alias an absolute target onto the tracked relative path
  // "plugins/x" and false-green. (Proven.)
  if (posix.isAbsolute(target)) {
    return "absolute target (machine-specific)";
  }
  // A directory target may carry a trailing "/" (e.g. "pkg/sub/"); posix.normalize keeps
  // it, but "pkg/sub/" and "pkg/sub" name the same directory. Strip it before membership.
  // Safe: posix-absolute targets are already rejected above, so `resolved` is never "/".
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target)).replace(/\/+$/, "");
  if (!isTrackedPath(resolved)) {
    return `does not resolve to a tracked in-repo file (resolves to ${resolved})`;
  }
  return null;
}

// Pure core: given tracked symlink entries [{ path, target }] (repo-relative,
// POSIX paths), return offenders [{ path, target, reason }].
export function findForeignSymlinks(entries, isTrackedPath) {
  const offenders = [];
  for (const { path: linkPath, target } of entries) {
    const reason = classifyForeignTarget(linkPath, target, isTrackedPath);
    if (reason) {
      offenders.push({ path: linkPath, target, reason });
    }
  }
  return offenders;
}

// Parse `git ls-files -s -z` output → [{ mode, sha, path }].
// Record format: "<mode> <sha> <stage>\t<path>", records NUL-delimited. `-z`
// disables C-quoting, so special bytes in a path survive intact.
export function parseLsFilesStage(output) {
  const out = [];
  for (const rec of output.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    if (tab === -1) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    out.push({ mode: meta[0], sha: meta[1], path: rec.slice(tab + 1) });
  }
  return out;
}

function makeRunGit(cwd) {
  return (args) =>
    execFileSync(DEFAULT_GIT_BINARY, ["-C", cwd, ...args], {
      encoding: "utf8",
      env: TRUSTED_GIT_ENV,
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
    });
}

function makeIsTrackedPath(trackedPaths) {
  return (p) => {
    if (p === "" || p === ".") return true;
    if (trackedPaths.has(p)) return true;
    for (const f of trackedPaths) {
      if (f.startsWith(p + "/")) return true;
    }
    return false;
  };
}

function collectTrackedSymlinkState(runGit) {
  const entries = parseLsFilesStage(runGit(["ls-files", "-s", "-z"]));
  const trackedPaths = new Set(entries.map((e) => e.path));
  const symlinks = entries
    .filter((e) => e.mode === "120000")
    .map((e) => ({
      path: e.path,
      // A symlink blob's content IS its target string.
      target: runGit(["cat-file", "blob", e.sha]),
    }));
  return { symlinks, isTrackedPath: makeIsTrackedPath(trackedPaths) };
}

// Collect tracked symlinks and their committed targets via git.
export function collectTrackedSymlinks(runGit) {
  return collectTrackedSymlinkState(runGit).symlinks;
}

export function main(cwd = process.cwd()) {
  // Anchor to the enclosing git toplevel so `git ls-files` covers the whole repo
  // regardless of the directory the check was invoked from.
  const toplevel = execFileSync(DEFAULT_GIT_BINARY, ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: TRUSTED_GIT_ENV,
    timeout: 15000,
  }).trim();
  const runGit = makeRunGit(toplevel);

  const { symlinks, isTrackedPath } = collectTrackedSymlinkState(runGit);
  const offenders = findForeignSymlinks(symlinks, isTrackedPath);
  if (offenders.length > 0) {
    process.stderr.write("Foreign-symlink check FAILED:\n");
    for (const o of offenders) {
      process.stderr.write(`  ✗ ${o.path} -> ${o.target}  (${o.reason})\n`);
    }
    process.stderr.write(
      "\nTracked symlinks must use a relative target that resolves to tracked repo contents.\n" +
        "An absolute or untracked target is machine-specific and breaks other clones (see #247).\n"
    );
    process.exit(1);
  }
  process.stdout.write(`✓ All ${symlinks.length} tracked symlink(s) resolve inside the repo\n`);
}

// Execute only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
