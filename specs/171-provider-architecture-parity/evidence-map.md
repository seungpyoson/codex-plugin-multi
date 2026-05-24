# Provider Architecture Parity Evidence Map

Date: 2026-05-24  
Branch: `goal/provider-architecture-parity-171`  
Worktree: `.worktrees/provider-architecture-parity-171`  
Primary issue: #171, "Fix provider architecture parity across external model adapters"  
Topology input issue: #170, "Audit repo-wide runtime topology and duplicated provider paths"

## Baseline Evidence

- `git fetch origin`: passed after sandbox escalation for Git ref writes.
- `git status --short --branch`: `## goal/provider-architecture-parity-171...origin/main`.
- `npm install`: added 7 packages, audited 13 packages, 0 vulnerabilities.
- `npm test`: 2118 tests, 2106 pass, 0 fail, 12 skipped, duration 156395 ms after
  the spec packet was reconstructed in the linked worktree.
- `npm run lint:sync`: passed; `default auth policy OK`.
- `.worktrees` exists and `git check-ignore -q .worktrees` passed before worktree creation.

## Issue Evidence

- #171 is open/P1/architecture and asks for one shared provider architecture contract unless a provider has a documented, tested reason to differ. It explicitly scopes Claude, Gemini, Kimi, Grok, DeepSeek, GLM, route/fallback behavior, JobRecord/status/lifecycle semantics, provider readiness, source-send approval state, billing path, failure class, next action, generated docs, and packaged copies.
- #170 is open/P2/architecture and maps repo-wide topology/copy risks. It is evidence input only for this goal; current evidence does not yet prove #171 must become a repo-wide topology split.
- #159 remains open and now states Grok should be CLI-primary while the existing web tunnel should become an audited fallback when CLI is unavailable. Current code/docs/tests instead intentionally keep `web` explicit-only. This is the strongest unresolved parity decision.
- #162 is open for Gemini Antigravity compatibility. It is provider-adapter future work, not current shared-policy drift unless Gemini CLI compatibility changes land.
- #172 is open for broad large custom-review packet routing/chunking parity. It is related to packet-budget guardrails, not this audit's immediate implementation target.
- #173 is open for the reproduced Claude subscription CLI `custom-review` packet-budget gap: current Claude `custom-review` can fall back to full selected-source bodies without a pre-launch budget or resend-confirmation gate. This was confirmed after #171 final review work through code-path tracing, current job records, and a non-Claude Grok adversarial review approval.
- #167/#146 are open UX/generated-contract follow-ups. They reinforce shared status/contract surfaces but are not substitutes for #171.
- #147/#160/#144 are direct-API workflow follow-ups. They are related to approval/session/env/rescue, but #171 should not absorb them unless the parity plan proves shared route/source-send semantics are missing.

## Architecture Evidence Map

