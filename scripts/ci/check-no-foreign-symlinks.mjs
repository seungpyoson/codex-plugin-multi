#!/usr/bin/env node
// Repo-hygiene guard: every tracked symlink (git mode 120000) must point to a
// RELATIVE target that resolves INSIDE the repository.
//
// Rejects:
//   - absolute targets (machine-specific; e.g. /Users/x/relay/node_modules)
//   - relative targets that escape the repo root via ../
//
// Why this exists (#247): a `node_modules` symlink whose target was the absolute
// path /Users/.../relay/node_modules was committed to main, because .gitignore's
// `node_modules/` (directory-only) never matched the symlink form. That ignore
// rule is now corrected, but an ignore rule NEVER blocks a path that is
// explicitly `git add`-ed. This check closes the recurrence class for ALL
// symlinks, regardless of .gitignore form — it catches the consequence (a
// foreign/escaping target) rather than any single pattern. Subsumes both the
// per-pattern .gitignore gap and the reintroduction risk.
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

// Absolute target detection across POSIX + Windows forms. Git stores the symlink
// target verbatim; reject anything machine-rooted.
function isAbsoluteTarget(target) {
  return (
    target.startsWith("/") || // POSIX absolute
    /^[A-Za-z]:[\\/]/.test(target) || // Windows drive (C:\ or C:/)
    target.startsWith("\\\\") // Windows UNC
  );
}

// Pure core: given tracked symlink entries [{ path, target }] (repo-relative,
// POSIX paths), return offenders [{ path, target, reason }].
export function findForeignSymlinks(entries) {
  const offenders = [];
  for (const { path: linkPath, target } of entries) {
    if (isAbsoluteTarget(target)) {
      offenders.push({ path: linkPath, target, reason: "absolute target (machine-specific)" });
      continue;
    }
    // Resolve the relative target lexically against the link's own directory.
    const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
    if (resolved === ".." || resolved.startsWith("../")) {
      offenders.push({ path: linkPath, target, reason: `escapes repo root (resolves to ${resolved})` });
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

// Collect tracked symlinks and their committed targets via git.
export function collectTrackedSymlinks(runGit) {
  const symlinks = parseLsFilesStage(runGit(["ls-files", "-s", "-z"])).filter((e) => e.mode === "120000");
  return symlinks.map((e) => ({
    path: e.path,
    // A symlink blob's content IS its target string (no trailing newline).
    target: runGit(["cat-file", "blob", e.sha]).replace(/\r?\n$/, ""),
  }));
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

  const entries = collectTrackedSymlinks(runGit);
  const offenders = findForeignSymlinks(entries);
  if (offenders.length > 0) {
    process.stderr.write("Foreign-symlink check FAILED:\n");
    for (const o of offenders) {
      process.stderr.write(`  ✗ ${o.path} -> ${o.target}  (${o.reason})\n`);
    }
    process.stderr.write(
      "\nTracked symlinks must use a RELATIVE target that resolves inside the repo.\n" +
        "An absolute or escaping target is machine-specific and breaks other clones (see #247).\n"
    );
    process.exit(1);
  }
  process.stdout.write(`✓ All ${entries.length} tracked symlink(s) resolve inside the repo\n`);
}

// Execute only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
