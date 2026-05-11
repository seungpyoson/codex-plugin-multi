# Tasks: No-Mistakes Provider Readiness

**Input**: `specs/140-no-mistakes-provider-readiness/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `quickstart.md`

## Phase 1: Grok Default Startup MVP

- [X] T001 [US2] Add failing smoke test proving Grok `uv` spawn receives default writable `UV_CACHE_DIR` when caller omits it in `tests/smoke/grok-web.smoke.test.mjs`.
- [X] T002 [US2] Add smoke test proving explicit caller `UV_CACHE_DIR` is preserved in `tests/smoke/grok-web.smoke.test.mjs`.
- [X] T003 [US2] Implement Grok `uvExecutionEnv` default cache dir in `plugins/grok/scripts/grok-web-reviewer.mjs`.
- [X] T004 [US2] Verify `npm run smoke:grok`.

## Phase 2: Provider Manifest Harness

- [X] T005 [US1] Design CLI contract for six-provider readiness manifest.
- [X] T006 [US1] Add tests for manifest row failure classes and prompt-persistence checks.
- [X] T007 [US1] Implement manifest builder.
- [X] T008 [US1] Document synthetic fixture live-smoke process.

## Phase 3: Review Quality Repeatability

- [ ] T009 [US3] Add regression coverage for shallow/missing-verdict Kimi output as `review_not_completed`.
- [ ] T010 [US3] Add current-prompt-shape smoke replay fixture that passes review-quality gate.

## Phase 4: Final Gates

- [X] T011 Run `npm run lint`.
- [X] T012 Run relevant smoke tests.
- [X] T013 Run `npm run test:full`.
- [ ] T014 Push through no-mistakes gate before PR.
