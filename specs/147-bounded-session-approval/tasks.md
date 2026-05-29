# Tasks: Bounded Session Approval for Direct API Reviewers

**Input**: `specs/147-bounded-session-approval/`
**Prerequisites**: Pre-implementation review gate must approve this plan before TDD implementation starts.

## Phase 1: Setup

- [x] T001 Record pre-implementation external review results in `specs/147-bounded-session-approval/plan-review-results.md`
- [x] T002 Run focused baseline `npm run smoke:api-reviewers` and append results to `specs/147-bounded-session-approval/evidence-map.md`

## Phase 2: Foundational

- [x] T003 [P] Add docs-contract coverage for strict `specs/147-bounded-session-approval/contracts/session-approval-grant.schema.json` in `tests/unit/docs-contracts.test.mjs`
- [x] T004 [P] Add help/command contract expectations for `approval-grant request` and `approval-grant activate` in `tests/smoke/api-reviewers.smoke.test.mjs`

## Phase 3: User Story 1 - Create a Bounded Grant (P1)

**Goal**: A source-free grant request and activation flow exists.

**Independent Test**: Grant request and activation return source-free artifacts and persist no token/source/secret body.

- [x] T005 [US1] RED: Add failing grant request smoke test for source-free output, `approval_scope:"grant"`, `grant_bounds`, and `grant_approval_token` in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T006 [US1] GREEN: Add `approval-grant request` parsing and source-free response in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T007 [US1] RED: Add failing activation tests proving activation must reuse the request `grant_bounds.expires_at`, and normal session approval tokens and `approval_scope:"once"` tokens cannot create grants in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T008 [US1] GREEN: Add grant-scoped token validation and reject non-grant activation proofs in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T009 [US1] RED: Add failing persistence tests for strict schema shape, no top-level tuple duplicates, deterministic grant id, idempotent duplicate activation, and owner-only file mode where supported in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T010 [US1] GREEN: Persist active grant files under API reviewer data root with strict schema, deterministic id, exclusive create, and idempotent duplicate activation in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T011 [US1] Add privacy assertions for no source body, raw prompt body, token value, secret persistence, or sensitive mismatch diagnostics in grant files, JobRecords, lifecycle events, and errors in `tests/smoke/api-reviewers.smoke.test.mjs`

## Phase 4: User Story 2 - Reuse a Matching Grant (P1)

**Goal**: A matching grant authorizes a source-bearing Direct API run without per-run `--approval-token`.

**Independent Test**: Activate one grant, run the same command without token, and inspect JobRecord grant audit fields.

- [x] T012 [US2] RED: Add failing matching grant-approved run test in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T013 [US2] GREEN: Add active grant lookup and exact canonical tuple matching before approval-token rejection in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T014 [US2] RED: Add failing audit-manifest assertions for `approval_source:"session_grant"`, `approval_grant.grant_id`, `approval_grant.grant_session_id`, and safe selected-source/prompt hash evidence in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T015 [US2] GREEN: Add grant audit fields to Direct API JobRecord audit manifest in `plugins/api-reviewers/scripts/api-reviewer.mjs`

## Phase 5: User Story 3 - Reject Mismatches and Expiry (P1)

**Goal**: Grants fail closed for every out-of-bounds run and existing per-request approval still works.

**Independent Test**: Each mismatch fails before source send with `approval_required` and no launch event.

- [x] T016 [P] [US3] RED: Add provider and mode mismatch tests in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T017 [US3] GREEN: Enforce provider and mode allowlists in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T018 [P] [US3] RED: Add workspace, scope path, literal `scope_paths:null`, selected-source hash, and file/byte bound mismatch tests in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T019 [US3] GREEN: Enforce workspace, selected-source, scope-resolution, path-constraint, and file/byte bounds in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T020 [P] [US3] RED: Add prompt, request, auth, billing, selected route, route step, route steps, and fallback reason mismatch tests in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T021 [US3] GREEN: Enforce prompt/request/auth/billing/route tuple matching in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T022 [P] [US3] RED: Add expired, over-maximum TTL, schema-extra-field, top-level projection mismatch, tampered hash, timestamp format, canonical JSON determinism, and fingerprint mismatch tests in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T023 [US3] GREEN: Fail closed for expired, over-maximum TTL, schema-invalid, projection-mismatched, hash-tampered, timestamp-invalid, canonicalization-mismatched, and fingerprint-mismatched grants in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T024 [P] [US3] RED: Add multiple active matching grants and same-timestamp ambiguity tests in `tests/smoke/api-reviewers.smoke.test.mjs`
- [x] T025 [US3] GREEN: Fail closed when more than one active grant matches in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T026 [US3] RED/GREEN: Preserve existing per-request session and one-time approval-token paths outside grants, and reject grant-scoped tokens passed to normal `run --approval-token`, in `tests/smoke/api-reviewers.smoke.test.mjs`

## Phase 6: User Story 4 - Operator and Reviewer Clarity (P2)

**Goal**: Docs and contracts explain the grant workflow without implying broad Direct API bypass.

**Independent Test**: Help/docs tests prove grant commands and safety language are present.

- [x] T027 [P] [US4] Update CLI help output and command list in `plugins/api-reviewers/scripts/api-reviewer.mjs`
- [x] T028 [P] [US4] Update Direct API approval docs in `README.md`
- [x] T029 [P] [US4] Update generated contract source in `scripts/lib/external-model-contracts.mjs` if command/skill text changes
- [x] T030 [US4] Run sync commands required by generated contract changes and keep plugin copies in sync

## Phase 7: Verification and Review

- [x] T031 Run focused #147 smoke tests with RED/GREEN evidence recorded in `specs/147-bounded-session-approval/evidence-map.md`
- [x] T032 Run `npm run smoke:api-reviewers`
- [x] T033 Run `npm test`
- [x] T034 Run `npm run lint`
- [x] T035 Run `git diff --check`
- [x] T036 Run final external review and record usable verdicts in `specs/147-bounded-session-approval/final-review-results.md`
- [x] T037 Address final review findings with TDD if behavioral, then rerun affected verification
- [x] T038 Commit, push, and open PR for #147 after verification and review gates pass

## Dependencies

- T001 must complete before implementation tasks.
- T005 must fail before T006.
- T007 must fail before T008.
- T009 must fail before T010.
- T012 must fail before T013.
- T014 must fail before T015.
- T016/T018/T020/T022/T024 must each fail before their matching GREEN task.
- T027-T030 depend on stable behavior from US1-US3.
- T036 depends on T031-T035.

## Parallel Notes

- T003 and T004 can run in parallel.
- T016, T018, T020, T022, and T024 can be drafted independently but must be verified RED before implementation.
- T027-T029 can be drafted in parallel after behavior is green, then synced by T030.
