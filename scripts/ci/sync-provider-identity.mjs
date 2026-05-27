#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REVIEW_PROMPT_PLUGIN_TARGETS } from "../lib/plugin-targets.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = path.join(REPO_ROOT, "scripts/lib/provider-identity.mjs");
const TARGETS = REVIEW_PROMPT_PLUGIN_TARGETS.map((plugin) =>
  path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/provider-identity.mjs`)
);

const checkOnly = process.argv.includes("--check");
const sourceText = readFileSync(SOURCE, "utf8");
const failures = [];

for (const target of TARGETS) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === sourceText) continue;
  if (checkOnly) {
    failures.push(path.relative(REPO_ROOT, target));
    continue;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, sourceText);
}

if (failures.length > 0) {
  process.stderr.write(`error: provider-identity packaging copies are stale: ${failures.join(", ")}\n`);
  process.exit(1);
}
