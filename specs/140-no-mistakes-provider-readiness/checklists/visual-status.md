# Visual Status Requirements Quality Checklist

**Purpose**: Validate that requirements for visually explicit external-review status are complete, clear, measurable, and implementation-ready.
**Created**: 2026-05-13
**Feature**: 140-no-mistakes-provider-readiness
**Audience/Timing**: PR reviewer before implementation
**Depth**: Standard

## Requirement Completeness

- [ ] CHK001 Are requirements defined for both per-job lifecycle cards and cross-job aggregate provider panels as separate user-facing surfaces? [Gap, Spec §User Story 1, Architecture §Provider panels]
- [ ] CHK002 Are requirements defined for when visual status must appear automatically versus when an operator must invoke a manual command? [Gap, README §Review panel]
- [ ] CHK003 Are requirements defined for installed-plugin users who do not have the repository root scripts available? [Gap, README §Install, Architecture §Provider panels]
- [ ] CHK004 Are requirements defined for direct API, companion CLI, and Grok tunnel providers using one shared visual-status contract? [Completeness, Spec §FR-001, Plan §Technical Context]
- [ ] CHK005 Are requirements defined for source-transmission disclosure in every visual status surface before and after source-bearing review? [Completeness, Spec §FR-002, Spec §FR-004]

## Requirement Clarity

- [ ] CHK006 Is "visually explicit" defined with concrete output format expectations such as table/card fields, ordering, and terminal timing? [Ambiguity, Architecture §Provider panels]
- [ ] CHK007 Is the lifecycle mode name and accepted values specified for runtime output beyond the current `jsonl` mode? [Gap, External model contract]
- [ ] CHK008 Is the responsibility boundary clear between runtime-rendered output and agent-rendered output from JSON lifecycle events? [Ambiguity, External model contract]
- [ ] CHK009 Are required card fields for launch, terminal success, terminal failure, and blocked-before-source cases explicitly listed? [Gap, External model contract]
- [ ] CHK010 Is "review-ready" distinguished from "visually surfaced" so provider correctness and operator visibility requirements cannot collapse? [Clarity, Spec §FR-001, Spec §FR-008]

## Requirement Consistency

- [ ] CHK011 Are the status/failure classes consistent between readiness manifest rows and review-panel operator states? [Consistency, Spec §SC-005, Data Model §ProviderReadinessRow, Architecture §Provider panels]
- [ ] CHK012 Are direct API approval-gate requirements consistent between readiness manifest rows and lifecycle/card disclosure requirements? [Consistency, Spec §FR-002, Quickstart §Direct API approvals]
- [ ] CHK013 Are generated command/skill contract requirements consistent with runtime lifecycle mode requirements and packaging requirements? [Consistency, External model contract, README §Packaged plugin commands]
- [ ] CHK014 Are no-mistakes status requirements explicitly separated from local runtime status and GitHub CI/readiness evidence? [Consistency, Spec §Assumptions, Quickstart §no-mistakes status]

## Acceptance Criteria Quality

- [ ] CHK015 Are success criteria defined for a source-free smoke path that proves visual status without contacting external providers? [Gap, Spec §Success Criteria]
- [ ] CHK016 Are acceptance criteria measurable for installed-cache packaging of visual-status scripts or shared renderers? [Gap, README §Cache drift checks]
- [ ] CHK017 Are acceptance criteria defined for malformed lifecycle mode input so invalid values fail safely without hiding status? [Gap, Companion runtime contract]
- [ ] CHK018 Can the requirement "broken review slots are not hidden behind prose" be objectively verified across launch, waiting, failed, and completed states? [Measurability, Architecture §Provider panels]

## Scenario Coverage

- [ ] CHK019 Are primary scenarios defined for foreground review, background review launch, status polling, and result retrieval? [Coverage, External model contract]
- [ ] CHK020 Are exception scenarios defined for provider unavailable, sandbox blocked, auth/session failure, approval required, and review-quality failure visual output? [Coverage, Spec §SC-005]
- [ ] CHK021 Are recovery scenarios defined for rerunning after missing provider env, stale installed cache, or unavailable no-mistakes gate? [Gap, Quickstart §no-mistakes status]
- [ ] CHK022 Are non-functional requirements defined for secret safety, source privacy, and prompt persistence in rendered visual output? [Non-Functional, Spec §FR-009, External model contract §Secret Safety]

## Dependencies & Assumptions

- [ ] CHK023 Are assumptions documented for which package owns the shared renderer and how it is synced into provider plugin roots? [Assumption, Architecture §Shared code stays shared]
- [ ] CHK024 Are dependencies on Codex client markdown rendering capabilities explicit and bounded to plain terminal-safe markdown? [Gap]
- [ ] CHK025 Are requirements defined for preserving existing `jsonl` consumers or migration behavior when adding a visual lifecycle mode? [Gap, External model contract]
