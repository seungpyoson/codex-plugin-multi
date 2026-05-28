# Implementation Plan: Large Custom-Review Packet Recovery

**Branch**: `goal/provider-reliability-172-large-custom-packet-recovery`
**Date**: 2026-05-26
**Spec**: `specs/172-large-custom-review-packet-recovery/spec.md`

## Summary

#172 remains open after #171/#173/#176/#177/#180. The missing product behavior
is not another raw packet guard. It is deterministic operator recovery when a
large `custom-review` packet cannot safely complete as selected.

No runtime implementation starts until `spec.md`, `plan.md`, `tasks.md`,
`data-model.md`, `quickstart.md`, `evidence-map.md`,
`plan-review-results.md`, and `contracts/packet-recovery.schema.json` have
usable APPROVE verdicts from Claude, Gemini, Grok, GLM, DeepSeek, and Kimi.

## Speckit Note

This repo has no `.specify/` scripts in the active worktree. Speckit artifacts
are maintained manually under `specs/172-large-custom-review-packet-recovery/`.

## Technical Context

- Runtime: Node.js 20+, `node:test`, local provider CLIs, direct API reviewer.
- Key modules: `scripts/lib/provider-route-policy.mjs`,
  `scripts/lib/review-prompt.mjs`, provider packaged copies,
  `plugins/api-reviewers/scripts/api-reviewer.mjs`,
  `plugins/grok/scripts/grok-web-reviewer.mjs`, companion smoke tests.
- Safety: no secret printing, no full source/prompt persistence, no silent paid
  billing, no source resend after failed source-bearing slot without shared
  policy approval.
- Verification: focused RED/GREEN tests, `git diff --check`,
  `npm run lint:sync`, targeted smokes, broad `npm test` if shared runtime
  surface changes, `npm run doctor:cache` if packaged copies/generated docs
  change.

## Constitution Check

- Evidence first: current issue/PR state and baseline tests are recorded in
  `evidence-map.md`.
- TDD: every runtime slice starts with one failing behavior test.
- Audit fields over prose: `packet_recovery`, `source_packet_policy`,
  `review_slot`, and `review_quality` are authoritative.
- Privacy: only hashes/counts/paths/bounded diagnostics, never full prompts,
  source bodies, approval tokens, cookies, bearer tokens, or secrets.
- Workflow safety: no push, merge, issue closure, browser repair, cache sync,
  billing, deploy, or destructive cleanup without explicit operator approval.

## Architecture Direction

Shared policy owns recovery semantics. Provider adapters expose facts.

Shared policy owns:

- packet recovery action taxonomy
- source transmission truth
- review-surface change and approval credit
- direct API approval tuple requirements
- failure-to-recovery mapping
- audit/status field names
- schema conformance and no-secret invariants

Adapters expose:

- source packet byte limits
- rendered prompt caps
- transport and auth capability facts
- launch mechanics
- provider-specific parse/runtime error facts
- a single capability surface consumed by shared recovery policy

The adapter capability surface must be defined before provider wiring so each
provider contributes facts only. Direct API and Grok get first behavior smokes
because they already expose #172 pre-send failures. Claude, Gemini, and Kimi
must still get conformance/projection tests so field meanings do not drift.

## Phase 0: Evidence And Matrix

Inputs:

- #172 issue body and target issue state.
- PR #174, #175, #181, #183, #184 completed slice bodies.
- Current source/test evidence around source-packet policy, prompt caps,
  sharding plan, Grok transport, Direct API approval, and failed-slot gates.

Output:

- `evidence-map.md` with issue matrix, root problem, non-goals, and selected
  smallest valid next action.

## Phase 1: Plan And Contract

Artifacts:

- `spec.md`: user stories and functional requirements.
- `data-model.md`: `PacketRecovery`, `ReviewSurface`, `RecoveryAction`,
  `ShardPlan`, `CoverageProof`, `ApprovalTuple`.
- `contracts/packet-recovery.schema.json`: JSON schema guard.
- `quickstart.md`: operator verification scenarios.
- `tasks.md`: TDD implementation order.
- `plan-review-results.md`: external planning-review ledger and blocker
  disposition.

## Phase 2: External Plan Review Gate

Required reviewers:

- Claude
- Gemini
- Grok
- GLM
- DeepSeek
- Kimi

Review packet:

- `specs/172-large-custom-review-packet-recovery/spec.md`
- `plan.md`
- `tasks.md`
- `data-model.md`
- `quickstart.md`
- `evidence-map.md`
- `plan-review-results.md`
- `contracts/packet-recovery.schema.json`

Rules:

- Missing, timed-out, source-sent failed, no-verdict, shallow, or failed slot is
  not approval.
- Any request-changes verdict must be resolved in docs before runtime code.
- Direct API source-send approval for DeepSeek/GLM is covered by the standing
  approval in the goal prompt, but approval artifacts and metadata still must be
  preserved.

## Phase 3: Runtime Implementation After Approval

TDD order:

1. Add RED shared-policy/unit tests for `PacketRecovery` from source-packet
   budget failure and changed review-surface state.
2. Add RED schema/no-secret conformance tests for `PacketRecovery`.
3. Define the provider adapter recovery-capability shape consumed by shared
   policy.
4. Implement minimal shared `buildPacketRecovery` helper.
5. Add RED Direct API smoke for source-packet failure and prompt-cap failure
   projecting `packet_recovery` while keeping `sharding_plan`.
6. Wire Direct API diagnostics/audit projection.
7. Add RED Grok smoke for source-packet and prompt-cap failure projecting the
   same `packet_recovery` shape.
8. Wire Grok diagnostics/audit projection.
9. Add JobRecord/review-prompt source-of-truth tests proving failed runtime
   slots remain failed when recovery metadata exists.
10. Add Claude/Gemini/Kimi companion conformance tests for the same field names,
   including Kimi packet-cap and source-sent step-limit recovery projection.
11. Add companion/shared sync tests for packaged policy copies if shared files
   move.
12. Update docs/skills only through canonical sources or sync checks.

## Verification Gates

Planning gate:

- `git diff --check`
- plan-review approval from all six reviewers

Implementation gate:

- RED/GREEN evidence per task
- `git diff --check`
- `npm run lint:sync`
- targeted `node --test ...`
- `npm test` for broad shared runtime changes
- `npm run doctor:cache` if runtime scripts, generated docs/skills, shared
  synced libs, or packaged plugin copies change
- final whole-issue reviews from the operator-approved review gate for the
  implementation pass

## Current State

Planning artifacts passed the external plan review gate. Runtime
implementation is complete for #172, with final review evidence and residual
risk notes recorded in `final-review-results.md`.