| Policy Area | Canonical Module / Interface / Implementation | Provider Adapters Consuming It | Packaged Copies / Sync Guard | Tests / Gates | Verdict |
| --- | --- | --- | --- | --- | --- |
| Route/auth/source-send policy | Module `scripts/lib/provider-route-policy.mjs`; interface `selectProviderRoute()` and `normalizeApprovalScope()`; implementation selects `subscription` or `api`, records `selected_route`, `fallback_reason`, `auth_path`, `billing_path`, and source-send approval state. | Claude/Gemini via `scripts/lib/auth-selection.mjs` copies; Kimi via `selectProviderRoute()`; Grok via `providerCapabilitiesForConfig()` and `subscriptionRouteForConfig()`; DeepSeek/GLM via API reviewer `routeStateForApproval()`. | Copied to all reviewer plugins by `scripts/ci/sync-provider-route-policy.mjs`; checked by `tests/unit/plugin-copies-in-sync.test.mjs`; included in `npm run lint:sync`. | `tests/unit/provider-route-policy.test.mjs`, `tests/unit/auth-selection.test.mjs`, Grok smoke route assertions, API approval tuple tests, `npm test`, `npm run lint:sync`. | Compliant shared policy, with one unresolved Grok fallback product decision from #159. |
| Claude/Gemini auth wrapper | Module `scripts/lib/auth-selection.mjs`; interface `resolveAuthSelection()`, `apiKeyFallbackSelection()`, `authDiagnosticFields()`; implementation wraps shared route policy and rejects ambiguous `auto`. | Claude `resolveAuthSelection()` wrapper at `plugins/claude/scripts/claude-companion.mjs`; Gemini wrapper at `plugins/gemini/scripts/gemini-companion.mjs`. | Copied to Claude/Gemini by `scripts/ci/sync-auth-selection.mjs`; checked by `tests/unit/plugin-copies-in-sync.test.mjs`. | `tests/unit/auth-selection.test.mjs`; Claude/Gemini dispatcher/smoke tests in default `npm test`. | Compliant shared policy for Claude/Gemini. |
| Source transmission truth/disclosure | Module `scripts/lib/external-review.mjs`; interface `SOURCE_CONTENT_TRANSMISSION`, `sourceContentTransmissionForExecution()`, `buildExternalReview()`; implementation preserves `not_sent`, `may_be_sent`, `sent`, `unknown`. | Claude/Gemini/Kimi companion job records; Grok runtime; API reviewer runtime. | Copied to companion plugins plus Grok/API by `scripts/ci/sync-external-review.mjs`; checked by copy sync tests. | `tests/unit/companion-common.test.mjs`, JobRecord tests, API/Grok smoke tests, default `npm test`. | Compliant shared policy. |
| Prompt/source packet/audit manifest | Module `scripts/lib/review-prompt.mjs`; interfaces `buildReviewPrompt()`, `buildSelectedSourcePromptBlock()`, `buildReviewAuditManifest()`; implementation records prompt hash, selected source manifest, git identity, request, route fields, approval scope, source-bearing state, and review-quality flags. | Claude/Gemini/Kimi/Grok/API review paths build manifests through packaged copies. | Copied to all reviewer plugins by `scripts/ci/sync-review-prompt.mjs`; checked by copy sync tests and `lint:sync`. | `tests/unit/review-prompt.test.mjs`, `tests/unit/external-model-contracts.test.mjs`, smoke tests. | Compliant shared policy. |
| Failure taxonomy / suggested action | Modules `scripts/lib/external-model-failure-core.mjs`, `scripts/lib/external-model-failure-catalog.mjs`, `scripts/lib/external-model-review-quality.mjs`; interfaces `classifyCompanionExecution()`, `buildExternalModelFailureDiagnostic()`, `reviewQualityFailureState()`. | Claude/Gemini/Kimi job-record modules delegate to shared classifier; Grok/API call shared review-quality and diagnostic helpers. | Synced by `scripts/ci/sync-external-model-failure-classification.mjs` and `scripts/ci/sync-external-model-review-quality.mjs`; checked by copy sync tests. | `tests/unit/plugin-copies-in-sync.test.mjs` asserts runtime imports/calls; failure-core/review-quality/job-record tests run in default `npm test`. | Compliant shared policy. Provider-specific error parsers remain adapter facts. |
| Status/UX normalization | Module `scripts/lib/review-panel.mjs`; interfaces `buildReviewPanelRows()`, `collectReviewPanelRecords()`, `renderReviewPanelMarkdown()`; implementation normalizes provider, job id, state, status, readiness, sent state, quality, inspection, error code, HTTP status, and reasons. | Packaged review-panel CLIs/libs for Claude/Gemini/Kimi/Grok/API. | Synced by `scripts/ci/sync-review-panel.mjs`; checked by copy sync tests. | `tests/unit/review-panel.test.mjs`; #167/#146 track richer operator UX. | Compliant shared normalization, with UX depth follow-ups out of scope. |
| Provider launch mechanics | Provider adapters own CLI/API/tunnel launch facts: Claude/Gemini/Kimi companion runtimes, Grok CLI/web runtime, API reviewer HTTP runtime. | All providers. | Provider-specific entrypoints are not copied as shared policy; shared libs are copied as distribution artifacts. | Provider smoke/unit tests in default `npm test`; live E2E opt-ins exist. | Intentional adapter layer. Exceptions must remain documented/tested. |
| Packaged copies | Canonical sources under `scripts/lib/`; package copies under `plugins/*/scripts/lib/`; generated commands/skills/docs from canonical generators. | All plugin packages. | `scripts/ci/sync-*.mjs` scripts plus `tests/unit/plugin-copies-in-sync.test.mjs`; `npm run lint:sync` passed. | `npm run lint:sync`, copy sync tests, generated contract tests. | Packaging copy with sync guard. No current evidence of unguarded shared-policy copy drift. |

