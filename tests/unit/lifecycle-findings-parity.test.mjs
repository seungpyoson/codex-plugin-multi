// ORCH-1 (#232) cross-renderer parity guard.
//
// The "completed review findings hidden from foreground markdown" bug exists
// because `renderLifecycleMarkdown` is duplicated across three independent
// renderer lineages that cannot share code (separate Codex plugin roots):
//   1. scripts/lib/companion-common.mjs  (synced into claude/gemini/kimi/agy)
//   2. plugins/grok/scripts/grok-web-reviewer.mjs
//   3. plugins/api-reviewers/scripts/api-reviewer.mjs  (shared by glm/deepseek)
//
// The original #233 fix landed the "### REVIEW FINDINGS" section in lineage 1
// only, leaving grok and the direct-API family rendering a metadata card with
// the actual model findings still hidden on record.result. A behavioral test
// per provider proves each renderer works; THIS test enforces the class
// invariant — every renderLifecycleMarkdown source must surface record.result —
// so a future renderer (or an edit that drops the block) fails loudly instead
// of silently regressing one provider.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_ROOTS = ["scripts", "plugins"];
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "fixtures"]);
const DEFINITION_RE = /(?:export\s+)?function\s+renderLifecycleMarkdown\s*\(/;

// The canonical renderer sources a human edits. The scan must find at least
// these (synced packaging copies and relay/ build outputs are covered by their
// own sync gates); requiring them prevents the parity check from passing
// vacuously if directory discovery ever breaks and misses a lineage.
const REQUIRED_SOURCES = [
  "scripts/lib/companion-common.mjs",
  "plugins/grok/scripts/grok-web-reviewer.mjs",
  "plugins/api-reviewers/scripts/api-reviewer.mjs",
];

function walkMjs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return out;
    throw e;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkMjs(full, out);
    else if (ent.isFile() && ent.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

// Brace-walk the renderLifecycleMarkdown body from its definition. Every `${}`
// interpolation in the body is balanced and no string literal contains a stray
// brace, so a plain depth counter captures the whole function (same technique
// scripts/ab/verify/P6-post-run-mutation-invalidation.mjs uses).
function extractRenderBody(src) {
  const start = src.search(DEFINITION_RE);
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

test("every renderLifecycleMarkdown source surfaces completed review findings (ORCH-1 parity)", () => {
  const files = SOURCE_ROOTS.flatMap((root) => walkMjs(join(REPO_ROOT, root)));
  const definers = files.filter((file) => DEFINITION_RE.test(readFileSync(file, "utf8")));
  const discovered = new Set(definers.map((file) => relative(REPO_ROOT, file)));

  for (const required of REQUIRED_SOURCES) {
    assert.ok(
      discovered.has(required),
      `parity scan must discover the canonical renderer ${required} (found: ${[...discovered].join(", ")})`,
    );
  }

  for (const file of definers) {
    const rel = relative(REPO_ROOT, file);
    const body = extractRenderBody(readFileSync(file, "utf8"));
    assert.ok(body, `${rel}: could not extract renderLifecycleMarkdown body`);
    assert.match(
      body,
      /typeof obj\.result === "string"/,
      `${rel}: renderLifecycleMarkdown must read obj.result to surface findings`,
    );
    assert.match(
      body,
      /### REVIEW FINDINGS/,
      `${rel}: renderLifecycleMarkdown must emit a "### REVIEW FINDINGS" section — completed findings must not be hidden from operator markdown (ORCH-1 #232)`,
    );
  }
});
