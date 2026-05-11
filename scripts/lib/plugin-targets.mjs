// Shared plugin target sets for repo-level tooling and tests.

export const COMPANION_PLUGIN_TARGETS = Object.freeze(["claude", "gemini", "kimi"]);
export const CLAUDE_GEMINI_PLUGIN_TARGETS = Object.freeze(["claude", "gemini"]);
export const CODEX_ENV_PLUGIN_TARGETS = Object.freeze(["claude", "gemini", "kimi", "api-reviewers"]);
export const REVIEW_PROMPT_PLUGIN_TARGETS = Object.freeze(["api-reviewers", "claude", "gemini", "grok", "kimi"]);
