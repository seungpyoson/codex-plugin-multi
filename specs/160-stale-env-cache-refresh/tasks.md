# Tasks: Refresh-Aware Direct API Credentials

**Input**: `specs/160-stale-env-cache-refresh/`
**Hard gate**: runtime implementation starts only after planning artifacts have
usable external approval or the operator explicitly narrows/waives that gate.

## Phase 1: Planning

- [x] T001 Confirm #160 is open and scoped to stale direct API credentials.
- [x] T002 Record current code behavior: cache fills missing env only.
- [x] T003 Create Speckit-style artifacts under `specs/160-stale-env-cache-refresh/`.
- [x] T004 Obtain external review of plan/spec/tasks artifacts.

## Phase 2: RED Tests

- [x] T005 [US1] Add doctor stale-env/cache-override RED test in `tests/smoke/api-reviewers.smoke.test.mjs`.
- [x] T006 [US2] Add no-cache and disabled-cache fallback source tests in `tests/smoke/api-reviewers.smoke.test.mjs`.
- [x] T007 [US3] Add approval auth path `credential_source` RED assertions in `tests/smoke/api-reviewers.smoke.test.mjs`.
- [x] T007A [US3] Add cache-rotation redaction RED test in `tests/smoke/api-reviewers.smoke.test.mjs`.

## Phase 3: Implementation

- [x] T008 [US1] Implement provider-neutral credential resolution metadata in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [x] T009 [US1] Make cache entries override stale process env for configured credential keys in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [x] T010 [US3] Project `credential_source` into doctor, run records, provider execution metadata, and approval auth paths in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [x] T011 [US3] Preserve redaction coverage for cache-sourced values in `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- [x] T011A [US3] Preserve redaction coverage for the selected credential snapshot when the cache changes before record rendering.

## Phase 4: Verification

- [x] T012 Run focused stale-env/cache tests.
- [x] T013 Run `npm run smoke:api-reviewers`.
- [x] T014 Run `npm test`.
- [x] T015 Run `npm run lint`.
- [x] T016 Run `git diff --check`.
- [x] T017 Obtain final latest-head external review.

## Phase 5: Adjacent Grok Auth Persistence Repair

- [x] T018 Reproduce the Grok stale-login class: temp-home CLI refresh can
  update runtime `auth.json` while durable `~/.grok/auth.json` remains stale.
- [x] T019 Add RED tests for source-bearing and source-free Grok CLI auth sync.
- [x] T020 Sync only refreshed regular-file `auth.json` back to the durable
  Grok home with `0600` temp-file write and atomic rename.
- [x] T021 Preserve source/session artifact isolation and expose auth-sync
  diagnostics in Grok run and doctor records.
- [x] T022 Verify `npm run smoke:grok` and live Grok doctor after a
  source-bearing Grok review.

## Phase 6: Adjacent Claude Session-Limit Retry Repair

- [x] T023 Reproduce Claude session-limit wording being classified outside the
  usage-limit path.
- [x] T024 Add RED unit coverage for `session limit` usage-limit detection and
  Claude dispatcher classification.
- [x] T025 Add RED smoke coverage proving the Claude permission-mode ladder does
  not retry a session-limit failure.
- [x] T026 Extend the shared usage-limit classifier and synced provider copies
  to recognize `session limit` wording.
- [x] T027 Verify focused unit tests, Claude smoke tests, `npm run lint`, and
  `git diff --check`.

## Phase 7: Provider Workload Admission RCA And Repair

- [x] T028 Reconstruct the 2026-05-27 Claude usage window from companion
  JobRecords and `.claude/projects` metadata without printing source or raw
  account values.
- [x] T029 Prove same-provider source-bearing overlap existed: local records
  show 6.78 MB of Claude selected source in the window, maximum concurrency of
  three, and two active Claude source-bearing jobs at the session-limit failure.
- [x] T030 Add RED unit coverage for provider workload lease acquisition,
  stale/dead lock reclamation, source-free bypass, and blocked execution shape.
- [x] T031 Implement `scripts/lib/review-workload.mjs` and synced reviewer
  packaging copies.
- [x] T032 Wire Claude, Gemini, Grok, Kimi, DeepSeek, and GLM launch paths so
  same-provider source-bearing reviews fail pre-target as
  `provider_workload_blocked` with `payload_sent:false`.
- [x] T033 Update smoke tests for same-provider Grok concurrency and per-test
  workload lock isolation.
- [x] T034 Verify focused workload tests and the Claude/API/Grok smoke suite
  before later identity-telemetry changes.

## Phase 8: Provider Account Identity Observability

- [x] T035 Prove the historical account gap: Claude `auth status --json` has
  account fields, while historical JobRecords and runtime diagnostics omitted
  account identity and cannot retroactively distinguish browser/CLI accounts.
- [x] T036 Add RED provider-neutral identity helper coverage for stable
  pseudonymous fingerprints and raw-value exclusion.
- [x] T037 Add RED JobRecord and Claude smoke coverage proving OAuth status and
  source-bearing run diagnostics include an account fingerprint without raw
  email/org/account values.
- [x] T038 Implement `scripts/lib/provider-identity.mjs`, synced reviewer
  packaging copies, JobRecord diagnostic normalization, and Claude OAuth status
  wiring.
- [x] T039 Verify focused identity/unit/sync/CPD tests and the two Claude smoke
  identity paths.
- [x] T040 Rerun final broad sync, unit, smoke, lint, and diff verification
  after identity telemetry (`npm run lint:sync`, focused unit/smoke slices,
  `npm run lint`, `git diff --check`, `npm test`).
## Phase 9: Source-Supplied Review Permission-Blocked Repair

- [x] T041 Reproduce the latest-head Claude retry failure class: source was
  supplied, but the prompt exposed the original absolute worktree path and the
  review profile allowed local read/search tool attempts.
- [x] T042 Add RED prompt/unit/smoke coverage proving review prompts withhold
  absolute repository paths, include a supplied-source-only instruction, and
  Claude review args disallow `Read`, `Glob`, and `Grep`.
- [x] T043 Implement shared review-prompt path withholding in
  `scripts/lib/review-prompt.mjs` and sync packaged reviewer copies.
- [x] T044 Align Claude and Gemini review-mode profile tables so review profiles
  disallow local read/search tools consistently.
- [x] T045 Verify focused prompt/profile/dispatcher/smoke tests, `npm run
  lint:sync`, `npm run smoke:claude`, and `git diff --check`.
- [ ] T046 Obtain final latest-head external review after all runtime and spec
  changes.

## Phase 10: Review-Quality EACCES Advisory False Positive Repair

- [x] T047 Reproduce the live Claude/Kimi final-review failure class where an
  approving source-supplied review mentioned workload-lock `EACCES`/`EPERM`
  behavior and was incorrectly marked `permission_blocked`.
- [x] T048 Add RED review-prompt regression coverage for workload-lock
  `EACCES` advisory wording and shared-tmp lock-root findings across all
  packaged reviewer copies.
- [x] T049 Tighten review-quality permission failure detection so code-under-
  review filesystem-error advisories do not count as reviewer permission
  failures while real selected-source read/inspect denials still fail.
- [x] T050 Verify focused review-prompt regression and full review-prompt unit
  coverage.
- [ ] T051 Rerun final latest-head external review after the classifier repair.

## Dependencies

1. T004 blocks runtime implementation unless waived by the operator.
2. T005-T007 are RED tests and must fail for the intended reason before T008.
3. T008-T011 are implementation tasks.
4. T012-T017 are original #160 completion gates.
5. T040-T051 are current completion gates for the expanded provider-reliability
   branch.
