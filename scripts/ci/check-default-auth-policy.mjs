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
    matcher: findOperatorAuthModeAutoMatches,
  },
  {
    id: "runtime-auth-mode-auto-default",
    matcher: findRuntimeAuthModeAutoMatches,
  },
];

const RUNTIME_AUTH_MODE_NAMES = Object.freeze([
  "DEFAULT_AUTH_MODE",
  "defaultAuthMode",
  "default_auth_mode",
  "authMode",
  "auth_mode",
  "requestedMode",
]);

function isIdentifierChar(char) {
  const code = char?.charCodeAt(0) ?? 0;
  return char === "_" || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWhitespace(char) {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
  return cursor;
}

function isBareLiteralTerminator(char) {
  return isWhitespace(char) || char === "," || char === ";" || char === ")" || char === "`" || char === "'" || char === '"' || char === ".";
}

function readLiteral(text, index) {
  let cursor = skipWhitespace(text, index);
  const quote = text[cursor];
  if (quote === "'" || quote === '"') {
    const start = cursor;
    cursor += 1;
    let value = "";
    while (cursor < text.length && text[cursor] !== quote) {
      value += text[cursor];
      cursor += 1;
    }
    if (text[cursor] !== quote) return null;
    return { value, start, end: cursor + 1, raw: text.slice(start, cursor + 1) };
  }

  const start = cursor;
  while (cursor < text.length && !isBareLiteralTerminator(text[cursor])) {
    cursor += 1;
  }
  if (cursor === start) return null;
  return { value: text.slice(start, cursor), start, end: cursor, raw: text.slice(start, cursor) };
}

function isAutoLiteral(literal) {
  return literal?.value === "auto";
}

function findOperatorAuthModeAutoMatches(text) {
  const matches = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf("--auth-mode", cursor);
    if (index === -1) break;
    let afterFlag = index + "--auth-mode".length;
    if (text[afterFlag] === "'" || text[afterFlag] === '"') afterFlag += 1;
    afterFlag = skipWhitespace(text, afterFlag);
    if (text[afterFlag] === "=") {
      const literal = readLiteral(text, afterFlag + 1);
      if (isAutoLiteral(literal)) matches.push({ index, text: text.slice(index, literal.end) });
    } else if (text[afterFlag] === ",") {
      const literal = readLiteral(text, afterFlag + 1);
      if (isAutoLiteral(literal)) matches.push({ index, text: text.slice(index, literal.end) });
    } else {
      const literal = readLiteral(text, afterFlag);
      if (isAutoLiteral(literal)) matches.push({ index, text: text.slice(index, literal.end) });
    }
    cursor = index + "--auth-mode".length;
  }
  return matches;
}

function hasIdentifierBoundary(text, index, name) {
  return !isIdentifierChar(text[index - 1]) && !isIdentifierChar(text[index + name.length]);
}

function lineSliceFrom(text, index) {
  const newline = text.indexOf("\n", index);
  const semicolon = text.indexOf(";", index);
  const endCandidates = [newline, semicolon].filter((item) => item !== -1);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : text.length;
  return text.slice(index, end);
}

function findRuntimeAuthModeAutoMatches(text) {
  const matches = [];
  for (const name of RUNTIME_AUTH_MODE_NAMES) {
    let cursor = 0;
    while (cursor < text.length) {
      const index = text.indexOf(name, cursor);
      if (index === -1) break;
      if (hasIdentifierBoundary(text, index, name)) {
        const line = lineSliceFrom(text, index);
        if ((line.includes("=") || line.includes(":") || line.includes("??") || line.includes("||"))
            && (line.includes('"auto"') || line.includes("'auto'"))) {
          matches.push({ index, text: line.trim() });
        }
      }
      cursor = index + name.length;
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}

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
      for (const match of rule.matcher(entry.text)) {
        violations.push({
          path: entry.path,
          line: lineFor(entry.text, match.index),
          rule: rule.id,
          match: match.text,
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
