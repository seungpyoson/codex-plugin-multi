# Final Review Results

## Scope

Operator narrowed the final implementation review gate to Claude and Grok only.

Reviewed implementation branch:
`goal/provider-reliability-172-large-custom-packet-recovery`

Reviewed head recorded by both provider audit manifests:
`119183e7663b262773482aa76b5d836d13ac94da`

The final review packets were custom-review source packets:

- `.codex-plugin-data/review-packets/provider-reliability-172-final.md`
- `.codex-plugin-data/review-packets/provider-reliability-172-post-review-delta.md`

Both packets were source-bearing and were sent to the reviewers.

## Whole-Issue Review

| Reviewer | Job | Source sent | Verdict | Blocking findings |
| --- | --- | --- | --- | --- |
| Claude | `53c84758-b9d6-4e5b-acc9-c7c97d6bc93c` | yes | APPROVE | none |
| Grok | `job_31ea50b7-54ea-46cc-b661-3229740c4207` | yes | APPROVE | none |

Accepted Claude non-blocking findings:

- Schema reason enum missed `resend_confirmation_required`.
- Direct API source-sent recovery test missed the FR-012 assertion that
  top-level `error_code` matches `packet_recovery.reason`.
- Grok audit-manifest backfill froze the inner audit manifest but not the outer
  `reviewMetadata` object.
- Several broader US3 tasks remained unchecked.

Accepted Grok non-blocking findings:

- Several broader US3 tasks remained unchecked.
- Shared policy helper duplication across synced provider copies remains a
  maintenance risk, mitigated by sync checks.
- Some edge-case approval-proof paths remain future work.

## Post-Review Cleanup Delta

Cleanup applied after the whole-issue review:

- Added `resend_confirmation_required` to the `PacketRecovery.reason` schema
  contract and a docs-contract assertion.
- Added the Direct API FR-012 source-sent assertion.
- Froze Grok outer `reviewMetadata` when backfilling `packet_recovery`.

| Reviewer | Job | Source sent | Verdict | Blocking findings |
| --- | --- | --- | --- | --- |
| Claude | `2c37c230-a400-4ff4-9c48-b4fa1b0f75d4` | yes | APPROVE | none |
| Grok | `job_a5b6301d-1bdb-49ff-b1d3-a517b9097e5b` | yes | APPROVE | none |

Residual non-blocking notes from delta review:

- Claude noted the delta packet did not include the schema JSON diff itself,
  but the docs-contract test validates the schema content.
- Grok noted a fragile diagnostics object spread order in one Grok prompt-cap
  fallback path. The current provider-failure diagnostics object is fresh and
  does not carry a colliding `packet_recovery` key, so this was not treated as
  a blocking defect.
- Grok noted no isolated unit test for the Grok source-sent recovery helper;
  smoke coverage exercises the observable provider behavior.

## Verification Evidence

Focused verification recorded in `evidence-map.md`:

```sh
node --test --test-name-pattern "packet recovery|source-sent|source packet|source-packet|prompt cap|over-budget|review panel rows expose|custom-review guides substantive|direct API reviewers guide substantive" tests/unit/provider-route-policy.test.mjs tests/unit/review-panel.test.mjs tests/unit/docs-contracts.test.mjs tests/smoke/api-reviewers.smoke.test.mjs tests/smoke/grok-web.smoke.test.mjs tests/smoke/kimi-companion.smoke.test.mjs tests/smoke/claude-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs
```

Result: 40 tests passed, 0 failed.

Full verification recorded in `evidence-map.md`:

- `npm run lint:sync`: passed.
- `git diff --check`: passed.
- `npm test`: 2224 tests, 2212 passed, 0 failed, 12 skipped.
- `npm run doctor:cache`: exited 0 with `"ok": false` because installed plugin
  cache is in sync with marketplace cache, but not with this dirty feature
  worktree. No cache refresh was performed.

## Residual Scope

