# Implementation Plan: Provider Architecture Parity Audit

**Branch**: `goal/provider-architecture-parity-171` | **Date**: 2026-05-24 | **Spec**: `specs/171-provider-architecture-parity/spec.md`  
**Input**: Evidence-first execution of #171 using #170 as topology evidence input.

## Summary

Produce an evidence-backed provider architecture parity audit, add the minimum
machine-validated parity contract, and implement the one runtime slice the first
external review identified as required: Grok CLI-primary audited web fallback in
explicit auto transport mode. No implementation may start until the revised
plan/tasks review receives usable APPROVE verdicts from all six reviewers.

The current investigation found broad shared-policy compliance in route/auth,
source-send disclosure, prompt/audit manifests, failure taxonomy, review-quality
gates, status normalization, generated contracts, and packaged-copy sync. The
main unresolved runtime gap is Grok CLI/web fallback: current code intentionally
keeps web explicit-only, while #159 asks for audited fallback. Gemini and
DeepSeek plan review rejected a docs-only treatment, so the revised plan includes
a TDD runtime slice.

## Speckit Execution Note

The installed `speckit-plan` workflow expects `.specify/scripts/bash/setup-plan.sh`,
but this repo/worktree does not contain `.specify/`. This plan applies the
Speckit workflow manually using the existing `specs/*` artifact structure:
`spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`,
`quickstart.md`, and `tasks.md`.

## Technical Context

**Language/Version**: Node.js 20+  
**Primary Dependencies**: Node built-ins, provider CLIs, direct API providers,
local plugin scripts, GitHub issue metadata  
**Storage**: Markdown specs, JSON contracts, local JobRecord JSON, generated
plugin package copies  
**Testing**: `node:test`, sync lint, focused unit tests, provider smoke tests as
needed, external adversarial review gates  
**Target Platform**: macOS/Linux Codex local sessions  
**Project Type**: CLI/plugin bundle  
**Constraints**: No source-send ambiguity; no secret printing; no new issue,
push, merge, destructive cleanup, deploy, browser repair, or billing action
without separate explicit approval; no implementation before unanimous
plan/tasks approval. The later #173 issue was separately operator-approved after
the Claude custom-review packet-budget root cause was proven and adversarially
reviewed.  
**Scope**: Claude, Gemini, Kimi, Grok, DeepSeek, GLM, shared libs under
`scripts/lib/`, package copies under `plugins/*/scripts/lib/`, provider
entrypoints, generated commands/skills/docs, sync scripts, and tests

## Constitution Check

- Evidence before assertions: `evidence-map.md`, issue fetches, source searches,
  `npm test`, and `npm run lint:sync` ground the plan.
- Provider-neutral shared policy: shared Modules own policy; Adapters expose
  launch/capability facts only.
- TDD: any guardrail implementation after external approval starts with RED
  tests and then minimal GREEN changes.
- Privacy/source safety: direct API source sends require approval-request
  artifacts and audit metadata even under standing approval.
- Workflow safety: no remote mutation or destructive side effect without
  explicit approval.

No constitution violations are justified for planning. Implementation remains
blocked until external plan/tasks review is unanimous.

## Phase 0: Research

1. Resolve issue-scope fit between #171, #170, #159, #162, #172, #167, #146,
   #147, #160, and #144. After the later Claude usage investigation, record
   #173 as a distinct Claude packet-budget follow-up rather than a #171 scope
   expansion.
2. Map shared policy Modules, Interfaces, Implementations, Adapters, sync guards,
   tests, exceptions, and drift risk.
3. Record why first-pass review escalated Grok fallback from docs-only
   classification to a TDD runtime slice.

Output: `research.md`, `evidence-map.md`.

## Phase 1: Design & Contracts

1. Define Provider Parity Table entities in `data-model.md`.
2. Define a JSON contract for provider parity table shape in
   `contracts/provider-parity-table.schema.json`.
3. Define operator quickstart and verification path in `quickstart.md`.
4. Update Speckit context in `CLAUDE.md` to this feature.

## Phase 2: Tasks

1. Generate dependency-ordered tasks in `tasks.md`.
2. Include explicit external plan/tasks review tasks before implementation.
3. Include exact field inventories for guardrail tests.
4. Include Grok auto fallback TDD tasks only after the review gate.

## Phase 3: External Review Gate

Run adversarial review of the plan/tasks/evidence packet with:

- Claude
- Gemini
- Grok
- GLM
- DeepSeek
- Kimi

Missing, timed-out, shallow, source-send failure, no-verdict, or failed slots do
not count as approval.

## Phase 4: Implementation If Approved

Implementation targets after unanimous plan approval:

1. Add canonical `provider-parity-table.json` and schema validation.
2. Add focused guard tests for provider coverage and required shared audit
   fields.
3. Add or update generated contract docs only through canonical generator if
   generated docs are touched.
4. Implement Grok `auto` transport by TDD only:
   - RED: auto mode accepted while default remains CLI.
   - RED: CLI happy path never touches web.
   - RED: approved CLI readiness/login/model failure falls back to web tunnel.
   - RED: plain CLI mode remains terminal.
   - RED: xAI/direct API env never becomes fallback billing.
   - GREEN: minimal `plugins/grok/scripts/grok-web-reviewer.mjs` changes.

## Verification Gates

Minimum after plan/tasks artifact creation:

1. `git diff --check`
2. `npm run lint:sync`
3. `npm test`

If docs/tests/code guardrails are implemented:

1. Focused RED/GREEN test evidence for each slice.
2. `git diff --check`
3. `npm run lint:sync`
4. Targeted `node --test ...`
5. `npm test`
6. `npm run test:full` before PR/merge-readiness
7. `npm run doctor:cache` if runtime scripts, generated docs/skills, shared
   synced libs, or packaged plugin copies change.
8. Final six-reviewer external review.

## Complexity Tracking

Current complexity is justified by #171's broad provider-facing scope. The
implementation should remain shallow outside the Grok auto-fallback slice:
parity JSON, guard tests, and minimal runtime changes needed to satisfy #159's
audited fallback requirement.
