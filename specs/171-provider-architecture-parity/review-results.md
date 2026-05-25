# External Plan/Tasks Review Results

Stage: revised pre-implementation root-problem/spec/plan/tasks review
Status: passed - current pre-implementation gate has six usable approvals

Latest note: `spec.md`, `plan.md`, and `tasks.md` were revised after partial
reviews to address clarity concerns, reduce prose, record the stale Kimi
task-review result, and then obtain a compact Kimi task-list approval. Existing
approvals are therefore evidence for problem direction, not final current-file
approval. A current four-file packet review then failed because Grok requested
changes and Kimi timed out after source send. The Grok blocker was applied to
`tasks.md`; the updated `plan.md`/`tasks.md` delta then received six usable
APPROVE verdicts. Since `root-problems.md` and `spec.md` were unchanged after
their current approvals, the pre-implementation gate is passed by current-file
coverage.

## Stale Historical Reviews

Prior review rounds approved the older #175 plan: provider parity table,
contract guardrails, and Grok auto fallback. Those approvals are not valid for
the corrected requirement because they did not review exact shared policy parity
for all six providers.

Stale gate summary:

- Claude: prior approval, stale.
- Gemini: prior approval, stale.
- Grok: prior approval, stale.
- GLM: prior approval, stale.
- DeepSeek: prior approval by shards, stale.
- Kimi: prior approval after retry, stale.

Reason stale:

- DeepSeek/GLM API-only path was treated as compliant instead of as an
  unproven capability fact in a shared route ladder.
- Kimi subscription-only behavior was not challenged as route-ladder drift.
- OpenRouter was not modeled as the third route step for all six providers.
- Packet budget/resend policy was split into follow-ups instead of owned by
  #171 shared policy.

## Revised Review Packet

Required files:

```text
specs/171-provider-architecture-parity/root-problems.md
specs/171-provider-architecture-parity/spec.md
specs/171-provider-architecture-parity/plan.md
specs/171-provider-architecture-parity/tasks.md
specs/171-provider-architecture-parity/evidence-map.md
specs/171-provider-architecture-parity/research.md
specs/171-provider-architecture-parity/data-model.md
specs/171-provider-architecture-parity/provider-parity-table.json
specs/171-provider-architecture-parity/quickstart.md
```

Reviewer instruction:

```text
Adversarial review of revised #171 provider architecture parity root problems,
spec, plan, and tasks. Required architecture: same provider policy Interface
for Claude, Gemini, Kimi, Grok, DeepSeek, and GLM. Same route ladder:
subscription -> direct API -> OpenRouter. Same source packet budget/resend
policy. Same auth/readiness, status, failure taxonomy, review-quality, audit,
docs, and sync policy. Provider differences allowed only as evidence-backed
Adapter capability facts. Verdict must be APPROVE or REQUEST_CHANGES.
```

## Revised Gate Results

| Reviewer | Job | Status | Source | Verdict | Notes |
| --- | --- | --- | --- | --- | --- |
| Claude | `9a59374a-9169-4875-9b31-9863141a331f` | completed | sent | APPROVE | Latest revised packet approved; non-blocking concerns only. |
| Gemini | `5f28d958-3d9e-4c66-840d-e2dfcc2e4fc2` | completed | sent | APPROVE | Approved after `attempted_route` and `skipped_reason` were added to the guardrail inventory. |
| Grok | `job_2670a90b-1114-4a62-ba92-ec6c0791120c` | completed | sent | APPROVE | Usable approval; external-scope caveats recorded as non-blocking. |
| GLM | `job_2b23f2e2-f8cb-41b5-b7cf-40cb9b03f7da` | completed | sent | APPROVE | Retry produced a usable approval after first GLM result used non-contract labels. |
| DeepSeek | `job_da257d59-7333-43c8-bcc1-515b8bb63035` | completed | sent | APPROVE | Usable approval. |
| Kimi | mixed; see below | partial | sent | partial APPROVE only | `root-problems.md`, `spec.md`, compact `plan.md`, and compact `tasks.md` each received usable APPROVE verdicts in separate single-file reviews. Current full-packet approval is still missing. |

Gate result: FAILED. Five reviewers produced usable APPROVE verdicts for an
earlier revised packet. Kimi approved the compact task list, but no reviewer has
approved the final current packet after all edits. Implementation remains
blocked until the current packet receives all six approvals.

## Kimi Attempts

