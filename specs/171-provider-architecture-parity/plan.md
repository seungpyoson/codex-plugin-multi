# Implementation Plan: Provider Architecture Parity Audit

**Branch**: `goal/provider-architecture-parity-171`
**Date**: 2026-05-24
**Spec**: `specs/171-provider-architecture-parity/spec.md`

## Summary

#171 is not complete. Prior work solved a narrower Grok/autofallback and parity
table slice. Correct scope is exact provider policy parity for Claude, Gemini,
Kimi, Grok, DeepSeek, and GLM.

No implementation may start until `root-problems.md`, `spec.md`, `plan.md`, and
`tasks.md` have usable APPROVE verdicts from all six reviewers.

## Speckit Note

This repo has no `.specify/` scripts in the active worktree. Speckit artifacts
are maintained manually under `specs/171-provider-architecture-parity/`:
`root-problems.md`, `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/`, `quickstart.md`, `tasks.md`, and `issue-drafts.md`.

## Architecture Answer

Shared `subscription -> direct API -> OpenRouter` ladder is the right
architecture. It is efficient if implemented as shared policy over Adapter
capability facts:

- API-only providers do not run fake subscription commands.
- Each missing route step is recorded as unsupported with same field meanings.
- Source-bearing fallback requires same approval tuple and resend policy.
- No provider silently changes billing path.

Different treatment is allowed only when:

1. Adapter exposes a concrete capability fact.
2. Shared policy consumes that fact.
3. Same status/audit field names and meanings are emitted.
4. Reason is documented and tested.
5. Difference does not create provider-specific policy branches.

## Technical Context

- Runtime: Node.js 20+, provider CLIs, direct API reviewers, Git metadata.
- Artifacts: Markdown specs, JSON parity table/schema, JobRecord JSON,
  generated commands/skills/docs, packaged copies.
- Verification: `node:test`, sync checks, smoke tests, external reviews.
- Safety: no secret printing, no silent paid billing, no automatic source
  resend after source-bearing failure, no issue creation/push/merge/deploy/cache
  sync/browser repair/billing action without explicit operator approval.

## Deep Module Direction

Create one deep policy Module. Provider Adapters stay thin.

Shared policy owns:

- route ladder and route attempt ledger
- source packet budget, review surface, retry, resend
- readiness/auth state and next action
- failure taxonomy, JobRecord/status/review-panel fields, review quality
- generated contracts, docs, packaged-copy sync invariants

Adapters expose:

- subscription capability/probe, if present
- direct API capability/probe, if present
- OpenRouter capability/probe, if present
- prompt/byte/step/time/model limits
- CLI/API/web launch mechanics
- provider parser facts

## Phase 0: Root Cause

Inputs:

- #171: umbrella provider architecture parity.
- #170: topology evidence only.
- #159: Grok CLI/web architecture evidence.
- #172/#173: packet budget/source-send evidence.
- Current code: route policy supports only `subscription` and `api`; Kimi
  declares subscription only; OpenRouter is not first-class route policy.

Outputs:

- `root-problems.md`: root cause and 5 Whys.
- `evidence-map.md`: source/job/issue evidence.
- `issue-drafts.md`: task-to-issue output with duplicate checks.

## Phase 1: Design

Update artifacts so current truth is explicit:

- `data-model.md`: shared policy Interface, route steps, capability facts,
  packet policy, review gate.
- `provider-parity-table.json`: incomplete route and packet parity are marked
  honestly.
- `quickstart.md`: operator verification scenarios.
- `contracts/`: JSON/schema guardrails.

## Phase 2: Tasks

`tasks.md` must stay dependency-ordered, issue-oriented, and one-issue-at-a-time.
It must block all implementation until six-reviewer plan/spec/tasks approval.

Grok/Kimi issue creation remains gated:

- prove distinct root cause outside existing issues
- duplicate check
- explicit operator approval

## Phase 3: External Review Gate

Required reviewers:

- Claude
- Gemini
- Grok
- GLM
- DeepSeek
- Kimi

Required reviewed artifacts:

- `root-problems.md`
- `spec.md`
- `plan.md`
- `tasks.md`

Evidence artifacts may be included or sharded:

- `evidence-map.md`
- `provider-parity-table.json`
- source snippets
- JobRecord snippets

Missing, timed-out, source-sent failure, shallow output, no-verdict, or failed
slot is not approval.

## Phase 4: Implementation After Approval

Only after six usable approvals:

1. Add full-policy contract tests for all shared field names and meanings.
2. Implement #171 shared Provider Policy Interface/facade.
3. Implement provider-neutral route ladder and packet budget/resend policy for
   all six through that Interface.
4. Wire readiness/auth, status/lifecycle, failure taxonomy, suggested action,
   review quality, audit, docs, and sync policy through the same Interface.
5. Address Grok login only if proven separate from #171/#159.
6. Address Kimi transport/capacity only if proven separate from #171/#172/#173.

Each implementation slice:

- RED characterization/contract tests first.
- Minimal GREEN shared-policy code.
- Adapter edits only for capability facts and launch mechanics.
- Sync generated/package copies via canonical scripts.
- Verify locally.
- Get final six latest-head reviews.

## Verification Gates

Planning gate:

- `git diff --check`
- JSON/schema validation when JSON changes
- focused docs contract tests
- six external approvals

Implementation gate:

- focused RED/GREEN tests
- `git diff --check`
- `npm run lint:sync`
- targeted `node --test ...`
- `npm test`
- `npm run test:full` for broad shared/runtime changes
- `npm run doctor:cache` if generated docs/skills, synced libs, runtime scripts,
  or packaged plugin copies change
- final six latest-head reviews

## Current State

Pre-implementation gate passed. The first current-packet round found one Grok
blocker and one Kimi combined-packet timeout. The Grok blocker was applied to
`tasks.md`, and the updated `plan.md`/`tasks.md` delta received six usable
APPROVE verdicts. Runtime implementation may start, constrained to the approved
#171 shared-policy scope and TDD task order.
