# Final External Review Results

Stage: focused current-delta review before Kimi missing-verdict repair follow-up
Status: blocked on latest-head review refresh and Claude local OAuth readiness

## Review Packet

- Scope: `/private/tmp/cpm-171-review/provider-architecture-parity-171-focused-current.diff`
- Evidence: `/private/tmp/cpm-171-review/provider-architecture-parity-171-focused-evidence.md`
- Packet size before the Kimi missing-verdict repair follow-up: 165844 bytes across two files
- Reason for focused packet: full `git diff origin/main` packet was 597224 bytes, above the shared 512 KiB source-packet budget; reviewers were therefore scoped to the current hardening delta instead of bypassing the new policy.

## Usable Results Before Kimi Repair Follow-Up

| Provider | Result | Job | Source State | Notes |
| --- | --- | --- | --- | --- |
| Gemini | APPROVE | `6b46794f-dfb3-40a4-b225-78c64a34bb6d` | sent | No blocking findings. |
| Grok | APPROVE | `job_70418f8e-008c-4785-b7f0-82e3908fb824` | sent | CLI transport, no web/API fallback used. |
| GLM | APPROVE | `job_17545183-a3b1-4852-8743-268587756869` | sent | No blocking findings. |
| DeepSeek | APPROVE | `job_84086e26-b4e5-489e-b99b-56e0336966fb` | sent | Raised non-blocking foreground/static guardrail concerns; addressed with stronger tests. |
| Kimi | APPROVE | `f82a94c5-5b7e-46dc-aca1-458371e47d52` | not_sent on continue | Initial job `5b2b6fca-7f0e-4918-80c8-9d264572ff9b` hit `step_limit_exceeded` after source send. Continue used `resume_without_source_resend` with zero selected-source bytes and returned APPROVE. |

## Unusable Slot

| Provider | Result | Job | Source State | Blocker |
| --- | --- | --- | --- | --- |
| Claude | FAILED | `4ab5a239-43e5-430e-bc33-596ccc7b0853` | not_sent | `oauth_inference_rejected`: Claude Code non-interactive OAuth returned HTTP 401 before source delivery. |

## Review Follow-Ups Addressed

- DeepSeek noted the static launch guard was stronger for background sidecars than foreground provider launch. Added foreground ordering checks and one-background-preflight-per-sidecar checks in `tests/unit/plugin-copies-in-sync.test.mjs`.
- Kimi noted the no-resend failure set should be proven a subset of resend-gated failures. Added a parsed set-subset guard in `tests/unit/plugin-copies-in-sync.test.mjs`.
- Kimi noted Grok source-bearing behavior was hardcoded. Changed Grok to derive source-bearing semantics from mode and added a guardrail that rejects hardcoded policy semantics.
- Live latest-delta Kimi testing exposed a second no-resend gap: after a no-source repair failed for `review_not_completed:missing_verdict`, the next continue could lose the original source-bearing attempt and resend source. The shared provider route policy now treats substantive invalid-verdict prose as no-source-repair eligible and carries the original source attempt through failed no-source repair chains. This applies through the shared policy used by Claude, Gemini, and Kimi continue paths.

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

Final six-provider latest-head approval is not complete until the latest PR head is reviewed after the Kimi repair fix and Claude is usable or explicitly waived by the operator. The earlier usable reviewers approved prior deltas after source-packet budget constraints were honored, but those approvals are not final merge evidence for the current head.