| Job | Packet | Result | Evidence |
| --- | --- | --- | --- |
| `d919f5de-1390-4e9a-b3c4-a8e063a01f99` | Full revised packet before Gemini fix | cancelled | Source had been sent; packet became stale after Gemini requested a guardrail fix. |
| `3040d5d9-469a-49c0-9b7f-39cbb58aa3fb` | Four-file latest packet | cancelled | Source had been sent; run produced no usable verdict and required manual process termination after companion cancel could not verify PID because `ps` was denied. |
| `abdc226d-d5b1-4b12-b19a-f7cf9eb6cb69` | Minimal one-file `provider-parity-table.json` packet | failed | Source sent; timeout after 257,212 ms, no stdout/stderr, no verdict. |
| `a2578a28-aec1-4ab2-b8d9-77b6e45516fc` | Single-file `root-problems.md` packet | completed | Source sent; APPROVE; reviewed only root-problems. |
| `6b5f8b7d-0116-4b96-adcd-4c9a5187dbdd` | Single-file `spec.md` packet | completed | Source sent; APPROVE; reviewed only spec, with non-blocking clarity concerns. |
| `3c39881a-2875-4ba8-a785-ae3bcca4c2f8` | Single-file old `plan.md` packet | failed | Source sent; timeout after 904,740 ms, no stdout/stderr, no verdict. |
| `7a870d59-edab-4a49-b968-fa44136080b9` | Single-file compact `plan.md` packet | completed | Source sent; APPROVE; reviewed compact plan. |
| `c14df593-ce72-4a5a-ba3e-0a1e20b80227` | Single-file old `tasks.md` packet | stale | Source sent; worker exceeded 900,000 ms timeout plus 30,000 ms grace, no stdout/stderr, no verdict. |
| `4ad59213-96b4-40a4-9f03-6f7e04ab3504` | Single-file compact `tasks.md` packet | completed | Source sent; APPROVE; reviewed compact task list. |
| `ea4c9156-8a96-449f-ac99-2c87ad52d57b` | Four-file current packet before Grok fix | failed | Source sent; timeout after 907,148 ms, no verdict. |

## Current Packet Round Before Grok Fix

Reviewed files: `root-problems.md`, `spec.md`, `plan.md`, `tasks.md`.

| Reviewer | Job | Status | Verdict | Notes |
| --- | --- | --- | --- | --- |
| Claude | `9e6ed781-39a6-49ac-b757-3363d6c07af0` | completed | APPROVE | Non-blocking concerns only; scope gaps for out-of-packet artifacts. |
| Gemini | `fb2cc595-2f5c-4603-8776-b445d1bd30d1` | completed | APPROVE | No blocking findings. |
| Grok | `job_22d2588b-f333-451c-9af2-ed0588daab07` | completed | REQUEST_CHANGES | Phase 7 tasks missed explicit full-policy tests/interface coverage for readiness/auth/status/failure/review-quality/audit/docs/sync. |
| GLM | `job_05e2d498-8686-4c0c-b0d2-3208ec0dc387` | completed | APPROVE | Non-blocking concerns only. |
| DeepSeek | `job_1cf945f8-ba4c-4eb3-8b05-88e4e30484b4` | completed | APPROVE | Non-blocking concerns only. |
| Kimi | `ea4c9156-8a96-449f-ac99-2c87ad52d57b` | failed | failed_slot | Source sent; wall-clock timeout; no verdict. |

Gate result for this round: FAILED. Grok's blocking finding was applied to
`tasks.md`. Kimi's timeout is additional evidence that combined source-bearing
packets are not reliable for this provider under the current policy.

## Delta Round After Grok Fix

Reviewed files: updated `plan.md` and `tasks.md`. `root-problems.md` and
`spec.md` were unchanged from their current approvals.

| Reviewer | Job | Status | Verdict | Notes |
| --- | --- | --- | --- | --- |
| Claude | `6b498796-0f9b-403b-96d2-2b3b8f6b0ba7` | completed | APPROVE | No blocking findings. |
| Gemini | `45f02f60-56c1-47c4-9c1d-746ab8bb1402` | completed | APPROVE | No blocking findings. |
| Grok | `job_6999f0a2-3ea8-4ba9-9441-d680f9902a98` | completed | APPROVE | Confirms prior Phase 7 blocker is addressed. |
| GLM | `job_b166c0cd-948d-49e7-80a6-0b85d0f9d6e8` | completed | APPROVE | Non-blocking concerns only. |
| DeepSeek | `job_28a187bc-b350-46b3-9b3e-037ad46de2ac` | completed | APPROVE | Non-blocking concerns only. |
| Kimi | `5eaf99d9-f3b7-490a-82c6-a2d22889e2fa` | completed | APPROVE | No blocking findings. |

Gate result: PASSED for pre-implementation planning. Implementation may start,
but remains constrained to the approved #171 shared-policy scope and TDD task
order.
