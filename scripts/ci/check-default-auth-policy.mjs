#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const DOC_PATH_RE = /^(?:README\.md|plugins\/[^/]+\/(?:commands\/[^/]+\.md|skills\/[^/]+\/SKILL\.md|agents\/[^/]+\.md))$/;
const RUNTIME_PATH_RE = /^(?:plugins\/[^/]+\/scripts\/.*|scripts\/(?:lib|review-panel)\b.*)\.mjs$/;

const RULES = [
  {
    id: "operator-auth-mode-auto",
    pattern: /--auth-mode(?:(?:=|\s+)\s*["']?auto\b["']?|["']?\s*,\s*["']auto["'])/g,
  },
  {
    id: "runtime-auth-mode-auto-default",
    pattern: /\b(?:DEFAULT_AUTH_MODE|defaultAuthMode|default_auth_mode|authMode|auth_mode|requestedMode)\b\s*(?:(?::|=)\s*(?:[^;\n]*?(?:\?\?|\|\|)\s*)?|(?:\?\?|\|\|)\s*)["']auto["']/g,
  },
];

function walk(relDir, out = []) {
  const absDir = path.join(REPO_ROOT, relDir);
  if (!existsSync(absDir)) return out;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(relPath, out);
      continue;
    }
    out.push(relPath);
  }
  return out;
}

function defaultScanEntries() {
  return [
    ...walk("plugins"),
    "README.md",
    ...walk("scripts/lib"),
    "scripts/review-panel.mjs",
  ]
    .filter((relPath) => DOC_PATH_RE.test(relPath) || RUNTIME_PATH_RE.test(relPath))
    .map((relPath) => ({
      path: relPath,
      text: readFileSync(path.join(REPO_ROOT, relPath), "utf8"),
    }));
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

export function findDefaultAuthPolicyViolations(entries = defaultScanEntries()) {
  const violations = [];
  for (const entry of entries) {
    const scanDocRule = DOC_PATH_RE.test(entry.path);
    const scanRuntimeRule = RUNTIME_PATH_RE.test(entry.path);
    for (const rule of RULES) {
      if (rule.id === "operator-auth-mode-auto" && !scanDocRule && !scanRuntimeRule) continue;
      if (rule.id === "runtime-auth-mode-auto-default" && !scanRuntimeRule) continue;
      rule.pattern.lastIndex = 0;
      for (const match of entry.text.matchAll(rule.pattern)) {
        violations.push({
          path: entry.path,
          line: lineFor(entry.text, match.index ?? 0),
          rule: rule.id,
          match: match[0],
        });
      }
    }
  }
  return violations;
}

function main() {
  const violations = findDefaultAuthPolicyViolations();
  if (violations.length === 0) {
    process.stdout.write("default auth policy OK\n");
    return;
  }
  process.stderr.write("default auth policy violations:\n");
  for (const item of violations) {
    process.stderr.write(`${item.path}:${item.line}: ${item.rule}: ${item.match}\n`);
  }
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
