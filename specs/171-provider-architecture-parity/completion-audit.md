# Completion Audit

Date: 2026-05-25
Repo: `/Users/spson/Projects/Claude/codex-plugin-multi`
Worktree: `/Users/spson/Projects/Claude/codex-plugin-multi/.worktrees/provider-architecture-parity-171`
Branch: `goal/provider-architecture-parity-171`

## Current Status

Implementation is locally complete for the focused #171 parity hardening slice, but merge readiness is not complete. Current head `d13ffdf44918ff12bcd54b6caa94e0b4375b1778` has green local verification and green GitHub CI. Latest code-delta external approvals exist from Claude, Gemini, DeepSeek, and GLM for `29832ae..249f80b`, but those approvals are stale for the audit-only `249f80b..d13ffdf` delta if strict exact-head review is required. Kimi has failed both over-cap and under-cap review attempts, and Grok latest-head review was not sent because the sandbox blocked a source-bearing external review for this private/not-verified-public repository.

## Requirement Coverage

| Requirement | Current Evidence | Status |
| --- | --- | --- |
| Use #171 as the umbrella and #170 as topology input. | `spec.md`, `plan.md`, `root-problems.md`, `provider-parity-table.json`. | Complete |
| Define root problems before implementation. | `root-problems.md` and `evidence-map.md`. | Complete |
| Same route ladder for all six providers unless an Adapter capability fact explains the difference. | `scripts/lib/provider-route-policy.mjs`, plugin copies, `tests/unit/provider-route-policy.test.mjs`, `provider-parity-table.json`. | Complete for implemented slice |
| Same source packet budget/resend policy for all six providers and source-bearing modes. | Shared policy plus provider launch preflight in Claude, Gemini, Kimi, Grok, DeepSeek, and GLM paths. Grok and direct API branch-diff now use shared git diff packets instead of full HEAD file bodies. Kimi now uses adapter capacity facts for its lower source-bearing packet budget and unsupported no-source repair, while still flowing through the same shared policy fields and gates. | Complete for implemented slice |
| No fake parity: allowed differences require clear capability facts. | Provider parity table requires `intentional=true` and `capability_fact` for adapter differences; unresolved gaps require follow-up issues. | Complete |
| Grok `--transport auto` is an Adapter transport capability, not alternate provider policy. | Grok CLI-first/web-fallback smoke tests and mode-derived source-bearing guardrail. | Complete |
| Kimi step-limit and missing-verdict symptoms are handled through shared policy, not a Kimi-only special case. | Kimi compact latest-delta review `0ef067c5-d9be-4820-a7d4-034b337c54b6` sent 63,197 bytes and failed with `step_limit_exceeded` at 128 steps. Raw no-tool continuation of session `73ab07c5-7c8a-4661-a271-632e13a5143d` returned `Verdict: NOT_REVIEWED` because prior source was not retained. Shared policy now blocks Kimi no-source repair by adapter capability and pre-blocks packets above Kimi's 32 KiB source capacity before launch; job `08d2f957-bb06-4222-a15c-651691be8655` proves the same broad packet is now blocked before source send. | Complete for implemented slice; Kimi latest-head approval remains blocked until narrowed review succeeds or is waived |
| Full guardrail against provider-neutral drift. | `plugin-copies-in-sync.test.mjs`, `docs-contracts.test.mjs`, `external-model-contracts.test.mjs`, and parity-table schema coverage. | Complete for current policy surface |
| Final six-provider approval. | Current head `d13ffdf44918ff12bcd54b6caa94e0b4375b1778` has green CI but no exact-head six-provider approval. Code-delta approvals from Claude, Gemini, DeepSeek, and GLM covered `29832ae..249f80b`; Kimi narrowed shard `6cecf19f-2145-48d2-84b5-cd77bc09c835` sent 13,062 bytes and became `stale_active_job` with no verdict; Grok latest-head source-bearing review was blocked before send by sandbox policy. | Blocked on exact-head review refresh, Kimi usable verdict or waiver, and Grok usable verdict or waiver |

