# External Plan/Tasks Review Results

Stage: pre-implementation plan/tasks review  
Packet: `CLAUDE.md` plus `specs/171-provider-architecture-parity/`  
Safety: DeepSeek/GLM approval-request artifacts were generated in `/private/tmp/cpm-171-plan-review/`; approval token values are not recorded here.

## Plan-Gate Revised Packet Integrity

This table records the plan/tasks packet that external reviewers approved before
implementation. It is historical review evidence, not a live hash assertion for
post-final-review metadata edits such as the later #173 follow-up split.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `CLAUDE.md` | 1459 | `fe4aec10fb04aa842f49b36bcb1f75a401f94b218674408db3e43704e1071184` |
| `specs/171-provider-architecture-parity/evidence-map.md` | 11250 | `9a3b54e422d863316402c54b0a01f22d38e740ce8ba3ae06da1f6a8532585232` |
| `specs/171-provider-architecture-parity/spec.md` | 8795 | `fb3751c8e872e5f4eaf91378b7dc4e04ef36b0efd2939b992844fb66339d4a3e` |
| `specs/171-provider-architecture-parity/plan.md` | 6096 | `81960a5361945f616783b5d95af513b7c2096c56da45c09e9a84571a611fef76` |
| `specs/171-provider-architecture-parity/research.md` | 3251 | `ae9348c4b981f827c697f57fe1c485cfadc7b2d1107b8a0fc94025dc9fbe062c` |
| `specs/171-provider-architecture-parity/data-model.md` | 4007 | `6ec7beb916608f936ddd657a172a344b13eb2db48e622e7b9f8e90bc90aa1e17` |
| `specs/171-provider-architecture-parity/contracts/provider-parity-table.schema.json` | 5066 | `18102ca5641deb9b3635f9224448c14806ff4a12be8dd55eb6dec70b5b505780` |
| `specs/171-provider-architecture-parity/quickstart.md` | 3473 | `361abf7f7808461624b1909fdc157d43728e5f0682ad5ba6d27b2e29767d459a` |
| `specs/171-provider-architecture-parity/tasks.md` | 7876 | `97e0a4bd8a7f2be93f10291b19b09d174e8bda7d27ddf762e94beb50c75d1411` |
| `specs/171-provider-architecture-parity/review-results.md` | self-referential | excluded from its own hash assertion |

## First Pass

| Reviewer | Job | Status | Source | Verdict | Action |
| --- | --- | --- | --- | --- | --- |
| Claude | `20ae79bb-3ee9-45cc-a840-387d1fcd0e46` | completed | sent | APPROVE | Keep non-blocking caveat: source-code evidence was not independently reviewed in that packet. |
| Gemini | `fefdde12-326c-4c3b-a8a9-6506f0bb5e83` | completed | sent | REQUEST_CHANGES | Add Grok runtime fallback slice, full-test final gate, and schema/data-model reconciliation. |
| Grok | `job_f25a9b70-c67a-472d-9442-486bdddfb0e5` | completed | sent | APPROVE | No blocking changes. |
| GLM | `job_cdb30449-4ba1-4c72-ba36-52e80f85c2fa` | completed | sent | APPROVE | No blocking changes. |
| DeepSeek | `job_a2f0a90b-dcc2-444f-a4d0-37892e00a341` | completed | sent | REQUEST_CHANGES | Make parity table machine-validatable JSON, pin exact guardrail fields/interfaces, and record packet integrity. |
| Kimi | `3a99de56-a3b7-4bd5-a9b5-fc301b016cd9` | failed | sent | failed_slot | Retry with revised/narrower packet or higher step budget; failed slot is not approval. |

Gate result: FAILED. No implementation may start.

## Blocking Changes Applied To Plan Packet

- Canonical parity artifact is now `provider-parity-table.json`, validated by `contracts/provider-parity-table.schema.json`.
- Tasks now require packet file list, byte counts, and SHA-256 hashes.
- Guardrail tests now pin exact audit/status fields and exact shared interfaces.
- Final verification now includes `npm run test:full` before PR/merge-readiness.
- Grok docs-only classification was replaced with a TDD runtime slice for explicit `auto` transport, CLI-primary behavior, audited web fallback, terminal plain-CLI behavior, and no paid xAI API fallback.

