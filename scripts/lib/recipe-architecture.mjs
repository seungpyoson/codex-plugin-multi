// scripts/lib/recipe-architecture.mjs
//
// Single source of truth for the smoke-rerecord recipe architecture
// kinds. Imported by:
//   - scripts/smoke-rerecord.mjs (recipe declarations + validator)
//   - scripts/lib/fixture-sanitization.mjs (sanitize() architecture
//     dispatch)
//
// Both sides previously branched on raw string literals
// ("companion" / "grok" / "api-reviewers"); a typo in either place
// silently disabled the architecture's sanitization rules. Importing
// from this module catches typos at the import (or at validateRecipes
// time) instead of at recording time.

export const ARCHITECTURE_COMPANION = "companion";
export const ARCHITECTURE_GROK = "grok";
export const ARCHITECTURE_API_REVIEWERS = "api-reviewers";

export const ARCHITECTURE_KINDS = Object.freeze([
  ARCHITECTURE_COMPANION,
  ARCHITECTURE_GROK,
  ARCHITECTURE_API_REVIEWERS,
]);
