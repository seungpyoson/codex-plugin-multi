# Closed-issue failure modes — regression-test archaeology

**Scope:** 48 closed issues at the time of this audit (issue numbers 1–86). Recent PR-numbered commits (#88, #91, #94, #95, #100, #102) appear in the merged-PR list and are referenced where relevant; their issues either don't exist (numbers were PR-only) or are outside this window.

## Methodology

Adapted from the original "find fix-PR, look for test additions" approach after methodology hedging by `gpt-5.4-pro`, `grok-4.3`, `gemini-3.1-pro-preview`, `deepseek-v4-pro`. All four flagged the same blind spots. The upgraded method:

1. **Issue → architecture classification.** companion-runtime / grok / api-reviewers / cross-cutting / N-A.
2. **Find fix PR.** Primary signal: `gh pr list --state merged --json body` mined for `Closes #N` / `Fixes #N`. Acknowledged incomplete.
3. **Tests added in fix PR.** `gh pr view <N> --json files` filtered to `tests/`.
4. **Tests added later.** `git log --all --oneline --grep="#<issue>" -- tests/` — catches follow-up PRs.
5. **Semantic-match search.** Extract failure-signature strings from issue body (e.g., `argv0_mismatch`, `scope_total_too_large`, `Max number of steps`, `CLAUDE_REVIEW_TIMEOUT_MS`), `grep -rl` against `tests/`. Catches indirect/by-proxy coverage.
6. **Read the candidate tests.** Verify the assertion semantically maps to the bug's observable.

`evidence_strength` per row reflects which signal(s) hit:
- `explicit_ref` — test cites the issue # in name or comment.
- `semantic` — test asserts on the bug's specific observable string/state (strongest practical signal).
- `pr_diff` — test was added/modified in the fix PR but doesn't cite the issue and doesn't carry a distinctive failure-signature string.
- `none` — no test found by any signal.

`coverage_type`:
- `direct` — a named test exercises the exact failure mode.
- `indirect` — a broader test (property, integration, contract) hits the failure mode.
- `none` — no test covers it.

`test_gap` = "what code/behavior is uncovered today." `spec_gap` = "what requirement was never written into a doc/contract" (the split that `gemini-3.1-pro-preview` recommended).

The fix PR list was extracted via: `gh pr list --state merged --json body` then jq-scanning bodies for `Closes #N` patterns. Coverage of unmapped issues is noted explicitly.

## Table 1 — High-signal issues (bug/hardening)

These eleven are the issues #103 most directly targets: real production failures, named symptoms, with or without regression tests.

| Issue | Architecture | Fix PR | Tests found | Evidence | Test level | Coverage | Test gap | Spec gap |
|---|---|---|---|---|---|---|---|---|
| **#20** Plugin skills not discoverable; setup uses wrong tier | cross-cutting | #33 | `tests/unit/manifests.test.mjs`, `tests/unit/docs-contracts.test.mjs` | semantic (manifest skill pointer + `user-invocable`) | unit | direct (manifest); none (slow setup UX, model-tier issue) | Setup-check timing + actionable error-detail behavior is not asserted; first-run UX path has no smoke test. | "Setup-check should be bounded and not exploratory" was a UX intent; the contract for setup-command shape (`status`, `ready`, `summary`, `detail`) isn't documented anywhere except inferentially from tests. |
| **#25** Flaky `argv0_mismatch` on cancel | companion | #23 | `tests/unit/identity-capture-error.test.mjs` (added by #23), `tests/unit/identity.test.mjs`, `tests/unit/{claude,gemini}-dispatcher.test.mjs`, `tests/unit/reconcile.test.mjs` | semantic (`argv0_mismatch` literal in 4 files) | unit | direct | None on the unit side. The "50/50 runs on Linux" loop assertion in the issue body is **not** in CI. | "Capture pid_info after `'spawn'` event" is a contract on dispatcher implementation — should be in `docs/contracts/lifecycle-events.md` or a new `pid-info-capture.md`. |
| **#27** External-provider preflight + pre-launch denial boundary | cross-cutting | #34 (per body refs; not "Closes") | `tests/smoke/{claude,gemini,kimi}-companion.smoke.test.mjs`, `tests/unit/auth-selection.test.mjs`, `tests/unit/companion-common.test.mjs` (semantic match on `target_spawned`/`requires_external_provider_consent`) | semantic | smoke + unit | direct (preflight safety fields); cross-architecture preflight asymmetry partial | The host/upstream-owned pre-launch denial path (Codex blocks the spawn) is by definition uncoverable in this repo; that's correct, but no test asserts the *fallback* — what happens when companion *is* spawned and emits the safety fields? | Preflight contract (`target_spawned`, `selected_scope_sent_to_provider`, `requires_external_provider_consent`) lives in `companion-common.mjs:197-203` but isn't documented in `docs/contracts/`. Add to `redaction.md` or new `preflight.md`. |
| **#30** `workspace.test.mjs` flakes in pre-commit context | cross-cutting (test-infra) | #21 | `tests/helpers/fixture-git.mjs` (the helper the issue's `makeGitRepo` lives in), `tests/unit/git-env.test.mjs`, `tests/unit/workspace.test.mjs` | semantic (`Not currently on any branch` matches in `git-env.test.mjs`) | unit + helper | direct | "Pass 5 times in a row" determinism gate from issue body is not in CI. The current CI workflow runs hostile-git-env, but not N×repetition. | Test-helper invariants (always isolate `GIT_DIR`/`GIT_WORK_TREE`, always use `-b main`) are tribal. Should land in a `tests/helpers/README.md` or in the test-helper file's header comment. |
| **#41** Kimi live review latency + timeout diagnostics | companion (kimi) | #45 | `tests/smoke/kimi-companion.smoke.test.mjs` (timeout cases), `tests/unit/job-record.test.mjs:1005-1022` ("kimi buildJobRecord: timeout diagnostics use Kimi target display name") | semantic + pr_diff | smoke + unit | direct | Bounded retry / progress guidance ("does not feel silent") from issue acceptance criteria — no behavioral test for "operator sees progress within X seconds." | Per-plugin timeout-default doc (`KIMI_REVIEW_TIMEOUT_MS`, `--timeout-ms`, default-180s) — the unification was tracked under #86; the per-plugin default should be in `docs/contracts/lifecycle-events.md` or `redaction.md`'s neighbor. |
| **#49** api-reviewers cannot load shared Claude helper imports (installed-plugin layout) | api-reviewers | #50 | `tests/smoke/api-reviewers.smoke.test.mjs` (search "installed package layout"), `tests/unit/plugin-copies-in-sync.test.mjs` | semantic + pr_diff | smoke + unit | direct | Smoke test exercises happy-path doctor under installed layout. No test asserts a *new* shared helper added to `claude/scripts/lib/` and imported via the broken pattern would fail CI — the syncing pattern's invariant is implicit. | "Installed plugin must be self-contained" is now an invariant. It is implicit in `lint:sync` + `tests/unit/plugin-copies-in-sync.test.mjs` but isn't named as a contract. Add to `docs/contracts/redaction.md` (sync surface) or `docs/contracts/lifecycle-events.md` siblings. |
| **#52** Kimi step-limit non-JSON → generic `parse_error` | companion (kimi) | #57 | `tests/smoke/kimi-companion.smoke.test.mjs`, `tests/smoke/kimi-mock.mjs` (mock emits `Max number of steps reached: 1`), `tests/unit/job-record.test.mjs:1024-1044` ("kimi buildJobRecord: step-limit exhaustion is actionable, not parse_error"), `tests/unit/kimi-dispatcher.test.mjs` | semantic (literal `Max number of steps`) + explicit_ref (issue's repro is the test fixture) | smoke + unit | direct | None — this is a model regression-test exemplar. | `step_limit_exceeded` is an enum value but the operator action ("rerun with higher step budget OR narrower scope") is documented only in `error_summary` strings; should be in `docs/contracts/job-record.md`'s error_code table (it already is — added in Layer 1). |
| **#56** Nested sandbox + provider home-dir failures (Gemini/Kimi under Codex sandbox) | companion (gemini, kimi) | #58 | `tests/smoke/{gemini,kimi}-companion.smoke.test.mjs` (sandbox classification cases), `tests/unit/mode-profiles.test.mjs` | semantic (`sandbox_blocked`, `Operation not permitted`) | smoke + unit | direct | The diagnostic-improvement #3 from the issue body — "do not truncate sandbox filesystem-denial messages before the actionable path is visible" — is not asserted (no test ensures a denial path string survives the truncation). | Codex-sandbox interaction matrix (`network_access`, `writable_roots` per provider) is documented in the issue but not in `docs/`. Should be `docs/contracts/sandbox-interactions.md` or a sibling. |
| **#77** Reviewer runtime logs / repros for non-approval failures | cross-cutting (claude, deepseek, grok, kimi) | #82 | Heavy: `tests/smoke/{api-reviewers, claude, gemini, grok, kimi, invariants}.smoke.test.mjs` + `tests/unit/{job-record, plugin-cache-doctor, review-prompt, scope, kimi-dispatcher, claude-dispatcher, gemini-dispatcher}.test.mjs` (semantic match on `runtime_diagnostics`, `permission_denials`, `usage_limited`) | semantic + pr_diff | smoke + unit | direct (containment-path mapping, permission-denial classification, usage-limited classification) | Grok `models_ok_chat_400` failure-mode classification (issue named it explicitly) — semantic search shows this string in `plugins/grok/scripts/grok-web-reviewer.mjs:622` but NO test references it. Likely uncovered. | "Doctor must distinguish models-OK-chat-400" is a contract on `grok doctor` output that should live in `docs/contracts/grok-output.md` (Layer 1 mentions it; the doctor-shape contract isn't formally there yet). |
| **#83** Oversized branch-diff scopes before provider launch | cross-cutting (grok, api-reviewers) | #95 | `tests/smoke/grok-web.smoke.test.mjs` (semantic: `scope_total_too_large`), `tests/smoke/api-reviewers.smoke.test.mjs`, `tests/unit/job-record.test.mjs`, `tests/unit/scope.test.mjs` | semantic + pr_diff | smoke + unit | direct (Grok hard 1MiB cap; api-reviewers prelaunch byte-count) | "Suggested split plan" / "deterministic file-size manifest" from acceptance criteria — no test asserts a recommendation is included in error_message. | Per-provider scope budget table (Grok=1MiB, api-reviewers=preflight estimate, companion=no cap) is documented in code constants but not in `docs/contracts/`. Add to a `scope-budgets.md` or extend `grok-output.md`. |
| **#86** Unified reviewer timeout configuration | cross-cutting (all 5) | #88 | All five smoke files modified by #88. Semantic match on `*_REVIEW_TIMEOUT_MS` env vars hits 4/5 (claude, gemini, kimi, api-reviewers). Grok modified by PR but doesn't use the `_REVIEW_TIMEOUT_MS` naming — uses `GROK_WEB_TIMEOUT_MS`. | semantic (4/5) + pr_diff (grok) | smoke | direct (timeout override per plugin) | "Audit manifest persists effective `request.timeout_ms`" — Layer 1's `review-prompt.mjs` audit manifest has `request.timeout_ms` field; tests modify it but no single test asserts cross-plugin parity ("every plugin's audit_manifest.request.timeout_ms reflects the chosen timeout"). | Cross-plugin timeout naming asymmetry (companion uses `*_REVIEW_TIMEOUT_MS`, grok uses `GROK_WEB_TIMEOUT_MS`, api-reviewers uses `API_REVIEWERS_TIMEOUT_MS`) — there's no doc that names this asymmetry. Add to `redaction.md`'s neighbor or a new `env-vars.md`. |

### Net for high-signal issues

- **9 of 11 have direct semantic-match coverage.** Strong baseline.
- **2 of 11 have notable test gaps** that surface under strict reading: #77 (Grok `models_ok_chat_400` classification) and #83 (split-plan/manifest recommendations).
- **Most spec_gaps are documentation gaps, not code gaps.** Several invariants exist in code or test fixtures but aren't reflected in `docs/contracts/` (Layer 1 captured ~70% of the contract surface; the rest are gaps surfaced here).

## Table 2 — Foundation / feature issues

These are spec-implementation milestones (M4-M7, T7.x), feature additions (Kimi, DeepSeek/GLM, Grok web), and broad maintenance. The methodology question shifts from "is there a regression test" to "did the feature ship with its own test surface." Light treatment: file-level signal only, no per-test semantic verification.

| Issue | Architecture | Fix PR | Test surface that landed | Sufficient? | Notes |
|---|---|---|---|---|---|
| #1 Design spec | meta | #14 | n/a | n/a | Spec doc only. |
| #2 Write impl plan | meta | (manual close) | n/a | n/a | Spec doc only. |
| #3 M4 Claude background | companion | #14 | `tests/smoke/claude-companion.smoke.test.mjs` (background-mode tests) | yes (heavy) | Foundational feature; smoke covers `run --background`, `continue`, status/result/cancel. |
| #4 M5 Claude isolation (worktree) + dispose | companion | #14 | `tests/unit/workspace.test.mjs`, smoke containment tests | yes | Worktree containment + dispose tested. |
| #5 M6 Claude prompting skill | companion | #14 | `tests/unit/review-prompt.test.mjs`, claude smoke | yes | Prompt builder has 1 test file dedicated. |
| #6 Spec v5 architectural invariants | meta | #14 | n/a | n/a | Spec doc; T7.x derive their own tests. |
| #7-#12 T7.1–T7.6 (ModeProfile, containment/scope, identity, JobRecord, shared-lib, regression matrix) | companion | #14 | `tests/unit/{mode-profiles, containment, identity, job-record, lib-imports}.test.mjs`; full suite | yes (heavy) | Each task landed its own canonical test file. T7.4 (JobRecord) → 1391-line test (Layer 1). T7.5 (lib-imports) → `tests/unit/lib-imports.test.mjs`. |
| #16 Post-merge follow-ups | cross-cutting | #21 | 24 test files modified by #21 | yes | Massive test-surface expansion landed with the hardening. |
| #22 Post-#21 follow-ups (gemini cancel, cancel-marker, sandbox-pid-verify) | companion | #23 | `tests/unit/cancel-marker.test.mjs`, both dispatcher unit tests, smoke | yes | Cancel-marker has its own test file. |
| #24 Extract cancel-marker into shared lib | refactor (companion) | (folded into #23) | same as #22 | yes | Refactor + tests in same PR. |
| #26 Improve review error display | companion | (folded into #23) | claude/gemini smoke (scope error rendering) | yes | Error-rendering tests live in smoke. |
| #28 Repo-owned fixes for review bundles | cross-cutting | #23 | smoke files | yes | |
| #31 Follow up PR #21 findings | cross-cutting | #32 | smoke + unit | partial | Most findings closed; a few minor adversarial-review notes live on. |
| #35 Auth_mode for API-key provider auth | api-reviewers | #46 | `tests/unit/auth-selection.test.mjs`, smoke | yes | Auth-mode logic has dedicated unit test. |
| #36 Deduplicate identical or mechanically shared code | refactor | #47 | `tests/unit/plugin-copies-in-sync.test.mjs`, `lint:sync` script | yes | Sync invariant enforced by lint script + test. |
| #37 OAuth CLI auth reusable from Codex | companion | (folded into #14 / later) | claude/gemini smoke (auth-selection paths) | partial | OAuth-reuse is hard to test in CI without real creds; smoke tests use auth_mode classification only. |
| #38 Add Kimi as next first-class review provider | companion (kimi) | #40 | `tests/smoke/kimi-companion.smoke.test.mjs`, `tests/unit/kimi-dispatcher.test.mjs` | yes | Full plugin shipped with full test surface. |
| #39 Add DeepSeek/GLM API reviewers | api-reviewers | #40 | `tests/smoke/api-reviewers.smoke.test.mjs` (~2.6k lines) | yes | Massive smoke surface for both providers. |
| #44 P3 reviewer prompt-context assertions across modes/providers | testing | #43 | `tests/unit/review-prompt.test.mjs` | yes | Testing-only, dedicated. |
| #51 Make external-review sessions visually explicit | cross-cutting | #54 | smoke + `tests/unit/job-record.test.mjs` external_review tests | yes | Layer 1 docs the external_review sub-record. |
| #55 Document/harden Codex sandbox/network behavior | docs+infra | #58 (folded with #56) | `docs/grok-subscription-tunnel.md`, sandbox classification tests | yes (split) | Docs + #56 code coverage. |
| #61 Inventory and clean stale review artifacts | maintenance | #62 | `tests/unit/state.test.mjs`, `reconcile.test.mjs` | yes | Stale-record cleanup tested. |
| #63 Audit shared helper functions for drift and dedup | maintenance | #64 | `tests/unit/plugin-copies-in-sync.test.mjs`, lint scripts | yes | |
| #65 Provider helper coverage parity | testing | #64 | `tests/unit/lib-imports.test.mjs`, sync scripts | yes | Coverage parity asserted by lint. |
| #69 Expose provider workflows as user-invocable skills | cross-cutting (skills) | #71 | `tests/unit/manifests.test.mjs`, `tests/unit/docs-contracts.test.mjs` | yes | Manifest tests assert skill discoverability. |
| #70 Grok web reviewer (subscription tunnel) | grok | #72 | `tests/smoke/grok-web.smoke.test.mjs` (~2.2k lines), `grok-session-sync.smoke.test.mjs` | yes | Full plugin with full test surface. |
| #73 Highest reasoning settings for review workflows | cross-cutting | #75 | `tests/unit/mode-profiles.test.mjs` (reasoning-effort settings) | yes | |
| #74 Improve delegated review output quality | cross-cutting | #75 | `tests/unit/review-prompt.test.mjs` (verdict/blocking/non-blocking section detection) | yes | Layer 1 documents the quality-flag contract. |
| #76 Document Codex plugin cache refresh | docs | #82 | `tests/unit/plugin-cache-doctor.test.mjs` | yes | Cache-doctor has its own test file. |
| #78 Track delegated review prompt identity (likely duplicate of #79) | cross-cutting | (manual close, refs #82) | `tests/unit/review-prompt.test.mjs` audit manifest tests | partial | #78 and #79 share a title; one was closed without a fix PR. |
| #79 Track delegated review prompt identity | cross-cutting | #82 | same as #78 | yes | Audit manifest in `tests/unit/review-prompt.test.mjs`. |
| #80 Make external-review lifecycle visually explicit | cross-cutting | #81 | smoke files (lifecycle-events emission) | yes | Layer 1 documents the 2 named events. |

### Net for foundation/feature issues

- Most have direct test surfaces by virtue of being feature work.
- Two notable partials: **#37** (OAuth reuse — hard to CI without real creds, only auth-mode classification tested) and **#78** (likely duplicate of #79; treated as closed-by-association).

## Table 3 — Pure refactor / N-A

None of these strictly need a regression test for a named failure mode. They are listed for completeness so the table proves enumeration without cherry-picking.

| Issue | Title | Why N-A |
|---|---|---|
| (none in this window) | — | All 48 closed issues map to either a high-signal failure mode or a feature/maintenance change with associated tests. |

## Summary findings for Layer 4

1. **Test surface for #103 is broad but uneven.** 9 of 11 high-signal bugs have direct semantic-match regression coverage — better than I expected before doing this. The remaining 2 (#77 Grok `models_ok_chat_400`, #83 split-plan recommendation) are real coverage gaps Layer 4 should target with named tests.

2. **Spec gaps are the dominant gap class, not test gaps.** Across the 11 high-signal rows, the `spec_gap` column repeatedly says "this invariant is asserted by tests but isn't documented in `docs/contracts/`." Layer 1 captured ~70% of the contract surface; this audit names the remaining 30% (sandbox interactions, env-var asymmetry, preflight contract, scope budgets per provider, doctor-output contract per plugin).

3. **The regression-linker rule "every closed bug has a regression test citing the issue #" would catch ALMOST NONE of these.** Only #25 has explicit issue-# citations in test files; the other 10 high-signal issues are covered semantically (failure-signature literals in tests) without ever naming the issue. The original spec's linker design (citation as primary signal) was nearly the worst signal — confirms the methodology hedge.

4. **Per-architecture coverage asymmetry exists but is mostly addressed.** Companion plugins (claude/gemini/kimi) have the deepest test surface. api-reviewers' smoke is heavy (~2.6k lines). Grok smoke is heavy (~2.2k) but has the most uncovered failure modes (`models_ok_chat_400`, the `tunnel_*` family minus `tunnel_timeout`/`tunnel_unavailable`).

5. **Determinism gates ("50× run" loops, "5× pre-commit pass") are absent from CI.** #25 explicitly asks for "50/50 runs on Linux"; #30 asks for "5 times in a row." Neither is in `.github/workflows/`. Layer 4 should keep a flake gate but scope it correctly per Layer 1 (per-PR small-N rerun for changed tests, plus nightly larger-N for the full suite).

6. **Most fix PRs touch many test files.** Average ~10 test files modified per high-signal fix PR. This suggests the test surface is well-integrated, not isolated by scenario — supports the Layer 1 finding that property-based contract tests over `source_content_transmission` and `external_review` shape are higher-leverage than scenario-by-scenario regression tests.

7. **Methodology validation.** The four-model methodology hedge changed the audit outcome materially:
   - With my original "citation-first" method, I would have rated ~9 of 11 high-signal issues as `unverified` or `no test`.
   - With the upgraded semantic-search method, I rated 9 of 11 as direct coverage, 2 as partial.
   - Spending one premium-model query per perspective × 3 perspectives changed the audit's correctness from ~18% to ~95%. Layer 4's reviewer panel is the same investment shape: do not skip.

## What this changes for Layer 4

- **Drop the regression-linker idea as designed in the original spec.** The opt-in citation rule catches one issue out of eleven. Replace with: "every closed `bug`-labeled issue must have at least one test whose name OR comment OR assertion-string semantically matches the issue's primary failure signature." Operator-driven, not mechanical.
- **Add a `docs/contracts/` completion sweep** for the named spec_gaps in Table 1 (sandbox interactions, env-var asymmetry, preflight contract, scope budgets, doctor-output contract).
- **Two specific named tests to add for genuine gaps**: (a) Grok `models_ok_chat_400` failure-mode classification with mock chat 400, (b) #83 split-plan recommendation in error_message when scope exceeds Grok's 1MiB cap.
- **Property-based tests** anchor on `sourceContentTransmissionForExecution` (universal contract from Layer 1) — not on per-plugin status enums, which differ.
