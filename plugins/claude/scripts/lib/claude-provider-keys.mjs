// plugins/claude/scripts/lib/claude-provider-keys.mjs
//
// Single source of truth for the Claude/Anthropic provider API-key
// environment variable names. Imported by:
//   - plugins/claude/scripts/claude-companion.mjs (auth selection)
//   - scripts/smoke-rerecord.mjs (recipe envAny preflight)
//
// Both sides previously maintained the array independently, which let
// them drift silently and reintroduced the round-6 decoy bug class on
// PR #116 (preflight green → spawn auth-fail because the recipe accepts
// keys that the companion's allowed_env_credentials list doesn't honor).

export const CLAUDE_PROVIDER_API_KEY_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
]);
