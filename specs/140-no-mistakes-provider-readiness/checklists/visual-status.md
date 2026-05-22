# Visual Status Requirements Quality Checklist

**Purpose**: Validate that requirements for visually explicit external-review status are complete, clear, measurable, and implementation-ready.
**Created**: 2026-05-13
**Feature**: 140-no-mistakes-provider-readiness
**Audience/Timing**: PR reviewer before implementation
**Depth**: Standard

## Requirement Completeness

- [x] CHK001 Are requirements defined for both per-job lifecycle cards and cross-job aggregate provider panels as separate user-facing surfaces? [Evidence: Quickstart §Visual status contract; Ledger §Visual Status Evidence Map]
- [x] CHK002 Are requirements defined for when visual status must appear automatically versus when an operator must invoke a manual command? [Evidence: Quickstart §Visual status contract]
- [x] CHK003 Are requirements defined for installed-plugin users who do not have the repository root scripts available? [Evidence: Ledger §Visual Status Evidence Map]
- [x] CHK004 Are requirements defined for direct API, companion CLI, and Grok tunnel providers using one shared visual-status contract? [Evidence: Spec FR-029/FR-030; Ledger §Visual Status Evidence Map]
- [x] CHK005 Are requirements defined for source-transmission disclosure in every visual status surface before and after source-bearing review? [Evidence: Quickstart §Visual status contract]

## Requirement Clarity

- [x] CHK006 Is "visually explicit" defined with concrete output format expectations such as table/card fields, ordering, and terminal timing? [Evidence: Spec SC-011; Quickstart §Visual status contract]
- [x] CHK007 Is the lifecycle mode name and accepted values specified for runtime output beyond the current `jsonl` mode? [Evidence: Quickstart §Visual status contract]
- [x] CHK008 Is the responsibility boundary clear between runtime-rendered output and agent-rendered output from JSON lifecycle events? [Evidence: Quickstart §Visual status contract]
- [x] CHK009 Are required card fields for launch, terminal success, terminal failure, and blocked-before-source cases explicitly listed? [Evidence: Quickstart §Visual status contract]
- [x] CHK010 Is "review-ready" distinguished from "visually surfaced" so provider correctness and operator visibility requirements cannot collapse? [Evidence: Spec FR-008/FR-029; Ledger §Visual Status Evidence Map]

## Requirement Consistency

- [x] CHK011 Are the status/failure classes consistent between readiness manifest rows and review-panel operator states? [Evidence: Data Model Provider Row; Ledger §Visual Status Evidence Map]
- [x] CHK012 Are direct API approval-gate requirements consistent between readiness manifest rows and lifecycle/card disclosure requirements? [Evidence: Quickstart direct API + visual contracts]
- [x] CHK013 Are generated command/skill contract requirements consistent with runtime lifecycle mode requirements and packaging requirements? [Evidence: Ledger §Visual Status Evidence Map; T037/T044 gates]
- [x] CHK014 Are no-mistakes status requirements explicitly separated from local runtime status and GitHub CI/readiness evidence? [Evidence: Quickstart §Visual status contract; Spec Assumptions]

## Acceptance Criteria Quality

- [x] CHK015 Are success criteria defined for a source-free smoke path that proves visual status without contacting external providers? [Evidence: Spec SC-011; Ledger §Visual Status Evidence Map]
- [x] CHK016 Are acceptance criteria measurable for installed-cache packaging of visual-status scripts or shared renderers? [Evidence: T044 cache gate; Ledger §Visual Status Evidence Map]
- [x] CHK017 Are acceptance criteria defined for malformed lifecycle mode input so invalid values fail safely without hiding status? [Evidence: Ledger §Visual Status Evidence Map]
- [x] CHK018 Can the requirement "broken review slots are not hidden behind prose" be objectively verified across launch, waiting, failed, and completed states? [Evidence: Spec FR-029/FR-030; Quickstart §Visual status contract]

## Scenario Coverage

- [x] CHK019 Are primary scenarios defined for foreground review, background review launch, status polling, and result retrieval? [Evidence: Ledger §Visual Status Evidence Map]
- [x] CHK020 Are exception scenarios defined for provider unavailable, sandbox blocked, auth/session failure, approval required, and review-quality failure visual output? [Evidence: Data Model failure classes; Ledger §Visual Status Evidence Map]
- [x] CHK021 Are recovery scenarios defined for rerunning after missing provider env, stale installed cache, or unavailable no-mistakes gate? [Evidence: Quickstart repair boundaries; Ledger §Visual Status Evidence Map]
- [x] CHK022 Are non-functional requirements defined for secret safety, source privacy, and prompt persistence in rendered visual output? [Evidence: Quickstart privacy + visual contracts]

## Dependencies & Assumptions

- [x] CHK023 Are assumptions documented for which package owns the shared renderer and how it is synced into provider plugin roots? [Evidence: Ledger §Visual Status Evidence Map; T044 cache gate]
- [x] CHK024 Are dependencies on Codex client markdown rendering capabilities explicit and bounded to plain terminal-safe markdown? [Evidence: Quickstart §Visual status contract]
- [x] CHK025 Are requirements defined for preserving existing `jsonl` consumers or migration behavior when adding a visual lifecycle mode? [Evidence: Quickstart §Visual status contract]
