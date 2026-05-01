// ModeProfile table — the ONLY source of mode-specific defaults (spec §21.2).
//
// Every knob whose correct value is determined by mode lives here in exactly
// one place. Dispatcher libraries (`claude.mjs`) accept a profile object; they
// do NOT take individual flag knobs with defaults. Adding a new mode is adding
// one row to this table — nothing else changes.
//
// Mutating these objects is a bug: all rows (and their nested arrays) are
// deep-frozen. The table is read by value identity, not by deep-copy — if a
// downstream caller needs a scratch copy, it should clone explicitly.

// Tools Claude should never invoke in review/ping mode (hard blocklist,
// spec §4.5 / §10). `mcp__*` wildcard blocks every MCP tool. Kept as a frozen
// constant so the three profiles that need it share the same array identity.
const REVIEW_DISALLOWED = Object.freeze([
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Bash", "WebFetch", "Agent", "Task", "mcp__*",
]);

const EMPTY_TOOLS = Object.freeze([]);

/**
 * MODE_PROFILES — verbatim copy of the spec §21.2 canonical table.
 *
 * Each profile row has exactly these fields:
 *   name             — the mode key (kept in the value for self-description)
 *   model_tier       — "cheap" | "medium" | "default" | "native" (§8)
 *   permission_mode  — "plan" | "acceptEdits" (§4.5)
 *   strip_context    — emit `--setting-sources ""`? (§4.6)
 *   disallowed_tools — hard blocklist (§4.5). Empty array means don't pass
 *                      `--disallowedTools` at all.
 *   containment      — "none" | "worktree" (§21.4) — OWNED BY T7.2; this task
 *                      fixes the field's presence, not its use in companion.
 *   scope            — "working-tree" | "staged" | "branch-diff" | "head" |
 *                      "custom" (§21.4) — same caveat.
 *   dispose_default  — worktree cleanup default (§10)
 *   add_dir          — pass `--add-dir <path>` at all?
 *   schema_allowed   — is `--json-schema` meaningful for this mode? When
 *                      false, jsonSchema runtime input is silently dropped.
 */
export const MODE_PROFILES = Object.freeze({
  review: Object.freeze({
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
  }),
  "adversarial-review": Object.freeze({
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
  }),
  "custom-review": Object.freeze({
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
  }),
  rescue: Object.freeze({
    name: "rescue",
    model_tier: "default",
    permission_mode: "acceptEdits",
    strip_context: false, // §9: rescue inherits CLAUDE.md context on purpose
    disallowed_tools: EMPTY_TOOLS,
    containment: "none",
    scope: "working-tree",
    dispose_default: false,
    add_dir: true,
    schema_allowed: false,
  }),
  ping: Object.freeze({
    name: "ping",
    model_tier: "native",
    permission_mode: "plan",
    strip_context: true,
    disallowed_tools: REVIEW_DISALLOWED,
    containment: "none",
    scope: "head",
    dispose_default: false,
    add_dir: false, // ping is a bare OAuth probe — no directory is granted
    schema_allowed: false,
  }),
});

/** Tier names used across the table. Exported so UI/tests can enumerate. */
export const MODEL_TIERS = Object.freeze(["cheap", "medium", "default", "native"]);

/**
 * Look up a profile by mode name. Throws loudly on unknown names — silent
 * fall-throughs would be exactly the defects §21.2 aims to eliminate.
 */
export function resolveProfile(name) {
  if (!Object.prototype.hasOwnProperty.call(MODE_PROFILES, name)) {
    const known = Object.keys(MODE_PROFILES).join(", ");
    throw new Error(`unknown mode ${JSON.stringify(name)}; expected one of: ${known}`);
  }
  return MODE_PROFILES[name];
}

/**
 * Resolve a model ID for a profile given the parsed models config
 * (`plugins/claude/config/models.json` at runtime). Returns null when the
 * tier is not present in the config — callers decide how to fail. Model IDs
 * are intentionally NOT stored in this file; the config is the single source
 * of truth for "which model is the 'cheap' tier today".
 */
export function resolveModelForProfile(profile, modelsConfig) {
  if (!profile || typeof profile.model_tier !== "string") {
    throw new Error("resolveModelForProfile: profile.model_tier is required");
  }
  if (profile.model_tier === "native") return null;
  if (!modelsConfig || typeof modelsConfig !== "object") return null;
  return modelsConfig[profile.model_tier] ?? null;
}
