# Implementation Plan: Grok CLI-Primary Transport Parity

**Branch**: `goal/provider-reliability-159-grok-cli-primary-parity`
**Date**: 2026-05-28
**Spec**: `specs/159-grok-cli-primary-parity/spec.md`
**Issue**: #159

## Summary

#159 remains open, but its original problem statement is stale. Grok is no
longer web-only: current `main` defaults to CLI, supports explicit web, and
supports auto fallback from eligible pre-source CLI failures to the
subscription-backed web tunnel.

The remaining architecture problem is that Grok's transport Adapter Interface is
implicit and scattered through `plugins/grok/scripts/grok-web-reviewer.mjs`.
This slice deepens the Grok transport Module so CLI and web are explicit
Adapters with one small Interface, while preserving existing shared source-send,
review-quality, JobRecord, lifecycle, and no-paid-fallback behavior.

## Speckit Note

This worktree has no `.specify/` scripts. Speckit artifacts are maintained
manually under `specs/159-grok-cli-primary-parity/`.

## Architecture Answer

The correct architecture is not "remove web" and not "add paid xAI API fallback."
The correct architecture is:

- Shared provider policy remains provider-neutral.
- Grok exposes transport capability facts through a Grok transport Module.
- CLI and web are two transport Adapters behind that Module Interface.
- `auto` is a selection mode that starts with CLI and may choose web only after
  eligible pre-source CLI readiness/auth/model failures.

## Deep Module Direction

Current shallow shape:

- Transport mode parsing, config, prompt-budget cap names, fallback eligibility,
  fallback diagnostics, doctor fallback, and run fallback are spread across one
  large runtime file.
- Tests can prove behavior, but maintainers must inspect unrelated runtime code
  to understand transport policy.

Deepened shape:

- A Grok transport Module owns the Interface for:
  - transport normalization
  - Adapter facts for CLI and web
  - config construction
  - selected route/auth mode metadata
  - prompt-budget cap names
  - auto fallback eligibility
  - redacted CLI diagnostics projection for web fallback
- Runtime launch code still owns process spawn, web fetch, tunnel startup,
  prompt lifecycle, JobRecord building, and review-quality handling.

This improves locality because transport changes happen in one Module. It
improves leverage because tests can exercise transport decisions without
launching external processes.

## Deepening Candidates

1. **Grok Transport Adapter Module**
   - **Files**: `plugins/grok/scripts/grok-web-reviewer.mjs`, new
     `plugins/grok/scripts/lib/grok-transport-adapters.mjs`,
     `tests/smoke/grok-web.smoke.test.mjs`, `tests/unit/plugin-copies-in-sync.test.mjs`
   - **Problem**: Transport facts and fallback rules are scattered.
   - **Solution**: Move transport normalization, config builders, prompt-budget
     cap names, fallback eligibility, and fallback diagnostics into one Module.
   - **Benefits**: Higher locality for Grok transport changes; more leverage
     from focused tests; lower risk of accidental paid fallback or source-send
     policy drift.

2. **Full Launch Adapter Split**
   - **Files**: all Grok runtime launch and readiness code.
   - **Problem**: CLI launch and web tunnel launch are still in the same runtime.
   - **Solution**: Move launch mechanics into separate CLI and web launch
     Modules.
   - **Benefits**: Potentially deeper separation, but high blast radius.
   - **Disposition**: Not selected for this slice. It can follow after the
     transport Interface is proven.

3. **Cross-Provider Transport Interface**
   - **Files**: Claude/Gemini/Kimi/Grok/direct API runtimes and shared policy.
   - **Problem**: Providers differ in launch mechanics.
   - **Solution**: Build one generic transport Interface for all providers.
   - **Benefits**: Could improve parity later.
   - **Disposition**: Not selected for this slice. #171 already owns shared
     provider policy; #159 should not reopen that scope.

Selected candidate: **Grok Transport Adapter Module**.

## Technical Context

- Runtime: Node.js 20+, Grok CLI, local Grok web tunnel, `node:test`.
- Existing entrypoint: `plugins/grok/scripts/grok-companion.mjs`.
- Existing runtime: `plugins/grok/scripts/grok-web-reviewer.mjs`.
- Existing focused test lane: `npm run smoke:grok`.
- Broad verification: `npm run lint:sync`, `npm test`, `git diff --check`.
- Safety: no secret printing, no source resend after source-bearing failure, no
  silent billing route change, no browser/session repair without approval.

## Phase 0: Evidence

Inputs:

- #159 live issue body.
- #176 live issue body and `specs/176-grok-cli-readiness-auto/evidence-map.md`.
- Current Grok runtime and tests.
- Saved provider reliability goal prompt.

Outputs:

- `evidence-map.md`: current behavior, stale issue statement, and root problem.
- `research.md`: selected architecture direction and rejected alternatives.

## Phase 1: Design

Design artifacts:

- `spec.md`: clarified #159 requirement.
- `data-model.md`: Grok transport Adapter entities and invariants.
- `contracts/grok-transport-adapter.md`: required Module Interface.
- `quickstart.md`: planning and verification commands.
- `tasks.md`: dependency-ordered TDD tasks and review gates.

## Phase 2: External Plan Review Gate

Before runtime implementation, send the planning packet to:

- Claude
- Gemini
- Grok
- GLM
- DeepSeek
- Kimi

Review packet:

- `spec.md`
- `plan.md`
- `tasks.md`
- `evidence-map.md`
- `research.md`
- `data-model.md`
- `contracts/grok-transport-adapter.md`
- `quickstart.md`

Missing, timed-out, shallow, failed, no-verdict, or source-sent failure slots do
not count as approval. Source-send approval handling must stay provider-neutral:
each reviewer route follows the same shared route/source-send policy, and any
required approval or waiver must be recorded with the review-slot evidence.

## Phase 3: TDD Implementation After Approval

1. Add RED tests for the transport Module Interface.
2. Add RED preservation tests for default CLI, explicit web, no direct API
   credential leakage, source-sent auto-fallback ineligibility, and auto fallback
   metadata if current smoke coverage does not already fail on the intended seam.
3. Introduce the Grok transport Module with CLI and web Adapter facts.
4. Wire `grok-web-reviewer.mjs` to consume the Module for config, budget cap
   name, fallback eligibility, and fallback diagnostics.
5. Keep launch mechanics in the existing runtime.
6. Refactor only while tests stay green.

## Verification Gates

Planning gate:

- `git diff --check`
- external plan/task approvals or explicit waivers

Implementation gate:

- focused RED/GREEN tests
- `npm run smoke:grok`
- `npm run lint:sync`
- `npm test`; compare pass/fail/skip counts against the baseline unless the
  change is intentionally explained
- `git diff --check`
- final latest-head external reviews from all six required reviewers, or
  explicit operator waivers for unavailable slots

## Current State

Planning artifacts are being created. Runtime implementation is blocked until
the external plan review gate is satisfied.
