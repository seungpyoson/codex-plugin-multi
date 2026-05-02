#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMPANION_PLUGIN_TARGETS } from "../lib/plugin-targets.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = path.join(REPO_ROOT, "scripts/lib/external-review.mjs");
const COPIES = COMPANION_PLUGIN_TARGETS.map((plugin) =>
  path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/external-review.mjs`)
);

const checkOnly = process.argv.includes("--check");
const sourceText = readFileSync(SOURCE, "utf8");
const failures = [];

for (const copyPath of COPIES) {
  const current = existsSync(copyPath) ? readFileSync(copyPath, "utf8") : null;
  if (current === sourceText) continue;
  if (checkOnly) {
    failures.push(path.relative(REPO_ROOT, copyPath));
    continue;
  }
  mkdirSync(path.dirname(copyPath), { recursive: true });
  writeFileSync(copyPath, sourceText);
}

if (failures.length > 0) {
  process.stderr.write(`error: external-review packaging copies are stale: ${failures.join(", ")}\n`);
  process.exit(1);
}
