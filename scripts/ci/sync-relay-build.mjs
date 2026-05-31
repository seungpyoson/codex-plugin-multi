#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildCodexDirectApiSuite } from "../lib/codex-relay-build.mjs";
import { buildRelaySuite } from "../lib/relay-build.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GENERATED_PATHS = [
  "plugins/relay-glm",
  "plugins/relay-deepseek",
  "plugins/api-reviewers/.claude-plugin/plugin.json",
  "relay",
];

const checkOnly = process.argv.includes("--check");

function comparePathStrings(a, b) {
  return a.localeCompare(b);
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listPathHashes(root) {
  const files = new Map();
  if (!existsSync(root)) return files;

  const rootStat = statSync(root);
  if (rootStat.isFile()) {
    files.set(".", hashFile(root));
    return files;
  }

  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => comparePathStrings(a.name, b.name))) {
      if (entry.name === ".DS_Store") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files.set(path.relative(root, full).replaceAll("\\", "/"), hashFile(full));
    }
  }
  return files;
}

function pathMatches(expected, current) {
  if (!existsSync(expected)) return false;
  const expectedFiles = listPathHashes(expected);
  const currentFiles = listPathHashes(current);
  if (expectedFiles.size !== currentFiles.size) return false;
  for (const [file, hash] of expectedFiles) {
    if (currentFiles.get(file) !== hash) return false;
  }
  return true;
}

function copyBuildInputs(targetRepo) {
  mkdirSync(targetRepo, { recursive: true });
  cpSync(path.join(REPO_ROOT, "plugins"), path.join(targetRepo, "plugins"), { recursive: true });
  mkdirSync(path.join(targetRepo, "scripts", "lib"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "scripts", "lib", "claude-env.mjs"), path.join(targetRepo, "scripts", "lib", "claude-env.mjs"));
  cpSync(path.join(REPO_ROOT, "LICENSE"), path.join(targetRepo, "LICENSE"));
}

if (!checkOnly) {
  buildCodexDirectApiSuite({ repoRoot: REPO_ROOT });
  buildRelaySuite({ repoRoot: REPO_ROOT });
  process.exit(0);
}

const tempRoot = mkdtempSync(path.join(tmpdir(), "relay-build-sync-"));
const tempRepo = path.join(tempRoot, "repo");
const stale = [];
try {
  copyBuildInputs(tempRepo);
  buildCodexDirectApiSuite({ repoRoot: tempRepo });
  buildRelaySuite({ repoRoot: tempRepo });
  stale.push(...GENERATED_PATHS.filter((relPath) =>
    !pathMatches(path.join(tempRepo, relPath), path.join(REPO_ROOT, relPath))
  ));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

if (stale.length > 0) {
  process.stderr.write(`error: relay build artifacts are stale: ${stale.join(", ")}\n`);
  process.stderr.write("Run `npm run build:codex-relay` and `npm run build:relay`, then retry.\n");
  process.exit(1);
}
