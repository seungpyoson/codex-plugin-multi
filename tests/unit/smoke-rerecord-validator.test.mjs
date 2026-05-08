// tests/unit/smoke-rerecord-validator.test.mjs
//
// Structural-invariant tests for the recipe schema validator
// (`validateRecipes` in scripts/smoke-rerecord.mjs) and the helper
// (`invalidateProviderKeys`) that the validator co-verifies through
// recipe shape. Each describe block targets a *class* of drift the
// validator must catch. Recipe-specific semantic tests live in
// smoke-rerecord-recipes.test.mjs; this file is for the recipe-
// construction rules themselves, exercised against fabricated input
// so the assertions don't depend on the live RECIPES shape.
//
// Rules these tests pin:
//   - `*-auth-rejected` recipe naming is reserved for api-reviewers
//     architecture. Companion / grok recipes use `*-auth-failure`
//     instead. Without this, a future cross-architecture recipe with
//     the wrong env-shape bypasses the invalidate-every-key check.
//   - Recipes whose declared exit code is non-zero must cite the
//     GitHub Actions run ID that observed the exit on a sterile CI
//     runner. Local probes can be wrong because dev `~/.claude` state
//     leaks through environment scrubs (see round-13 incident).
//   - `invalidateProviderKeys(provider)` returns a frozen-shape
//     overlay sentineling every accepted key for that provider, and
//     throws on unknown providers.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  ARCHITECTURE_API_REVIEWERS,
  ARCHITECTURE_COMPANION,
  ARCHITECTURE_GROK,
} from "../../scripts/lib/recipe-architecture.mjs";
import {
  INVALID_PROVIDER_KEY_SENTINEL,
  invalidateProviderKeys,
  validateRecipes,
} from "../../scripts/smoke-rerecord.mjs";

// Build a minimally-valid recipe object. Tests override fields per-case.
function makeRecipe(over = {}) {
  const baseSpec = {
    script: "scripts/x.mjs",
    args: [],
    env: {},
    expectExit: [0],
    ...over.spec,
  };
  return {
    architecture: over.architecture ?? ARCHITECTURE_COMPANION,
    plugin: over.plugin ?? "x",
    spawnArgs: () => baseSpec,
  };
}

// ───────────────────────────────────────────────────────────────────────
// *-auth-rejected naming is reserved for api-reviewers architecture
// ───────────────────────────────────────────────────────────────────────

describe("validateRecipes — *-auth-rejected is reserved for api-reviewers architecture", () => {
  it("rejects auth-rejected recipes with companion architecture", () => {
    // Reproduction: a contributor adds `claude/auth-rejected` (companion
    // architecture) with a buggy env override. Without this convention
    // check, the validator's auth-rejected invalidate-every-key block —
    // which is gated by `architecture === api-reviewers` — never fires,
    // and the bad recipe ships silently.
    const fake = {
      "claude/auth-rejected": makeRecipe({
        architecture: ARCHITECTURE_COMPANION,
        plugin: "claude",
        spec: { expectExit: [1] },
      }),
    };
    assert.throws(
      () => validateRecipes(fake),
      /auth-rejected.*api-reviewers|api-reviewers.*auth-rejected/i,
      "validateRecipes must reject *-auth-rejected outside api-reviewers architecture",
    );
  });

  it("rejects auth-rejected recipes with grok architecture", () => {
    const fake = {
      "grok/auth-rejected": makeRecipe({
        architecture: ARCHITECTURE_GROK,
        plugin: "grok",
        spec: { expectExit: [1] },
      }),
    };
    assert.throws(
      () => validateRecipes(fake),
      /auth-rejected.*api-reviewers|api-reviewers.*auth-rejected/i,
    );
  });

  it("accepts auth-failure naming with companion architecture", () => {
    // Sanity: the convention says companion uses *-auth-failure (the
    // existing claude/auth-failure recipe). The validator must not
    // reject the legal naming.
    const fake = {
      "claude/auth-failure": makeRecipe({
        architecture: ARCHITECTURE_COMPANION,
        plugin: "claude",
        spec: { expectExit: [1], expectExitObservedRun: 25489163404 },
      }),
    };
    assert.doesNotThrow(() => validateRecipes(fake));
  });
});

// ───────────────────────────────────────────────────────────────────────
// Negative recipes must cite a CI-observed workflow run
// ───────────────────────────────────────────────────────────────────────

