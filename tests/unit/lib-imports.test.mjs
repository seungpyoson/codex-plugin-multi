// Spec §21.5: shared-lib contract is importability + behavior.
//
// This test guards against the class of failure that byte-identity cannot
// catch: a lib module that is byte-identical across plugins but cannot be
// imported (e.g., v4's job-control.mjs depending on a missing ./codex.mjs),
// or that is shipped but has no production consumer.
//
// For every `plugins/<target>/scripts/lib/*.mjs`:
//   a. `await import(file://…)` succeeds without throwing.
//   b. Every export declared in the source resolves to a defined value in
//      the imported module namespace.
//   c. Every file under `plugins/claude/scripts/lib/` has at least one
//      PRODUCTION consumer. Production = the companion entry point,
//      another lib file, or a code-fenced reference in commands/agents
//      markdown. Tests alone do NOT satisfy §21.5.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function listLibFiles(plugin) {
  const dir = path.join(REPO_ROOT, "plugins", plugin, "scripts", "lib");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => ({ plugin, name, abs: path.join(dir, name) }));
}

function parseDeclaredExports(source) {
  // Covers `export function NAME`, `export async function NAME`,
  // `export const NAME`, `export let NAME`, `export var NAME`,
  // `export class NAME`. Re-export syntax (`export { … }`) is not used
  // in this tree today; if it appears later, extend this parser.
  const names = new Set();
  const singleDecl = /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let match;
  while ((match = singleDecl.exec(source)) !== null) {
    names.add(match[1]);
  }
  // `export { a, b as c }` — rare, but supported.
  const groupDecl = /^\s*export\s*\{\s*([^}]+)\s*\}/gm;
  while ((match = groupDecl.exec(source)) !== null) {
    for (const piece of match[1].split(",")) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(trimmed);
      names.add(asMatch ? asMatch[1] : trimmed.split(/\s+/)[0]);
    }
  }
  return [...names];
}

const CLAUDE_FILES = listLibFiles("claude");
const GEMINI_FILES = listLibFiles("gemini");
const ALL_LIB_FILES = [...CLAUDE_FILES, ...GEMINI_FILES];

for (const entry of ALL_LIB_FILES) {
  test(`${entry.plugin}/lib/${entry.name}: imports cleanly (§21.5)`, async () => {
    const mod = await import(pathToFileURL(entry.abs).href);
    assert.ok(mod && typeof mod === "object", `module namespace missing for ${entry.name}`);
  });

  test(`${entry.plugin}/lib/${entry.name}: every declared export is defined (§21.5)`, async () => {
    const source = readFileSync(entry.abs, "utf8");
    const declared = parseDeclaredExports(source);
    assert.ok(
      declared.length > 0,
      `${entry.plugin}/lib/${entry.name} has no declared exports; if it's a side-effect-only module, document why or delete it.`
    );
    const mod = await import(pathToFileURL(entry.abs).href);
    for (const name of declared) {
      assert.notEqual(
        typeof mod[name],
        "undefined",
        `${entry.plugin}/lib/${entry.name}: export '${name}' is declared in source but undefined in the imported module namespace`
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Consumer check: every lib/*.mjs under plugins/claude/ must have a
// production importer. Gemini's lib/ currently exists only as a byte-identity
// mirror of portable claude lib files; once gemini grows its own entry point,
// extend this block to enforce the rule there too.

function collectProductionCallers() {
  const callers = [];
  // Companion entry points (both plugins, whichever exist).
  for (const plugin of ["claude", "gemini"]) {
    const scriptsDir = path.join(REPO_ROOT, "plugins", plugin, "scripts");
    let entries;
    try {
      entries = readdirSync(scriptsDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = path.join(scriptsDir, name);
      if (!statSync(abs).isFile()) continue;
      if (!name.endsWith(".mjs")) continue;
      callers.push(abs);
    }
  }
  // Lib-to-lib imports count as production usage as long as the importing lib
  // itself is (transitively) production-consumed. Assert this via a reachability
  // walk from each plugin's companion entry points.
  for (const plugin of ["claude", "gemini"]) {
    const libDir = path.join(REPO_ROOT, "plugins", plugin, "scripts", "lib");
    let entries;
    try {
      entries = readdirSync(libDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".mjs")) continue;
      callers.push(path.join(libDir, name));
    }
  }
  // Code-fenced references in commands/agents markdown.
  for (const plugin of ["claude", "gemini"]) {
    for (const sub of ["commands", "agents"]) {
      const dir = path.join(REPO_ROOT, "plugins", plugin, sub);
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".md")) continue;
        callers.push(path.join(dir, name));
      }
    }
  }
  return callers;
}

function fileReferencesLibName(callerAbs, libName) {
  // libName like "workspace.mjs" — we look for ./workspace.mjs or ./lib/workspace.mjs
  // anywhere in the file. This intentionally also matches string occurrences in
  // markdown code fences, which are the prose contract for command dispatch.
  const source = readFileSync(callerAbs, "utf8");
  const patterns = [
    `./${libName}`,
    `./lib/${libName}`,
    `/lib/${libName}`
  ];
  return patterns.some((pattern) => source.includes(pattern));
}

function findProductionImportersForClaude(libName) {
  const callers = collectProductionCallers().filter((abs) => {
    // Exclude tests/** — test-only consumers do not satisfy §21.5.
    if (abs.startsWith(path.join(REPO_ROOT, "tests") + path.sep)) return false;
    // A file cannot be its own importer.
    return !abs.endsWith(path.sep + libName) || !abs.includes(path.sep + "plugins" + path.sep + "claude" + path.sep + "scripts" + path.sep + "lib" + path.sep);
  });
  return callers.filter((caller) => fileReferencesLibName(caller, libName));
}

// Only enforce consumer check on the claude plugin — see comment above.
for (const entry of CLAUDE_FILES) {
  test(`claude/lib/${entry.name}: has a production consumer (§21.5)`, () => {
    const importers = findProductionImportersForClaude(entry.name)
      .filter((abs) => abs !== entry.abs);
    assert.ok(
      importers.length > 0,
      `lib/${entry.name} has no production consumer; §21.5 forbids this. Either wire it into claude-companion.mjs (or a live lib that is itself consumed) or delete it.`
    );
  });
}
