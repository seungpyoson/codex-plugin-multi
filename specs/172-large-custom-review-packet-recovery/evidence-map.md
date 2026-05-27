# Issue #172 Evidence Map

## Live State

Verified on 2026-05-26 from `origin/main` at `119183e`.

Saved goal prompt source:
`/Users/spson/Downloads/prompts/codex-plugin-multi/2-provider-reliability-architecture-goal.md`.
Preserved gates: issue/worktree isolation, #172 target selection, manual
Speckit artifacts, no runtime implementation before unanimous provider planning
approval, TDD implementation, local verification, final external reviews, and
no push/merge/cache refresh/destructive cleanup without explicit approval.

| Item | State | Evidence | Verdict |
| --- | --- | --- | --- |
| #171 provider architecture parity | closed | PR #175 merged `cd5b488`; issue closed 2026-05-25 | Completed context, do not redo |
| #173 source-packet budget gate | closed | PR #174 merged `6fc7229`; issue closed 2026-05-25 | Completed source-packet groundwork |
| #176 Grok CLI login readiness / auto doctor | closed | PR #184 merged `119183e`; issue closed 2026-05-26 | Completed #159 slice |
| #177 Kimi scope-base custom-review packet shape | closed | PR #183 merged `3847687`; issue closed 2026-05-26 | Completed #172-adjacent slice |
| #180 review-slot disposition and same-packet retry | closed | PR #181 merged `a39ddbe`; issue closed 2026-05-26 | Completed failed-slot/retry groundwork |
| #172 large custom-review packets | open P1 | Issue body records DeepSeek/Grok pre-send scope failures, Gemini/Kimi source-sent no-verdict failures, manual diff workaround | Selected target |
| #147 bounded direct API session approval | open P1 | Existing per-run approval token model only | Separate source-send safety feature |
| #159 Grok provider architecture | open P2 | #176 completed auto-doctor/readiness slice, broader architecture remains | Later target |
| #160 stale env after key rotation | open | Env-cache fallback exists, issue still asks rotated cache refresh inside long session | Later target |
| #144 API-backed rescue | open P3 | No write-capable direct API rescue contract | Later target |

## Current Main Implementation Evidence

- Shared source-packet policy exists in `scripts/lib/provider-route-policy.mjs`.
  It records `source_packet_budget_bytes`, `selected_source_bytes`,
  `source_packet_action`, `review_surface_changed`, and `suggested_action`.
- Over-budget packets without explicit override fail with
  `source_packet_action:"narrow_source_packet"` and
  `source_content_transmission:"not_sent"`.
- Existing suggested action is prose only: narrow/shard, or use
  `--allow-large-source-packet` after explicit confirmation.
- Direct API `approval-request` and `run` already emit `sharding_plan` when
  rendered prompt exceeds provider prompt cap.
- Direct API custom-review rejects one file over `262144` bytes before source
  delivery, but the output has no first-class recovery plan for alternate
  packet surfaces.
- Grok rejects over-budget source packets and prompt caps before transport
  launch, but has no structured sharding/recovery plan like direct API prompt
  cap failures.
- Claude/Gemini/Kimi/Grok/API tests already prove failed source-sent slots and
  over-budget packets do not count as approval, but operator recovery is still
  spread across prose, provider-specific errors, and manual packet invention.

## Baseline Verification

Focused baseline in the isolated worktree passed:

```sh
node --test --test-name-pattern "source packet|source-packet|custom-review rejects|prompt exceeds cap|prompt cap|sharding_plan|over-budget" tests/unit/provider-route-policy.test.mjs tests/smoke/api-reviewers.smoke.test.mjs tests/smoke/grok-web.smoke.test.mjs tests/smoke/kimi-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs tests/smoke/claude-companion.smoke.test.mjs
```

Result: 36 tests passed, 0 failed.

## Root Problem

#172 is no longer "add any source-packet guard." That was covered by #173 and
#180. The remaining root problem is missing structured, deterministic recovery
planning when selected custom-review source cannot complete as the originally
requested review surface.

The operator should not need to invent a temporary diff packet or hand-pick
shards after a provider refuses or cannot finish a packet. The tool should
produce an auditable recovery plan that says:

1. what failed before source send or after source send,
2. whether the original full-source review surface changed,
3. which exact next actions are safe,
4. which actions require fresh approval or explicit waiver,
5. which resulting review slots may count as full-source approval.

## Selected Smallest Valid Next Action

