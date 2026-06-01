# Issue 144 Tasks

## Phase 1: Rescue Proposal

- [ ] T001 [US1] Add a RED smoke test in `tests/smoke/api-reviewers.smoke.test.mjs` proving `run --provider deepseek --mode rescue` returns a completed patch proposal, leaves the workspace unchanged, and records `mutations: []`.
- [ ] T002 [US1] Implement minimal capability-gated `rescue` mode in `plugins/api-reviewers/scripts/api-reviewer.mjs` and `plugins/api-reviewers/config/providers.json`.
- [ ] T003 [US1] Add `plugins/api-reviewers/scripts/lib/api-rescue-patch.mjs` with proposal parsing, validation, patch hashing, and proposed-file extraction.
- [ ] T004 [US1] Wire rescue prompt construction in `plugins/api-reviewers/scripts/api-reviewer.mjs` so provider output is a patch proposal, not an approval or direct edit.
- [ ] T005 [US1] Run the focused US1 test and keep it green before adding the next test.

## Phase 2: Read-Only Preservation

- [ ] T006 [US2] Add a RED smoke test proving `review`, `adversarial-review`, and `custom-review` ignore patch-looking provider output and still record no structured rescue proposal or mutations in `tests/smoke/api-reviewers.smoke.test.mjs`.
- [ ] T007 [US2] Restrict rescue proposal parsing to `mode === "rescue"` in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [ ] T008 [US2] Run the focused US2 test plus the US1 test.

## Phase 3: Parse And Apply Failure Gates

- [ ] T009 [US3] Add a RED smoke test proving malformed rescue output fails closed with `error_code: rescue_patch_parse_failed`, `source_content_transmission: sent`, and no mutations.
- [ ] T010 [US3] Implement rescue parse-failure JobRecord handling in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [ ] T011 [US3] Add a RED smoke test proving `apply-request --job-id <rescue_job_id>` fails for missing, non-rescue, failed, or malformed proposal jobs without source send.
- [ ] T012 [US3] Implement source-free `apply-request` token generation and patch preflight in `plugins/api-reviewers/scripts/api-reviewer.mjs` using `api-rescue-patch.mjs`.
- [ ] T013 [US3] Add a RED smoke test proving `apply --job-id <rescue_job_id>` rejects missing/invalid apply approval and dirty worktrees without applying a patch.
- [ ] T014 [US3] Implement apply token validation, clean-worktree guard, and fail-closed apply rejection in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [ ] T015 [US3] Run all focused US3 tests plus earlier US1/US2 tests.

## Phase 4: Successful Apply And Mutation Reporting

- [ ] T016 [US4] Add a RED smoke test proving a successful approved apply changes the expected file and persists an apply JobRecord with `parent_job_id`, `mode: rescue-apply`, `source_content_transmission: not_sent`, patch hash, and after-apply mutations.
- [ ] T017 [US4] Implement `git apply --check`, `git apply`, before/after `git status --short`, and apply JobRecord persistence in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [ ] T018 [US4] Add a RED smoke test proving failed patch apply records failed apply state and leaves files unchanged.
- [ ] T019 [US4] Implement failed apply diagnostics and no-mutation guarantees in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [ ] T020 [US4] Run the full direct API focused smoke set for all rescue slices.

## Phase 5: Generated Surfaces And Docs

- [ ] T021 [US5] Add RED contract tests proving DeepSeek/GLM generated command and skill surfaces include rescue only through generator-owned files.
- [ ] T022 [US5] Extend `scripts/lib/external-model-contracts.mjs` for direct API rescue commands/skills and regenerate synced artifacts.
- [ ] T023 [US5] Update `README.md`, `docs/artifact-cleanup-inventory.md`, and any contract docs to distinguish API-backed review, API-backed rescue proposal, approved local apply, and manual relay.
- [ ] T024 [US5] Run `node --test tests/unit/docs-contracts.test.mjs tests/unit/plugin-copies-in-sync.test.mjs tests/unit/relay-build-contracts.test.mjs tests/unit/codex-relay-build-contracts.test.mjs`.

## Phase 6: Verification And Review Gates

- [ ] T025 Run `npm run lint:sync`.
- [ ] T026 Run `npm run smoke:api-reviewers`.
- [ ] T027 Run `npm run lint`.
- [ ] T028 Run `npm test` if targeted smoke and lint indicate broad shared-surface risk.
- [ ] T029 Run `git diff --check`.
- [ ] T030 Obtain six-model final whole-work approval from Claude, Gemini, Grok, DeepSeek, GLM, and Kimi before opening the PR.
- [ ] T031 Open one PR for issue #144, wait for CI, address all PR comments, and stop before merge.

## Dependencies

- US1 before US2-US4.
- US3 before US4.
- US5 after runtime behavior exists.
- Phase 6 after all implementation slices are green.

## Independent Test Criteria

- US1: A direct API rescue run can produce a patch proposal without applying it.
- US2: Existing review modes remain read-only even when provider output contains a patch.
- US3: Bad proposals and unapproved apply attempts fail closed without mutation.
- US4: Approved apply records exact local mutations and failed apply leaves files unchanged.
- US5: User-facing surfaces expose rescue consistently and only through generated contracts.
