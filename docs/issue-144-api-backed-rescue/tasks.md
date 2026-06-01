# Issue 144 Tasks

Execute these tasks as TDD vertical slices: one RED behavior test, the smallest GREEN implementation, focused verification, then the next slice. Do not batch all RED tests before implementation.

## Phase 1: Rescue Proposal

- [ ] T001 [US1] Add a RED smoke test in `tests/smoke/api-reviewers.smoke.test.mjs` proving `run --provider deepseek --mode rescue` returns a completed patch proposal, leaves the workspace unchanged, persists inert `verification` commands, and records `mutations: []`.
- [ ] T002 [US1] Implement minimal capability-gated `rescue` mode in `plugins/api-reviewers/scripts/api-reviewer.mjs` and `plugins/api-reviewers/config/providers.json`.
- [ ] T003 [US1] Add `plugins/api-reviewers/scripts/lib/api-rescue-patch.mjs` with proposal parsing, schema-version validation, patch hashing, proposed-file extraction, and inert verification-command persistence.
- [ ] T004 [US1] Add a RED smoke test proving `approval-request --provider deepseek --mode rescue` discloses external rescue patch proposal source send, not review approval or direct editing.
- [ ] T005 [US1] Wire rescue prompt construction and approval disclosure in `plugins/api-reviewers/scripts/api-reviewer.mjs` so provider output is a patch proposal, never an approval.
- [ ] T006 [US1] Add a RED smoke test proving a provider with `capabilities.rescue !== true` rejects `approval-request --mode rescue` and `run --mode rescue` before source selection or source transmission.
- [ ] T007 [US1] Implement provider rescue capability rejection before source-send approval lookup or source packet construction.
- [ ] T008 [US1] Run focused US1 tests and keep them green before adding the next behavior.

## Phase 2: Read-Only Preservation

- [ ] T009 [US2] Add a RED smoke test proving `review`, `adversarial-review`, and `custom-review` ignore patch-looking provider output and still record no structured rescue proposal or mutations.
- [ ] T010 [US2] Restrict rescue proposal parsing to `mode === "rescue"` in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [ ] T011 [US2] Run the focused US2 test plus the US1 tests.

## Phase 3: Parse And Safety Gates

- [ ] T012 [US3] Add a RED smoke test proving malformed rescue output fails closed with `error_code: rescue_patch_parse_failed`, `source_content_transmission: sent`, and no mutations.
- [ ] T013 [US3] Implement rescue parse-failure JobRecord handling in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [ ] T014 [US3] Add RED smoke tests proving `apply-request --job-id <rescue_job_id>` fails without emitting a token for missing, non-rescue, failed, malformed, stale, dirty-worktree, or unsafe-job-id jobs.
- [ ] T015 [US3] Add RED smoke tests proving `apply-request` rejects unsafe patch proposals before token emission: parent traversal, absolute path, `.git/` path, outside-workspace path, Windows drive/UNC path, binary patch, symlink-creating diff, gitlink/submodule diff, mode-only diff, unsupported rename/copy, and denied runtime/policy paths.
- [ ] T016 [US3] Implement source-free `apply-request` token generation, clean-worktree guard, safe job ID validation, and non-mutating patch preflight in `plugins/api-reviewers/scripts/api-reviewer.mjs` using `api-rescue-patch.mjs`.
- [ ] T017 [US3] Add stable error-code assertions for `rescue_patch_unsafe_path`, `rescue_patch_binary_unsupported`, `rescue_patch_unsupported_file_change`, `rescue_apply_job_not_found`, and `rescue_apply_not_rescue_job`.
- [ ] T018 [US3] Run all focused US3 tests plus earlier US1/US2 tests.

## Phase 4: Apply Approval And Failure Guards

