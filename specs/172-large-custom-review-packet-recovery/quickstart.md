# Quickstart: Large Custom-Review Packet Recovery

## Pre-Code Review Packet

Review these planning artifacts before runtime code:

```sh
specs/172-large-custom-review-packet-recovery/spec.md
specs/172-large-custom-review-packet-recovery/plan.md
specs/172-large-custom-review-packet-recovery/tasks.md
specs/172-large-custom-review-packet-recovery/data-model.md
specs/172-large-custom-review-packet-recovery/quickstart.md
specs/172-large-custom-review-packet-recovery/evidence-map.md
specs/172-large-custom-review-packet-recovery/plan-review-results.md
specs/172-large-custom-review-packet-recovery/contracts/packet-recovery.schema.json
```

Required verdict: usable APPROVE from Claude, Gemini, Grok, GLM, DeepSeek, and
Kimi before implementation.

## Baseline Focused Check

```sh
node --test --test-name-pattern "source packet|source-packet|custom-review rejects|prompt exceeds cap|prompt cap|sharding_plan|over-budget" tests/unit/provider-route-policy.test.mjs tests/smoke/api-reviewers.smoke.test.mjs tests/smoke/grok-web.smoke.test.mjs tests/smoke/kimi-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs tests/smoke/claude-companion.smoke.test.mjs
```

Expected current-main baseline: pass.

## Target Behavior: Direct API Source Packet Too Large

Create a git-backed temporary workspace with three files around 180 KiB each.
Run Direct API custom-review with a high prompt cap and no large-source override.

Expected:

- status failed
- top-level `error_code:"source_packet_too_large"`
- `packet_recovery.reason:"source_packet_too_large"`
- `source_content_transmission:"not_sent"`
- no `external_review_launched`
- `review_metadata.audit_manifest.packet_recovery`
- `runtime_diagnostics.packet_recovery`
- recovery actions include `shard`, `diff_packet`, and
  `allow_large_source_packet`

## Target Behavior: Direct API Prompt Too Large

Run Direct API custom-review with a low `API_REVIEWERS_MAX_PROMPT_CHARS`.

Expected:

- status failed
- top-level `error_code:"prompt_too_large"`
- `packet_recovery.reason:"prompt_too_large"`
- existing `runtime_diagnostics.sharding_plan` remains
- new `runtime_diagnostics.packet_recovery` mirrors the shard action shape
- per-shard approval tuples still include provider, mode, source packet hash,
  rendered prompt hash, scope-resolution hash, route, fallback reason, auth
  path, billing path, request settings hash, and approval scope
- per-shard recovery tuples carry `approval_tuple_fingerprint`, not an
  approval token; run `approval-request` for the exact shard before sending
  that shard through Direct API
- persisted recovery output does not contain the approval token value

## Target Behavior: Direct API Source-Sent Retry

When a Direct API review sent source and then failed without a usable verdict:

- the prior slot remains failed
- retrying the same packet requires a review-slot disposition such as
  `--review-slot-disposition retry`
- sending the same selected source again also requires
  `--resend-confirmation-approved`
- `--allow-large-source-packet` only confirms the packet size; it does not
  bypass the resend-confirmation gate
- without resend confirmation, source stays `not_sent` and
  `packet_recovery.reason:"resend_confirmation_required"`

## Target Behavior: Grok Source Packet Too Large

Run Grok custom-review with selected source above its source-packet budget.

Expected:

- failure before CLI/web launch
- `source_content_transmission:"not_sent"`
- `packet_recovery` has same field meanings as Direct API
- any auto-fallback diagnostics remain adapter facts, not product policy

## Target Behavior: Companion Provider Projection

When Claude, Gemini, or Kimi surface packet-cap, step-limit, timeout, no-verdict,
stale, or runtime failure metadata:

- `packet_recovery` uses the same field names and schema as Direct API/Grok
- `failed_review_slot:true` is preserved for source-sent missing-verdict,
  timeout, crash, stale, or step-limit failures
- Kimi lower packet-cap recovery either narrows/shards before send or records
  `packet_recovery.provider_capabilities.supports_no_source_resume:false` after
  a source-bearing step-limit failure
- Kimi source-bearing step-limit and stale recovery omit
  `resume_without_source_resend` and offers resend-confirmation, provider
  switch, or waiver paths instead

## Changed Surface Rule

If operator follows a diff-packet or shard action:

- record changed surface
- record current packet hash/counts
- do not count as approval for original full-source packet unless shard coverage
  proof exists
- direct API source sends require fresh matching approval for changed tuple
- if the prior attempt sent source and failed, an unchanged-packet resend still
  needs explicit resend confirmation and keeps the old slot failed

## Schema And Safety Checks

Required implementation checks:

- generated `packet_recovery` objects validate against
  `contracts/packet-recovery.schema.json`
- unknown fields are rejected by the schema
- hash fields match SHA-256 format
- `approval_tuple` never contains approval tokens or credential values
- top-level `error_code` matches `packet_recovery.reason` for packet recovery
  failures
- `changed:true` without complete `coverage_proof` cannot produce
  `approval_credit:"full_source"`

## Safety

Do not print approval tokens, API keys, cookies, bearer tokens, raw env values,
or selected source bodies. Do not push, merge, close issues, mutate GitHub,
repair browser/session auth, refresh marketplace cache, or change billing/tier
without explicit operator approval.