The previously residual US3 follow-up tasks were completed in the same branch
after investigation and TDD.

## US3 Follow-Up Review

Follow-up scope:

- `packet_recovery` JobRecord/review-prompt source-of-truth persistence.
- Source-send approval tuple fingerprint and token freshness.
- Direct API failure-before-token recovery projection.
- Recovery shard approval tuple behavior.
- Source-sent resend-confirmation interaction with `--allow-large-source-packet`.

| Reviewer | Job | Source sent | Verdict | Blocking findings |
| --- | --- | --- | --- | --- |
| Claude | `007063c2-cbdc-4676-b922-5e8b9a2088f4` | yes | APPROVE | none |
| Grok | `job_615e06c5-e0cb-43ee-9594-42dd5782167b` | yes | APPROVE | none |

Grok first attempt `job_8e686c30-a7bc-4a59-8e7e-27c648bf9824` failed before
source send with `prompt_too_large`; the successful Grok review used a narrower
code/doc packet and the prompt included the focused/full test evidence.

Accepted follow-up non-blocking findings:

- Claude noted an unreachable `return empty;` in
  `plugins/kimi/scripts/lib/job-record.mjs`. It was removed as dead code.
- Claude noted one readability concern around reason dispatch indirection in
  `sourcePacketRecoveryActions`; this was left as non-blocking because tests
  assert dispatch by normalized reason and policy error code.
- Grok reported no blocking findings and only minor documentation polish
  opportunities outside the blocking scope.

Follow-up verification:

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

After removing the unreachable Kimi `return empty;`:

```sh
node --test --test-name-pattern "packet recovery from failed slots|Kimi missing-verdict diagnostic|scope" tests/unit/job-record.test.mjs
git diff --check
```

Results: 18 tests passed, 0 failed; `git diff --check` passed.

## End-to-End Gap Audit Delta

Additional gap audit scope:

- Claude, Gemini, and Kimi source-sent initial failures now project
  `packet_recovery` for missing-verdict, timeout, and step-limit outcomes.
- Reconciled Claude, Gemini, and Kimi stale active jobs now project conservative
  `stale_active_job` packet recovery with source state `unknown`.
- Review-surface recovery now infers changed source packets from normalized
  source hashes when older records do not contain `review_surface_changed:true`.

Local verification:

```sh
npm run lint
git diff --check
node --test tests/smoke/result-reconcile.smoke.test.mjs
npm test
npm run doctor:cache
```

Results:

- `npm run lint`: passed.
- `git diff --check`: passed.
- `node --test tests/smoke/result-reconcile.smoke.test.mjs`: 3 tests passed,
  0 failed.
- `npm test`: 2238 tests, 2226 passed, 0 failed, 12 skipped after the
  post-review schema-contract fix.
- `npm run doctor:cache`: exited 0 with `"ok": false` because the installed
  plugin cache is still in sync with the marketplace cache, not with this dirty
  feature worktree.

External review:

| Reviewer | Job | Source sent | Verdict | Blocking findings |
| --- | --- | --- | --- | --- |
| Claude | `6f6b165a-76d2-4467-9b11-8655015f0ad1` | yes | APPROVE | none |
| Grok | `job_ca38d864-e37a-4a96-a117-ac842e71d157` | yes | APPROVE | none |

Grok pre-send attempts:

- `job_ae5ce107-10b8-4884-b6b6-dfb87aa67527` failed before source send with
  `prompt_too_large` on the full branch-diff packet.
- `job_700c1b51-2abb-4e6a-be23-1c62b046a57b` failed before source send with
  `scope_total_too_large` on the first broad custom packet.

Accepted Claude non-blocking finding:

- The `approvalTuple` JSON schema lagged the runtime shard approval tuple
  shape. The schema now models runtime fields (`source_packet`,
  `scope_resolution`, `scope_paths`, `request_settings`, `route_step`,
  `route_steps`, and `approval_tuple_fingerprint`) and keeps
  `rendered_prompt_hash` as the emitted hex string. A docs-contract test covers
  this exact shape.

