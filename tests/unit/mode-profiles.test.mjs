// Unit tests for plugins/claude/scripts/lib/mode-profiles.mjs.
// Per spec §21.2, ModeProfile is the only source of mode-specific defaults.
// These tests bind the code to the canonical table verbatim — any drift fails.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODE_PROFILES,
  MODEL_TIERS,
  resolveProfile,
  resolveModelForProfile,
} from "../../plugins/claude/scripts/lib/mode-profiles.mjs";
import * as GeminiProfiles from "../../plugins/gemini/scripts/lib/mode-profiles.mjs";

import { buildClaudeArgs } from "../../plugins/claude/scripts/lib/claude.mjs";
import { buildGeminiArgs } from "../../plugins/gemini/scripts/lib/gemini.mjs";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const RESUME_UUID = "11111111-2222-4333-8444-555555555555";

// Expected review/adversarial-review/ping disallowed-tools list (verbatim from
// spec §4.5 / §10). Rescue must have an empty disallowed-tools array.
const REVIEW_DISALLOWED = [
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Bash", "WebFetch", "Agent", "Task", "mcp__*",
];

// ——————————————————————————————————————————————————————————————
// (a) Exactly five mode keys — no extras, no omissions.
// ——————————————————————————————————————————————————————————————
test("MODE_PROFILES has exactly the five spec-§21.2 keys", () => {
  const keys = Object.keys(MODE_PROFILES).sort();
  assert.deepEqual(keys, ["adversarial-review", "custom-review", "ping", "rescue", "review"]);
});

// ——————————————————————————————————————————————————————————————
// (b) Every profile has exactly the documented field set — no extras.
// ——————————————————————————————————————————————————————————————
const REQUIRED_FIELDS = [
  "name", "model_tier", "permission_mode", "strip_context",
  "disallowed_tools", "containment", "scope",
  "dispose_default", "add_dir", "schema_allowed",
].sort();

for (const name of ["review", "adversarial-review", "custom-review", "rescue", "ping"]) {
  test(`profile "${name}" has exactly the required fields`, () => {
    const p = MODE_PROFILES[name];
    const actual = Object.keys(p).sort();
    assert.deepEqual(actual, REQUIRED_FIELDS, `field set mismatch for ${name}`);
  });
}

// ——————————————————————————————————————————————————————————————
// (c) Values match spec §21.2 canonical table verbatim.
// ——————————————————————————————————————————————————————————————
test("review profile values match spec §21.2 table", () => {
  assert.deepEqual(MODE_PROFILES.review, {
    name: "review",
    model_tier: "cheap",
    permission_mode: "plan",
    strip_context: true,
    disallowed_tools: REVIEW_DISALLOWED,
    containment: "worktree",
    scope: "working-tree",
    dispose_default: true,
    add_dir: true,
    schema_allowed: true,
  });
});

test("adversarial-review profile values match spec §21.2 table", () => {
  assert.deepEqual(MODE_PROFILES["adversarial-review"], {
    name: "adversarial-review",
    model_tier: "medium",
    permission_mode: "plan",
    strip_context: true,
    disallowed_tools: REVIEW_DISALLOWED,
    containment: "worktree",
    scope: "branch-diff",
    dispose_default: true,
    add_dir: true,
    schema_allowed: true,
  });
});

test("custom-review profile values match spec §21.2 table", () => {
  assert.deepEqual(MODE_PROFILES["custom-review"], {
    name: "custom-review",
    model_tier: "medium",
    permission_mode: "plan",
    strip_context: true,
    disallowed_tools: REVIEW_DISALLOWED,
    containment: "worktree",
    scope: "custom",
    dispose_default: true,
    add_dir: true,
    schema_allowed: true,
  });
});

test("rescue profile values match spec §21.2 table (strip_context=false)", () => {
  assert.deepEqual(MODE_PROFILES.rescue, {
    name: "rescue",
    model_tier: "default",
    permission_mode: "acceptEdits",
    strip_context: false,
    disallowed_tools: [],
    containment: "none",
    scope: "working-tree",
    dispose_default: false,
    add_dir: true,
    schema_allowed: false,
  });
});