Implement a shared `packet_recovery` contract for #172.

MVP:

- Emit the same structured recovery object for source-packet budget failures and
  prompt-budget failures.
- Include deterministic next actions for custom-review packets: shard selected
  paths, use branch-diff packet with explicit `--scope-base`, explicitly approve
  large source packet when policy permits, or record waiver.
- Include review-surface metadata so diff/shard fallback is auditable and cannot
  silently count as original full-source approval.
- Wire through Direct API and Grok first because they expose both pre-send
  failures from #172; keep shared helpers and packaged-copy sync so
  Claude/Gemini/Kimi use the same field meanings when their packet policy blocks.

## Non-Goals

- Do not redo #171 route/parity architecture.
- Do not redo #173 source-packet hard budget or `--allow-large-source-packet`.
- Do not redo #177 `custom-review --scope-base` branch-diff normalization.
- Do not redo #180 review-slot retry/disposition.
- Do not add bounded session approval (#147).
- Do not silently downgrade full-source review to diff-only approval.
- Do not auto-resend selected source after source-bearing failure.

## Risk If Grouped Wrong

| Wrong grouping | Risk |
| --- | --- |
| Fold into #147 | Turns packet recovery into source-send grant work and weakens approval boundaries |
| Fold into #159 | Lets Grok architecture swallow provider-neutral recovery semantics |
| Fold into #160 | Confuses credential freshness with packet recovery |
| Fold into #144 | Mixes read-only review recovery with write-capable rescue design |

## Implementation Evidence

Current implementation adds a shared `packet_recovery` object with provider
capability facts, review-surface hashes/counts, and bounded next actions. The
object is emitted for:

- Direct API source-packet budget failures and rendered prompt-cap sharding
  failures.
- Grok source-packet budget failures, rendered prompt-cap failures, and
  source-sent no-verdict failures.
- Claude, Gemini, and Kimi source-packet policy failures through shared
  `review-prompt` audit-manifest generation.
- Claude, Gemini, and Kimi initial source-sent review failures where the
  provider received or may have received selected source but returned no valid
  review because of missing verdict, timeout, or step-limit exhaustion.
- Reconciled Claude, Gemini, and Kimi stale active jobs when the retained
  process/session cannot prove whether selected source was already sent.
- Kimi packet-cap and source-sent retry failures, including
  `supports_no_source_resume:false`.
- Review-panel failed rows without changing failed-slot classification.

Post-review fix evidence:

- Grok and Direct API recovery capabilities now omit
  `resume_without_source_resend`; neither runtime exposes a no-source
  continuation command.
- Direct API source-sent no-verdict failures now project `packet_recovery` into
  both runtime diagnostics and the audit manifest.
- `sourcePacketRecoveryActions` dispatches `source_packet_too_large` and
  `resend_confirmation_required` from the normalized recovery reason as well as
  the policy error code.
- US3 follow-up work now adds explicit source-of-truth persistence tests,
  shared source-send approval tuple fingerprinting, Direct API recovery shard
  tuple freshness tests, approval-request failure-before-token recovery
  assertions, and a source-sent resend-confirmation test proving
  `--allow-large-source-packet` does not bypass the resend gate.
- Direct API now records prior source-sent attempts with selected-source packet
  metadata so source-packet policy can enforce resend confirmation after a
  failed source-bearing slot, while review-slot retry counting still uses the
  same validated prior review-slot records.
- Review-surface comparison now hashes normalized selected-source metadata, so
  packet recovery still detects a changed review surface when a legacy or
  sparse prior record lacks an explicit `review_surface_changed:true` flag.

Verification on 2026-05-26:

```sh
node --test --test-name-pattern "packet recovery|source-sent|source packet|source-packet|prompt cap|over-budget|review panel rows expose|custom-review guides substantive|direct API reviewers guide substantive" tests/unit/provider-route-policy.test.mjs tests/unit/review-panel.test.mjs tests/unit/docs-contracts.test.mjs tests/smoke/api-reviewers.smoke.test.mjs tests/smoke/grok-web.smoke.test.mjs tests/smoke/kimi-companion.smoke.test.mjs tests/smoke/claude-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs
```

Result: 40 tests passed, 0 failed.

```sh
npm run lint:sync
git diff --check
npm test
```

Results:

- `npm run lint:sync`: passed, including provider-route-policy,
  review-prompt, review-panel, contract, and auth/env sync checks.
- `git diff --check`: passed.
- `npm test`: 2224 tests, 2212 passed, 0 failed, 12 skipped.

Follow-up verification on 2026-05-27:

```sh
node --test --test-name-pattern "packet recovery from failed slots|failed-slot packet recovery|source-send approval proof|emits sharding plan with per-shard approval tuple|recovery shard requires fresh approval|approval-request emits sharding plan|large source packet override|same-packet resend|same-packet request-changes|explicit same-packet retry disposition" tests/unit/job-record.test.mjs tests/unit/review-prompt.test.mjs tests/unit/provider-route-policy.test.mjs tests/smoke/api-reviewers.smoke.test.mjs
```

Result: 13 tests passed, 0 failed.

```sh
npm run lint:sync
git diff --check
npm test
```

Results:

- `npm run lint:sync`: passed.
- `git diff --check`: passed.
- `npm test`: 2229 tests, 2217 passed, 0 failed, 12 skipped.

After Claude's non-blocking dead-code cleanup finding:

```sh
node --test --test-name-pattern "packet recovery from failed slots|Kimi missing-verdict diagnostic|scope" tests/unit/job-record.test.mjs
git diff --check
```

Results: 18 tests passed, 0 failed; `git diff --check` passed.

End-to-end gap-audit verification on 2026-05-27:

```sh
npm run lint
git diff --check
node --test tests/smoke/result-reconcile.smoke.test.mjs
npm test
```

Results:

- `npm run lint`: passed.
- `git diff --check`: passed.
- `node --test tests/smoke/result-reconcile.smoke.test.mjs`: 3 tests passed,
  0 failed. This covers Claude, Gemini, and Kimi stale active source-bearing
  jobs projecting conservative `stale_active_job` `packet_recovery` with
  `source_content_transmission:"unknown"` and no no-source resume action.
- `npm test`: 2238 tests, 2226 passed, 0 failed, 12 skipped after the
  post-review schema-contract fix.

```sh
npm run doctor:cache
```

Result: command exited 0 with `"ok": false` because installed plugin cache is
still in sync with the marketplace cache, but not with this dirty feature
worktree. No cache refresh was performed because the saved goal prompt requires
explicit approval before refresh. Changed repo-cache files are the touched
runtime scripts and synced shared libraries across API reviewers, Claude,
Gemini, Grok, and Kimi.

## Final Review Evidence

Final implementation review gate was narrowed by the operator to Claude and
Grok only. Results are recorded in
`specs/172-large-custom-review-packet-recovery/final-review-results.md`.

Final whole-issue packet:

- Claude `53c84758-b9d6-4e5b-acc9-c7c97d6bc93c`: APPROVE, no blocking
  findings.
- Grok `job_31ea50b7-54ea-46cc-b661-3229740c4207`: APPROVE, no blocking
  findings.

Post-review cleanup delta:

- Claude `2c37c230-a400-4ff4-9c48-b4fa1b0f75d4`: APPROVE, no blocking
  findings.
- Grok `job_a5b6301d-1bdb-49ff-b1d3-a517b9097e5b`: APPROVE, no blocking
  findings.

US3 follow-up review:

- Claude `007063c2-cbdc-4676-b922-5e8b9a2088f4`: APPROVE, no blocking
  findings. One non-blocking unreachable Kimi `return empty;` cleanup was
  accepted and removed.
- Grok `job_615e06c5-e0cb-43ee-9594-42dd5782167b`: APPROVE, no blocking
  findings. First Grok attempt
  `job_8e686c30-a7bc-4a59-8e7e-27c648bf9824` failed before source send with
  `prompt_too_large`, so the successful review used a narrower code/doc packet.

End-to-end gap audit review:

- Claude `6f6b165a-76d2-4467-9b11-8655015f0ad1`: APPROVE, no blocking
  findings on the full branch diff.
- Grok `job_ca38d864-e37a-4a96-a117-ac842e71d157`: APPROVE, no blocking
  findings on a narrowed source-bearing packet covering shared recovery logic,
  companion job-record projection, schema, and stale-job tests.
- Grok pre-send attempts
  `job_ae5ce107-10b8-4884-b6b6-dfb87aa67527` and
  `job_700c1b51-2abb-4e6a-be23-1c62b046a57b` failed before source send with
  `prompt_too_large` and `scope_total_too_large`; neither counted as review.
- Accepted Claude's non-blocking schema finding: the `approvalTuple` JSON
  schema now matches the runtime shard tuple shape and has a docs-contract
  regression test.