## Verification Evidence

| Command | Result |
| --- | --- |
| `node --test --test-name-pattern "explicit sent source transmission|source packet policy transmission|no-source resume progress" tests/unit/companion-common.test.mjs` | Passed after lifecycle source-state coverage. |
| `node --test --test-name-pattern "plugin packaging copies expose|explicit sent source transmission|source packet policy transmission" tests/unit/companion-common.test.mjs` | Passed after plugin-copy lifecycle coverage. |
| `CODEX_PLUGIN_SKIP_SMOKE=1 CODEX_PLUGIN_FULL_TESTS=1 npm run test:coverage` | Passed; copied `companion-common` branch coverage rose above baseline. |
| `gh pr checks 175 --repo seungpyoson/codex-plugin-multi` | Passed on head `d13ffdf44918ff12bcd54b6caa94e0b4375b1778`: SonarCloud, lint, smoke api-reviewers, smoke claude, smoke gemini, smoke grok, smoke kimi, and test. |
| `node --check plugins/grok/scripts/grok-web-reviewer.mjs` | Passed after mode-derived Grok source-bearing change. |
| `node --test tests/unit/plugin-copies-in-sync.test.mjs` | Passed, 55 tests. |
| `node --test tests/unit/docs-contracts.test.mjs tests/unit/provider-route-policy.test.mjs tests/unit/external-model-contracts.test.mjs` | Passed, 63 tests. |
| `node --test tests/unit/plugin-copies-in-sync.test.mjs tests/smoke/grok-web.smoke.test.mjs tests/unit/provider-route-policy.test.mjs` | Passed, 220 tests. |
| `node --test tests/unit/provider-route-policy.test.mjs tests/unit/plugin-copies-in-sync.test.mjs tests/unit/docs-contracts.test.mjs tests/smoke/claude-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs` | Passed, 331 tests, after the Kimi missing-verdict repair fix. |
| `node --test tests/unit/plugin-copies-in-sync.test.mjs tests/smoke/api-reviewers.smoke.test.mjs` | Passed, 212 tests, after the direct API branch-diff diff-packet parity fix. |
| `node --test tests/unit/plugin-copies-in-sync.test.mjs tests/smoke/grok-web.smoke.test.mjs tests/smoke/api-reviewers.smoke.test.mjs` | Passed, 360 tests, after the Grok branch-diff diff-packet parity fix. |
| `git diff --check` | Passed. |
| `npm run lint:sync` | Passed after the final guardrail edits. |
| `npm test` | Passed; 2153 tests, 2141 passed, 12 skipped, 0 failed. |
| `COVERAGE_ENFORCE_TARGET=1 npm run test:coverage` on local Node `v24.13.0` | Tests passed; 2278 tests, 2258 passed, 20 skipped, 0 failed. Coverage baseline comparison failed for untouched copied helpers (`companion-common.mjs`, `diff-source.mjs`) under local Node 24 V8 coverage. The PR workflow pins Node 20. |
| Prior `npm run test:full` | 2307 tests; 2295 passed, 12 skipped, 0 failed. |

## Review Evidence

The focused current-delta review packets stayed under the shared source-packet budget instead of bypassing it:

- `provider-architecture-parity-171-focused-current.diff`: current hardening delta.
- `provider-architecture-parity-171-focused-evidence.md`: scope, root problem, verification, and review focus.
- Latest-delta refresh used branch-diff source packets from `29832ae86c1f883dcdcb5e2732f4fb7a8b58aae7` to `249f80bf0b73c9b29db4b5f5e72d0e39c2715248`; direct API approval preflights selected 18 files / 68,196 bytes / 1,324 lines, while the Kimi narrowed shard selected 4 files / 13,062 bytes / 309 lines.
- Full `git diff origin/main`: 597224 bytes, intentionally not sent as one source packet because it exceeded the 512 KiB shared budget.

