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
