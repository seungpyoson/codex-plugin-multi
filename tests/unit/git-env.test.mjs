// Adversarial review of PR #21 found GIT_CONFIG_GLOBAL leaking through 4 of
// 5 scrub callsites — fixture branches got hijacked into "injected-master"
// when a parent env had GIT_CONFIG_GLOBAL set. This test pins the canonical
// strip list AND exercises the actual leak path that was missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { STRIPPED_GIT_ENV_KEYS, cleanGitEnv } from "../../plugins/claude/scripts/lib/git-env.mjs";
import { fixtureGit, fixtureGitEnv } from "../helpers/fixture-git.mjs";

// ——— Pinned canonical list ———
//
// If a key is added/removed, update both this expectation and every
// downstream consumer (companions, fixture-git, run-tests, scope.mjs).
// The byte-identical-pair test guarantees the gemini side stays in sync.
const REQUIRED_KEYS = [
  // Location overrides
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX",
  "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ATTR_SOURCE", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE",
  // Config injection
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  // Trace family
  "GIT_TRACE", "GIT_TRACE2",
  // Behavior overrides
  "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "GIT_PROTOCOL", "GIT_AUTO_GC",
  "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_PAGER_IN_USE", "PAGER",
];

test("STRIPPED_GIT_ENV_KEYS covers the canonical attack surface", () => {
  const stripped = new Set(STRIPPED_GIT_ENV_KEYS);
  for (const k of REQUIRED_KEYS) {
    assert.ok(stripped.has(k), `${k} must be in STRIPPED_GIT_ENV_KEYS`);
  }
});

test("cleanGitEnv removes every listed key", () => {
  const seed = Object.fromEntries(STRIPPED_GIT_ENV_KEYS.map((k) => [k, "x"]));
  seed.UNRELATED = "keep";
  const out = cleanGitEnv(seed);
  for (const k of STRIPPED_GIT_ENV_KEYS) {
    assert.equal(out[k], undefined, `${k} must be stripped`);
  }
  assert.equal(out.UNRELATED, "keep", "non-git keys must survive");
});

test("cleanGitEnv removes GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> by pattern", () => {
  const seed = {
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    GIT_CONFIG_KEY_42: "core.hooksPath",
    GIT_CONFIG_VALUE_42: "/tmp/evil",
    GIT_CONFIG_KEY_X: "should not match",
    UNRELATED: "keep",
  };
  const out = cleanGitEnv(seed);
  assert.equal(out.GIT_CONFIG_KEY_0, undefined);
  assert.equal(out.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(out.GIT_CONFIG_KEY_42, undefined);
  assert.equal(out.GIT_CONFIG_VALUE_42, undefined);
  assert.equal(out.GIT_CONFIG_KEY_X, "should not match", "non-numeric suffix must not match");
  assert.equal(out.UNRELATED, "keep");
});

test("cleanGitEnv defaults to process.env (deletes from a clone, not the original)", () => {
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = "/intentionally-bad";
  try {
    const out = cleanGitEnv();
    assert.equal(out.GIT_DIR, undefined, "clone must drop GIT_DIR");
    assert.equal(process.env.GIT_DIR, "/intentionally-bad", "process.env must be untouched");
  } finally {
    if (before === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = before;
  }
});

test("fixtureGitEnv applies the same scrub (no GIT_CONFIG_GLOBAL leak)", () => {
  const env = fixtureGitEnv({ FOO: "bar" });
  // The canonical scrub must reach the fixture helper.
  for (const k of REQUIRED_KEYS) {
    assert.equal(env[k], undefined, `fixtureGitEnv must strip ${k}`);
  }
  assert.equal(env.FOO, "bar", "extra arg must be merged in");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1", "fixture env must opt out of system git config");
});

test("fixtureGit ignores a malicious GIT_CONFIG_GLOBAL pointing at attacker config", () => {
  // Adversarial repro: parent env exports GIT_CONFIG_GLOBAL pointing at a
  // config that overrides init.defaultBranch. Without the scrub the fixture
  // repo would init on branch "injected-master".
  const evil = path.join(tmpdir(), `evil-gitconfig-${Date.now()}.cfg`);
  writeFileSync(evil, "[init]\n\tdefaultBranch = injected-master\n", "utf8");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = evil;
  const dir = mkdtempSync(path.join(tmpdir(), "git-env-evil-"));
  try {
    fixtureGit(dir, ["init", "-q"]);
    const branch = fixtureGit(dir, ["branch", "--show-current"]).stdout.trim();
    assert.notEqual(branch, "injected-master",
      "GIT_CONFIG_GLOBAL must not influence fixture branch — got " + branch);
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
    rmSync(dir, { recursive: true, force: true });
    rmSync(evil, { force: true });
  }
});