test("ping profile values match spec §21.2 table", () => {
  assert.deepEqual(MODE_PROFILES.ping, {
    name: "ping",
    model_tier: "native",
    permission_mode: "plan",
    strip_context: true,
    disallowed_tools: REVIEW_DISALLOWED,
    containment: "none",
    scope: "head",
    dispose_default: false,
    add_dir: false,
    schema_allowed: false,
  });
});

// ——————————————————————————————————————————————————————————————
// (b-bis) Profiles are frozen — a caller cannot mutate them into drift.
// ——————————————————————————————————————————————————————————————
test("MODE_PROFILES object is frozen", () => {
  assert.ok(Object.isFrozen(MODE_PROFILES));
  for (const name of Object.keys(MODE_PROFILES)) {
    assert.ok(Object.isFrozen(MODE_PROFILES[name]), `${name} not frozen`);
    assert.ok(Object.isFrozen(MODE_PROFILES[name].disallowed_tools),
      `${name}.disallowed_tools not frozen`);
  }
});

// ——————————————————————————————————————————————————————————————
// (d) resolveProfile — known names pass, unknown throws.
// ——————————————————————————————————————————————————————————————
test("resolveProfile('review') returns the review row by identity", () => {
  assert.equal(resolveProfile("review"), MODE_PROFILES.review);
});

test("resolveProfile throws on unknown mode", () => {
  assert.throws(() => resolveProfile("chaos"), /unknown mode|unknown profile/i);
});

test("resolveProfile rejects inherited object property names", () => {
  for (const name of ["__proto__", "constructor", "toString"]) {
    assert.throws(() => resolveProfile(name), /unknown mode|unknown profile/i);
    assert.throws(() => GeminiProfiles.resolveProfile(name), /unknown mode|unknown profile/i);
  }
});

// ——————————————————————————————————————————————————————————————
// MODEL_TIERS export lists the tier names used by the table.
// ——————————————————————————————————————————————————————————————
test("MODEL_TIERS enumerates cheap|medium|default|native", () => {
  assert.deepEqual([...MODEL_TIERS].sort(), ["cheap", "default", "medium", "native"]);
});

// ——————————————————————————————————————————————————————————————
// resolveModelForProfile picks by tier — no hard-coded model IDs in lib.
// ——————————————————————————————————————————————————————————————
test("resolveModelForProfile returns the tier's model from config", () => {
  const cfg = { cheap: "h", medium: "s", default: "o" };
  assert.equal(resolveModelForProfile(MODE_PROFILES.review, cfg), "h");
  assert.equal(resolveModelForProfile(MODE_PROFILES["adversarial-review"], cfg), "s");
  assert.equal(resolveModelForProfile(MODE_PROFILES["custom-review"], cfg), "s");
  assert.equal(resolveModelForProfile(MODE_PROFILES.rescue, cfg), "o");
  assert.equal(resolveModelForProfile(MODE_PROFILES.ping, cfg), null);
});

test("resolveModelForProfile returns null when tier missing from config", () => {
  assert.equal(resolveModelForProfile(MODE_PROFILES.review, {}), null);
});

test("resolveModelForProfile rejects invalid profiles and null configs", () => {
  assert.throws(() => resolveModelForProfile(null, {}), /profile\.model_tier/);
  assert.throws(() => resolveModelForProfile({}, {}), /profile\.model_tier/);
  assert.equal(resolveModelForProfile(MODE_PROFILES.review, null), null);
});

