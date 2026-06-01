# Issue 144 Plan

## Scope

Implement API-backed rescue for direct API reviewers in relay, limited to DeepSeek and GLM. The workflow must let providers propose patches without mutating the workspace, then require a separate local apply approval before any provider-suggested diff is applied.

## Non-Goals

- No Grok, Claude, Gemini, or Kimi rescue changes.
- No source-send approval weakening.
- No automatic provider fallback.
- No direct provider workspace mutation.
- No hand-edited generated command/skill files when the generator owns them.
- No issue closure or merge without explicit operator approval.

## Technical Context

- Runtime: Node.js ESM, `node:test`, no new dependencies.
- Canonical direct API runtime: `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- Direct API provider packages: `plugins/relay-deepseek`, `plugins/relay-glm`.
- Generated docs/skills source: `scripts/lib/external-model-contracts.mjs`.
- Verification: `node --test` targeted slices, `npm run lint:sync`, `npm run smoke:api-reviewers`, `npm run lint`, `npm test` as blast radius grows.
- Speckit hooks: not available in relay (`.specify/` absent). This document follows Speckit-style plan structure manually.

## Public Interface

### Rescue Proposal

Add `rescue` as a direct API mode only when provider capability metadata declares rescue support.

Source-bearing commands:

```text
api-reviewer approval-request --provider deepseek|glm --mode rescue --scope branch-diff --scope-base REF --prompt "<task>"
api-reviewer run --provider deepseek|glm --mode rescue --scope branch-diff --scope-base REF --approval-token "<approval_token.value>" --lifecycle-events markdown --prompt "<task>"
```

`approval-request --mode rescue` reuses existing source-send approval tuple binding. Its disclosure must say the source will be sent for an external rescue proposal, not for review approval.

`run --mode rescue` sends selected source after approval and prompts the provider to return an `API_RESCUE_PATCH_PROPOSAL_V1` JSON object containing:

- `schema_version: 1`
- `summary`
- `unified_diff`
- `verification` as an array of suggested commands

The runtime parses that proposal, persists it in `structured_output`, records a stable patch hash, and keeps `mutations: []`. The provider never edits files.

### Apply Approval

Add source-free local commands:

```text
api-reviewer apply-request --job-id <rescue_job_id>
api-reviewer apply --job-id <rescue_job_id> --approval-token "<apply_token.value>"
```

`apply-request` reads the completed rescue proposal JobRecord, validates that it contains a parseable patch proposal, runs a non-mutating patch preflight, and emits an approval token bound to:

- rescue job ID
- provider
- workspace root
- current HEAD
- patch hash
- proposed files

`apply` validates that token, rejects dirty worktrees before applying, runs `git apply --check`, applies the patch, captures `git status --short` before and after, and persists a source-free apply JobRecord with:

- `parent_job_id` set to the rescue proposal job
- `mode: rescue-apply`
- `source_content_transmission: not_sent`
- `structured_output.apply.state`
- patch hash and applied files
- `mutations` populated from after-apply status

Invalid token, parse failure, failed patch preflight, failed apply, dirty workspace, missing job, unsafe job ID, or missing proposal all fail closed without applying changes.

## Data Model

- `ProviderCapability`: existing provider config plus `capabilities.rescue === true`.
- `RescuePatchProposal`: schema version, summary, unified diff, verification commands, patch hash, proposed files.
- `ApplyApproval`: source-free token with bound job/provider/workspace/head/patch/file tuple.
- `ApplyJobRecord`: retained JobRecord representing local apply outcome, not provider output.

## Test Plan

Use TDD vertical slices:

1. RED: rescue mode remains proposal-only and does not mutate workspace. GREEN: add capability-gated rescue mode, prompt, parser, and JobRecord structured output.
2. RED: review modes cannot apply patch-looking output. GREEN: keep parser active only for `mode === "rescue"`.
3. RED: malformed rescue provider output fails closed after source send with no mutations. GREEN: parse failure path.
4. RED: `apply-request` emits source-free approval only for completed rescue proposals. GREEN: apply approval token generation and patch preflight.
5. RED: `apply` rejects missing/invalid approval and dirty workspace without mutation. GREEN: token/worktree guards.
6. RED: failed patch apply reports failed apply and no mutation. GREEN: `git apply --check`/apply error handling.
7. RED: successful apply records before/after mutation metadata. GREEN: apply command and apply JobRecord persistence.
8. RED: generated DeepSeek/GLM surfaces expose rescue only when support is declared. GREEN: generator update plus sync.
9. RED: README/docs describe API-backed review vs rescue vs manual relay and artifact cleanup. GREEN: docs update.

## Behavior Preservation

- Existing review, adversarial-review, and custom-review modes remain read-only.
- Existing source-send approval, prompt budget, packet recovery, grants, provider workload lease, credential provenance, and redaction behavior are reused.
- Direct API source-send approval is not reused for applying patches; apply approval is separate and source-free.
- Provider capability metadata controls exposure. A provider without rescue support must reject rescue before source send.

## Verification Commands

Run as applicable while implementing:

```text
node --test --test-name-pattern "<current RED/GREEN slice>" tests/smoke/api-reviewers.smoke.test.mjs
node --test tests/smoke/api-reviewers.smoke.test.mjs
node --test tests/unit/docs-contracts.test.mjs tests/unit/plugin-copies-in-sync.test.mjs tests/unit/relay-build-contracts.test.mjs tests/unit/codex-relay-build-contracts.test.mjs
npm run lint:sync
npm run smoke:api-reviewers
npm run lint
npm test
git diff --check
```

## Residual Risks

- Unified-diff apply must reject unsafe paths and binary patches unless explicitly supported.
- Apply approval token binding must include HEAD and patch hash so stale provider output cannot be applied after workspace drift.
- Direct API rescue prompts must not make provider output look like approval; the result is a patch proposal only.
- Existing installed cache may need verification if generated plugin surfaces change.