Latest-delta approvals for `29832ae86c1f883dcdcb5e2732f4fb7a8b58aae7..249f80bf0b73c9b29db4b5f5e72d0e39c2715248`:

- Claude: APPROVE, job `ba6a2dad-4ca3-402b-a1f7-b0ddf7e8d099`.
- Gemini: APPROVE, job `19017086-9290-43ad-a9fc-ba22190a430d`.
- GLM: APPROVE, job `job_6975cf07-9a83-4408-b53f-15377dd2377e`.
- DeepSeek: APPROVE, job `job_697a7d54-a3dd-4d7f-a020-fba3fe8399e4`.

Current failed or missing latest-head slots:

- Kimi: FAILED. Broad job `08d2f957-bb06-4222-a15c-651691be8655` was blocked before source send as `source_packet_too_large`. Narrowed shard `6cecf19f-2145-48d2-84b5-cd77bc09c835` sent 4 files / 13,062 bytes / 309 lines, then became `stale_active_job` after 586,979 ms with zero stdout/stderr, no session id, no verdict, and no findings sections.
- Grok: NOT SENT. The attempted latest-head `--transport auto` review was rejected by sandbox policy before source send.

Historical code-bearing approvals for `38d4c59` are stale for the current head:

- Gemini: APPROVE, job `c8515a3d-1338-411e-a675-8093967a94f5`.
- Grok: APPROVE, job `job_69fb63bd-363b-40d7-a963-6d3d79df5d1b`; `--transport auto` recorded `fallback_reason=grok_cli_login_required`, `selected_route=subscription_web`, and no paid API fallback.
- GLM: APPROVE, job `job_25e493d7-93b9-4851-abee-dba13358ecfc`.
- DeepSeek: APPROVE, job `job_14c3e957-3395-4b0c-9035-b17cd155a04e`.
- Kimi: at the time was recorded as APPROVE via continue job `987ecc31-66af-49e4-8cfb-146ccd341827`; later raw no-tool continuation evidence showed Kimi did not retain selected source reliably, so current policy no longer treats Kimi no-source repair as supported.

Gemini Code Assist comments:

- Resolved stale `sourceTransmission` typo thread; current Grok code uses `sourceContentTransmissionForExecution`.
- Resolved stale Grok auto-fallback diagnostics thread; current prompt-size fallback preserves `diagnostics.cli_request`.

Historical usable approvals before the Kimi repair follow-up:

- Gemini: APPROVE.
- Grok: APPROVE.
- GLM: APPROVE.
- DeepSeek: APPROVE.
- Kimi: was recorded as APPROVE after no-source continuation from `step_limit_exceeded`; later evidence invalidated that as a current Kimi policy assumption.

Latest-delta refresh before the Kimi missing-verdict repair fix:

- Gemini: APPROVE on head `4960b04`.
- Grok: APPROVE on head `4960b04`; `--transport auto` recorded `fallback_reason=grok_cli_login_required`, `selected_route=subscription_web`, and no paid API fallback.
- GLM: APPROVE on head `4960b04`.
- DeepSeek: APPROVE on head `4960b04`.
- Kimi: unusable. The first latest-delta attempt hit `step_limit_exceeded`; a no-source continue returned substantive APPROVE-like prose but omitted the required verdict marker; a second repair attempt exposed that failed no-source repairs did not carry the original source attempt and therefore resent source. This is fixed in the shared retry policy and must be re-reviewed.

Historical unusable slot:

- Claude: code-bearing review job `850deefe-bf2f-4f11-a65c-d024a47f629c`, `oauth_inference_rejected`, HTTP 401 before source delivery, `source_content_transmission=not_sent`, zero token usage.

## Remaining Gate

1. Get a usable Kimi latest-head verdict on narrowed shards or an explicit operator waiver.
2. Get a usable Grok latest-head verdict after explicit risk approval or an explicit operator waiver.
3. Re-run `npm run lint:sync` and a final test command after any further code changes.
