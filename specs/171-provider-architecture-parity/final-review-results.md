# Final External Review Results

Stage: exact-head review ledger for PR #175
Status: final six-provider gate is blocked after the Kimi prompt-only compatibility change; all prior approvals must refresh on the current PR head recorded in the PR body

## Review Packet

- Current code-delta focused source packet: branch-diff from `29832ae86c1f883dcdcb5e2732f4fb7a8b58aae7` to `249f80bf0b73c9b29db4b5f5e72d0e39c2715248`.
- Current Kimi compatibility follow-up delta starts at `cff8af84c54935b7f15ad3b88b29755240efae09` and ends at the current PR head recorded in the PR body.
- Most recent audit-only refresh target before this Kimi follow-up: `249f80bf0b73c9b29db4b5f5e72d0e39c2715248..cff8af84c54935b7f15ad3b88b29755240efae09`.
- Latest-delta refresh used branch-diff source packets from `29832ae86c1f883dcdcb5e2732f4fb7a8b58aae7` to `249f80bf0b73c9b29db4b5f5e72d0e39c2715248`; direct API approval preflights selected 18 files / 68,196 bytes / 1,324 lines, while the Kimi narrowed shard selected 4 files / 13,062 bytes / 309 lines.
- Earlier packet before the Kimi missing-verdict repair follow-up: `/private/tmp/cpm-171-review/provider-architecture-parity-171-focused-current.diff` plus `/private/tmp/cpm-171-review/provider-architecture-parity-171-focused-evidence.md`, 165844 bytes across two files.
- Reason for focused packet: full `git diff origin/main` packet was 597224 bytes, above the shared 512 KiB source-packet budget; reviewers were therefore scoped to the current hardening delta instead of bypassing the new policy.

## Latest-Delta Review Results

| Provider | Result | Job | Source State | Notes |
| --- | --- | --- | --- | --- |
| Claude | APPROVE | `ba6a2dad-4ca3-402b-a1f7-b0ddf7e8d099` | sent | No blocking findings on `29832ae..249f80b`. |
| Gemini | APPROVE | `19017086-9290-43ad-a9fc-ba22190a430d` | sent | No blocking findings on `29832ae..249f80b`. |
| GLM | APPROVE | `job_6975cf07-9a83-4408-b53f-15377dd2377e` | sent | No blockers on `29832ae..249f80b`. |
| DeepSeek | APPROVE | `job_697a7d54-a3dd-4d7f-a020-fba3fe8399e4` | sent | No blockers on `29832ae..249f80b`. |

## Blocked Or Missing Slots

| Provider | Result | Job | Source State | Blocker |
| --- | --- | --- | --- | --- |
| Kimi | FAILED | `08d2f957-bb06-4222-a15c-651691be8655`, `6cecf19f-2145-48d2-84b5-cd77bc09c835` | not_sent, then sent | Broad packet was blocked pre-source as `source_packet_too_large`; under-cap shard sent 13,062 bytes and became `stale_active_job` after 586,979 ms with no verdict. |
| Grok | NOT_SENT | n/a | not_sent | Sandbox rejected the source-bearing `--transport auto` latest-head review before source send for this private/not-verified-public repository. |

## Latest Audit-Only Refresh Attempt

| Provider | Result | Job | Source State | Notes |
| --- | --- | --- | --- | --- |
| Gemini | APPROVE | `34a2cb4c-b8f8-4404-89d8-53bf4e99572c` | sent | Approved `249f80b..cff8af8`; noted stale `d13ffdf` references as non-blocking because T042 tracked refresh. |
| Claude | APPROVE | `1741d272-6bb5-49d9-91ee-7d715270a848` | sent | Approved `249f80b..cff8af8`; flagged stale head wording and issue wording as non-blocking. |
| DeepSeek | APPROVE | `job_585f40d0-dea9-477f-8fb0-664a08b790ec` | sent | Approved `249f80b..cff8af8`; noted stale `d13ffdf` references. |
| GLM | REQUEST_CHANGES | `job_bea36418-91b1-4774-9cf2-f96e5a53f8eb` | sent | Blocking stale-head finding: audit docs called `d13ffdf` current while review head was `cff8af8`. |
| Grok | REQUEST_CHANGES | `job_262966a1-5c2d-4719-b82b-0f67d1dee268` | sent | Blocking stale-head finding matching GLM; Grok CLI was logged in and used `subscription_cli`, no fallback. |
| Kimi | FAILED | `db42549b-2bae-4430-8e1a-b5538c56b547` | sent | Failed as `usage_limited` after 668,215 ms; no verdict and no findings. |