test("Gemini resolveModelCandidatesForProfile appends configured tier fallbacks", () => {
  const cfg = {
    cheap: "g-fast",
    medium: "g-smart",
    default: "g-default",
    fallbacks: {
      cheap: ["g-fast"],
      medium: ["g-stable", "g-fast", "g-stable"],
    },
  };
  assert.deepEqual(
    GeminiProfiles.resolveModelCandidatesForProfile(GeminiProfiles.MODE_PROFILES["adversarial-review"], cfg),
    ["g-smart", "g-stable", "g-fast"],
  );
  assert.deepEqual(
    GeminiProfiles.resolveModelCandidatesForProfile(GeminiProfiles.MODE_PROFILES.ping, cfg),
    [null, "g-fast"],
  );
});

// ——————————————————————————————————————————————————————————————
// (e) buildClaudeArgs(profile, runtimeInputs) — per-mode argv assertions.
// ——————————————————————————————————————————————————————————————
test("buildClaudeArgs: review produces the exact §4.5/§9 argv", () => {
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "review this",
    sessionId: UUID,
  });
  // Core prefix.
  assert.deepEqual(args.slice(0, 10), [
    "-p", "review this",
    "--output-format", "json",
    "--no-session-persistence",
    "--model", "claude-haiku-4-5-20251001",
    "--effort", "max",
    "--session-id",
  ]);
  assert.equal(args[10], UUID);
  // Layer 1 — strip_context.
  assert.ok(args.includes("--setting-sources"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  // Layer 2 — plan.
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  // Layer 3 — hard blocklist (exactly the spec list, joined by spaces).
  assert.ok(args.includes("--disallowedTools"));
  assert.equal(
    args[args.indexOf("--disallowedTools") + 1],
    REVIEW_DISALLOWED.join(" "),
  );
});

test("buildClaudeArgs: adversarial-review matches review except for the profile's model_tier (caller resolves)", () => {
  const args = buildClaudeArgs(resolveProfile("adversarial-review"), {
    model: "claude-sonnet-4-6",
    promptText: "challenge",
    sessionId: UUID,
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(args.includes("--disallowedTools"));
  assert.ok(args.includes("--setting-sources"));
  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-4-6");
});

test("buildClaudeArgs: custom-review uses the read-only review flag stack", () => {
  const args = buildClaudeArgs(resolveProfile("custom-review"), {
    model: "claude-sonnet-4-6",
    promptText: "review selected bundle files",
    sessionId: UUID,
    addDirPath: "/tmp/scoped-bundle",
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(args.includes("--disallowedTools"));
  assert.ok(args.includes("--setting-sources"));
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/scoped-bundle");
});

test("buildClaudeArgs: rescue omits --setting-sources (strip_context=false)", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-opus-4-7",
    promptText: "fix it",
    sessionId: UUID,
  });
  assert.ok(!args.includes("--setting-sources"),
    "rescue MUST NOT pass --setting-sources; it would strip CLAUDE.md and violate §9");
});

test("buildClaudeArgs: rescue omits --disallowedTools (empty list)", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-opus-4-7",
    promptText: "fix it",
    sessionId: UUID,
  });
  assert.ok(!args.includes("--disallowedTools"));
});

test("buildClaudeArgs: rescue uses --permission-mode acceptEdits", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-opus-4-7",
    promptText: "fix it",
    sessionId: UUID,
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
});

test("buildClaudeArgs: ping ignores addDirPath because profile.add_dir=false", () => {
  const args = buildClaudeArgs(resolveProfile("ping"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "pong",
    sessionId: UUID,
    addDirPath: "/tmp/should-be-ignored",
  });
  assert.ok(!args.includes("--add-dir"),
    "ping has add_dir=false in the profile; --add-dir must not be emitted");
});

test("buildClaudeArgs: ping is read-only (plan + disallowedTools + setting-sources)", () => {
  const args = buildClaudeArgs(resolveProfile("ping"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "pong",
    sessionId: UUID,
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.ok(args.includes("--disallowedTools"));
  assert.ok(args.includes("--setting-sources"));
});

test("buildClaudeArgs: review with addDirPath emits --add-dir", () => {
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "x",
    sessionId: UUID,
    addDirPath: "/tmp/some/dir",
  });
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/some/dir");
});

