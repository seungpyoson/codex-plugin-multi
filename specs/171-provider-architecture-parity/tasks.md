# Tasks: Provider Architecture Parity Audit

**Input**: `specs/171-provider-architecture-parity/`
**Hard gate**: no runtime implementation until `root-problems.md`, `spec.md`,
`plan.md`, and this task list have usable APPROVE verdicts from Claude, Gemini,
Grok, GLM, DeepSeek, and Kimi.

Current rule: all six providers use the same policy. A difference is allowed
only when an Adapter declares a capability fact and the shared policy consumes
that fact through the same field names and meanings.

## Phase 1: Freeze Scope

- [x] T001 Confirm #171 is the implementation issue and #170 is evidence input.
- [x] T002 Mark PR #175 completion/review claims as stale for corrected #171 scope.
- [x] T003 Record that no runtime implementation resumes before six approvals.

## Phase 2: Define The Root Problem

- [x] T004 Define the root problem in `root-problems.md`: missing shared Provider Policy Interface, not Claude-only usage, Kimi-only step limits, Grok-only login, or API-only DeepSeek/GLM.
- [x] T005 Define the Clear Reason Standard for allowed provider differences.
- [x] T006 Record why Grok login is not a separate issue yet: current doctor passes and exact failed-job context is missing.
- [x] T007 Record why Kimi step-limit/timeout is #171 evidence: source-bearing review lacks shared packet, capacity, timeout, and fallback policy.

## Phase 3: Shared Route Ladder

**Independent test**: one matrix covers Claude, Gemini, Kimi, Grok, DeepSeek,
and GLM through `subscription -> direct_api -> openrouter`.

- [x] T008 Record current route facts for Claude, Gemini, Kimi, Grok, DeepSeek, and GLM in `evidence-map.md`.
- [x] T009 Update `provider-parity-table.json` so API-only or subscription-only behavior is not marked complete.
- [x] T010 Define shared route fields in `data-model.md`: attempted, selected, skipped reason, fallback reason, auth path, billing path, error code, and suggested action.
- [x] T011 Add route-order and unsupported-route test plan in `quickstart.md`.

## Phase 4: Shared Source Packet Policy

**Independent test**: one over-budget source fixture produces same pre-send,
retry, resend, and review-surface semantics for every provider and mode.

- [x] T012 Record current packet behavior for all six providers in `evidence-map.md`.
- [x] T013 Include Kimi `step_limit_exceeded`, minimal-packet timeout, and stale task-review timeout as shared packet/capacity evidence.
- [x] T014 Define shared packet budget, retry, resend, and review-surface fields in `data-model.md`.
- [x] T015 Require provider prompt/byte/step/timeout/model/transport/auth limits to be Adapter capability facts.

## Phase 5: Issue Ownership

- [x] T016 Draft issue ownership in `issue-drafts.md` without creating GitHub issues.
- [x] T017 Keep Grok login under #171/#159 until exact failed-job evidence proves separate scope.
- [x] T018 Keep Kimi timeout/step-limit under #171/#172/#173 until post-policy evidence proves a Kimi-specific transport bug.
- [x] T019 Record that new issue creation requires root cause, duplicate check, and explicit operator approval.
- [x] T040 Convert proven Grok residual symptom into #176 in `issue-drafts.md`.
- [x] T041 Convert proven Kimi residual symptom into #177 in `issue-drafts.md`.

## Phase 6: External Review Before Implementation

**Independent test**: all six reviewers approve current root-problem/spec/plan/tasks.

- [x] T020 Record prior five approvals as directional, not final-current approval.
- [x] T021 Record Kimi usable approvals for `root-problems.md`, `spec.md`, and compact `plan.md`.
- [x] T022 Record Kimi failures/timeouts: full packet, provider table packet, old plan packet, and task packet.
- [x] T023 Obtain a usable Kimi verdict for this compact task list.
- [x] T024 Re-run final current-packet review across Claude, Gemini, Grok, GLM, DeepSeek, and Kimi.
- [x] T025 Stop implementation unless all six current reviewers approve.

## Phase 7: Implementation After Approval Only

- [x] T026 Add RED full-policy contract tests proving all six providers share the same field names and meanings for route, packet, readiness/auth, status/lifecycle, failure taxonomy, suggested action, review quality, audit, docs, and sync rules.
- [x] T027 Implement one shared Provider Policy Interface/facade that owns the full cross-cutting policy contract, not just route and packet helpers.
- [x] T028 Add RED route-ladder matrix tests for all six providers in `tests/unit/provider-route-policy.test.mjs`.
- [x] T029 Implement one shared route ladder Module through the Provider Policy Interface.
- [x] T030 Add Adapter capability facts for subscription, direct API, and OpenRouter.
- [x] T031 Add RED packet budget/resend tests for all six providers and all modes.
- [x] T032 Implement one shared source packet policy through the Provider Policy Interface.
- [x] T033 Wire shared route, packet, readiness/auth, failure/status, review-quality, audit, docs, and sync policy into provider launch paths.
- [x] T034 Update `provider-parity-table.json` and `data-model.md` to match the implemented full-policy slice.
- [x] T035 Sync packaged copies and generated docs through canonical scripts.
- [ ] T036 Address Grok login persistence only if Phase 5 proves separate scope.
- [x] T037 Address proven Kimi adapter compatibility: prompt-contained launch, no workspace tools, no `--add-dir`.
- [x] T038 Run focused tests, `git diff --check`, `npm run lint:sync`, `npm test`, and any changed generated-doc checks.
- [ ] T039 Run latest-head reviews from all six providers before merge-readiness.
- [ ] T042 Refresh exact-head review state after audit-only commits.
- [ ] T043 Refresh exact-head review state after Kimi prompt-only compatibility commit.

