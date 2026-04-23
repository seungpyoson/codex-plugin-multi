#!/usr/bin/env node
// Unit-test runner. Uses `node --test` on tests/unit/ when it exists.
// Returns exit 0 with a notice when no tests exist yet (pre-M1 milestones).

import { stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TESTS_DIR = resolve(REPO_ROOT, "tests/unit");

try {
  const s = await stat(TESTS_DIR);
  if (!s.isDirectory()) throw new Error("tests/unit exists but is not a directory");
} catch (e) {
  if (e.code === "ENOENT") {
    process.stdout.write("(no tests/unit/ yet — skipping. Tests land in M1 per plan.)\n");
    process.exit(0);
  }
  throw e;
}

const res = spawnSync(
  "node",
  ["--test", "--test-reporter=spec", "tests/unit/"],
  { cwd: REPO_ROOT, stdio: "inherit" }
);
process.exit(res.status ?? 1);
