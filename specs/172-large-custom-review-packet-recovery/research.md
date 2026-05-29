# Research: Large Custom-Review Packet Recovery

## Decision: Recovery Is A Shared Policy Object

`packet_recovery` belongs beside source-packet policy and review-slot policy,
not inside individual provider launch branches.

Rationale:

- #172 is cross-provider: DeepSeek/Grok can fail before source send while
  Gemini/Kimi can fail after source send.
- #171 established shared policy over thin adapters.
- Existing `source_packet_policy.suggested_action` is provider-neutral but too
  shallow for deterministic operator recovery.

Alternatives considered:

- Provider-specific suggested actions. Rejected: repeats #171 drift pattern.
- Only prose docs. Rejected: not machine-checkable and not auditable.

## Decision: Direct API Sharding Plan Becomes One Recovery Action Shape

Existing Direct API prompt-cap failures already emit `sharding_plan` with
per-shard approval tuples. Keep that data, but expose it through the same
`packet_recovery.actions[]` contract used by other providers.

Rationale:

- Avoid discarding working approval tuple evidence.
- Let operators inspect one field for all recovery paths.
- Preserve exact direct API source-send approval semantics.

Alternatives considered:

- Rename `sharding_plan` immediately. Rejected: unnecessary churn; keep it as
  compatibility data and add shared projection.

## Decision: Diff Packet Is A Changed Review Surface

Fallback from full custom-review to branch diff is useful but must be auditable.
It is not equivalent to full-source review unless coverage proof says so.

Rationale:

- #172 observed manual diff packet approval after full-source failure.
- Prompt requires no silent downgrade from full-source to diff-only review.
- #177 already made `custom-review --scope-base` available as a provider-neutral
  packet-shape tool.

Alternatives considered:

- Auto-convert full custom-review to diff packet. Rejected: silent surface
  change.

## Decision: First Runtime Slice Targets Direct API And Grok, With Shared Hooks

Direct API and Grok directly reproduce #172 pre-send failures and have existing
tests around scope size, source budget, and prompt cap. The shared contract must
be designed for Claude/Gemini/Kimi too, but first RED/GREEN runtime evidence can
land on the two paths that expose deterministic local failures.

Rationale:

- Smaller vertical slice while preserving provider-neutral design.
- Does not special-case product behavior; shared helpers are canonical.
- Claude/Gemini/Kimi packaged copies still need sync checks if shared libs move.

Alternatives considered:

- Implement every provider launch path in one pass. Rejected: higher churn and
  harder review before proving the contract.

## Decision: Speckit Is Manual In This Repo

The worktree has no `.specify/` directory or setup scripts. Speckit commands
cannot run literally here. Artifacts are maintained manually in the established
repo format under `specs/172-large-custom-review-packet-recovery/`.