## Phase 8: #180 Follow-Up - Review Slot Disposition And Same-Packet Retry Guard

**Evidence**: #180 was opened after #171/#174/#175 left a shared-policy gap:
the repo has source-packet resend gates, but no provider-neutral retry
fingerprint, retry count, not-counted reason, or final slot disposition model.

- [x] T044 Record source-backed evidence in `evidence-map.md` for current
  launch/tracking surfaces: Claude/Gemini/Kimi `cmdRun`/`cmdContinue`, direct
  API reviewer, Grok web reviewer, `buildJobRecord`, `buildExternalReview`,
  `review-panel`, and `evaluateSourcePacketPolicy`.
- [x] T045 Update `data-model.md`, `spec.md`, `plan.md`, `tasks.md`, and
  `quickstart.md` with review-slot disposition, retry fingerprint, retry count,
  not-counted reason, waiver artifact, exact reviewed-head binding, and
  same-packet third-attempt fail-closed rule, including the shared interfaces
  `reviewSlotRetryFingerprint`, `evaluateReviewSlotRetryPolicy`,
  `buildReviewSlotDisposition`, and `redactReviewSlotDisposition`.
- [ ] T046 Obtain six-reviewer approval or explicit operator waivers for updated
  Phase 8 `spec.md`, `data-model.md`, `plan.md`, `tasks.md`, `quickstart.md`,
  and `evidence-map.md` before any RED runtime test or implementation begins.
  If planning docs change after a reviewer request-changes verdict, repeat the
  planning-review gate on the new exact head or record explicit waiver.
- [x] T047 Add RED provider-neutral tests for retry fingerprint construction and
  third same-packet retry blocking across all providers/modes. Required cases:
  `retry_count` 0 initial attempt, 1 first retry/second total attempt with
  `disposition: retry`, 2 third attempt blocked before launch, packet split or
  provider switch producing a new fingerprint, waiver/override artifact escape,
  failure-code/request-setting changes not resetting retry count, stale-head
  approvals excluded with `not_counted_reason: stale_head`, and pre-#180 parent
  records projecting null/unknown values without satisfying the new guard.
- [x] T048 Add RED contract/status tests proving JobRecord/external_review or
  audit metadata exposes slot id, parent attempt, source state, retry count,
  verdict, not-counted reason, and disposition without raw source/prompt/output,
  raw command args, or raw paths. Coverage must include audit manifest,
  JobRecord `review_metadata`, `external_review`, lifecycle/status events,
  review-panel rows, and direct API/OpenRouter approval/waiver/override
  artifacts.
- [x] T049 Implement shared retry/disposition helpers:
  `reviewSlotRetryFingerprint`, `evaluateReviewSlotRetryPolicy`,
  `buildReviewSlotDisposition`, and `redactReviewSlotDisposition`. Adapters may
  provide only capability facts and launch mechanics.
- [x] T050 Wire Claude/Gemini/Kimi continuation, DeepSeek/GLM direct API
  single-attempt slots, and Grok single-attempt slots through the same
  review-slot disposition model.
- [x] T051 Project disposition and retry state through review panel/status so a
  failed slot cannot remain silently pending or be counted as approval.
- [x] T052 Verify with focused tests, `npm run lint:sync`, `npm test`, and
  `npm run test:full` if shared runtime or packaged copies changed.
- [ ] T053 Run latest-head external reviews or record explicit operator waivers
  for failed review slots before claiming merge-readiness.

## Dependencies

1. Phases 1-5 define the problem and issue ownership.
2. Phase 6 blocks all implementation.
3. Phase 7 proceeds one issue at a time after six approvals.
4. Phase 8 is #180 follow-up work and must repeat the planning review gate
   before runtime implementation.

## MVP

MVP is the shared Provider Policy Interface plus route-ladder and packet-policy
tests proving exact policy parity across all six providers. Grok and Kimi
symptom fixes are separate only after evidence satisfies the Clear Reason
Standard.

## Phase 9: Relay Claude-Host Walking Skeleton

**Goal**: Add the smallest Claude-Code-host `relay-gemini` vertical slice while preserving the existing Codex suite unchanged.

**Independent test**: host-env unit tests, generated-artifact contract tests, Codex sync checks, and eventually a real Claude Code install/command-registration smoke.