test("buildClaudeArgs: rescue with schema input silently drops it (schema_allowed=false)", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-opus-4-7",
    promptText: "fix",
    sessionId: UUID,
    jsonSchema: '{"type":"object"}',
  });
  assert.ok(!args.includes("--json-schema"),
    "profile.schema_allowed=false must suppress --json-schema");
});

test("buildClaudeArgs: review with schema emits --json-schema", () => {
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "x",
    sessionId: UUID,
    jsonSchema: '{"type":"object"}',
  });
  assert.ok(args.includes("--json-schema"));
  assert.equal(args[args.indexOf("--json-schema") + 1], '{"type":"object"}');
});

test("buildClaudeArgs: resume emits --resume and omits --session-id (works for any profile)", () => {
  const args = buildClaudeArgs(resolveProfile("rescue"), {
    model: "claude-opus-4-7",
    promptText: "follow up",
    resumeId: RESUME_UUID,
  });
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], RESUME_UUID);
  assert.ok(!args.includes("--session-id"));
});

// ——————————————————————————————————————————————————————————————
// (f) buildClaudeArgs rejects legacy knob arguments (stripContext, addDir,
// mode) — the profile is the only source of those.
// ——————————————————————————————————————————————————————————————
test("buildClaudeArgs throws if called with the legacy object-shape signature", () => {
  // Legacy shape: {mode, model, ...} with no profile. First arg must now be a
  // profile object; passing an object without the required profile fields
  // should fail loudly rather than silently apply defaults.
  assert.throws(
    () => buildClaudeArgs({
      mode: "review",
      model: "claude-haiku-4-5-20251001",
      promptText: "x",
      sessionId: UUID,
    }),
    /profile|permission_mode|strip_context/i,
  );
});

test("buildClaudeArgs ignores unknown runtimeInputs fields (no silent stripContext etc.)", () => {
  // If a caller passes a legacy `stripContext: false` runtime input, it must
  // have no effect — the profile's strip_context field is the only source.
  const args = buildClaudeArgs(resolveProfile("review"), {
    model: "claude-haiku-4-5-20251001",
    promptText: "x",
    sessionId: UUID,
    stripContext: false, // intentionally passed; must be ignored
  });
  assert.ok(args.includes("--setting-sources"),
    "review profile has strip_context=true; runtime stripContext=false must NOT override it");
});

// ——————————————————————————————————————————————————————————————
// (f-cont) cmdContinue re-resolves the profile from a persisted mode name.
// ——————————————————————————————————————————————————————————————
test("resolveProfile reflects live table for a persisted mode name (no snapshot)", () => {
  // Simulates what cmdContinue does: it persists only prior.mode ("rescue"),
  // then re-resolves at execution time. The returned object is the current
  // table row by identity, not a stale clone.
  const priorModeName = "rescue";
  const profileAtContinue = resolveProfile(priorModeName);
  assert.equal(profileAtContinue, MODE_PROFILES.rescue);
  // And the profile is frozen so subsequent code cannot mutate it.
  assert.ok(Object.isFrozen(profileAtContinue));
});

// ——————————————————————————————————————————————————————————————
// Runtime-input validation — no defaults leak into profile fields.
// ——————————————————————————————————————————————————————————————
test("buildClaudeArgs rejects missing model even when profile is present", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("review"), {
      promptText: "x", sessionId: UUID,
    }),
    /model is required/,
  );
});

test("buildClaudeArgs rejects missing promptText", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("review"), {
      model: "claude-haiku-4-5-20251001", sessionId: UUID,
    }),
    /promptText is required/,
  );
});

test("buildClaudeArgs rejects when neither sessionId nor resumeId is given", () => {
  assert.throws(
    () => buildClaudeArgs(resolveProfile("review"), {
      model: "claude-haiku-4-5-20251001", promptText: "x",
    }),
    /session|resume/i,
  );
});