## Revised Gate

Rerun all six reviewers after this file and the revised plan packet are included. A Kimi retry should use a narrower source packet or higher step budget; it must still produce a usable verdict to count.

## Second Pass

| Reviewer | Job | Status | Source | Verdict | Action |
| --- | --- | --- | --- | --- | --- |
| Claude | `4256a610-ebdd-4893-8148-f861fdfcf767` | completed | sent | APPROVE | Non-blocking data-model/schema polish noted. |
| Gemini | `2d98843f-d5bb-44ee-a210-cfd9c8ab92d9` | completed | sent | APPROVE | No blockers. |
| Grok | `job_66180815-c17d-40ea-abd9-e35a1e190666` | failed | sent | REQUEST_CHANGES | Add packet-budget policy-area coverage and align `verification`/`guardrail_tests` data model with schema. |
| GLM | `job_a14dc2c5-5964-497c-a74b-9f991da33515` | completed | sent | APPROVE | Non-blocking data-model/schema polish noted. |
| DeepSeek | `job_5f40bcbc-c16d-4478-80c9-bdbfb953e3fd` | completed | sent | APPROVE | Non-blocking policy-area completeness and fallback class precision noted. |
| Kimi | `5d05db73-b252-4290-8d02-87328d458abe` | failed | sent | failed_slot | Timed out with `target CLI exceeded the configured timeoutMs`; no verdict. |

Gate result: FAILED. No implementation may start.

## Blocking Changes Applied After Second Pass

- T016 now requires the JSON parity table to cover every FR-002 policy area, including packet budgets, with #172 as the allowed follow-up when deferral is evidence-backed.
- `data-model.md` now defines `verification` as an array, adds `guardrail_tests` to the top-level table, and defines the Verification Evidence item shape.
- Provider exceptions now permit either a follow-up issue or an explicit null reason when no follow-up issue is needed.

## Third Gate Plan

Rerun Grok after the second-pass blockers are addressed. Kimi has failed twice on the full packet; use a narrower Kimi packet focused on `spec.md`, `plan.md`, `tasks.md`, `data-model.md`, `contracts/provider-parity-table.schema.json`, and `review-results.md` unless the operator requests another full-packet attempt.

## Third Pass

| Reviewer | Job | Status | Source | Verdict | Scope |
| --- | --- | --- | --- | --- | --- |
| Grok | `job_2a8fd54c-6d69-42a7-a08b-6871d92f2bba` | completed | sent | APPROVE | Focused packet: `spec.md`, `plan.md`, `tasks.md`, `data-model.md`, schema, `review-results.md`. |
| Kimi | `c4b3d0ec-7d08-4fc6-a764-b4bd296c01d8` | completed | sent | APPROVE | Focused packet: `spec.md`, `plan.md`, `tasks.md`, `data-model.md`, schema, `review-results.md`. |

Gate result: PASSED for pre-implementation planning. Current usable approvals:

- Claude v2: APPROVE
- Gemini v2: APPROVE
- Grok v3: APPROVE
- GLM v2: APPROVE
- DeepSeek v2: APPROVE
- Kimi v3: APPROVE

Implementation may start, constrained to the approved plan and TDD tasks.

## Post-Final-Review Follow-Up Split

After the #171 final implementation review, a separate Claude usage-limit
investigation reproduced a narrower packet-budget root cause in Claude
subscription CLI `custom-review`: explicit scoped custom-review jobs can fall
back to full selected-source bodies and launch without a pre-launch packet budget
or resend-confirmation gate. Grok adversarial review approved the narrowed
problem definition in `job_36627cf7-dfe5-40e8-8a5f-2567bdd318a2`, and issue #173
now tracks that Claude-specific fix. #172 remains the broader large-packet
routing/chunking follow-up.
