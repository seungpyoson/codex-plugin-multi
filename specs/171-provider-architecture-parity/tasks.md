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
- [ ] T037 Address Kimi transport/capacity only if Phase 5 proves separate scope.
- [x] T038 Run focused tests, `git diff --check`, `npm run lint:sync`, `npm test`, and any changed generated-doc checks.
- [ ] T039 Run latest-head reviews from all six providers before merge-readiness.
- [ ] T042 Refresh exact-head review state after audit-only commits.

## Dependencies

1. Phases 1-5 define the problem and issue ownership.
2. Phase 6 blocks all implementation.
3. Phase 7 proceeds one issue at a time after six approvals.

## MVP

MVP is the shared Provider Policy Interface plus route-ladder and packet-policy
tests proving exact policy parity across all six providers. Grok and Kimi
symptom fixes are separate only after evidence satisfies the Clear Reason
Standard.