test("gemini MODE_PROFILES preserves the canonical frozen mode table", () => {
  assert.deepEqual(Object.keys(GeminiProfiles.MODE_PROFILES).sort(), ["adversarial-review", "custom-review", "ping", "rescue", "review"]);
  assert.deepEqual(GeminiProfiles.MODE_PROFILES.review, MODE_PROFILES.review);
  assert.deepEqual(GeminiProfiles.MODE_PROFILES["adversarial-review"], MODE_PROFILES["adversarial-review"]);
  assert.deepEqual(GeminiProfiles.MODE_PROFILES["custom-review"], MODE_PROFILES["custom-review"]);
  assert.deepEqual(GeminiProfiles.MODE_PROFILES.rescue, MODE_PROFILES.rescue);
  assert.deepEqual(GeminiProfiles.MODE_PROFILES.ping, MODE_PROFILES.ping);
  assert.ok(Object.isFrozen(GeminiProfiles.MODE_PROFILES));
  for (const profile of Object.values(GeminiProfiles.MODE_PROFILES)) {
    assert.ok(Object.isFrozen(profile));
    assert.ok(Object.isFrozen(profile.disallowed_tools));
  }
});

test("gemini resolveProfile and model-tier lookup mirror Claude semantics", () => {
  assert.deepEqual([...GeminiProfiles.MODEL_TIERS].sort(), ["cheap", "default", "medium", "native"]);
  assert.equal(GeminiProfiles.resolveProfile("review"), GeminiProfiles.MODE_PROFILES.review);
  assert.throws(() => GeminiProfiles.resolveProfile("unknown"), /unknown mode|unknown profile/i);
  assert.equal(GeminiProfiles.resolveModelForProfile(GeminiProfiles.MODE_PROFILES.review, { cheap: "flash" }), "flash");
  assert.equal(GeminiProfiles.resolveModelForProfile(GeminiProfiles.MODE_PROFILES.rescue, { cheap: "flash" }), null);
  assert.equal(GeminiProfiles.resolveModelForProfile(GeminiProfiles.MODE_PROFILES.review, null), null);
  assert.throws(() => GeminiProfiles.resolveModelForProfile(null, {}), /profile\.model_tier/);
});

test("gemini profile rows have the canonical field set and values", () => {
  for (const name of ["review", "adversarial-review", "custom-review", "rescue", "ping"]) {
    assert.deepEqual(
      Object.keys(GeminiProfiles.MODE_PROFILES[name]).sort(),
      REQUIRED_FIELDS,
      `field set mismatch for Gemini ${name}`,
    );
  }
  assert.deepEqual(GeminiProfiles.MODE_PROFILES.review, {
    name: "review",
    model_tier: "cheap",
    permission_mode: "plan",
    strip_context: true,
    disallowed_tools: REVIEW_DISALLOWED,
    containment: "worktree",
    scope: "working-tree",
    dispose_default: true,
    add_dir: true,
    schema_allowed: true,
  });
  assert.deepEqual(GeminiProfiles.MODE_PROFILES["adversarial-review"], {
    name: "adversarial-review",
    model_tier: "medium",
    permission_mode: "plan",
    strip_context: true,
    disallowed_tools: REVIEW_DISALLOWED,
    containment: "worktree",
    scope: "branch-diff",
    dispose_default: true,
    add_dir: true,
    schema_allowed: true,
  });
  assert.deepEqual(GeminiProfiles.MODE_PROFILES["custom-review"], {
    name: "custom-review",
    model_tier: "medium",
    permission_mode: "plan",
    strip_context: true,
    disallowed_tools: REVIEW_DISALLOWED,
    containment: "worktree",
    scope: "custom",
    dispose_default: true,
    add_dir: true,
    schema_allowed: true,
  });
  assert.deepEqual(GeminiProfiles.MODE_PROFILES.rescue, {
    name: "rescue",
    model_tier: "default",
    permission_mode: "acceptEdits",
    strip_context: false,
    disallowed_tools: [],
    containment: "none",
    scope: "working-tree",
    dispose_default: false,
    add_dir: true,
    schema_allowed: false,
  });
  assert.deepEqual(GeminiProfiles.MODE_PROFILES.ping, {
    name: "ping",
    model_tier: "native",
    permission_mode: "plan",
    strip_context: true,
    disallowed_tools: REVIEW_DISALLOWED,
    containment: "none",
    scope: "head",
    dispose_default: false,
    add_dir: false,
    schema_allowed: false,
  });
});

