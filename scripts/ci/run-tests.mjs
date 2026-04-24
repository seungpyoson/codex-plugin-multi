#!/usr/bin/env node
// Unit-test runner. Discovers tests/unit/**/*.test.mjs and runs them via
// `node --test`. Returns exit 0 with a notice when no tests exist yet.

import { readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Walks tests/unit AND tests/smoke. Smoke tests can be skipped by pointing
// CODEX_PLUGIN_SKIP_SMOKE=1 (CI sets this when a smoke fixture is missing).
const TEST_DIRS = [
  resolve(REPO_ROOT, "tests/unit"),
  ...(process.env.CODEX_PLUGIN_SKIP_SMOKE ? [] : [resolve(REPO_ROOT, "tests/smoke")]),
];

// Directories never walked — avoid picking up fixture deps or generated trees.
const SKIP_DIRS = new Set(["node_modules", "fixtures", ".git", "coverage"]);

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
    else if (ent.isFile() && ent.name.endsWith(".test.mjs")) out.push(full);
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
const res = spawnSync(
  "node",
  ["--test", "--test-reporter=spec", ...rel],
  { cwd: REPO_ROOT, stdio: "inherit" }
);
process.exit(res.status ?? 1);
