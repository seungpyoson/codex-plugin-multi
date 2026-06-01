# Evidence Map: #147 Bounded Session Approval

## Live State Checked

- #147 is open and requests bounded session approval for Direct API source sends.
- Current main has per-request `approval-request` and tuple-bound `approval_token.value`.
- Current main does not contain `session_grant`, `approval_grant`, or grant id support in Direct API runtime/tests.
- Baseline on #147 worktree:
  - `npm run smoke:api-reviewers`: 160 passed, 0 failed
  - `npm test`: 2218 tests, 2206 passed, 12 skipped, 0 failed
- T005 RED:
  - `node --test --test-name-pattern "approval-grant request emits source-free bounded grant proof" tests/smoke/api-reviewers.smoke.test.mjs`
  - Failed as expected with `unknown_command:approval-grant`.
- T006 GREEN:
  - Same focused command.
  - Passed with source-free grant request output, `approval_scope:"grant"`, `grant_bounds.expires_at`, no normal `approval_token`, no selected source body, no credential, and no raw workspace path in output.
- T007 RED:
  - `node --test --test-name-pattern "approval-grant activate" tests/smoke/api-reviewers.smoke.test.mjs`
  - Failed as expected because activation returned no `approval_required` error code for wrong expiry and session/once tokens.
- T008 GREEN:
  - Same focused command.
  - Passed with exact request-expiry validation and rejection of normal session and once approval tokens without creating `approval-grants`.
- Explicit TTL hardening:
  - RED: `node --test --test-name-pattern "approval-grant request requires explicit TTL" tests/smoke/api-reviewers.smoke.test.mjs` initially returned a grant with implicit TTL.
  - GREEN: same command passed after removing the hidden default and requiring `--grant-ttl-ms`.
- Configured TTL ceiling hardening:
  - RED: targeted focused test failed while the expectation still assumed an unqualified hard-coded maximum string after moving the runtime ceiling to config.
  - GREEN: `node --test --test-name-pattern "approval-grant request emits source-free bounded grant proof|approval-grant request rejects TTL above maximum|bounded session approval grant schema" tests/smoke/api-reviewers.smoke.test.mjs tests/unit/docs-contracts.test.mjs`
  - Passed with `grant_bounds.max_ttl_ms` sourced from `plugins/api-reviewers/config/session-approval.json`; schema no longer duplicates the numeric ceiling.
- T009 RED:
  - `node --test --test-name-pattern "approval-grant activate persists strict idempotent grant file" tests/smoke/api-reviewers.smoke.test.mjs`
  - Failed as expected with `approval_grant_activation_pending`.
- T010/T011 GREEN:
  - Same focused command passed after persisting owner-only deterministic grant files.
  - Privacy sub-check caught and fixed token-value persistence by separating `approval_fingerprint` from `grant_approval_token.value`.
- T012/T014 RED:
  - `node --test --test-name-pattern "run uses matching session grant" tests/smoke/api-reviewers.smoke.test.mjs`
  - Failed as expected with `approval_required` because run-time grant lookup/audit fields were missing.
- T013/T015 GREEN:
  - Same focused command passed after adding active grant lookup, exact canonical tuple matching, and `approval_source:"session_grant"` / `approval_grant` audit fields.
- US3 mismatch coverage:
  - `node --test --test-name-pattern "session grants fail closed on provider" tests/smoke/api-reviewers.smoke.test.mjs`
  - Passed for provider, mode, workspace, scope path, literal `scope_paths:null` not acting as wildcard, source content, prompt, request timeout, expiry, projection mismatch, schema-extra-field, malformed JSON, timestamp format, and tampered fingerprint.
  - The schema-extra-field and timestamp-format cases both produced RED failures before strict grant-loader validation was added.
- Additional US3 coverage:
  - `node --test --test-name-pattern "approval-grant activate persists|run uses matching session grant|multiple active matches|grant approval token as normal|session grants are bound to auth" tests/smoke/api-reviewers.smoke.test.mjs`
  - Passed for matching run success, duplicate/multiple-match fail-closed behavior, grant-scoped token rejection in normal `run --approval-token`, and auth/billing/route fallback binding.