Residual non-blocking notes:

- Claude noted a future-proofing concern if `fail_closed:true` were ever
  produced without a `fail_closed_reason`; current policy paths set the reason.
- Claude repeated the existing Grok CLI-to-web diagnostics spread-order concern;
  current diagnostics do not carry a colliding `packet_recovery` key.
- Claude noted approval-token fingerprint changes invalidate in-flight
  pre-branch tokens; tokens are session-scoped and this is acceptable here.
- Grok noted duplicated job-record projection across Claude/Gemini/Kimi and
  suggested additional boundary/property tests for review-quality exclusions.

Post-review contract verification:

```sh
node --test --test-name-pattern "packet recovery schema matches runtime shard approval tuple shape" tests/unit/docs-contracts.test.mjs
node --test tests/unit/docs-contracts.test.mjs
npm run lint
git diff --check
npm test
```

Results:

- RED contract test failed before the schema update because the schema still
  required `source_packet_hash`, `scope_resolution_hash`, and
  `request_settings_hash`.
- Focused contract test passed after the schema update.
- `node --test tests/unit/docs-contracts.test.mjs`: 40 tests passed, 0 failed.
- `npm run lint`: passed.
- `git diff --check`: passed.
- `npm test`: 2238 tests, 2226 passed, 0 failed, 12 skipped.

## Post-PR Provider Alias Follow-up

Accepted Greptile finding:

- Grok packet recovery still contained a transport-specific alias conditional:
  `grok-web` was hardcoded back to `grok` inside the runtime instead of being
  represented as provider metadata. The fix adds provider-neutral
  `canonical_provider` recovery metadata, sets Grok CLI and Grok Web to the
  shared canonical provider `grok`, and projects that value through the shared
  provider recovery capability snapshot and schema.

Verification:

```sh
node --test --test-name-pattern "Grok auto transport stays" tests/unit/plugin-copies-in-sync.test.mjs
node --test --test-name-pattern "Grok runtime reads direct API credential names|custom-review guides substantive missing-verdict retry" tests/smoke/grok-web.smoke.test.mjs
node --test --test-name-pattern "Grok CLI lifecycle markdown streams running card" tests/smoke/grok-web.smoke.test.mjs
npm run smoke:grok
npm test
npm run lint
npm run lint:sync
git diff --check
```

Results:

- RED static unit test failed before the runtime metadata update because
  `canonical_provider` was absent.
- RED Grok source-sent recovery smoke test failed before the runtime metadata
  update because `provider_capabilities.canonical_provider` was absent.
- Focused Grok metadata/recovery smoke assertions passed after adding direct
  coverage for Grok CLI, Web, and fallback config `canonical_provider`.
- Focused Grok lifecycle smoke test passed after hardening its fake CLI delay
  and wait budgets for full-suite load.
- `npm run smoke:grok`: 173 tests passed, 0 failed.
- `npm test`: 2238 tests, 2226 passed, 0 failed, 12 skipped.
- `npm run lint`: passed.
- `npm run lint:sync`: passed.
- `git diff --check`: passed.

External delta review:

| Reviewer | Job | Source sent | Verdict | Blocking findings |
| --- | --- | --- | --- | --- |
| Claude | `7d9cd7a9-16fc-4e4a-81af-9c8f776e560c` | yes | APPROVE | none |
| Grok | `job_c64902b2-07e3-4041-8a92-6268d3b293f1` | yes | APPROVE | none |

Review packet note:

- The first Claude whole-file attempt
  `267a379e-da20-4bde-919a-07727d038429` failed before launch with
  `source_packet_too_large`; selected source was not sent. The retry used a
  narrow source packet containing the delta diff and verification evidence.
- Claude's low non-blocking test-gap suggestion was addressed before the Grok
  review by adding direct assertions that Grok CLI, Web, and fallback configs
  all carry `canonical_provider`.
