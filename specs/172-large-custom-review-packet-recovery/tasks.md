# Tasks: Large Custom-Review Packet Recovery

**Input**: `specs/172-large-custom-review-packet-recovery/`
**Hard gate**: no runtime implementation until `spec.md`, `plan.md`,
`tasks.md`, `data-model.md`, `quickstart.md`, `evidence-map.md`,
`plan-review-results.md`, and `contracts/packet-recovery.schema.json` have
usable APPROVE verdicts from Claude, Gemini, Grok, GLM, DeepSeek, and Kimi.

## Phase 1: Setup And Evidence

- [x] T001 Confirm live issue matrix and selected target #172 in `specs/172-large-custom-review-packet-recovery/evidence-map.md`
- [x] T002 Record completed non-target slices #171/#173/#176/#177/#180 in `specs/172-large-custom-review-packet-recovery/evidence-map.md`
- [x] T003 Run focused baseline source-packet tests and record result in `specs/172-large-custom-review-packet-recovery/evidence-map.md`
- [x] T004 Create manual Speckit artifacts because `.specify/` is absent in `specs/172-large-custom-review-packet-recovery/`

## Phase 2: Planning Gate

- [x] T005 Obtain Claude approval for planning artifacts in `specs/172-large-custom-review-packet-recovery/`
- [x] T006 Obtain Gemini approval for planning artifacts in `specs/172-large-custom-review-packet-recovery/`
- [x] T007 Obtain Grok approval for planning artifacts in `specs/172-large-custom-review-packet-recovery/`
- [x] T008 Obtain GLM approval for planning artifacts in `specs/172-large-custom-review-packet-recovery/`
- [x] T009 Obtain DeepSeek approval for planning artifacts in `specs/172-large-custom-review-packet-recovery/`
- [x] T010 Obtain Kimi approval for planning artifacts in `specs/172-large-custom-review-packet-recovery/`
- [x] T011 Resolve any planning review blocker in `specs/172-large-custom-review-packet-recovery/` before runtime code
- [x] T012 Record planning review results and blocker disposition in `specs/172-large-custom-review-packet-recovery/plan-review-results.md`

## Phase 3: User Story 1 - Pre-Send Oversized Packets Produce Recovery Plan

**Independent test**: Direct API and Grok custom-review oversized preflight
failures emit `packet_recovery` and keep source `not_sent`; all providers use
the same schema and capability vocabulary.

- [x] T013 [US1] Add RED JSON-schema contract tests for valid/invalid `packet_recovery` objects in `tests/unit/docs-contracts.test.mjs`, including rejection of `resume_without_source_resend` when `provider_capabilities.supports_no_source_resume:false`
- [x] T014 [US1] Add RED no-secret/no-token invariant tests for `packet_recovery` in `tests/unit/provider-route-policy.test.mjs`
- [x] T015 [US1] Define provider recovery capability facts consumed by shared policy in `scripts/lib/provider-route-policy.mjs`
- [x] T016 [US1] Add RED shared unit tests for source-packet budget recovery in `tests/unit/provider-route-policy.test.mjs`
- [x] T017 [US1] Implement shared packet recovery helper in `scripts/lib/provider-route-policy.mjs`
- [x] T018 [US1] Add RED Direct API smoke test for `source_packet_too_large` recovery in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T019 [US1] Wire Direct API source-packet failure diagnostics in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T020 [US1] Add RED Grok smoke test for `source_packet_too_large` recovery in `tests/smoke/grok-web.smoke.test.mjs`
- [x] T021 [US1] Wire Grok source-packet failure diagnostics in `plugins/grok/scripts/grok-web-reviewer.mjs`
- [x] T022 [US1] Add companion conformance assertions for Claude/Gemini/Kimi recovery field names in `tests/smoke/claude-companion.smoke.test.mjs`, `tests/smoke/gemini-companion.smoke.test.mjs`, and `tests/smoke/kimi-companion.smoke.test.mjs`

## Phase 4: User Story 2 - Prompt Cap And Changed Surface Are Auditable

**Independent test**: prompt-cap sharding and diff/shard actions show changed
review surface and approval boundaries.

- [x] T023 [US2] Add RED Direct API prompt-cap test mirroring `sharding_plan` into `packet_recovery` in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T024 [US2] Implement Direct API prompt-cap `packet_recovery` projection in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T025 [US2] Add RED Grok prompt-cap recovery test in `tests/smoke/grok-web.smoke.test.mjs`
- [x] T026 [US2] Implement Grok prompt-cap `packet_recovery` projection in `plugins/grok/scripts/grok-web-reviewer.mjs`
- [x] T027 [US2] Add RED changed-review-surface approval-credit tests in `tests/unit/provider-route-policy.test.mjs`
- [x] T028 [US2] Add RED coverage-proof absence test showing shard/diff cannot count as full-source approval in `tests/unit/provider-route-policy.test.mjs`
- [x] T029 [US2] Implement review-surface approval-credit fields in `scripts/lib/provider-route-policy.mjs`