- Docs/contract coverage:
  - `node --test --test-name-pattern "bounded session approval grant schema|direct API docs describe bounded session grants|help malformed providers" tests/unit/docs-contracts.test.mjs tests/smoke/api-reviewers.smoke.test.mjs`
  - Passed for strict grant schema docs, direct API session-grant operator docs, and help command list.
- Final local verification:
  - `node --test --test-name-pattern "approval-grant|session grants|bounded session approval grant schema|direct API docs describe bounded session grants|help malformed providers" tests/smoke/api-reviewers.smoke.test.mjs tests/unit/docs-contracts.test.mjs`: 13 passed, 0 failed.
  - `npm run smoke:api-reviewers`: 172 passed, 0 failed.
  - `npm test`: 2232 tests, 2220 passed, 12 skipped, 0 failed. First run caught a stale manifest test missing `approval-grant`; rerun passed after updating `tests/unit/manifests.test.mjs`.
  - `npm run lint`: passed.
  - `git diff --check`: passed.
- Final external review:
  - Claude custom-review job `616dd0e1-e67a-4401-ab39-bb205438802e`: completed, APPROVE, no blocking findings.
  - Grok custom-review job `job_f1cca318-f2b3-40cb-a90c-66b1c340565b`: completed, APPROVE, no blocking findings.
  - Non-blocking notes are recorded in `specs/147-bounded-session-approval/final-review-results.md`.
- PR opened:
  - #186: `https://github.com/relay-org/relay/pull/186`

## Existing Evidence on Main

| Requirement Area | Current Evidence | Verdict |
| --- | --- | --- |
| Source-free approval request | `approval-request` tests assert `source_content_transmission:"not_sent"` | Complete groundwork |
| Tuple-bound approval token | Tests cover provider, mode, source packet, prompt, request, auth, billing mismatches | Complete groundwork |
| One-time token replay prevention | `approval_scope:"once"` smoke test | Complete groundwork |
| Reusable bounded grant | No grant id/store/session grant fields found | Missing |
| Auto-approval without per-run token | No runtime grant lookup exists | Missing |
| Grant-specific audit source | No `approval_source:"session_grant"` field exists | Missing |
| Expiry and max bounds | No grant TTL/max-files/max-bytes logic exists | Missing |

## Issue Matrix

| Issue | State | Current Verdict | Smallest Valid Next Action | Risk if Grouped Incorrectly |
| --- | --- | --- | --- | --- |
| #172 large packets | Open, PR #185 green | PR exists, not merged; outside #147 branch | Wait for merge or keep separate | Rebase conflict or duplicated recovery work |
| #147 bounded session approval | Open | Still missing | Implement grant workflow with TDD | Weakening source-egress safety |
| #159 Grok architecture | Open | Broader P2 architecture remains | Separate plan after #147/#160 as directed | Swallows #147 into Grok-specific design |
| #160 stale env | Open | Partial env-cache fallback evidence exists; acceptance needs audit | Separate completion audit | Duplicates or overclaims completed work |
| #144 API rescue | Open | Not implemented | Separate rescue design | Adds write-capable behavior to review-only grant work |
| #178 parity analyzer | Open, not in saved prompt | Adjacent follow-up | Report only unless prompt scope changes | Expands current work beyond target list |
| #179 mode/feature parity | Open, not in saved prompt | Adjacent follow-up | Report only unless prompt scope changes | Expands current work beyond target list |

## Proof Required Before Marking #147 Complete

- RED/GREEN evidence for grant request.
- RED/GREEN evidence for grant activation.
- RED/GREEN evidence that activation reuses the request `grant_bounds.expires_at` instead of recomputing expiry.
- RED/GREEN evidence for matching grant-approved source send without `--approval-token`.
- RED/GREEN evidence for provider, mode, workspace, source path, source content, prompt, request, auth, billing, selected route, route step, route steps, fallback reason, expiry, file-count, byte-count, schema, fingerprint, and multiple-match mismatches.
- RED/GREEN evidence for canonical JSON determinism and grant-scoped token rejection in normal `run --approval-token` execution.
- Existing per-request approval-token tests still pass.
- Privacy assertions prove no source body, raw prompt body, token value, or secret is persisted.
- `npm run smoke:api-reviewers`, `npm test`, `npm run lint`, and `git diff --check` pass.
- Pre-implementation and final external review gates have usable verdicts or explicit operator decision for non-usable slots.
