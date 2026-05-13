#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REVIEW_PROMPT_PLUGIN_TARGETS } from "../lib/plugin-targets.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCES = [
  ["scripts/review-panel.mjs", "scripts/review-panel.mjs"],
  ["scripts/lib/review-panel.mjs", "scripts/lib/review-panel.mjs"],
];

const checkOnly = process.argv.includes("--check");
const failures = [];

for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
  for (const [sourceRel, copyRel] of SOURCES) {
    const sourcePath = path.join(REPO_ROOT, sourceRel);
    const copyPath = path.join(REPO_ROOT, "plugins", plugin, copyRel);
    const sourceText = readFileSync(sourcePath, "utf8");
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
  process.stderr.write(`error: review-panel packaging copies are stale: ${failures.join(", ")}\n`);
  process.exit(1);
}
