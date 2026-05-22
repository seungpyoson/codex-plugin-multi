#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REVIEW_PROMPT_PLUGIN_TARGETS } from "../lib/plugin-targets.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHARED_FILES = Object.freeze([
  "external-model-failure-catalog.mjs",
  "external-model-failure-core.mjs",
]);

const checkOnly = process.argv.includes("--check");
const failures = [];

for (const filename of SHARED_FILES) {
  const sourcePath = path.join(REPO_ROOT, "scripts/lib", filename);
  const sourceText = readFileSync(sourcePath, "utf8");
  for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
    const copyPath = path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/${filename}`);
    const current = existsSync(copyPath) ? readFileSync(copyPath, "utf8") : null;
    if (current === sourceText) continue;
    if (checkOnly) {
      failures.push(path.relative(REPO_ROOT, copyPath));
      continue;
    }
    mkdirSync(path.dirname(copyPath), { recursive: true });
    writeFileSync(copyPath, sourceText);
  }
}

if (failures.length > 0) {
  process.stderr.write(`error: external-model failure classification copies are stale: ${failures.join(", ")}\n`);
  process.exit(1);
}
