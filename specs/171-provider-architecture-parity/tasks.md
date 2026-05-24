# Tasks: Provider Architecture Parity Audit

**Input**: `specs/171-provider-architecture-parity/`  
**Prerequisites**: `evidence-map.md`, `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/provider-parity-table.schema.json`, `quickstart.md`  
**Hard gate**: Do not implement docs/test/runtime guardrails until the plan/tasks packet receives usable APPROVE verdicts from Claude, Gemini, Grok, GLM, DeepSeek, and Kimi.

## Phase 1: Setup

- [X] T001 Verify `specs/171-provider-architecture-parity/evidence-map.md` against current source and issue evidence.
- [X] T002 Verify the worktree is `goal/provider-architecture-parity-171` and clean before review packet creation.
- [X] T003 Run `git diff --check`, `npm run lint:sync`, and `npm test` before external plan/tasks review.

## Phase 2: Foundational Review Gate

- [X] T004 Build the plan/tasks review packet from all files under `specs/171-provider-architecture-parity/`.
- [X] T005 Run Claude adversarial review for the plan/tasks packet and record job/artifact evidence in `specs/171-provider-architecture-parity/review-results.md`.
- [X] T006 Run Gemini adversarial review for the plan/tasks packet and record job/artifact evidence in `specs/171-provider-architecture-parity/review-results.md`.
- [X] T007 Run Grok adversarial review for the plan/tasks packet and record job/artifact evidence in `specs/171-provider-architecture-parity/review-results.md`.
- [X] T008 Run GLM adversarial review for the plan/tasks packet and record job/artifact evidence in `specs/171-provider-architecture-parity/review-results.md`.
- [X] T009 Run DeepSeek adversarial review for the plan/tasks packet and record job/artifact evidence in `specs/171-provider-architecture-parity/review-results.md`.
- [X] T010 Run Kimi adversarial review for the plan/tasks packet and record job/artifact evidence in `specs/171-provider-architecture-parity/review-results.md`.
- [X] T011 Record review packet file list, byte counts, and SHA-256 hashes in `specs/171-provider-architecture-parity/review-results.md`.
- [X] T012 Stop before implementation unless every reviewer in `specs/171-provider-architecture-parity/review-results.md` has a usable APPROVE verdict.

## Phase 3: User Story 1 - Provider Parity Is Inspectable (P1)

**Independent Test**: A reader can inspect one parity table and find all six providers, required policy areas, evidence paths, verdicts, sync guards, and residual issue links.

- [X] T013 [P] [US1] Add RED provider parity table contract test in `tests/unit/docs-contracts.test.mjs`.
- [X] T014 [US1] Add canonical machine-validatable parity table artifact in `specs/171-provider-architecture-parity/provider-parity-table.json`.
- [X] T015 [US1] GREEN the provider parity contract test by validating `provider-parity-table.json` against `contracts/provider-parity-table.schema.json`.
- [X] T016 [US1] Ensure the JSON table covers all six providers and all required policy areas from FR-002: route/auth/source-send approval, packet budgets, fallback semantics, failure taxonomy, suggested actions, audit fields, review-quality gates, status/UX normalization, generated contracts, docs, packaged copies, and sync rules. Packet budgets may be represented as `unknown_needs_research`, follow-up #172, or the later Claude-specific follow-up #173 only if evidence supports deferral.
- [X] T017 [US1] Run focused docs contract verification with `node --test tests/unit/docs-contracts.test.mjs`.

## Phase 4: User Story 2 - Shared Policy Guardrails Prevent Drift (P1)

**Independent Test**: Focused tests fail if a provider-facing shared policy field or packaged-copy guardrail disappears.

