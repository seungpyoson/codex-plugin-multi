# Quickstart: Provider Architecture Parity Audit

## Current Worktree

```sh
cd /Users/spson/Projects/Claude/codex-plugin-multi/.worktrees/provider-architecture-parity-171
git status --short --branch
```

Expected branch:

```text
## goal/provider-architecture-parity-171...origin/main
```

## Evidence Baseline

```sh
npm test
npm run lint:sync
npm run test:full # final gate before PR/merge-readiness
```

Current baseline from 2026-05-24:

- `npm test`: 2118 tests, 2106 pass, 0 fail, 12 skipped.
- `npm run lint:sync`: passed, `default auth policy OK`.
- `npm run test:full`: required before PR/merge-readiness; not required for
  plan-only review.

## Required Source Inputs

- `specs/171-provider-architecture-parity/evidence-map.md`
- GitHub issue #171 body/comments
- GitHub issue #170 body/comments
- Related issue evidence from #159, #162, #172, #173, #167, #146, #147, #160, #144
- Shared modules under `scripts/lib/`
- Provider entrypoints under `plugins/*/scripts/`
- Sync scripts under `scripts/ci/`
- Tests under `tests/unit/` and `tests/smoke/`

## Plan/Tasks Review Packet

Before implementation, send reviewers a source packet containing at least:

```text
specs/171-provider-architecture-parity/evidence-map.md
specs/171-provider-architecture-parity/spec.md
specs/171-provider-architecture-parity/plan.md
specs/171-provider-architecture-parity/research.md
specs/171-provider-architecture-parity/data-model.md
specs/171-provider-architecture-parity/contracts/provider-parity-table.schema.json
specs/171-provider-architecture-parity/quickstart.md
specs/171-provider-architecture-parity/tasks.md
specs/171-provider-architecture-parity/review-results.md
```

Ask every reviewer:

```text
Adversarial review of the #171 provider architecture parity audit plan/tasks.
Find scope drift, missing evidence, weak guardrails, unsafe provider-specific
policy, incorrect issue fit, schema/task mismatches, or any place the plan
substitutes docs for required runtime behavior. Verdict must be APPROVE or
REQUEST_CHANGES.
```

Required reviewers:

- Claude
- Gemini
- Grok
- GLM
- DeepSeek
- Kimi

Do not count missing, timed-out, source-send failed, shallow, no-verdict, or
failed review slots as approval.

## Direct API Approval Handling

DeepSeek/GLM source sends are standing-approved for this goal, but the run must
still generate approval-request artifacts and preserve provider, mode, source
packet, prompt hash, request settings, auth path, billing path, selected route,
fallback reason, approval scope, and source-send state.

Fail closed if the tuple changes or source-send state cannot be proven.

## Implementation Rules After Approval

Implementation after unanimous revised plan approval:

1. Add a provider parity JSON artifact.
2. Add a focused RED guard test for provider coverage and required shared fields.
3. Add the minimal GREEN docs/test/generator change.
4. Add the Grok `auto` transport TDD slice if the revised review gate approves it.
5. Run focused tests.
6. Repeat only for the next guardrail.

Do not change runtime behavior before all six revised plan/tasks reviewers
approve.

## Completion Verification

For implemented changes:

```sh
git diff --check
npm run lint:sync
node --test <focused test files>
npm test
npm run test:full
```

If generated docs/skills, shared synced libs, runtime scripts, or packaged
plugin copies change:

```sh
npm run doctor:cache
```

Final external review must cover the whole completed audit/implementation.

Post-review metadata updates may record newly confirmed follow-up issue links
only when the root cause is independently evidenced and the local contract tests
cover the changed artifact. The 2026-05-24 Claude custom-review packet-budget
investigation is tracked as #173 after Grok adversarial approval of the narrowed
root-cause statement.