- [ ] T019 [US4] Add a RED smoke test proving `apply --job-id <rescue_job_id>` rejects missing, invalid, expired, and dirty-worktree apply approval without applying a patch.
- [ ] T020 [US4] Add a RED smoke test proving a one-time apply token is rejected on the second use after either successful apply or failed apply.
- [ ] T021 [US4] Add a RED smoke test proving HEAD drift between `apply-request` and `apply` rejects with `error_code: rescue_apply_head_mismatch` and leaves files unchanged.
- [ ] T022 [US4] Implement source-free apply token validation, token nonce/expiry, token consumption, current-HEAD comparison, clean-worktree guard, and fail-closed rejection in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [ ] T023 [US4] Add stable error-code assertions for `rescue_apply_approval_required`, `rescue_apply_token_invalid`, `rescue_apply_token_reused`, `rescue_apply_token_expired`, `rescue_apply_head_mismatch`, and `rescue_apply_dirty_worktree`.
- [ ] T024 [US4] Run focused apply-guard tests plus earlier US1-US3 tests.

## Phase 5: Successful Apply And Mutation Reporting

- [ ] T025 [US5] Add a RED smoke test proving a successful approved apply changes only the expected file and persists an apply JobRecord with `parent_job_id`, `mode: rescue-apply`, `source_content_transmission: not_sent`, patch hash, applied files, `structured_output.apply.state: applied`, and after-apply mutations.
- [ ] T026 [US5] Implement `git apply --check`, target-path snapshots, `git apply`, before/after `git status --short`, untracked-file mutation capture, and apply JobRecord persistence.
- [ ] T027 [US5] Add a RED smoke test proving failed patch apply records `failed_clean` or `failed_rolled_back` and leaves target files unchanged.
- [ ] T028 [US5] Add a RED smoke test proving rollback failure records `failed_dirty` or `rescue_apply_rollback_failed` without claiming a clean no-mutation failure.
- [ ] T029 [US5] Implement failed apply diagnostics, rollback handling, and `structured_output.apply.state` enum persistence.
- [ ] T030 [US5] Run the full direct API focused smoke set for all rescue slices.

## Phase 6: Generated Surfaces And Docs

- [ ] T031 [US6] Add RED contract tests proving DeepSeek/GLM generated command and skill surfaces include rescue only through generator-owned files when capability is true.
- [ ] T032 [US6] Add RED contract tests proving generated surfaces hide rescue when direct API rescue capability is false.
- [ ] T033 [US6] Extend `scripts/lib/external-model-contracts.mjs` for direct API rescue proposal/apply commands and regenerate synced artifacts.
- [ ] T034 [US6] Add RED help-output coverage proving `api-reviewer --help` exposes `apply-request` and `apply` with source-free apply language.
- [ ] T035 [US6] Update `README.md`, `docs/artifact-cleanup-inventory.md`, and any contract docs to distinguish API-backed review, API-backed rescue proposal, approved local apply, and manual relay.
- [ ] T036 [US6] Run `node --test tests/unit/docs-contracts.test.mjs tests/unit/plugin-copies-in-sync.test.mjs tests/unit/relay-build-contracts.test.mjs tests/unit/codex-relay-build-contracts.test.mjs`.

## Phase 7: Verification And Review Gates

- [ ] T037 Run `npm run lint:sync`.
- [ ] T038 Run `npm run smoke:api-reviewers`.
- [ ] T039 Run `npm run lint`.
- [ ] T040 Run `npm test` if targeted smoke and lint indicate broad shared-surface risk.
- [ ] T041 Run `git diff --check`.
- [ ] T042 Obtain six-model final whole-work approval from Claude, Gemini, Grok, DeepSeek, GLM, and Kimi before opening the PR.
- [ ] T043 Open one PR for issue #144, wait for CI, address all PR comments, and stop before merge.

## Dependencies

- US1 before US2-US5.
- US3 before US4-US5.
- US4 before US5.
- US6 after runtime behavior exists.
- Phase 7 after all implementation slices are green.

## Independent Test Criteria

- US1: A direct API rescue run can produce a patch proposal without applying it, and source-send disclosure is accurate.
- US2: Existing review modes remain read-only even when provider output contains a patch.
- US3: Bad proposals, unsafe patches, dirty worktrees, and unsafe job IDs fail closed before apply-token emission.
- US4: Unapproved, stale, reused, expired, dirty, or HEAD-drifted apply attempts fail closed without mutation.
- US5: Approved apply records exact local mutations, failed apply leaves files unchanged or reports failed rollback truthfully, and provider verification commands remain inert.
- US6: User-facing surfaces expose rescue consistently, source-free apply is documented, and capability-false providers do not expose rescue.