## Historical Code-Bearing Review Results

Earlier head `38d4c59` had five recorded approvals, including a Kimi no-source continuation. That Kimi approval is now historical only: later raw no-tool continuation evidence showed Kimi does not retain selected source reliably, so PR #175 now models Kimi no-source repair as unsupported and requires a fresh Kimi verdict or waiver.

## Review Follow-Ups Addressed

- DeepSeek noted the static launch guard was stronger for background sidecars than foreground provider launch. Added foreground ordering checks and one-background-preflight-per-sidecar checks in `tests/unit/plugin-copies-in-sync.test.mjs`.
- Kimi noted the no-resend failure set should be proven a subset of resend-gated failures. Added a parsed set-subset guard in `tests/unit/plugin-copies-in-sync.test.mjs`.
- Kimi noted Grok source-bearing behavior was hardcoded. Changed Grok to derive source-bearing semantics from mode and added a guardrail that rejects hardcoded policy semantics.
- Live latest-delta Kimi testing exposed a second no-resend gap: after a no-source repair failed for `review_not_completed:missing_verdict`, the next continue could lose the original source-bearing attempt and resend source. The shared provider route policy now treats substantive invalid-verdict prose as no-source-repair eligible and carries the original source attempt through failed no-source repair chains. This applies through the shared policy used by Claude, Gemini, and Kimi continue paths.
- Latest-head direct API approval preflight exposed that DeepSeek/GLM branch-diff still rendered full HEAD file bodies. Direct API branch-diff now uses the shared `diffSourceFiles` diff-packet collector, with a static guardrail and smoke coverage proving the prompt contains `diff --git` instead of relying on full selected files.
- Latest-head Grok review refresh then exposed the same class of bug in Grok branch-diff: prompt preflight failed at 423,967 characters before source send because Grok still read full `HEAD:<path>` bodies. Grok branch-diff now uses the same shared `diffSourceFiles` collector and smoke coverage asserts the prompt contains `diff --git`.
- Gemini Code Assist reported an earlier `sourceTransmission` typo and missing `cli_request` diagnostics in Grok auto fallback prompt-size failures. Both threads are resolved on the PR branch: Grok now calls the shared `sourceContentTransmissionForExecution` path and preserves `diagnostics.cli_request` in the fallback `prompt_too_large` path.

## Latest-Delta Refresh Before Kimi Repair Fix

| Provider | Result | Job | Source State | Notes |
| --- | --- | --- | --- | --- |
| Gemini | APPROVE | `64bd7a45-3502-4bb1-bb3e-d64333a8cd3d` | sent | Approved head `4960b04`. |
| Grok | APPROVE | `job_f4d5576c-d915-4e54-a020-b5c2339bb29c` | sent | Used documented CLI-first `--transport auto` fallback after `grok_cli_login_required`; selected `subscription_web`, no paid API fallback. |
| GLM | APPROVE | `job_fd907985-a8c5-4ec4-9ec0-2cfb5036ea8f` | sent | Approved head `4960b04`. |
| DeepSeek | APPROVE | `job_928c3a99-acf9-45f8-9a91-0c2b9bff61ab` | sent | Approved head `4960b04`. |
| Kimi | FAILED | `11d68ea5-dfc8-4cc6-9347-d9cbd07bcba5`, `d7550c36-d32b-4ab1-afc3-f06c523e5757` | mixed | First continue was no-source and returned substantive APPROVE-like prose without a verdict marker. Second repair exposed the resend bug fixed by the current follow-up. |
| Claude | FAILED | `c5fdea86-8054-4d9f-9100-79a2511ca76b` | not_sent | `oauth_inference_rejected`: HTTP 401 before source delivery, zero token usage. |

## Remaining Gate

Final six-provider approval is not complete. The Kimi prompt-only compatibility change is a new code delta, so the current PR head recorded in the PR body needs fresh CI and all six external reviews. Kimi also requires quota recovery plus a usable verdict or explicit waiver. PR #175 remains draft and not merge-ready.
