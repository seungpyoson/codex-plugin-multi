#!/usr/bin/env node
// Repo-hygiene guard: every tracked symlink (git mode 120000) must resolve via
// the OS to tracked repository contents.
//
// Model: two complementary, fail-closed gates per tracked symlink.
//
// 1. Portability of form (pure, on the committed blob target). A target is
//    portable across clones only when it is relative AND, resolved lexically
//    against the link's own directory, stays within the repo root. An absolute
//    target is pinned to one machine's filesystem; a `..` target that climbs
//    above the root depends on whatever sits outside the repo on a given clone.
//    Both can still resolve "inside" on the checkout that authored them, so a
//    realpath check alone cannot see them (realpath erases the absolute/relative
//    distinction and reports only the final resolved path). This is the #247
//    class and is checked directly on the blob string.
//
// 2. Actual resolution (kernel realpath + membership). The materialized symlink
//    is resolved with fs.realpathSync against the working tree and accepted only
//    when the real path stays inside the canonical repo root and names either a
//    tracked file or a directory prefix containing tracked files. The kernel
//    performs resolution, so intermediate symlinks, `..` through symlinks or
//    files (ENOTDIR), and cycles (ELOOP) need no hand-rolled path logic. The
//    tracked path set from `git ls-files -s -z` is the membership source of truth.
//
// A symlink must pass BOTH gates. Gate 1 only adds rejections, so it can never
// turn a realpath rejection into an accept; its worst case is a fail-closed
// rejection of an exotic target that escapes lexically yet stays in-repo via an
// intermediate symlink — acceptable hygiene, never a silent accept.
//
// This assumes a clean, materialized checkout, which is the CI case. A symlink
// whose target is absent, unresolvable, escaping, untracked, or not materialized
// as a real symlink is rejected.
//
// Why this exists (#247): a `node_modules` symlink whose target was the absolute
// path /Users/.../relay/node_modules was committed to main, because .gitignore's
// `node_modules/` (directory-only) never matched the symlink form. That ignore
// rule is now corrected, but an ignore rule NEVER blocks a path that is
// explicitly `git add`-ed. This check closes the recurrence class for ALL
// symlinks by requiring the kernel-resolved target to remain inside tracked repo
// contents. The committed symlink blob is kept only for offender display.
//
// Operates on the git repo enclosing the current working directory, so it is
// correct in worktrees and testable against a throwaway repo.
//
// Git is invoked via the absolute DEFAULT_GIT_BINARY with a fixed safe PATH
// (the repo-canonical trusted-binary pattern; see provider-readiness-manifest),
// never a $PATH-resolved bare name. `ls-files -s -z` is NUL-delimited and not
// C-quoted, so paths with special bytes are preserved verbatim (no quoting
// bypass of the escape check).
//
// Run in CI via `npm run lint`.

import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_GIT_BINARY, gitEnv } from "../../plugins/api-reviewers/scripts/lib/git-binary.mjs";
import { cleanGitEnv } from "../../plugins/api-reviewers/scripts/lib/git-env.mjs";

const TRUSTED_GIT_ENV = gitEnv(cleanGitEnv());

// Gate 1 — portability of the committed target FORM (pure; no filesystem).
// linkPath is the git-tracked POSIX path of the symlink; target is its blob.
// Returns a rejection reason, or null when the form is portable. Because this is
// AND-ed with the realpath gate it can only add rejections, never relax one.
export function classifyTargetPortability(linkPath, target) {
  if (path.posix.isAbsolute(target)) {
    return "absolute target (machine-specific; breaks other clones)";
  }
  // Resolve the target lexically (plain path arithmetic, no symlink-following)
  // against the link's own directory. A result that climbs to or above the repo
  // root cannot be relocated to another clone's checkout root.
  const resolvedRel = path.posix.join(path.posix.dirname(linkPath), target);
  if (resolvedRel === ".." || resolvedRel.startsWith("../")) {
    return `target escapes the repo root (${target})`;
  }
  return null;
}

// Gate 2 — actual resolution + membership.
// isTrackedPath: (repoRelativePosixPath) => boolean
export function classifyResolvedSymlink(realPath, repoRoot, isTrackedPath) {
  if (realPath !== repoRoot && !realPath.startsWith(repoRoot + path.sep)) {
    return `resolves outside the repo (${realPath})`;
  }
  const rel = path.relative(repoRoot, realPath).split(path.sep).join("/");
  if (rel !== "" && !isTrackedPath(rel)) {
    return `resolves to an untracked path (${rel})`;
  }
  return null;
}

function errorCode(e) {
  return e && typeof e === "object" && "code" in e ? e.code : "UNKNOWN";
}

function resolveTrackedSymlink(absPath) {
  let st;
  try {
    st = lstatSync(absPath);
  } catch (e) {
    return { reason: `missing from the working tree (${errorCode(e)})` };
  }
  if (!st.isSymbolicLink()) {
    return { reason: "not a materialized symlink (is core.symlinks disabled?)" };
  }
  try {
    return { realPath: realpathSync(absPath) };
  } catch (e) {
    return { reason: `unresolvable (${errorCode(e)})` };
  }
}

// symlinks: [{ path, target }] where target is kept only for the offender message.
// repoRoot: canonical absolute repo root.
export function findForeignSymlinks(symlinks, repoRoot, isTrackedPath) {
  const offenders = [];
  for (const { path: linkPath, target } of symlinks) {
    const portability = classifyTargetPortability(linkPath, target);
    if (portability) {
      offenders.push({ path: linkPath, target, reason: portability });
      continue;
    }
    const abs = path.join(repoRoot, linkPath);
    const resolved = resolveTrackedSymlink(abs);
    const reason =
      resolved.reason ?? classifyResolvedSymlink(resolved.realPath, repoRoot, isTrackedPath);
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

export function main() {
  // Anchor to the enclosing git toplevel so `git ls-files` covers the whole repo
  // regardless of the directory the check was invoked from. Git runs in the
  // process's own working directory — no untrusted path argument is accepted, so
  // a `node check-no-foreign-symlinks.mjs <path>` invocation cannot steer git at
  // an arbitrary location.
  const toplevel = execFileSync(DEFAULT_GIT_BINARY, ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: TRUSTED_GIT_ENV,
    timeout: 15000,
  }).trim();
  const repoRoot = realpathSync(toplevel);
  const runGit = makeRunGit(toplevel);

  const { symlinks, isTrackedPath } = collectTrackedSymlinkState(runGit);
  const offenders = findForeignSymlinks(symlinks, repoRoot, isTrackedPath);
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
