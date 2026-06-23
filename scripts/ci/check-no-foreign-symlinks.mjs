#!/usr/bin/env node
// Repo-hygiene guard: every tracked symlink (git mode 120000) must point to a
// RELATIVE target that resolves INSIDE the repository.
//
// Model: ALLOWLIST, fail-closed. The committed blob is the same bytes on every
// clone, and we cannot resolve a foreign machine path against clones we don't
// have — so a target is ACCEPTED only when it is the one provably-portable,
// in-repo shape, and EVERYTHING ELSE is rejected. New or exotic absolute/escape
// syntaxes therefore fail closed without a per-form detector (a blocklist of
// "bad" forms — drive letters, UNC, \ escapes … — is unbounded whack-a-mole;
// requiring the single safe shape is the class fix).
//
// Accepts: a NON-empty, RELATIVE, forward-slash target whose EVERY segment is a
//   portable filename and which resolves INSIDE the repo on every clone OS
//   (e.g. ../plugins/api-reviewers, claude-mock.mjs).
// Rejects everything else: any "\" (Windows separator; subsumes \x, C:\x, \\UNC),
//   a leading "/" (POSIX absolute), a segment that is not a portable filename
//   (a Windows-illegal char incl. ":" — which covers drive qualifiers C:foo and
//   NTFS streams name:stream — or a control byte; a trailing dot/space Windows
//   strips; or a reserved device name CON/NUL/COM1… that binds to a device, not
//   a file), and "../" escapes above the repo root.
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

// Windows reserves a FIXED, OS-defined set of device names: any path segment that
// is one of these (with or without an extension) refers to the DEVICE, not an
// in-repo file, on a Windows clone. A closed set — not open-ended path syntax.
const WIN_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
// Punctuation illegal in a Windows path segment (the "/" separator excepted, and
// "\" already rejected wholesale). ":" also covers drive qualifiers (C:foo) and
// NTFS alternate-data-streams (name:stream).
const WIN_ILLEGAL_PUNCT = '<>:"|?*';

// True when a segment contains a byte illegal in a portable filename: a control
// byte (NUL .. US, 0x00–0x1f — covers embedded newline/NUL) or Windows-illegal
// punctuation. A codepoint scan avoids a control-character regex literal.
function hasNonPortableChar(segment) {
  for (const ch of segment) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f) return true;
    if (WIN_ILLEGAL_PUNCT.includes(ch)) return true;
  }
  return false;
}

// Classify a tracked symlink's committed target. Returns a human-readable reason
// when the target is foreign, or null when it is the one safe shape.
//
// This is an ALLOWLIST (see file header): rather than enumerate every foreign
// target syntax — a list that grows every time a new form is found — it requires
// the single portable, in-repo shape and rejects all else, so unknown forms fail
// closed. Each rejection below removes a whole sub-class, not one instance.
function classifyForeignTarget(linkPath, target) {
  if (target === "") {
    return "empty target";
  }
  // A portable git symlink target uses "/". A backslash is a Windows path
  // separator (and a divergent, non-portable byte on POSIX), so ANY "\" makes the
  // target non-portable — this single rule subsumes \x, C:\x and \\UNC.
  if (target.includes("\\")) {
    return "non-portable '\\' separator (symlink targets must use '/')";
  }
  // A leading "/" is POSIX-absolute → machine-rooted.
  if (posix.isAbsolute(target)) {
    return "absolute target (machine-specific)";
  }
  // Every segment must be a portable filename that names an in-repo file on EVERY
  // clone OS. One cohesive rule (vs. enumerating "bad target syntaxes") rejects:
  // Windows-illegal characters (incl. ":" → drive qualifiers and NTFS streams, and
  // control bytes), trailing dot/space (Windows silently strips them), and reserved
  // device names (which resolve to a device, not a file).
  for (const segment of target.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      continue; // separators and lexical navigation — handled by containment below
    }
    if (hasNonPortableChar(segment)) {
      return `non-portable character in path segment "${segment}"`;
    }
    if (/[ .]$/.test(segment)) {
      return `path segment "${segment}" ends with a space or dot (non-portable on Windows)`;
    }
    if (WIN_RESERVED_SEGMENT.test(segment)) {
      return `Windows reserved device name "${segment}" (machine-bound, not an in-repo file)`;
    }
  }
  // Containment: resolve lexically against the link's own directory; it must not
  // climb above the repo root.
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
  if (resolved === ".." || resolved.startsWith("../")) {
    return `escapes repo root (resolves to ${resolved})`;
  }
  return null;
}

// Pure core: given tracked symlink entries [{ path, target }] (repo-relative,
// POSIX paths), return offenders [{ path, target, reason }].
export function findForeignSymlinks(entries) {
  const offenders = [];
  for (const { path: linkPath, target } of entries) {
    const reason = classifyForeignTarget(linkPath, target);
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