## Exceptions And Unknowns

1. Grok transport fallback is the main unresolved exception. Current source supports `cli` default and explicit `web`; `transportMode()` rejects anything except `cli`/`web`, generated Grok docs say the legacy tunnel is explicit-only, and tests assert CLI failures do not suggest web fallback. #159 now says Grok should provide an audited CLI-to-web fallback mode. This is a documented/tested exception today, but not yet reconciled with the open #159/#171 desired outcome.
2. DeepSeek and GLM are API-only providers. Current route policy treats them as the same API route state with `fallback_reason: "subscription_not_supported"`, not a separate policy class. This appears compliant.
3. Gemini Antigravity (#162) is not implemented. The current evidence supports Gemini CLI parity only; Antigravity should become a future adapter/capability row after its contract is proven.
4. Packet-budget parity now has two follow-ups. #172 remains the broad large-packet routing/chunking issue; #173 is the narrower reproduced Claude subscription CLI `custom-review` full-source pre-launch budget gap. Neither should be silently folded into #171's provider architecture parity implementation.
5. No `.specify/` directory exists in this repo/worktree, so the Speckit plan/tasks workflow must be applied manually from the installed skill instructions using the existing `specs/*` artifact shape.

## Architecture Verdicts

- Route/auth/source-send: compliant shared policy, except the Grok fallback decision needs a plan-reviewed classification.
- Prompt/audit/review quality: compliant shared policy.
- Failure taxonomy/suggested actions: compliant shared policy with adapter-specific parser facts.
- Status/review panel: compliant shared normalization.
- Packaged copies: synced distribution artifacts with guardrails.
- Provider entrypoints: mostly thin adapters over shared policy plus launch mechanics; Grok remains the deepest adapter because it contains both CLI and web-tunnel implementations.
- Repo-wide topology split: not proven yet. #170 remains input; current #171 can proceed as provider parity documentation/test guardrails unless external review finds repo-wide topology drift.
- Claude custom-review packet budgeting: confirmed follow-up #173, not a #171 blocker after the root-cause issue was filed and recorded.

## Confidence And Fit

Implementation confidence is not 100%. First-pass external review rejected a
docs-only treatment of Grok fallback, so the revised plan includes a TDD runtime
slice for explicit Grok auto transport while still blocking implementation until
unanimous approval.

#171 is the correct primary issue because the current evidence is provider-facing and centered on route/auth/source-send/status/failure parity. #170 should not be the implementation target unless subsequent review finds unguarded repo-wide topology drift outside provider parity.

## Speckit Proposal

- Feature name: Provider Architecture Parity Audit
- Slug: `171-provider-architecture-parity`
- Recommended MVP after first external review feedback: machine-validated parity
  JSON plus a Grok `auto` transport fallback TDD slice.
- Candidate deliverables after plan/tasks approval:
  - A provider parity JSON table covering Claude, Gemini, Kimi, Grok, DeepSeek, and GLM.
  - Focused guard tests that the parity table and generated contracts mention every shared route/audit/status field.
  - An audited Grok CLI-primary/web-fallback runtime slice under #159/#171.
  - A recorded follow-up split for #173 so the Claude usage-limit root cause is not lost under the broader #172 packet-budget issue.
  - No implementation before the revised plan/tasks review is unanimous.
