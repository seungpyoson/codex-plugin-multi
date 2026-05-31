// Shared plugin target sets for repo-level tooling and tests.

export const COMPANION_PLUGIN_TARGETS = Object.freeze(["claude", "gemini", "kimi"]);
export const CLAUDE_GEMINI_PLUGIN_TARGETS = Object.freeze(["claude", "gemini"]);
export const PROVIDER_ENV_PLUGIN_TARGETS = Object.freeze(["claude", "gemini", "grok", "kimi"]);
export const DIRECT_API_PLUGIN_TARGETS = Object.freeze(["api-reviewers"]);
export const CODEX_ENV_PLUGIN_TARGETS = Object.freeze(["claude", "gemini", "kimi", ...DIRECT_API_PLUGIN_TARGETS]);
export const REVIEW_PROMPT_PLUGIN_TARGETS = Object.freeze([
  ...DIRECT_API_PLUGIN_TARGETS,
  "claude",
  "gemini",
  "grok",
  "kimi",
]);
