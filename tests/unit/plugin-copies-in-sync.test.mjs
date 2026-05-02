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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_GEMINI_PLUGIN_TARGETS,
  COMPANION_PLUGIN_TARGETS,
} from "../../scripts/lib/plugin-targets.mjs";

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
  "auth-selection.mjs",
  "provider-env.mjs",
  "reconcile.mjs",
  "git-env.mjs",
];

test("lib/companion-common.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/companion-common.mjs"), "utf8");
  for (const plugin of COMPANION_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/companion-common.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `companion-common.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/auth-selection.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/auth-selection.mjs"), "utf8");
  for (const plugin of CLAUDE_GEMINI_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/auth-selection.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `auth-selection.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/provider-env.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/provider-env.mjs"), "utf8");
  for (const plugin of CLAUDE_GEMINI_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/provider-env.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `provider-env.mjs packaging copy drifted in ${plugin}`);
  }
});

test("companion plugin target list matches packaged companion-common copies", () => {
  const pluginsWithCompanionCopy = readdirSync(path.join(REPO_ROOT, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((plugin) =>
      existsSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/companion-common.mjs`))
    )
    .sort();

  assert.deepEqual([...COMPANION_PLUGIN_TARGETS].sort(), pluginsWithCompanionCopy);
});

for (const file of VERBATIM_FILES) {
  test(`lib/${file}: byte-identical across plugins/{${COMPANION_PLUGIN_TARGETS.join(",")}}`, () => {
    const copies = COMPANION_PLUGIN_TARGETS.map((plugin) => [
      plugin,
      readFileSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib`, file), "utf8"),
    ]);
    for (const [plugin, text] of copies.slice(1)) {
      assert.equal(text, copies[0][1], `${file} drift between claude and ${plugin}`);
    }
  });
}

for (const file of CLAUDE_GEMINI_VERBATIM_FILES) {
  test(`lib/${file}: byte-identical across plugins/{${CLAUDE_GEMINI_PLUGIN_TARGETS.join(",")}}`, () => {
    const copies = CLAUDE_GEMINI_PLUGIN_TARGETS.map((plugin) => [
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