- Both final reviewers noted the narrow packet scope limitation: they reviewed
  the supplied delta packet rather than the whole live source tree. Local
  verification above was run against the live worktree.

## Post-#159 GLM Provider-Unavailable Follow-up

New evidence from the #159 final review gate showed that GLM can fail a
source-bearing Direct API review as `provider_unavailable` / `fetch failed` with
no HTTP status and conservative `source_content_transmission:"unknown"`. The
small source-free GLM probe passed, a small source-bearing request approved with
`max_tokens:4096`, and a small source-bearing request failed as
`missing_verdict` with `max_tokens:512`. This made the root problem a recovery
coverage gap, not a provider-auth outage.

Gap fixed in this branch:

- Direct API source-bearing `provider_unavailable` failures now project
  `packet_recovery.reason:"provider_unavailable"` into runtime diagnostics and
  the audit manifest.
- The recovery source state is `sent` for HTTP provider failures and
  conservative `unknown` when the request reached the server but the connection
  was dropped before a response.
- Recovery actions are resend with explicit confirmation, switch provider, or
  explicit waiver. The failed slot still does not count as approval.
- The `PacketRecovery` schema now allows `provider_unavailable` as an emitted
  recovery reason.

Local verification:

```sh
node --test --test-name-pattern "direct API (HTTP provider_unavailable under Codex|fetch failure after source receipt)" tests/smoke/api-reviewers.smoke.test.mjs
node --test --test-name-pattern "packet recovery schema keeps|direct API (HTTP provider_unavailable under Codex|fetch failure after source receipt)" tests/unit/docs-contracts.test.mjs tests/smoke/api-reviewers.smoke.test.mjs
node --test --test-name-pattern "provider_unavailable|packet recovery|source-sent|source sent|fetch failure after source receipt|review_not_completed" tests/smoke/api-reviewers.smoke.test.mjs tests/unit/docs-contracts.test.mjs tests/unit/provider-route-policy.test.mjs tests/unit/review-panel.test.mjs
npm run lint:sync
git diff --check
npm test
node --test --test-name-pattern "Grok CLI timeout escalates when source-bearing process ignores SIGTERM" tests/smoke/grok-web.smoke.test.mjs
```

Results:

- Focused Direct API provider-unavailable tests: 2 passed, 0 failed.
- Focused schema plus Direct API tests: 3 passed, 0 failed.
- Broader packet recovery/provider-unavailable targeted tests: 16 passed,
  0 failed.
- `npm run lint:sync`: passed.
- `git diff --check`: passed.
- `npm test`: 2226 passed, 12 skipped, 1 failed in the existing Grok CLI
  timeout escalation smoke test. The failing test passed when rerun in
  isolation, so this is recorded as a full-suite residual rather than evidence
  against the Direct API recovery delta.

External review follow-up:

- Grok CLI job `job_36de4da7-e5cb-47a5-ada0-d058b0f020cd` approved the
  Direct API provider-unavailable delta with non-blocking coverage suggestions.
- Claude job `95c3b411-c0cd-4fa7-8a3d-d52f9712b960` returned an approving raw
  review but was correctly recorded as a failed slot because the review-quality
  parser classified a packet-only helper caveat as `not_reviewed`.
- That Claude failure exposed an additional no-mistakes gap: provider packet
  reviewers can phrase a valid out-of-scope helper limitation as "not in packet"
  or "outside the packet". The shared review-quality parser now accepts that
  wording when the declared selected source was inspected.

Additional verification after the review-quality fix:

```sh
node --test --test-name-pattern "packet-only helper caveats" tests/unit/review-prompt.test.mjs
node --test tests/unit/review-prompt.test.mjs
node --test --test-name-pattern "direct API (HTTP provider_unavailable under Codex|fetch failure after source receipt)|packet recovery schema keeps" tests/smoke/api-reviewers.smoke.test.mjs tests/unit/docs-contracts.test.mjs
npm run lint:sync
```

