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
