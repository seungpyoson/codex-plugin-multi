// Guards against silent drift between the two plugins' copy-verbatim lib
// files. The files listed below MUST be byte-identical between
// plugins/claude/scripts/lib/ and plugins/gemini/scripts/lib/.
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
  "reconcile.mjs",
];

for (const file of VERBATIM_FILES) {
  test(`lib/${file}: byte-identical across plugins/{claude,gemini}`, () => {
    const claude = readFileSync(
      path.join(REPO_ROOT, "plugins/claude/scripts/lib", file),
      "utf8"
    );
    const gemini = readFileSync(
      path.join(REPO_ROOT, "plugins/gemini/scripts/lib", file),
      "utf8"
    );
    assert.equal(claude, gemini, `${file} drift between claude and gemini`);
  });
}

// The previous render.mjs guard ("no surviving Codex refs") was removed
// together with render.mjs itself in T7.5 — see header comment above.