Results:

- Packet-only helper caveat RED: failed before the parser fix across all six
  review-prompt modules.
- Packet-only helper caveat GREEN: 6 passed, 0 failed.
- Full review-prompt unit suite: 280 passed, 0 failed.
- Focused Direct API/schema regression suite: 3 passed, 0 failed.
- `npm run lint:sync`: passed.

Combined exact-head review follow-up:

- Grok CLI job `job_1a478574-0f57-4918-9227-115b68f06837` approved the combined
  `d264e59..dea26f1` delta.
- Claude job `cee97fc6-1378-42bb-b900-9c9eca4a5472` returned an approving raw
  review, but the persisted slot failed because review-quality parsing treated
  a negated classifier-analysis sentence as selected-source non-inspection.
- Local reparse of that stored Claude result now returns
  `semantic_failure_reasons:[]` and `failed_review_slot:false` after the
  negated-analysis parser fix.

Additional verification after the negated-analysis fix:

```sh
node --test --test-name-pattern "negated selected-source suppression analysis" tests/unit/review-prompt.test.mjs
node --test tests/unit/review-prompt.test.mjs
node --test --test-name-pattern "direct API (HTTP provider_unavailable under Codex|fetch failure after source receipt)|packet recovery schema keeps" tests/smoke/api-reviewers.smoke.test.mjs tests/unit/docs-contracts.test.mjs
npm run lint:sync
```

Results:

- Negated-analysis RED: failed before the parser fix across all six
  review-prompt modules.
- Negated-analysis GREEN: 6 passed, 0 failed.
- Full review-prompt unit suite: 286 passed, 0 failed.
- Focused Direct API/schema regression suite: 3 passed, 0 failed.
- `npm run lint:sync`: passed.

## Post-Parser Prompt Routing Follow-up

Claude job `806fb8a7-ecfa-41e7-8e91-fbcdc57dfdaa` returned an approving raw
review after the negated-analysis fix, but still failed the persisted slot
because Claude attempted a denied `Read` against the original local worktree
path. This was not a new code-review finding; it was a review-runner UX gap.

Fix applied:

- Claude, Gemini, and Kimi now render the prompt repository field from
  provider-facing repository identity instead of the local absolute workspace
  root. Repos with a remote use git identity; repos without a remote use
  `local-workspace:<basename>`.
- This keeps provider-facing review evidence packet-relative while preserving
  local path diagnostics in the JobRecord for operator audit.
- Added smoke coverage and mock prompt-exclusion oracles so all three
  subscription CLI providers reject local workspace paths in generated review
  prompts.

Verification:

- RED repo-identity smoke failed for Claude, Gemini, and Kimi under the old
  prompt behavior.
- GREEN repo-identity smoke passed after the first fix with
  `{"ok":true,"providers":["claude","gemini","kimi"]}`.
- Claude approved the first delta in job `bfb867bd-14ce-4de5-9266-19e724c470d4`
  and noted the no-remote fallback edge. That edge was fixed.
- GREEN remote plus no-remote smoke passed after the follow-up fix with
  `{"ok":true,"cases":["remote","local"],"providers":["claude","gemini","kimi"]}`.
- Fresh post-ledger verification:
  - `git diff --check`: passed.
  - `npm run lint`: passed.
  - `node --test tests/unit/review-prompt.test.mjs`: 286 passed, 0 failed.
  - `node --test tests/smoke/claude-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs tests/smoke/kimi-companion.smoke.test.mjs`: 319 passed, 0 failed.
  - `npm test`: 2257 tests, 2245 passed, 0 failed, 12 skipped.
  - `npm run doctor:cache`: exited 0 with `"ok": false` because installed
    plugin cache still matches marketplace cache, not this unpublished feature
    branch.

Final prompt-routing review:

| Reviewer | Job | Source sent | Verdict | Blocking findings |
| --- | --- | --- | --- | --- |
| Claude | `14d778b6-3c33-469f-a52d-42626ddd45a3` | yes | APPROVE | none |
| Grok | `job_eae44931-c910-4176-9308-b03d783fc8e7` | yes | APPROVE | none |

Both final stored review records show completed status, no error, approved
review slots, clean review-quality audits, and no permission denials.

## Post-Final-Review Follow-up

After the final Claude/Grok review above, the branch added a narrow companion
pre-send boundary clarification:

- `ProviderRecoveryCapabilities` now records
  `local_source_packet_policy_pre_send:true` and
  `source_sent_runtime_failures_failed_slot:true`.
- #172 spec artifacts now state that local source-packet policy gates are
  pre-send, while provider-runtime failures discovered after companion launch
  remain source-sent failed slots.

Verification for this follow-up:

- RED contract/policy tests failed before the capability facts existed.
- `node --test tests/unit/docs-contracts.test.mjs tests/unit/provider-route-policy.test.mjs tests/unit/plugin-copies-in-sync.test.mjs`: 145 passed, 0 failed.
- `npm run lint:sync`: passed.
- `node --test tests/unit/review-prompt.test.mjs tests/unit/job-record.test.mjs`: 509 passed, 0 failed.
- `node --test tests/smoke/api-reviewers.smoke.test.mjs`: 170 passed, 0 failed.
- `node --test tests/smoke/grok-web.smoke.test.mjs`: 166 passed, 0 failed.

Exact-head review for this follow-up used base
`32d4018c07906cc09d3d5a5ede8c1042a487a502` and head
`0a9602c40d2e71fd1c85b2ca9f2b76e77ac8949b`.

| Reviewer | Job | Source sent | Verdict | Blocking findings |
| --- | --- | --- | --- | --- |
| Claude | `7859246b-cccc-4ee8-8578-9e54f7eac83f` | yes | APPROVE | none |
| Grok | `job_ce0df962-84bb-444e-9dd4-c679694b2c5c` | yes | APPROVE | none |

Grok's first default-cap attempt
`job_562396dc-00d1-404d-84cb-a16540f1ff64` failed before source send with
`prompt_too_large`; the successful review used explicit large-packet allowance.

Accepted Claude non-blocking findings after the exact-head review:

- `approval_tuple_fingerprint` schema now matches the structured runtime object
  emitted by `sourceSendApprovalTupleFingerprint`.
- Packet-recovery `reason` enum now allows retry fail-closed reasons emitted by
  the same-packet retry guard.
- `latestSourcePacketPreviousAttempt` now prefers the chronological latest
  source-bearing attempt when `started_at` is present, and JobRecord-derived
  previous attempts preserve `started_at`.
- The `ApprovalTuple` data-model entry now describes the runtime tuple fields
  (`source_packet`, `scope_resolution`, `scope_paths`, `request_settings`,
  route audit fields, and structured fingerprint) instead of stale hash-only
  names.

Verification for the post-review fixes:

- RED `node --test tests/unit/docs-contracts.test.mjs` failed on the stale
  fingerprint schema and missing retry reasons before the fix.
- RED `node --test tests/unit/provider-route-policy.test.mjs` failed on
  chronological latest-attempt selection before the fix.
- `node --test tests/unit/docs-contracts.test.mjs`: 41 passed, 0 failed.
- `node --test tests/unit/provider-route-policy.test.mjs`: 42 passed, 0 failed.
- `npm run lint:sync`: passed.
- `node --test tests/unit/plugin-copies-in-sync.test.mjs tests/unit/review-prompt.test.mjs tests/unit/job-record.test.mjs`: 573 passed, 0 failed.
- `node --test tests/smoke/api-reviewers.smoke.test.mjs`: 170 passed, 0 failed.
- `node --test tests/smoke/grok-web.smoke.test.mjs`: 166 passed, 0 failed.
- `node --test tests/smoke/claude-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs tests/smoke/kimi-companion.smoke.test.mjs`: 324 passed, 0 failed.

