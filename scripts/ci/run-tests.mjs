#!/usr/bin/env node
// Unit-test runner. Discovers tests/unit/**/*.test.mjs and runs them via
// `node --test`. Returns exit 0 with a notice when no tests exist yet.

import { readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// One source of truth for the GIT_* scrub list — same module the companions
// and fixture helper consume. Adding a key in git-env.mjs propagates here too.
import { cleanGitEnv } from "../../plugins/claude/scripts/lib/git-env.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Walks tests/unit AND tests/smoke. Smoke tests can be skipped by pointing
// CODEX_PLUGIN_SKIP_SMOKE=1 (CI sets this when a smoke fixture is missing).
const TEST_DIRS = [
  resolve(REPO_ROOT, "tests/unit"),
  ...(process.env.CODEX_PLUGIN_SKIP_SMOKE ? [] : [resolve(REPO_ROOT, "tests/smoke")]),
];

// Directories never walked — avoid picking up fixture deps or generated trees.
const SKIP_DIRS = new Set(["node_modules", "fixtures", ".git", "coverage"]);

// #16 follow-up 9 (test isolation, secondary): the pre-commit gate runs
// `npm test` with a 60s timeout, but tests/unit/scope.test.mjs alone has
// 155 real-git tests that take ~140s on a typical laptop. Default
// `npm test` therefore skips scope.test.mjs; CI sets
// CODEX_PLUGIN_FULL_TESTS=1 to include it. Run `npm run test:full`
// locally before opening a PR.
const SLOW_TEST_BASENAMES = new Set([
  "scope.test.mjs",
]);
const RUN_FULL = process.env.CODEX_PLUGIN_FULL_TESTS === "1";

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && ent.name.endsWith(".test.mjs")) {
      if (!RUN_FULL && SLOW_TEST_BASENAMES.has(ent.name)) continue;
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const dir of TEST_DIRS) files.push(...await walk(dir));
if (files.length === 0) {
  process.stdout.write("(no test files yet — skipping.)\n");
  process.exit(0);
}

const rel = files.map((f) => relative(REPO_ROOT, f));

// #16 follow-up 9 (test isolation): scrub inherited GIT_* env vars before
// the test runner spawns its child. If a developer runs `npm test` from a
// pre-commit hook context, GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE point at
// the caller checkout. Test fixtures that spawn `git init` then
// `git checkout -qb feature` would otherwise be hijacked into mutating the
// caller checkout's branch + creating fixture commits there. Defense in
// depth: per-test-fixture helpers also scrub, but stripping at the runner
// boundary protects every legacy callsite at once.
//
// PR #21 review caveat: the inline strip list previously omitted
// GIT_CONFIG_GLOBAL/SYSTEM, GIT_TRACE*, GIT_OPTIONAL_LOCKS,
// GIT_TERMINAL_PROMPT, GIT_PROTOCOL, GIT_AUTO_GC. The shared cleanGitEnv()
// from plugin lib carries the canonical list so a future addition is a
// one-place change.
const cleanEnv = cleanGitEnv(process.env);

const res = spawnSync(
  "node",
  ["--test", "--test-reporter=spec", ...rel],
  { cwd: REPO_ROOT, stdio: "inherit", env: cleanEnv }
);
process.exit(res.status ?? 1);