describe("validateRecipes — negative recipes must cite a CI-observed workflow run", () => {
  it("rejects a negative recipe (expectExit !== [0]) lacking expectExitObservedRun", () => {
    // Reproduction: a contributor adds a new negative recipe and
    // declares an exit code from a local probe. Without an explicit
    // CI-observed-run reference, that claim accumulates silently.
    // Round-13 evidence: claude/auth-failure was wrong locally (exit 1)
    // vs. on CI (exit 2). The validator must force the contributor to
    // either run a workflow_dispatch or admit they haven't.
    const fake = {
      "x/y": makeRecipe({
        architecture: ARCHITECTURE_COMPANION,
        plugin: "x",
        spec: { expectExit: [1] },
      }),
    };
    assert.throws(
      () => validateRecipes(fake),
      /expectExitObservedRun/,
    );
  });

  it("rejects expectExitObservedRun set to a non-integer", () => {
    const fake = {
      "x/y": makeRecipe({
        architecture: ARCHITECTURE_COMPANION,
        plugin: "x",
        spec: { expectExit: [1], expectExitObservedRun: "25489163404" },
      }),
    };
    assert.throws(
      () => validateRecipes(fake),
      /expectExitObservedRun.*integer|integer.*expectExitObservedRun/,
    );
  });

  it("rejects expectExitObservedRun set to a non-positive integer (zero or negative)", () => {
    for (const bad of [0, -1, -25489163404]) {
      const fake = {
        "x/y": makeRecipe({
          architecture: ARCHITECTURE_COMPANION,
          plugin: "x",
          spec: { expectExit: [1], expectExitObservedRun: bad },
        }),
      };
      assert.throws(
        () => validateRecipes(fake),
        /expectExitObservedRun/,
        `expectExitObservedRun=${bad} must be rejected`,
      );
    }
  });

  it("accepts a negative recipe with a positive-integer expectExitObservedRun", () => {
    const fake = {
      "x/y": makeRecipe({
        architecture: ARCHITECTURE_COMPANION,
        plugin: "x",
        spec: { expectExit: [1], expectExitObservedRun: 25489163404 },
      }),
    };
    assert.doesNotThrow(() => validateRecipes(fake));
  });

  it("does NOT require expectExitObservedRun for happy-path recipes (expectExit: [0])", () => {
    // expectExit: [0] is the universal "the recipe succeeded" outcome —
    // a wrong value would fail the workflow obviously (any non-zero
    // exit). There's no silent-acceptance risk to insure against, so
    // the field is not required for happy-path recipes.
    const fake = {
      "x/happy": makeRecipe({
        architecture: ARCHITECTURE_COMPANION,
        plugin: "x",
        spec: { expectExit: [0] },
      }),
    };
    assert.doesNotThrow(() => validateRecipes(fake));
  });
});

// ───────────────────────────────────────────────────────────────────────
// Sanity: the live RECIPES module-load passes the new checks
// ───────────────────────────────────────────────────────────────────────

describe("validateRecipes — live RECIPES module-load contract", () => {
  it("all negative recipes in the live RECIPES carry expectExitObservedRun", async () => {
    // Importing scripts/smoke-rerecord.mjs runs validateRecipes(RECIPES)
    // at the bottom of the module — if any negative recipe lacked the
    // observed-run field, the import would throw. Re-importing here
    // confirms the live module passes the round-14 invariants.
    const mod = await import("../../scripts/smoke-rerecord.mjs");
    for (const [key, recipe] of Object.entries(mod.RECIPES)) {
      const spec = recipe.spawnArgs();
      const isNegative = !spec.expectExit.includes(0);
      if (isNegative) {
        assert.equal(
          typeof spec.expectExitObservedRun,
          "number",
          `${key}: must declare expectExitObservedRun (a workflow_dispatch run ID)`,
        );
        assert.ok(
          Number.isInteger(spec.expectExitObservedRun) && spec.expectExitObservedRun > 0,
          `${key}: expectExitObservedRun must be a positive integer`,
        );
      }
    }
  });

  it("INVALID_PROVIDER_KEY_SENTINEL is a non-empty string (sanity for downstream tests)", () => {
    // The sentinel is consumed by recipe assertions that import it from
    // the same module; pin its shape so a future refactor that turns it
    // into a function or null fires a unit-test failure instead of a
    // surprising recipe-validation error.
    assert.equal(typeof INVALID_PROVIDER_KEY_SENTINEL, "string");
    assert.ok(INVALID_PROVIDER_KEY_SENTINEL.length > 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// invalidateProviderKeys — direct unit tests
// ───────────────────────────────────────────────────────────────────────
//
// The helper is co-verified through the validator's runtime check on
// auth-rejected recipes (`spec.env[k] === SENTINEL` for every k in the
// canonical list). Direct tests here uncouple the helper's contract
// from the recipe-shape coupling: a future refactor that changes the
// helper's signature without touching the recipes — e.g. adds a third
// parameter that defaults wrong — would still satisfy the validator's
// shape check but would surface in these tests.

describe("invalidateProviderKeys", () => {
  it("returns a single-key overlay for a one-key provider (deepseek)", () => {
    const out = invalidateProviderKeys("deepseek");
    assert.deepEqual(out, { DEEPSEEK_API_KEY: INVALID_PROVIDER_KEY_SENTINEL });
  });

  it("returns an overlay with EVERY canonical key sentineled (glm)", () => {
    // The whole point of round-12: a multi-key provider must have all
    // its accepted keys invalidated. A typo or omission here is the
    // class of bug greptile P1 #3199 caught.
    const out = invalidateProviderKeys("glm");
    assert.deepEqual(out, {
      ZAI_API_KEY: INVALID_PROVIDER_KEY_SENTINEL,
      ZAI_GLM_API_KEY: INVALID_PROVIDER_KEY_SENTINEL,
    });
  });

  it("throws on an unknown provider with a clear remediation", () => {
    assert.throws(
      () => invalidateProviderKeys("does-not-exist"),
      /unknown provider/,
    );
  });
});