This post-review cleanup changes the branch after the exact-head review above;
the next external review must use the new head SHA.

## Final Delta Review Cleanup Follow-up

The first final-delta Grok review against head
`075beef7f80cb82dcfa27aeeb792eaf9395e2691` did not produce a usable approval:

- Grok `job_d638a729-eb98-49af-a89f-438d6c38194b`: source sent, failed slot,
  `privacy_persistence`.
- Runtime diagnostics showed `neutral_cwd_cleanup:"unverified"` and the reported
  `/var/folders/.../grok-cli-cwd-*` directory still existed with a copied repo
  snapshot, including `.git`.
- The leftover temp directory was removed after inspection and was not counted
  as approval evidence.

Root cause and fix:

- The Grok CLI runner used `rmdir(neutralCwd)`, which only succeeds for an empty
  directory. A source-bearing Grok CLI run can write files under the generated
  neutral cwd, so cleanup failed closed.
- `cleanupGrokCliNeutralCwd` now recursively removes only generated
  `grok-cli-cwd-*` directories directly under `tmpdir()`, then verifies the path
  no longer exists.
- The fingerprint schema also now allows string `auth_path` ingredients because
  `sourceSendApprovalTupleFingerprint` accepts string auth-path callers.

Verification:

- RED `node --test --test-name-pattern "non-empty Grok CLI neutral cwd" tests/smoke/grok-web.smoke.test.mjs` failed before the recursive cleanup fix.
- RED `node --test --test-name-pattern "runtime shard approval tuple shape" tests/unit/docs-contracts.test.mjs` failed before the auth-path schema relaxation.
- `node --test --test-name-pattern "non-empty Grok CLI neutral cwd" tests/smoke/grok-web.smoke.test.mjs`: passed.
- `node --test tests/unit/provider-route-policy.test.mjs`: 42 passed, 0 failed.
- `node --test tests/unit/docs-contracts.test.mjs tests/smoke/grok-web.smoke.test.mjs`: 207 passed, 0 failed.
- `npm run lint:sync`: passed.

Claude `7cb169a7-8b86-4784-a88a-93495333f15d` approved the prior delta with
source sent, but that review is stale after this cleanup. The next external
review must use the new head SHA.

## Final Delta Test-Hardening Follow-up

The later Grok cleanup-delta retry
`job_b9314978-ebf6-46f1-a5d1-4f93b8ae4930` sent source but failed as
`review_not_completed` / `not_reviewed`, so its raw `APPROVE` text is not
approval evidence. Its raw non-blocking note was valid: the branch covered
successful recursive cleanup of a non-empty neutral cwd, but did not separately
cover the new `unverified` cleanup-failure branch.

Follow-up:

- Added a fake Grok CLI option that creates an unreadable `blocked-cleanup`
  directory under the generated `grok-cli-cwd-*`.
- Added a smoke test proving that an unverified neutral cwd cleanup fails closed
  as `privacy_persistence`, records `neutral_cwd_cleanup:"unverified"`, keeps
  source transmission as `sent`, does not leak `CLI_SOURCE_SECRET`, and leaves
  the diagnostic cwd for manual cleanup.
- No production code changed in this follow-up.

Verification:

- RED `node --test --test-name-pattern "neutral cwd cleanup cannot be verified" tests/smoke/grok-web.smoke.test.mjs` failed before fake CLI support existed.
- `node --test --test-name-pattern "neutral cwd cleanup cannot be verified" tests/smoke/grok-web.smoke.test.mjs`: passed.
- `node --test --test-name-pattern "Grok CLI neutral cwd" tests/smoke/grok-web.smoke.test.mjs`: 2 passed, 0 failed.
- `node --test tests/smoke/grok-web.smoke.test.mjs`: 167 passed, 0 failed.

This test-only hardening changes the branch again after the prior final-delta
review attempts. Any final review must use the resulting head SHA.