## Phase 5: User Story 3 - Failed Runtime Slots Stay Failed

**Independent test**: recovery metadata never turns failed/no-verdict/runtime
slots into approval.

- [x] T030 [US3] Add RED JobRecord/review-prompt failed-slot recovery source-of-truth tests in `tests/unit/job-record.test.mjs` and `tests/unit/review-prompt.test.mjs`
- [x] T031 [US3] Add RED JobRecord invariant test that top-level `error_code` matches `packet_recovery.reason` for packet recovery failures in `tests/unit/job-record.test.mjs`
- [x] T032 [US3] Add RED source-not-sent unchanged-packet retry test proving same current-session approval proof may be reused only when the approval tuple is unchanged in `tests/unit/provider-route-policy.test.mjs`
- [x] T033 [US3] Add RED review-panel projection test for failed-slot recovery in `tests/unit/review-panel.test.mjs`
- [x] T034 [US3] Implement JobRecord/review-prompt failed-slot `packet_recovery` source-of-truth and top-level `error_code` to `packet_recovery.reason` synchronization in shared review-prompt and record builders
- [x] T035 [US3] Implement source-not-sent unchanged-packet approval-proof reuse only when provider, mode, source packet, prompt hash, scope resolution, request settings, auth path, billing path, selected route, fallback reason, and approval scope are unchanged in `scripts/lib/provider-route-policy.mjs`
- [x] T036 [US3] Preserve failed-slot classification while rendering recovery action in `scripts/lib/review-panel.mjs`
- [x] T037 [US3] Add RED Direct API approval-tuple change test for recovery shard action in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T038 [US3] Add RED Direct API approval-request failure-before-token recovery test in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T039 [US3] Preserve fresh approval requirement for changed recovery tuples in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T040 [US3] Add RED source-sent same-packet resend-confirmation test covering `--allow-large-source-packet` interaction in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T041 [US3] Implement Direct API failure-before-token recovery projection and source-sent resend-confirmation/large-packet interaction in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T042 [US3] Add RED Grok runtime failure recovery smoke for CLI auto-fallback/no-verdict behavior in `tests/smoke/grok-web.smoke.test.mjs`
- [x] T043 [US3] Add RED Kimi packet-cap, source-sent missing-verdict/timeout/step-limit, and stale-job recovery projection tests in `tests/smoke/kimi-companion.smoke.test.mjs` and `tests/smoke/result-reconcile.smoke.test.mjs`
- [x] T044 [US3] Implement Grok runtime failure and CLI auto-fallback no-verdict `packet_recovery` projection in `plugins/grok/scripts/grok-web-reviewer.mjs`
- [x] T045 [US3] Implement Kimi packet-cap, source-sent terminal failure, and stale-job `packet_recovery` projection, including `provider_capabilities.supports_no_source_resume:false`, in `plugins/kimi/scripts/kimi-companion.mjs` and shared companion helpers

## Phase 6: Sync, Docs, And Verification

- [x] T046 Sync packaged provider copies if shared libraries changed via `npm run lint:sync`
- [x] T047 Add or extend RED sync tests in `tests/unit/plugin-copies-in-sync.test.mjs` so packaged provider copies must expose `packet_recovery`, recovery capabilities, and shared failure semantics
- [x] T048 Update operator docs for packet recovery in `README.md` or provider command docs only if canonical docs own this surface
- [x] T049 Update `specs/172-large-custom-review-packet-recovery/evidence-map.md` with implementation evidence and selected residual risks
- [x] T050 Run `git diff --check`
- [x] T051 Run `npm run lint:sync`
- [x] T052 Run targeted `node --test` commands covering touched tests
- [x] T053 Run `npm test` if shared runtime or packaged copies changed
- [x] T054 Run `npm run doctor:cache` if runtime scripts, generated docs/skills, shared synced libs, or packaged plugin copies changed

## Phase 7: Final Review Gate

Operator narrowed the final review gate for this implementation pass to Claude
and Grok only.

- [x] T055 Obtain Claude final whole-issue approval for current head
- [x] T057 Obtain Grok final whole-issue approval for current head
- [x] T061 Record final review results and residual risks in `specs/172-large-custom-review-packet-recovery/final-review-results.md`

## Dependencies

1. Phase 2 blocks all runtime implementation.
2. US1 defines the core recovery object before prompt-cap projection.
3. US2 extends recovery to changed surfaces.
4. US3 verifies approval/failure semantics.
5. Phase 6 verification precedes Phase 7 reviews.

## MVP

MVP is US1 plus the shared `PacketRecovery` contract and Direct API/Grok
pre-send recovery projection. US2 and US3 are required for #172 completion
because fallback surface and failed-slot semantics are explicit issue
requirements.
