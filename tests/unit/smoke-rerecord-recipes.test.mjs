// tests/unit/smoke-rerecord-recipes.test.mjs
//
// Recipe-shape invariants for scripts/smoke-rerecord.mjs. These tests
// pin the union of two requirements that an external review surfaced
// in round-7:
//
//   (1) claude/happy-path-review must declare envAny so that a CI
//       runner with the API-key secret wired but no ~/.claude on disk
//       can still pass preflight (greptile P1 #3199437297).
//   (2) claude/happy-path-review must pass --auth-mode auto so the
//       spawned claude-companion does NOT strip the env key. Without
//       it, the run subcommand defaults to subscription, sets
//       allowed_env_credentials=[], and sanitizeTargetEnv removes
//       ANTHROPIC_API_KEY before exec — preflight green, runtime auth
//       fail. (auth-selection.mjs:42-47, claude-companion.mjs:818-829.)
//
// Either piece in isolation is insufficient. Dropping (1) resurrects
// the original P1; dropping (2) makes (1) a decoy. The test below
// asserts both — a single deletion in the recipe object is enough to
// fail the suite.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { RECIPES } from "../../scripts/smoke-rerecord.mjs";
import { checkAuthOrFile } from "../../scripts/lib/smoke-rerecord-preflight.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const COMPANION_PATH = path.join(
  REPO_ROOT,
  "plugins/claude/scripts/claude-companion.mjs",
);

describe("smoke-rerecord recipes — auth invariants", () => {
  describe("claude/happy-path-review", () => {
    const recipe = RECIPES["claude/happy-path-review"];
    const spec = recipe.spawnArgs();

    it("declares envAny so env-only CI runners pass preflight", () => {
      const envAny = spec.requireEnvOrFile?.envAny ?? [];
      assert.ok(
        envAny.includes("ANTHROPIC_API_KEY"),
        `envAny must include ANTHROPIC_API_KEY for the workflow secret to satisfy preflight; got ${JSON.stringify(envAny)}`,
      );
    });

    it("passes --auth-mode auto so the spawned claude does not strip the env var", () => {
      const idx = spec.args.indexOf("--auth-mode");
      assert.notEqual(idx, -1, "claude/happy-path-review must pass --auth-mode");
      assert.equal(
        spec.args[idx + 1],
        "auto",
        "--auth-mode must be 'auto' so envAny presence selects api_key_env in auth-selection.mjs",
      );
    });

    it("checkAuthOrFile passes when the key is wired and ~/.claude is absent", () => {
      const r = checkAuthOrFile(spec.requireEnvOrFile, {
        env: { ANTHROPIC_API_KEY: "wired-from-secret" },
        fileExists: () => false,
      });
      assert.equal(r.ok, true);
      assert.equal(r.source, "env");
    });

    it("checkAuthOrFile passes when the file exists and the key is unset", () => {
      const r = checkAuthOrFile(spec.requireEnvOrFile, {
        env: {},
        fileExists: () => true,
      });
      assert.equal(r.ok, true);
      assert.equal(r.source, "file");
    });

    it("checkAuthOrFile fails when neither key nor file is present", () => {
      const r = checkAuthOrFile(spec.requireEnvOrFile, {
        env: {},
        fileExists: () => false,
      });
      assert.equal(r.ok, false);
    });

    it("envAny matches the companion's provider key list (no silent drift)", () => {
      // Recipe's envAny and claude-companion.mjs's PING_PROVIDER_API_KEY_ENV
      // are independently maintained strings. If they drift, preflight can
      // pass with a key that auth-selection.mjs's auto mode then ignores
      // (filtered out by providerApiKeyEnv()), and sanitizeTargetEnv strips
      // the key before exec — same failure mode as the round-6 decoy. The
      // companion module cannot be imported (its main() runs unguarded at
      // file end), so the canonical list is parsed from source.
      const source = readFileSync(COMPANION_PATH, "utf8");
      const m = source.match(
        /const\s+PING_PROVIDER_API_KEY_ENV\s*=\s*(\[[^\]]*\])\s*;/,
      );
      assert.ok(
        m,
        `could not locate PING_PROVIDER_API_KEY_ENV in ${COMPANION_PATH}`,
      );
      const companionEnvs = JSON.parse(m[1]);
      const recipeEnvs = spec.requireEnvOrFile.envAny;
      assert.deepEqual(
        [...recipeEnvs].sort(),
        [...companionEnvs].sort(),
        "recipe envAny must match PING_PROVIDER_API_KEY_ENV exactly — drift "
        + "between the two reintroduces the round-6 decoy bug class",
      );
    });
  });
});
