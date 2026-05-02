// Guards against silent drift between plugins' copy-verbatim lib files. The
// files listed below MUST be byte-identical between every plugin in the
// matching provider set.
// If this test fails after a legitimate upstream re-sync, update BOTH copies.
//
// §21.5 requirement: only modules that are actually consumed in production
// ship. `job-control.mjs`, `prompts.mjs`, and `render.mjs` were removed in
// T7.5 because they had zero production consumers — the class of problem
// that makes byte-identity insufficient (both copies equally broken or
// equally dead). See tests/unit/lib-imports.test.mjs for the new contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const VERBATIM_FILES = [
  "workspace.mjs",
  "process.mjs",
  "args.mjs",
  "git.mjs",
  "identity.mjs",
  "scope.mjs",
  "cancel-marker.mjs",
  "companion-common.mjs",
];

const CLAUDE_GEMINI_VERBATIM_FILES = [
  "provider-env.mjs",
  "reconcile.mjs",
  "git-env.mjs",
];

for (const file of VERBATIM_FILES) {
  test(`lib/${file}: byte-identical across plugins/{claude,gemini,kimi}`, () => {
    const copies = ["claude", "gemini", "kimi"].map((plugin) => [
      plugin,
      readFileSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib`, file), "utf8"),
    ]);
    for (const [plugin, text] of copies.slice(1)) {
      assert.equal(text, copies[0][1], `${file} drift between claude and ${plugin}`);
    }
  });
}

for (const file of CLAUDE_GEMINI_VERBATIM_FILES) {
  test(`lib/${file}: byte-identical across plugins/{claude,gemini}`, () => {
    const copies = ["claude", "gemini"].map((plugin) => [
      plugin,
      readFileSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib`, file), "utf8"),
    ]);
    for (const [plugin, text] of copies.slice(1)) {
      assert.equal(text, copies[0][1], `${file} drift between claude and ${plugin}`);
    }
  });
}

// The previous render.mjs guard ("no surviving Codex refs") was removed
// together with render.mjs itself in T7.5 — see header comment above.