- [X] T018 [P] [US2] Add RED guard coverage in `tests/unit/external-model-contracts.test.mjs` for exact shared audit/status field inventory: `selected_route`, `fallback_reason`, `approval_scope`, `auth_path`, `billing_path`, `source_bearing`, `source_send_approval_required`, `source_send_approval_state`, `source_content_transmission`, `review_quality.failed_review_slot`, `review_quality.semantic_failure_reasons`, `error_code`, and `suggested_action`.
- [X] T019 [P] [US2] Add RED guard coverage in `tests/unit/plugin-copies-in-sync.test.mjs` that provider-facing entrypoints or synced libs consume the shared policy interfaces: `selectProviderRoute`, `buildReviewAuditManifest`, `SOURCE_CONTENT_TRANSMISSION`, `buildExternalModelFailureDiagnostic`, and `reviewQualityFailureState`.
- [X] T020 [US2] GREEN the guard tests through canonical docs/generator/test fixtures only; do not hand-edit generated provider docs.
- [X] T021 [US2] Run focused verification with `node --test tests/unit/external-model-contracts.test.mjs tests/unit/plugin-copies-in-sync.test.mjs`.

## Phase 5: User Story 3 - Grok Audited Fallback Is Implemented (P1)

**Independent Test**: In `GROK_TRANSPORT=auto` or `--transport auto`, a tested Grok CLI readiness/login/model failure attempts the local web tunnel fallback, records primary and fallback transport metadata, and never falls back to paid xAI API billing.

- [X] T022 [P] [US3] Add RED Grok smoke coverage that `GROK_TRANSPORT=auto` / `--transport auto` is accepted while default `cli` remains unchanged.
- [X] T023 [P] [US3] Add RED Grok smoke coverage that CLI happy path in auto mode records `transport: "cli"`, `auth_mode: "subscription_cli"`, `selected_route: "subscription_cli"`, and never contacts web/tunnel state.
- [X] T024 [P] [US3] Add RED Grok smoke coverage that an approved CLI readiness/login/model failure in auto mode attempts the existing local web tunnel and records `transport: "web"`, `fallback_from: "cli"`, `selected_route: "subscription_web"`, `auth_path: "subscription_web"`, and source-send disclosure for the web transport.
- [X] T025 [P] [US3] Add RED Grok smoke coverage that plain `--transport cli` remains terminal on CLI failure and does not fallback.
- [X] T026 [P] [US3] Add RED Grok smoke coverage that auto mode never falls back to paid xAI/direct API env credentials and redacts direct API env values.
- [X] T027 [US3] GREEN the minimal Grok runtime changes in `plugins/grok/scripts/grok-web-reviewer.mjs`, keeping web-tunnel bootstrap/repair explicit and preserving existing `--transport web` diagnostics.
- [X] T028 [US3] Update provider parity table JSON and generated/operator docs only through canonical source or sync path required by the existing tests.
- [X] T029 [US3] Run focused Grok verification with `node --test tests/smoke/grok-web.smoke.test.mjs`.

## Phase 6: Verification And Final Review

- [X] T030 Run `git diff --check`.
- [X] T031 Run `npm run lint:sync`.
- [X] T032 Run all focused tests touched by T013-T029.
- [X] T033 Run `npm test`.
- [X] T034 Run `npm run test:full` before any PR/merge-readiness claim, per `CLAUDE.md` slow-path guidance.
- [X] T035 Run `npm run doctor:cache` if generated docs/skills, shared synced libs, runtime scripts, or packaged plugin copies changed.
- [X] T036 Run final Claude, Gemini, Grok, GLM, DeepSeek, and Kimi review on the completed audit/implementation and record evidence in `specs/171-provider-architecture-parity/final-review-results.md`.
- [X] T037 Produce final completion audit mapping every requirement, task, changed file, command, and reviewer verdict before any PR/merge-readiness claim.
- [X] T038 Record the post-final-review Claude custom-review packet-budget root cause as issue #173 after non-Claude adversarial approval, and update parity artifacts/tests so #171 distinguishes #172 broad packet work from #173's reproduced Claude subscription CLI gap.

## Dependencies

- Phase 2 blocks all implementation phases.
- US1 and US2 may run in parallel after T012 approval if they touch different test/docs files.
- US3 depends on US1 because the provider parity table must exist before Grok classification can be guarded.
- Final review depends on all implemented guardrails and local verification.

## MVP

MVP after the first external review is US1 plus the Grok audited fallback slice
in US3. Gemini and DeepSeek reviewers rejected a docs-only treatment of #159, so
runtime fallback work is now planned but still blocked until the revised
plan/tasks packet receives unanimous approval.
