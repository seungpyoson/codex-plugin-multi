# Tasks: Grok CLI-Primary Transport Parity

**Input**: `specs/159-grok-cli-primary-parity/`
**Hard gate**: no runtime implementation until `spec.md`, `plan.md`, this task
list, and supporting artifacts have usable APPROVE verdicts from Claude, Gemini,
Grok, GLM, DeepSeek, and Kimi, or explicit operator waivers.

## Phase 1: Freeze Scope

- [x] T001 Confirm #159 is open and its original web-only statement is stale.
- [x] T002 Confirm #176 closed Grok CLI login readiness / auto-doctor fallback as a completed #159-adjacent slice.
- [x] T003 Record that #159 remaining scope is architecture parity, not adding CLI primary from scratch.
- [x] T004 Record non-goals: no paid xAI API fallback, no browser/session repair automation, no #172 large-packet recovery closure.

## Phase 2: Define The Root Problem

- [x] T005 Record root problem in `specs/159-grok-cli-primary-parity/evidence-map.md`: missing deep Grok transport Module Interface.
- [x] T006 Record data entities and invariants in `specs/159-grok-cli-primary-parity/data-model.md`.
- [x] T007 Record the selected deepening candidate and rejected alternatives in `specs/159-grok-cli-primary-parity/plan.md`.
- [x] T008 Record the proposed Module contract in `specs/159-grok-cli-primary-parity/contracts/grok-transport-adapter.md`.

## Phase 3: External Review Before Implementation

**Independent test**: implementation tasks remain unchecked until all required reviewers approve or the operator records explicit waivers.

- [x] T009 Run planning-packet review across Claude, Gemini, Grok, GLM, DeepSeek, and Kimi using `specs/159-grok-cli-primary-parity/spec.md`, `plan.md`, `tasks.md`, `evidence-map.md`, `research.md`, `data-model.md`, `contracts/grok-transport-adapter.md`, and `quickstart.md`.
- [x] T010 Stop implementation if any required reviewer returns request-changes, failed slot, no verdict, shallow output, timeout, or source-sent failure without explicit operator waiver.
- [x] T011 Record usable approvals or explicit waivers in `specs/159-grok-cli-primary-parity/review-results.md`.

## Phase 4: User Story 1 - Grok Transport Module Interface

**Goal**: Maintainers can inspect and test one Grok transport Module for CLI, web, and auto behavior.

**Independent test**: module-level tests prove default CLI, explicit web, legacy alias normalization, auto starts as CLI, prompt-budget cap names, and invalid transport failure.

- [x] T012 [US1] Add RED focused tests for Grok transport normalization, config, prompt budget env, default model env, timeout env, and legacy alias facts in `tests/unit/grok-transport-adapters.test.mjs`.
- [x] T013 [US1] Add RED focused tests for auto fallback eligibility, `source_sent` and `payload_sent` fallback ineligibility, early-error fallback record construction, and CLI diagnostics projection in `tests/unit/grok-transport-adapters.test.mjs`.
- [x] T014 [US1] Add RED focused tests proving direct API credential values do not influence default CLI, explicit web, or auto fallback config in `tests/unit/grok-transport-adapters.test.mjs`.
- [x] T015 [US1] Implement the Grok transport Adapter Module in `plugins/grok/scripts/lib/grok-transport-adapters.mjs`.
- [x] T016 [US1] Export only the Module Interface needed by the Grok runtime from `plugins/grok/scripts/lib/grok-transport-adapters.mjs`.

## Phase 5: User Story 2 - Runtime Uses The Module Without Behavior Drift

**Goal**: Existing Grok run, doctor, help, and JobRecord behavior remains unchanged while transport decisions come from the Module.

**Independent test**: existing Grok smoke tests pass without loosening assertions.

- [x] T017 [US2] Wire `plugins/grok/scripts/grok-web-reviewer.mjs` to use the transport Module for config selection and fallback config, deleting the redundant inlined transport normalization/config/fallback decision logic it replaces.
- [x] T018 [US2] Wire prompt-budget error cap names in `plugins/grok/scripts/grok-web-reviewer.mjs` through the transport Module.
- [x] T019 [US2] Wire auto fallback eligibility and CLI diagnostics projection in `plugins/grok/scripts/grok-web-reviewer.mjs` through the transport Module.
- [x] T020 [US2] Preserve existing `grok-companion.mjs` entrypoint behavior and generated skill/command references.
- [x] T021 [US2] Run `npm run smoke:grok`.

## Phase 6: User Story 3 - Reviewability And Guardrails

**Goal**: Reviewers can verify the architecture slice and safety guardrails without re-reading the full runtime.

**Independent test**: docs/contracts and sync tests prove the generic entrypoint, no-paid-fallback language, and transport Adapter contract remain in place.

- [x] T022 [US3] Add or update contract/sync assertions in `tests/unit/plugin-copies-in-sync.test.mjs` so the runtime consumes the Grok transport Module.
- [x] T023 [US3] Update docs or generated references only if implementation changes user-visible commands.
- [x] T024 [US3] Run `npm run lint:sync`.

## Phase 7: Final Verification And Review

- [x] T025 Run `npm test` and compare pass/fail/skip counts against the #159 baseline recorded in `specs/159-grok-cli-primary-parity/evidence-map.md`.
- [x] T026 Run `git diff --check`.
- [x] T027 Record local verification and implementation notes in `specs/159-grok-cli-primary-parity/review-results.md`.
- [x] T028 Run final implementation review across Claude, Gemini, Grok, GLM, DeepSeek, and Kimi, or record explicit operator waivers for unavailable slots.
- [x] T029 Record that the current branch head after the review only updates evidence/task files, then stop before push, PR, issue closure, merge, browser/session repair, cache sync, or billing/tier action unless separately approved.

## Dependencies

1. Phases 1-2 define evidence and scope.
2. Phase 3 blocks all runtime implementation.
3. Phase 4 creates the Module Interface.
4. Phase 5 wires runtime behavior through the Interface.
5. Phase 6 preserves reviewability and sync guardrails.
6. Phase 7 verifies and reviews latest-head implementation.

## MVP

MVP is the Grok transport Adapter Module plus tests proving default CLI,
explicit web, auto fallback eligibility, prompt-budget cap names, and fallback
diagnostics through one Interface, with existing Grok smoke behavior preserved.
