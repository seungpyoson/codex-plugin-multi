# Final External Review Results

Stage: completed #171 audit/implementation review  
Whole packet root: `/private/tmp/cpm-171-whole-review/`  
DeepSeek shard root: `/private/tmp/cpm-171-deepseek-shards/`  
Safety: DeepSeek/GLM approval-request artifacts were generated and retained in
the packet directories; approval token values are not recorded here.

## Reviewed Packet

The current final review packet is `/private/tmp/cpm-171-whole-review/packet.md`.
It covered the whole uncommitted #171 branch delta: 62 tracked changed files,
12 untracked Speckit/audit files, local verification output, cache-doctor
output, and embedded Speckit artifacts.

DeepSeek could not produce a usable verdict on the 252265-byte whole packet, so
the same whole-change coverage was split into three DeepSeek shards:

- `01-runtime-contract-tests.md` (47845 bytes): Grok runtime/control-flow,
  targeted smoke coverage, shared contract tests, and generated contract logic.
- `02-generated-provider-docs.md` (117739 bytes): generated provider commands,
  skills, README, CLAUDE.md, and Grok subscription transport docs.
- `03-speckit-evidence.md` (92267 bytes): Speckit spec, plan, tasks, evidence,
  provider parity table, final review notes, and completion audit.

## Final Verdicts

| Reviewer | Job | Status | Source | Verdict | Notes |
| --- | --- | --- | --- | --- | --- |
| Claude | `866761d2-97bb-41dc-b4ca-53d95cec2a9d` | completed | sent | APPROVE | Whole packet, 252265 bytes. |
| Gemini | `0ff12d19-5564-4992-95a5-42aa80266d8f` | completed | sent | APPROVE | Whole packet, 252265 bytes. |
| Grok | `job_0930b0d2-58e1-4ef4-a6bc-9fa9b0078efe` | completed | sent | APPROVE | Whole packet, 252265 bytes, subscription CLI transport. |
| GLM | `job_5deac4e2-7784-48fa-996e-2ae080bfa3ed` | completed | sent | APPROVE | Whole packet, 252265 bytes, HTTP 200. |
| Kimi | `d9d61eb1-aebd-4c45-b6b2-2e46933e8abf` | failed | sent | failed_slot | Whole packet step limit exceeded; not counted as approval. |
| Kimi | `1735bd1c-a8c4-4b10-a7fc-c712ecf8d4be` | completed | sent | APPROVE | Whole packet retry with 64 steps. |
| DeepSeek | `job_2e9258a3-72c7-4c23-a4b1-36276fadae54` | failed | not_sent | failed_slot | Whole packet attempt 1 failed with provider_unavailable HTTP 504. |
| DeepSeek | `job_e4b0ec88-b4d4-4cc7-bf47-6d618da635a3` | failed | not_sent | failed_slot | Whole packet retry 1 failed with provider_unavailable HTTP 504. |
| DeepSeek | `job_ae16669d-9e0b-4edc-88ef-cf80270fff74` | failed | sent | failed_slot | Whole packet retry 2 returned HTTP 200 but no verdict (`review_not_completed:missing_verdict`). |
| DeepSeek | `job_8a6e4d77-3134-4c5e-b515-00431308f0e2` | completed | sent | APPROVE | Shard 1/3: runtime, contract logic, tests. |
| DeepSeek | `job_43f8cb95-ab12-4b58-b294-568d0a859450` | completed | sent | APPROVE | Shard 2/3: generated provider docs and skills. |
| DeepSeek | `job_f9d65ae3-330b-4b0b-8030-13020479f862` | completed | sent | APPROVE | Shard 3/3: Speckit evidence, parity table, audit artifacts. |

Gate result: PASSED. Usable APPROVE verdicts were obtained from Claude,
Gemini, Grok, GLM, and Kimi on the whole packet. DeepSeek approved three
shards whose combined coverage is the whole #171 branch delta.

## Blockers Fixed Before Final Approval

- Earlier DeepSeek final shard 1 found generated Grok contract docs missing
  `--transport auto`; generated docs were updated through the sync path.
- Earlier Grok final shard 2 found the top-level Grok JobRecord did not expose
  `transport`; the runtime now records the selected transport at the top level.
- Earlier DeepSeek final3 shard 1b found stale runbook/module references to direct
  `grok-web-reviewer.mjs` use; docs and parity evidence were aligned to the
  canonical Grok companion entrypoint.

## DeepSeek Whole-Packet Failure Analysis

DeepSeek whole-packet failures were reviewer/provider failures, not approvals:

- First attempt and first retry returned HTTP 504 before source transmission.
- Second retry returned HTTP 200 and sent source, but the result was empty and
  failed review quality with `missing_verdict`.
- The successful shard results show the same reviewer can approve smaller
  packets, so the failure was packet/provider behavior, not an identified code
  blocker.

## Post-Review Follow-Up Metadata

Issue #173 is intentionally separate: Claude subscription CLI `custom-review`
can still send full selected-source packets without a pre-launch
budget/resend-confirmation gate. That issue is not counted as #171 completion.
