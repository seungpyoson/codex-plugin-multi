#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTERNAL_MODEL_CONTRACT_DOC_TARGETS,
  renderExternalModelContractDoc,
} from "../lib/external-model-contracts.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const checkOnly = process.argv.includes("--check");
const failures = [];

for (const target of EXTERNAL_MODEL_CONTRACT_DOC_TARGETS) {
  const targetPath = path.join(REPO_ROOT, target.path);
  const expected = renderExternalModelContractDoc(target);
  const current = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
  if (current === expected) continue;
  if (checkOnly) {
    failures.push(target.path);
    continue;
  }
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, expected);
}

if (failures.length > 0) {
  process.stderr.write(`error: external-model contract docs are stale: ${failures.join(", ")}\n`);
  process.exit(1);
}
