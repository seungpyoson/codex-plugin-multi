# Issue 63 Shared Helper Audit

## Scope

Issue #63 asked for a repo-wide audit of duplicated provider helpers, with
special attention to sandbox/environment detection, external-review metadata,
source-content disclosure, auth diagnostics, safe IDs, and reconcile/run-kind
helpers.

## Evidence And Decisions

| Candidate | Evidence | Owners / consumers | Decision | Adversarial review |
| --- | --- | --- | --- | --- |
| `isCodexSandbox` | Previously existed as identical local functions in `plugins/api-reviewers/scripts/api-reviewer.mjs`, `plugins/gemini/scripts/lib/gemini.mjs`, and `plugins/kimi/scripts/kimi-companion.mjs`. | API reviewers use it for Codex network-access diagnostics; Gemini uses it to avoid nested native sandboxing; Kimi uses it to classify sandbox-blocked ping failures. | Extracted to `scripts/lib/codex-env.mjs` with packaging copies in `plugins/{gemini,kimi,api-reviewers}/scripts/lib/codex-env.mjs`. | Sharing is justified because the false-like value list is a cross-provider semantic contract; drift would create inconsistent sandbox behavior. The helper remains tiny and dependency-free, so it does not add a new coupling hazard. |
| Companion utility helpers | `printJson`, `parseScopePathsOption`, `comparePathStrings`, `summarizeScopeDirectory`, `gitStatusLines`, `runKindFromRecord`, and prompt sidecar read/write helpers were exact duplicates across Claude, Gemini, and Kimi companion entry points. | Claude, Gemini, and Kimi companion commands. | Extracted to the existing canonical `scripts/lib/companion-common.mjs` and synced into plugin copies. | These helpers have small, stable inputs/outputs and no provider-specific semantics. The prompt sidecar helper takes a `jobsDir` rather than importing provider state, avoiding a hidden dependency on each plugin's `state.mjs`. |
| External-review metadata and source-content disclosure | `tests/unit/plugin-copies-in-sync.test.mjs` already checks `external-review.mjs` against canonical `scripts/lib/external-review.mjs` for Claude, Gemini, Kimi, and API reviewers. | All providers that persist external-review records. | Keep existing shared module and sync tests. | Further refactor would be churn; the existing canonical source plus byte-identity tests directly covers the drift risk. |
| Auth diagnostics | `auth-selection.mjs` is already canonical under `scripts/lib/auth-selection.mjs` and copied to Claude/Gemini only; Kimi intentionally has API-key auth ignored in companion code. | Claude/Gemini auth-mode selection and diagnostics. | Keep existing shared module; do not force Kimi into it. | Kimi has different auth semantics, so broadening this helper would obscure product-specific behavior. |
| Provider env scrubbing | `provider-env.mjs` is already canonical for Claude/Gemini. Kimi has a similar but intentionally different copy because its provider prefixes and allowed API key behavior differ. | Claude/Gemini target process spawning; Kimi target process spawning. | Keep as-is. | A single helper would need provider-specific knobs large enough to reduce clarity. Existing byte-identity and tests already guard the Claude/Gemini case. |
| `git-env.mjs` | API reviewers are byte-identical to Claude for `git-env.mjs`; Kimi has a stripped-key sync assertion. | Git fixture/test runner scrubbing and API reviewer scope collection. | Keep existing sync tests. | The module is already guarded where semantics must match, while Kimi keeps local implementation differences. |
| Companion-local command flow | Status/result/cancel glue, target invocation assembly, auth-mode selection, provider-specific resume/session handling, and Kimi runtime-options sidecars remain embedded in companion entry points. | Claude, Gemini, and Kimi companion entry points. | Leave local. | Extracting command orchestration would require many provider-specific parameters and would obscure target-specific behavior. The shared helper extraction above is intentionally limited to small utility functions with stable inputs and outputs. |
| Large copied companion libs (`state`, `scope`, `identity`, `process`, `args`, `job-record`, `reconcile`) | Existing byte-identity tests cover companion copies for the intended target sets. | Companion runtime libraries. | Leave current copy-sync model. | These are already shared-by-copy and covered; issue #63 is better served by adding the one missing unguarded helper than by widening a refactor blast radius. |

## New Guardrails

- `tests/unit/codex-env.test.mjs` locks down true and false-like
  `CODEX_SANDBOX` handling.
- `tests/unit/companion-common.test.mjs` locks down the shared companion utility
  helpers and verifies plugin copies expose the same behavior.
- `tests/unit/plugin-copies-in-sync.test.mjs` now prevents `codex-env.mjs`
  drift across Gemini, Kimi, and API reviewers.
- `scripts/ci/sync-codex-env.mjs` mirrors the existing sync-script pattern for
  canonical shared helper copies.
