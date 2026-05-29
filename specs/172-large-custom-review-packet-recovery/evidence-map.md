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
- Do not claim full pre-send parity for all companion runtime failures. Local
  packet-policy gates are wrapper-enforced before source send; provider-runtime
  failures discovered after launch are represented as source-sent failed slots.

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
- Provider recovery capabilities record
  `local_source_packet_policy_pre_send:true` and
  `source_sent_runtime_failures_failed_slot:true`, making the pre-send versus
  post-launch boundary explicit in every `packet_recovery` object.
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

Post-#159 GLM failure follow-up on 2026-05-28:

- #159 final GLM review job `job_32e52d7f-8a2f-4f74-b41e-25ec617887c7`
  failed after a source-bearing Direct API request with `provider_unavailable`,
  `fetch failed`, no HTTP status, `source_content_transmission:"unknown"`,
  prompt size about 97k characters, and no usable verdict.
- A GLM source-free `ping` succeeded afterward, so the failure was not basic
  credential or endpoint readiness.
- Small GLM source-bearing diagnostic job
  `job_f047fded-8c0e-48e9-8f6c-a32c4e561ce6` returned HTTP 200 but failed
  review quality as `missing_verdict` when capped at 512 output tokens.
- Small GLM source-bearing diagnostic job
  `job_61087aa7-1eea-456c-973a-121f118e5a09` completed and approved with
  `max_tokens:4096`, proving source-bearing GLM can work for smaller packets.
- Gap found: the #172 branch projected `packet_recovery` for Direct API
  source-sent `review_not_completed`, but not for source-bearing
  `provider_unavailable` failures with `sent` or conservative `unknown` source
  state.
- Fix: Direct API source-bearing `provider_unavailable` now emits
  `packet_recovery.reason:"provider_unavailable"` with resend-confirmation,
  provider-switch, and explicit-waiver actions. The same behavior is covered for
  HTTP 503 source-sent failure and for a dropped connection after the test
  server received selected source.

Post-review quality follow-up on 2026-05-28:

- Claude review job `95c3b411-c0cd-4fa7-8a3d-d52f9712b960` returned an
  approving packet-only review but the slot failed as `review_not_completed` /
  `not_reviewed` because the review-quality parser treated a helper caveat
  phrased as "not in packet" / "outside the packet" as if selected source was
  not inspected.
- The failed Claude record still correctly preserved `packet_recovery` and did
  not count as approval, but the user experience was not no-mistakes because a
  valid packet-only scope gap became a failed slot.
- Fix: shared review-quality parsing now treats "not in packet" / "outside the
  packet" caveats as out-of-scope inspection gaps when selected source was
  inspected. The test covers the shared module and every packaged provider copy.
- Claude combined-review job `cee97fc6-1378-42bb-b900-9c9eca4a5472` exposed a
  second parser false-negative: a reviewer explanation that "no genuine selected
  source not inspected case is newly suppressed" was itself classified as
  `not_reviewed`.
- Fix: shared review-quality parsing now ignores narrowly negated
  selected-source suppression analysis while preserving the existing tests that
  real selected-source non-inspection and permission denial still fail the slot.

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

## Subscription CLI Prompt Repository-Identity Follow-up

Claude exact-head review job `806fb8a7-ecfa-41e7-8e91-fbcdc57dfdaa` exposed a
separate no-mistakes gap after the parser fixes. The raw review approved the
delta and named inspected selected files, but the run still recorded a
permission-denied `Read` against the original absolute worktree path
`/Users/spson/.../provider-reliability-172-large-custom-packet-recovery/...`.

Root cause:

- Claude, Gemini, and Kimi review prompts rendered
  `Repository: <absolute local workspace root>`.
- Their selected source was already supplied through the prompt/source packet
  and, for Claude, copied into a contained `--add-dir` worktree.
- The generated local path was not review evidence; it nudged tool-capable
  subscription reviewers toward original-path filesystem reads. When that read
  was denied, the operator saw a provider-specific failed slot instead of a
  deterministic packet-only review result.

Fix:

- Claude, Gemini, and Kimi prompt builders now use a provider-facing review
  repository identity for the prompt `Repository` field, matching git
  `owner/repo` when a remote exists and using `local-workspace:<basename>` when
  no remote exists. The already-correct Grok and Direct API paths continue to
  use packet-relative review evidence.
- Local absolute workspace paths remain in JobRecord/runtime diagnostics for
  operator audit, but are not emitted as the provider-facing repository label.
- Smoke mocks now support prompt-exclusion assertions for Claude and Gemini,
  matching Kimi's existing prompt-exclusion oracle.

TDD evidence:

```sh
node --input-type=module -e '<repo-identity smoke across Claude, Gemini, Kimi>'
```

Results:

- RED: with the old prompt behavior restored, the smoke failed for Claude,
  Gemini, and Kimi because the prompt did not contain
  `Repository: seungpyoson/provider-prompt-fixture` and still included the
  temp local repo path.
- GREEN: after the first fix, the same smoke passed for all three providers:
  `{"ok":true,"providers":["claude","gemini","kimi"]}`.
- Claude review job `bfb867bd-14ce-4de5-9266-19e724c470d4` approved the first
  prompt-routing delta and raised a non-blocking but valid edge: repos without
  `origin` still fell back to the local path through `repositoryIdentity()`.
- The no-remote fallback was fixed with the provider-facing
  `local-workspace:<basename>` label. Updated smoke coverage now checks both
  remote and no-remote cases across Claude, Gemini, and Kimi.
- GREEN after the no-remote fix:
  `{"ok":true,"cases":["remote","local"],"providers":["claude","gemini","kimi"]}`.
- Fresh verification after the Speckit ledger update:
  - `git diff --check`: passed.
  - `npm run lint`: passed.
  - `node --test tests/unit/review-prompt.test.mjs`: 286 passed, 0 failed.
  - `node --test tests/smoke/claude-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs tests/smoke/kimi-companion.smoke.test.mjs`: 319 passed, 0 failed.
  - `npm test`: 2257 tests, 2245 passed, 0 failed, 12 skipped.
  - `npm run doctor:cache`: exited 0 with `"ok": false` because installed
    plugin cache still matches the marketplace cache, not this unpublished
    feature branch; no cache refresh was performed.
- Final Claude review job `14d778b6-3c33-469f-a52d-42626ddd45a3` approved the
  remote plus no-remote prompt-routing fix with selected source sent, a clean
  review-quality audit, and no permission denials.
- Final Grok review job `job_eae44931-c910-4176-9308-b03d783fc8e7` approved the
  same final packet with selected source sent, a clean review-quality audit,
  and no permission denials.

## Companion Pre-Send Boundary Follow-up

Post-review triage found that "companion pre-send parity" was a partially valid
review concern but not a runtime-architecture bug to solve inside #185. The
correct invariant is:

- Locally knowable source-packet policy failures fail before source send.
- Provider-runtime failures known only after launch are source-sent failed
  slots and cannot count as approval.

Fix:

- `ProviderRecoveryCapabilities` now records
  `local_source_packet_policy_pre_send:true` and
  `source_sent_runtime_failures_failed_slot:true`.
- The packet-recovery schema requires both capability facts.
- `spec.md`, `plan.md`, `data-model.md`, `quickstart.md`, and this evidence
  map now state that #172 does not promise all companion runtime failures are
  pre-send.

Verification:

- RED contract/policy tests failed before adding the two capability facts.
- GREEN focused contract/policy tests passed after implementation.
- `node --test tests/unit/docs-contracts.test.mjs tests/unit/provider-route-policy.test.mjs tests/unit/plugin-copies-in-sync.test.mjs`: 145 passed, 0 failed.
- `npm run lint:sync`: passed.
- `node --test tests/unit/review-prompt.test.mjs tests/unit/job-record.test.mjs`: 509 passed, 0 failed.
- `node --test tests/smoke/api-reviewers.smoke.test.mjs`: 170 passed, 0 failed.
- `node --test tests/smoke/grok-web.smoke.test.mjs`: 166 passed, 0 failed.

Exact-head review for the companion pre-send boundary follow-up used base
`32d4018c07906cc09d3d5a5ede8c1042a487a502` and head
`0a9602c40d2e71fd1c85b2ca9f2b76e77ac8949b`:

- Claude `7859246b-cccc-4ee8-8578-9e54f7eac83f`: APPROVE, no blocking
  findings, selected source sent.
- Grok `job_ce0df962-84bb-444e-9dd4-c679694b2c5c`: APPROVE, no blocking
  findings, selected source sent. The first Grok attempt
  `job_562396dc-00d1-404d-84cb-a16540f1ff64` failed before source send with
  `prompt_too_large`; the successful run used explicit large-packet allowance.

Post-review cleanup after Claude non-blocking findings:

- `approval_tuple_fingerprint` schema now matches the structured runtime object
  emitted by `sourceSendApprovalTupleFingerprint`.
- Packet-recovery `reason` enum now includes retry fail-closed reasons emitted
  by same-packet retry guards.
- Previous source attempts derived from JobRecords now preserve `started_at`,
  and `latestSourcePacketPreviousAttempt` prefers the chronological latest
  source-bearing attempt when timestamps are present.
- `data-model.md` now documents the runtime `ApprovalTuple` fields instead of
  stale hash-only names.

Verification for the post-review cleanup:

- RED `node --test tests/unit/docs-contracts.test.mjs` failed on stale schema
  fields before the fix.
- RED `node --test tests/unit/provider-route-policy.test.mjs` failed on
  chronological latest-attempt selection before the fix.
- `node --test tests/unit/docs-contracts.test.mjs`: 41 passed, 0 failed.
- `node --test tests/unit/provider-route-policy.test.mjs`: 42 passed, 0 failed.
- `npm run lint:sync`: passed.
- `node --test tests/unit/plugin-copies-in-sync.test.mjs tests/unit/review-prompt.test.mjs tests/unit/job-record.test.mjs`: 573 passed, 0 failed.
- `node --test tests/smoke/api-reviewers.smoke.test.mjs`: 170 passed, 0 failed.
- `node --test tests/smoke/grok-web.smoke.test.mjs`: 166 passed, 0 failed.
- `node --test tests/smoke/claude-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs tests/smoke/kimi-companion.smoke.test.mjs`: 324 passed, 0 failed.

This cleanup changed the branch after the exact-head review above; the next
external review must use the new head SHA.

## Grok CLI Neutral Cwd Cleanup Follow-up

The first final-delta Grok review after the contract cleanup surfaced another
real runner reliability gap:

- Grok `job_d638a729-eb98-49af-a89f-438d6c38194b` sent source, then failed as a
  review slot with `privacy_persistence`.
- Diagnostics showed `neutral_cwd_cleanup:"unverified"`.
- The reported `/var/folders/.../grok-cli-cwd-*` still existed and contained a
  copied repo snapshot, including `.git`, so the failure was valid and the slot
  was not counted.

Fix:

- The Grok CLI runner no longer uses non-recursive `rmdir(neutralCwd)` for the
  generated neutral cwd.
- It now recursively removes only directories whose parent is `tmpdir()` and
  whose basename starts with `grok-cli-cwd-`, then verifies the directory no
  longer exists.
- The final schema cleanup also relaxes fingerprint `ingredients.auth_path` to
  accept string auth paths because the shared fingerprint helper accepts string
  callers.

Verification:

- RED `node --test --test-name-pattern "non-empty Grok CLI neutral cwd" tests/smoke/grok-web.smoke.test.mjs` failed before the cleanup fix.
- RED `node --test --test-name-pattern "runtime shard approval tuple shape" tests/unit/docs-contracts.test.mjs` failed before the auth-path schema fix.
- `node --test --test-name-pattern "non-empty Grok CLI neutral cwd" tests/smoke/grok-web.smoke.test.mjs`: passed.
- `node --test tests/unit/provider-route-policy.test.mjs`: 42 passed, 0 failed.
- `node --test tests/unit/docs-contracts.test.mjs tests/smoke/grok-web.smoke.test.mjs`: 207 passed, 0 failed.
- `npm run lint:sync`: passed.

Claude `7cb169a7-8b86-4784-a88a-93495333f15d` approved the previous delta with
source sent, but that approval is stale after this cleanup. The next external
review must use the new head SHA.
