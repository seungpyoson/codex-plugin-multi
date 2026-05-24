# Final External Review Results

Stage: code-bearing review refresh for PR code head `38d4c59`
Status: five provider approvals recorded for the code-bearing changes; final six-provider gate blocked on Claude local OAuth readiness or explicit operator waiver

## Review Packet

- Current-head focused source packet: branch-diff from `4ac2b89` to `38d4c59`.
- Latest focused packet for direct API/Grok/Kimi refresh: 22914 bytes across eight diff files, not full file bodies.
- Earlier packet before the Kimi missing-verdict repair follow-up: `/private/tmp/cpm-171-review/provider-architecture-parity-171-focused-current.diff` plus `/private/tmp/cpm-171-review/provider-architecture-parity-171-focused-evidence.md`, 165844 bytes across two files.
- Reason for focused packet: full `git diff origin/main` packet was 597224 bytes, above the shared 512 KiB source-packet budget; reviewers were therefore scoped to the current hardening delta instead of bypassing the new policy.

## Code-Bearing Review Results

| Provider | Result | Job | Source State | Notes |
| --- | --- | --- | --- | --- |
| Gemini | APPROVE | `c8515a3d-1338-411e-a675-8093967a94f5` | sent | No blocking findings. Non-blocking binary-diff concern acknowledged; shared `diffSourceFiles` owns diff rendering. |
| Grok | APPROVE | `job_69fb63bd-363b-40d7-a963-6d3d79df5d1b` | sent | `--transport auto` fell back from `grok_cli_login_required` to local web, selected `subscription_web`, no paid API fallback. |
| GLM | APPROVE | `job_25e493d7-93b9-4851-abee-dba13358ecfc` | sent | No blockers. Non-blocking cleanup notes only. |
| DeepSeek | APPROVE | `job_14c3e957-3395-4b0c-9035-b17cd155a04e` | sent | No blockers. Non-blocking cleanup notes only. |
| Kimi | APPROVE | `987ecc31-66af-49e4-8cfb-146ccd341827` | not_sent on continue | Initial code-bearing review job `4d7f6ddf-130a-46dd-850b-e70de3bbba98` hit `step_limit_exceeded` after source send. Continue used `resume_without_source_resend`, selected zero files, and returned APPROVE. |

## Unusable Slot

| Provider | Result | Job | Source State | Blocker |
| --- | --- | --- | --- | --- |
| Claude | FAILED | `850deefe-bf2f-4f11-a65c-d024a47f629c` | not_sent | `oauth_inference_rejected`: Claude Code non-interactive OAuth returned HTTP 401 before source delivery. |

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

Final six-provider approval is not complete because Claude failed before source send with local OAuth HTTP 401. The code-bearing changes have five usable approvals; subsequent PR-head changes are audit-evidence documentation only. Claude requires OAuth repair or an explicit operator waiver before the six-provider merge gate is satisfied.
