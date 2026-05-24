# Final External Review Results

Stage: latest focused current-delta review
Status: blocked only on Claude local OAuth readiness

## Review Packet

- Scope: `/private/tmp/cpm-171-review/provider-architecture-parity-171-focused-current.diff`
- Evidence: `/private/tmp/cpm-171-review/provider-architecture-parity-171-focused-evidence.md`
- Packet size after final guardrail hardening: 165844 bytes across two files
- Reason for focused packet: full `git diff origin/main` packet was 597224 bytes, above the shared 512 KiB source-packet budget; reviewers were therefore scoped to the current hardening delta instead of bypassing the new policy.

## Usable Results

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

## Remaining Gate

Final six-provider latest-head approval is not complete until Claude is usable or explicitly waived by the operator. The five usable reviewers approved the focused current delta after source-packet budget constraints were honored.
