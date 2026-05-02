#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = path.join(REPO_ROOT, "scripts/lib/companion-common.mjs");
const COPIES = ["claude", "gemini", "kimi"].map((plugin) =>
  path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/companion-common.mjs`)
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
  assert.fail(`companion-common packaging copies are stale: ${failures.join(", ")}`);
}
