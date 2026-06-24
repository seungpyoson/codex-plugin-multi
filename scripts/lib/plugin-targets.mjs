// Shared plugin target sets for repo-level tooling and tests.

import {
  companionProviderDefinitions,
} from "./provider-plugin-definitions.mjs";

export const COMPANION_PLUGIN_TARGETS = Object.freeze(
  companionProviderDefinitions().map((provider) => provider.codex.packageDirectory),
);
export const CLAUDE_GEMINI_PLUGIN_TARGETS = Object.freeze(["claude", "gemini"]);
export const PROVIDER_ENV_PLUGIN_TARGETS = Object.freeze(["claude", "gemini", "grok", "kimi", "agy"]);
export const DIRECT_API_PLUGIN_TARGETS = Object.freeze(["api-reviewers"]);
export const CODEX_ENV_PLUGIN_TARGETS = Object.freeze(["claude", "gemini", "kimi", "agy", ...DIRECT_API_PLUGIN_TARGETS]);
export const REVIEW_PROMPT_PLUGIN_TARGETS = Object.freeze([
  ...DIRECT_API_PLUGIN_TARGETS,
  "claude",
  "gemini",
  "grok",
  "kimi",
  "agy",
]);
