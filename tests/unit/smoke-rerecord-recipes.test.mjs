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
import { describe, it } from "node:test";

import {
  INVALID_PROVIDER_KEY_SENTINEL,
  RECIPES,
} from "../../scripts/smoke-rerecord.mjs";
import { checkAuthOrFile } from "../../scripts/lib/smoke-rerecord-preflight.mjs";
import { CLAUDE_PROVIDER_API_KEY_ENV } from "../../plugins/claude/scripts/lib/claude-provider-keys.mjs";

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

    it("envAny is the shared CLAUDE_PROVIDER_API_KEY_ENV (single source of truth)", () => {
      // Round-9 made this structurally impossible to violate via drift:
      // both this recipe and claude-companion.mjs import the array from
      // plugins/claude/scripts/lib/claude-provider-keys.mjs. The test
      // documents the contract — a future edit that hardcodes a local
      // array on either side fails this assertion immediately.
      assert.strictEqual(
        spec.requireEnvOrFile.envAny,
        CLAUDE_PROVIDER_API_KEY_ENV,
        "recipe envAny must be the shared CLAUDE_PROVIDER_API_KEY_ENV import; "
        + "hardcoding a local array reintroduces the round-6 decoy bug class",
      );
    });

    it("declares expectExit: [0] (refuse to write a fixture if the spawn fails)", () => {
      assert.deepEqual(spec.expectExit, [0]);
    });
  });

  describe("claude/auth-failure", () => {
    const spec = RECIPES["claude/auth-failure"].spawnArgs();
    it("forces api_key auth and a sterile HOME so OAuth cannot rescue the negative", () => {
      assert.ok(spec.args.includes("--auth-mode"));
      assert.equal(spec.args[spec.args.indexOf("--auth-mode") + 1], "api_key");
      assert.equal(spec.env.HOME, "/var/empty");
      assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(spec.env.CLAUDE_API_KEY, undefined);
    });
    it("declares expectExit: [1] (negative recipe characterized via probe)", () => {
      assert.deepEqual(spec.expectExit, [1]);
    });
  });

  describe("grok/happy-path-review", () => {
    const spec = RECIPES["grok/happy-path-review"].spawnArgs();
    it("declares a tunnel URL so the operator knows what must be reachable", () => {
      assert.ok(typeof spec.requireTunnel?.url === "string");
      assert.match(spec.requireTunnel.url, /^https?:\/\//);
    });
    it("declares expectExit: [0]", () => {
      assert.deepEqual(spec.expectExit, [0]);
    });
  });

  describe("grok/tunnel-error", () => {
    const spec = RECIPES["grok/tunnel-error"].spawnArgs();
    it("forces tunnel-unavailable via an unreachable port (intent-encoded in env)", () => {
      // Negative recipe: must point GROK_WEB_BASE_URL at port 1
      // (universally unreachable) so the spawn deterministically hits a
      // tunnel error even on a developer machine where the real tunnel
      // is up. Exact match prevents accidental drift to ports like 11
      // or 1234 which `\b` would have allowed through.
      assert.equal(spec.env.GROK_WEB_BASE_URL, "http://127.0.0.1:1/v1");
    });
    it("declares expectExit: [1]", () => {
      assert.deepEqual(spec.expectExit, [1]);
    });
  });

  for (const provider of ["deepseek", "glm"]) {
    const happyKey = `api-reviewers-${provider}/happy-path-review`;
    const negKey = `api-reviewers-${provider}/auth-rejected`;

    describe(happyKey, () => {
      const spec = RECIPES[happyKey].spawnArgs();
      it("passes --provider <name> matching the recipe key", () => {
        const idx = spec.args.indexOf("--provider");
        assert.notEqual(idx, -1);
        assert.equal(spec.args[idx + 1], provider);
      });
      it("declares requireEnvAny matching API_REVIEWER_PROVIDER_KEYS (validated by validateRecipes)", () => {
        // Per-provider envAny correctness is validated structurally at
        // module load by validateRecipes; this test pins that the
        // recipe HAS a non-empty requireEnvAny so absent envAny doesn't
        // fall through silently.
        assert.ok(Array.isArray(spec.requireEnvAny));
        assert.ok(spec.requireEnvAny.length > 0);
      });
      it("declares expectExit: [0]", () => {
        assert.deepEqual(spec.expectExit, [0]);
      });
    });

    describe(negKey, () => {
      const spec = RECIPES[negKey].spawnArgs();
      it("invalidates EVERY canonical provider key (greptile P1 #3199 — class fix)", () => {
        // Round-11 had this assert only `happyKeys[0]` — vacuous when the
        // recipe also only set the first key. The class-of-problem fix
        // (invalidateProviderKeys iterates API_REVIEWER_PROVIDER_KEYS[provider])
        // closes the gap structurally; this test pins it: a recipe that
        // forgets a key gets caught here, and `validateRecipes` catches it
        // at module load. Without iterating, a runner with the secondary
        // key wired (e.g. ZAI_GLM_API_KEY for glm) would silently record
        // a happy-path response in the negative fixture.
        const happyKeys = RECIPES[happyKey].spawnArgs().requireEnvAny;
        assert.ok(happyKeys.length > 0);
        for (const k of happyKeys) {
          // Diagnostic intentionally avoids interpolating spec.env[k] —
          // when this assertion fires locally, the failing value is
          // typically the developer's real provider key (because the
          // recipe spread process.env and forgot to override one slot),
          // and surfacing it in the assertion message is a credential
          // leak (Rule 10).
          assert.equal(
            spec.env[k],
            INVALID_PROVIDER_KEY_SENTINEL,
            `auth-rejected must sentinel every canonical key for ${provider}; ${k} is not the sentinel`,
          );
        }
      });
      it("declares expectExit: [1]", () => {
        assert.deepEqual(spec.expectExit, [1]);
      });
    });
  }
});

describe("smoke-rerecord recipes — completeness", () => {
  it("RECIPES contains every plugin × scenario pair we expect", () => {
    // Hard-coded list as a tripwire: adding or removing a recipe forces
    // an explicit edit here, preventing accidental loss via merge.
    const expected = [
      "claude/happy-path-review",
      "claude/auth-failure",
      "grok/happy-path-review",
      "grok/tunnel-error",
      "api-reviewers-deepseek/happy-path-review",
      "api-reviewers-deepseek/auth-rejected",
      "api-reviewers-glm/happy-path-review",
      "api-reviewers-glm/auth-rejected",
    ];
    assert.deepEqual([...Object.keys(RECIPES)].sort(), [...expected].sort());
  });
});
