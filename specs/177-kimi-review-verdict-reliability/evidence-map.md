# Issue #177 Evidence Map

## Scope

Issue #177 remains after #175 and #181 for Kimi review reliability on packets that
cannot safely be sent as one full-file `custom-review` bundle. The fix should be
provider-neutral unless the evidence proves a Kimi-only capability difference.

## Current Evidence

- #175 merged Kimi adapter capability facts: subscription source packets are capped
  at 32 KiB, no-source repair after source-bearing step-limit failures is
  unsupported, and Kimi source-bearing reviews use prompt-contained source without
  workspace file tools.
- #181 merged provider-neutral review-slot disposition: failed, missing, timed-out,
  stale, source-sent-unusable, and no-verdict slots do not count as approval.
- Live #177 comments show Kimi now passes source-free readiness and can complete
  under-budget branch-diff shards after the account upgrade.
- The remaining #177 evidence is packet-shape, not auth: full PR or full-file
  `custom-review` bundles can exceed Kimi's adapter packet cap, while equivalent
  branch-diff shards can stay under the cap.
- Current shared `effectiveProfileForOptions` only converts `review --scope-base`
  into `branch-diff`. A `custom-review --scope-paths ... --scope-base ...` keeps
  effective scope `custom`, so committed explicit-path shards still follow the
  full-file custom-scope path instead of the provider-neutral branch-diff packet
  path.

## Root Cause

The shared scope/profile normalization does not treat an explicit base ref as a
committed-diff source contract for `custom-review`. Operators can provide both
explicit paths and a base ref, but the companion still classifies the review as
custom scope. That preserves the historical full-file packet path that caused
Kimi burn, even when a safer branch-diff packet is available.

## Acceptance

- `custom-review --scope-paths ... --scope-base <ref>` uses effective
  `branch-diff` scope across companion-backed providers.
- Explicit `--scope-paths` remains the shard filter; no implicit broadening.
- `custom-review` without `--scope-base` remains explicit full-file custom scope
  for non-git bundles and intentional file-body review.
- The behavior lives in shared companion policy, with packaged copies in sync.
- Kimi failed slots remain failed slots and no-source continuations remain
  `source_content_transmission:not_sent`.