- [x] T054 [US5] Add RED host-env tests for Claude Code detection, Claude plugin data root, and Claude session id mapping in `tests/unit/claude-env.test.mjs`. Evidence: RED failed with missing `scripts/lib/claude-env.mjs`.
- [x] T055 [US5] Implement `scripts/lib/claude-env.mjs` with `isClaudeCodeHost`, Claude plugin data root, and Claude session id helpers.
- [x] T056 [US5] Add relay build-plan contract tests for Claude `relay-gemini` manifest and command-token rendering in `tests/unit/relay-build-contracts.test.mjs`. Evidence: RED failed with missing `scripts/lib/relay-build.mjs`.
- [x] T057 [US5] Implement first relay build helper for Claude `relay-gemini` artifacts without modifying Codex `plugins/gemini/` output.
- [x] T058 [US5] Add containment/protected-mode contract test proving Claude command invocation carries prompt/source payload outside inline shell argv. Evidence: RED failed on inline `-- "<focus text>"`; GREEN passes with `--prompt-file "$RELAY_PROMPT_FILE"` and Gemini prompt-file smoke.
- [x] T059 [US5] Run focused verification: `node --test tests/unit/claude-env.test.mjs tests/unit/relay-build-contracts.test.mjs`; `node --test --test-name-pattern "gemini review foreground" tests/smoke/gemini-companion.smoke.test.mjs`. Evidence: 8/8 unit passed; 9/9 focused Gemini smoke passed.
- [x] T060 [US5] Run regression gates for touched shared sources: `npm run lint:sync` and `git diff --check`. Evidence: both passed; `npm test` passed 2474 tests (2462 passed, 12 skipped).

## Phase 10: Relay Gemini Artifact Emission

**Goal**: Materialize the first Claude-Code-host artifact so `relay-gemini` can be validated as a real plugin tree, not only a renderer helper.

**Independent test**: artifact-emission unit test, generated `relay/relay-gemini` tree inspection, `claude plugin validate`, Codex sync checks, and default tests.

- [x] T061 [US5] Add RED artifact-emission test proving `relay/relay-gemini` contains `.claude-plugin/plugin.json`, Claude command filenames, Gemini runtime scripts/config/policies, and no `.codex-plugin`. Evidence: RED failed with missing `buildRelayPlugin` export.
- [x] T062 [US5] Implement relay artifact builder and CLI script for `relay-gemini`.
- [x] T063 [US5] Generate `relay/relay-gemini` and validate it with `claude plugin validate relay/relay-gemini`. Evidence: `npm run build:relay -- gemini`; `claude plugin validate --strict relay/relay-gemini` passed; `claude --plugin-dir relay/relay-gemini plugin details relay-gemini` listed 7 components.
- [x] T064 [US5] Re-run focused tests, `npm run lint:sync`, `git diff --check`, and `npm test`. Evidence: 9/9 focused unit passed, 9/9 focused Gemini smoke passed, lint/diff passed, `npm test` passed 2475 tests (2463 passed, 12 skipped).

## Phase 11: Relay Suite Fan-Out

**Goal**: Emit the complete Claude relay provider suite after the `relay-gemini` skeleton proves the pattern.

**Independent test**: suite-emission unit tests, provider-specific command rewrite checks, Claude plugin validation/details for all emitted relay plugins, Codex sync checks, and default tests.

- [x] T065 [US5] Add RED suite-emission tests proving `relay-gemini`, `relay-grok`, `relay-kimi`, `relay-glm`, and `relay-deepseek` emit, while no `relay-claude` emits. Evidence: RED failed with missing `buildRelaySuite` export; GREEN emits exactly the five relay providers.
- [x] T066 [US5] Add RED command rewrite checks for Grok/Kimi/direct-API relay commands: no `CODEX_HOME`, no repo-relative `plugins/.../scripts`, no inline prompt argv, and direct APIs split by provider. Evidence: GREEN asserts no Codex-root, repo-relative runtime path, or inline prompt argv remains in rendered relay command docs.
- [x] T067 [US5] Implement suite builder fan-out and provider-specific command filtering. Evidence: `buildRelaySuite` emits `relay-gemini`, `relay-grok`, `relay-kimi`, `relay-glm`, and `relay-deepseek`; GLM/DeepSeek command filters split the shared direct-API source plugin by provider prefix.
- [x] T068 [US5] Add prompt-file CLI support for relay-used Grok, Kimi, and direct API reviewer launch paths. Evidence: Grok, Kimi, and API reviewer launch paths accept `--prompt-file`; focused companion and relay-build contract tests pass.
- [x] T069 [US5] Generate all relay plugins and validate/details each with Claude Code. Evidence: `npm run build:relay`; `claude plugin validate --strict relay/relay-{gemini,grok,kimi,glm,deepseek}` passed; `claude --plugin-dir relay/relay-<provider> plugin details relay-<provider>` listed components for all five.
- [x] T070 [US5] Re-run focused tests, `npm run lint:sync`, `git diff --check`, and `npm test`. Evidence: focused unit/companion tests passed; generated command scan found no forbidden strings; lint/diff passed; `npm test` passed 2478 tests (2466 passed, 12 skipped).