test("gemini resolveModelForProfile resolves every mode tier", () => {
  const cfg = { cheap: "gemini-flash", medium: "gemini-pro", default: "gemini-default" };
  assert.equal(GeminiProfiles.resolveModelForProfile(GeminiProfiles.MODE_PROFILES.review, cfg), "gemini-flash");
  assert.equal(GeminiProfiles.resolveModelForProfile(GeminiProfiles.MODE_PROFILES["adversarial-review"], cfg), "gemini-pro");
  assert.equal(GeminiProfiles.resolveModelForProfile(GeminiProfiles.MODE_PROFILES["custom-review"], cfg), "gemini-pro");
  assert.equal(GeminiProfiles.resolveModelForProfile(GeminiProfiles.MODE_PROFILES.rescue, cfg), "gemini-default");
  assert.equal(GeminiProfiles.resolveModelForProfile(GeminiProfiles.MODE_PROFILES.ping, cfg), null);
});

test("buildGeminiArgs: read-only modes keep native sandbox outside Codex", () => {
  const args = buildGeminiArgs(GeminiProfiles.MODE_PROFILES.ping, {
    policyPath: "/tmp/read-only.toml",
    env: {},
  });

  assert.ok(args.includes("-s"), "Gemini native sandbox should remain enabled outside Codex sandbox");
});

test("buildGeminiArgs: read-only modes omit native sandbox inside Codex", () => {
  const args = buildGeminiArgs(GeminiProfiles.MODE_PROFILES.ping, {
    policyPath: "/tmp/read-only.toml",
    env: { CODEX_SANDBOX: "seatbelt" },
  });

  assert.equal(
    args.includes("-s"),
    false,
    "Gemini -s invokes nested sandbox-exec and must be omitted inside Codex sandbox",
  );
  assert.ok(args.includes("--policy"));
  assert.ok(args.includes("--approval-mode"));
  assert.equal(args[args.indexOf("--approval-mode") + 1], "plan");
  assert.ok(args.includes("--skip-trust"));
});

test("gemini resolveModelCandidatesForProfile covers fallback edge cases", () => {
  assert.throws(
    () => GeminiProfiles.resolveModelCandidatesForProfile(null, {}),
    /profile\.model_tier/,
  );
  assert.throws(
    () => GeminiProfiles.resolveModelCandidatesForProfile({}, {}),
    /profile\.model_tier/,
  );
  assert.deepEqual(
    GeminiProfiles.resolveModelCandidatesForProfile(GeminiProfiles.MODE_PROFILES.review, null),
    [],
  );
  assert.deepEqual(
    GeminiProfiles.resolveModelCandidatesForProfile(GeminiProfiles.MODE_PROFILES.review, { fallbacks: { cheap: "not-array" } }),
    [],
  );
  assert.deepEqual(
    GeminiProfiles.resolveModelCandidatesForProfile(GeminiProfiles.MODE_PROFILES.review, {
      cheap: "gemini-flash",
      fallbacks: { cheap: ["", "gemini-flash", "gemini-stable", 7, "gemini-stable"] },
    }),
    ["gemini-flash", "gemini-stable"],
  );
  assert.deepEqual(
    GeminiProfiles.resolveModelCandidatesForProfile(GeminiProfiles.MODE_PROFILES.ping, {
      cheap: "ignored-primary-for-native",
      fallbacks: { cheap: ["", "gemini-flash", "gemini-flash"] },
    }),
    [null, "gemini-flash"],
  );
});
