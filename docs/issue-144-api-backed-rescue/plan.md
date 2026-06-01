# Issue 144 Plan

## Scope

Implement API-backed rescue for direct API reviewers in relay, limited to DeepSeek and GLM. The workflow must let providers propose patches without mutating the workspace, then require a separate local apply approval before any provider-suggested diff is applied.

This plan is intentionally write-conservative: provider output is data, not authority. The only workspace mutation is a local `apply` command after source-send approval, proposal validation, source-free apply approval, token validation, clean-worktree validation, and patch safety validation have all succeeded.

## Non-Goals

- No Grok, Claude, Gemini, or Kimi rescue changes.
- No source-send approval weakening.
- No automatic provider fallback.
- No direct provider workspace mutation.
- No hand-edited generated command/skill files when the generator owns them.
- No rescue patch may modify relay's API reviewer runtime, generated-surface contracts, provider config, plugin/session approval storage, CI configuration, package manager files, build scripts, hidden tool directories, or Git metadata. Changes to those paths require ordinary human-authored code edits in a separate workflow.
- No binary patch, symlink-creating patch, submodule/gitlink patch, file mode change, absolute path, parent traversal, or `.git/` path support in this issue.
- No patch may target an existing symlink or any path whose nearest existing parent resolves outside the workspace.
- No execution of provider-suggested verification commands. Commands are persisted for operator inspection only.
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
- `unified_diff`, limited to 512 KiB, non-empty, and text-only
- `verification` as an array of suggested commands

The runtime parses that proposal, persists it in `structured_output`, records a stable SHA-256 patch hash, records parsed proposed files, and keeps `mutations: []`. `verification` commands are retained as inert text and never executed by relay. The provider never edits files.

If provider capability metadata does not declare `capabilities.rescue === true`, both `approval-request --mode rescue` and `run --mode rescue` reject before source selection or source transmission.

### Apply Approval

Add source-free local commands:

```text
api-reviewer apply-request --job-id <rescue_job_id>
api-reviewer apply --job-id <rescue_job_id> --approval-token "<apply_token.value>"
```

`apply-request` reads the completed rescue proposal JobRecord, validates that it contains a parseable patch proposal, verifies the workspace is clean, runs a non-mutating patch preflight, and emits an approval token only when all validation passes. The token is source-free and bound to:

- rescue job ID
- provider
- workspace root
- current HEAD read at `apply-request` time
- patch hash
- proposed files
- apply policy version
- CSPRNG random nonce with at least 128 bits of entropy
- expiration timestamp with a 10-minute default and 15-minute maximum TTL

`apply-request` fails without emitting a token for missing, failed, non-rescue, malformed, unsafe, stale, or dirty-worktree jobs.

`apply` performs gates in this order: validate the source-free apply token, atomically consume the token before mutation, reject reused or expired tokens, re-read HEAD and reject drift from the token-bound HEAD, compare the actual proposal SHA-256 patch hash to the token-bound hash, reject dirty worktrees, repeat patch safety validation, run `git apply --check`, snapshot every target path, apply the patch, capture `git status --short` before and after, and persist a source-free apply JobRecord with:

- `parent_job_id` set to the rescue proposal job
- `mode: rescue-apply`
- `source_content_transmission: not_sent`
- `structured_output.apply.state` in `not_applied`, `approval_requested`, `applied`, `rejected`, `failed_clean`, `failed_rolled_back`, or `failed_dirty`
- patch hash and applied files
- `mutations` populated from after-apply status

Apply tokens are opaque, signed or stored server-side outside the workspace, and one-time use. A second `apply` with the same token is rejected after either a successful apply or a failed apply attempt. Token storage is outside provider-selected source and is covered by the runtime/policy denylist.

Invalid token, reused token, expired token, HEAD mismatch, patch-hash mismatch, parse failure, failed patch preflight, failed apply, dirty workspace, missing job, unsafe job ID, or missing proposal all fail closed. If `git apply` returns nonzero after the final check, relay restores the pre-apply path snapshots and records `failed_rolled_back`; if rollback itself cannot restore the original state, it records `failed_dirty` with error code `rescue_apply_rollback_failed`, before/after status, and no claim of a clean no-mutation failure. Snapshots record file existence, content, and type so rollback can restore modified or deleted files and remove newly created files.

### Patch Safety Policy

Patch safety is validated before token issuance and again immediately before apply. The validation must not rely on `git apply --check` alone. It rejects:

- absolute paths, parent traversal, empty paths, Windows drive or UNC paths, paths containing `.git`, and unsafe job IDs containing path separators or traversal
- NUL bytes, control characters, overlong or invalid UTF-8, and malformed path encodings
- binary patches, empty/no-op patches, symlink-creating diffs, patches targeting existing symlinks, gitlink/submodule entries, any file mode change, and unsupported rename/copy forms
- any proposed file outside the workspace after resolving the realpath of an existing target or the nearest existing parent directory
- new-file creation when the destination already exists as an untracked file
- any proposed file matching the runtime/policy denylist: `plugins/api-reviewers/**`, `plugins/relay-deepseek/**`, `plugins/relay-glm/**`, `scripts/lib/external-model-contracts.mjs`, generated command/skill files, provider config/session/approval stores, `.github/**`, `.gitignore`, `.gitattributes`, `.gitmodules`, package manager manifests or lockfiles, build scripts, hidden tool directories, and Git metadata

The narrow allowlist is ordinary tracked workspace files and new text files under existing tracked directories, outside the denylist, that can be represented by a text unified diff. New files are allowed only when their nearest existing parent realpath stays inside the workspace and the destination does not already exist.

Patch safety uses filesystem metadata, not string checks alone: `lstat` rejects existing symlink targets, realpath validation rejects parent symlink escapes, and path normalization must complete before any filesystem path construction beyond the workspace root.

### Error Taxonomy

Use stable error codes for operator-facing and test assertions:

- `rescue_patch_parse_failed`
- `rescue_patch_unsafe_path`
- `rescue_patch_binary_unsupported`
- `rescue_patch_unsupported_file_change`
- `rescue_patch_empty`
- `rescue_patch_too_large`
- `rescue_patch_hash_mismatch`
- `rescue_capability_denied`
- `rescue_apply_approval_required`
- `rescue_apply_token_invalid`
- `rescue_apply_token_reused`
- `rescue_apply_token_expired`
- `rescue_apply_head_mismatch`
- `rescue_apply_dirty_worktree`
- `rescue_apply_check_failed`
- `rescue_apply_failed`
- `rescue_apply_rollback_failed`
- `rescue_apply_job_not_found`
- `rescue_apply_not_rescue_job`

## Data Model

- `ProviderCapability`: existing provider config plus `capabilities.rescue === true`.
- `RescuePatchProposal`: schema version, summary, unified diff, inert verification commands, SHA-256 patch hash, proposed files, and proposal-size metadata.
- `ApplyApproval`: opaque source-free one-time token with bound job/provider/workspace/head/patch/file/policy/nonce/expiry tuple.
- `ApplyJobRecord`: retained JobRecord representing local apply outcome, not provider output.
- `RescueApplyPolicy`: parser/preflight policy describing supported patch forms, denied paths, safe job ID rules, and apply-state/error enums.

## Test Plan

Use TDD vertical slices:

1. RED: rescue mode remains proposal-only and does not mutate workspace. GREEN: add capability-gated rescue mode, prompt, parser, and JobRecord structured output.
2. RED: rescue source-send approval disclosure says external rescue patch proposal, not review approval. GREEN: explicit rescue disclosure string.
3. RED: provider without `capabilities.rescue` rejects rescue before source selection/send. GREEN: capability gate.
4. RED: review modes cannot apply patch-looking output. GREEN: keep parser active only for `mode === "rescue"`.
5. RED: malformed rescue provider output fails closed after source send with no mutations. GREEN: parse failure path.
6. RED: unsafe proposals are rejected by `apply-request` without token emission for traversal, absolute paths, `.git`, existing symlink targets, parent symlink escapes, binary, empty, oversized, gitlink, any mode change, unsupported rename/copy, malformed path encodings, untracked-file clobber, and denylisted runtime/policy paths. GREEN: patch safety policy module.
7. RED: `apply-request` emits source-free approval only for completed safe rescue proposals and rejects dirty worktrees. GREEN: apply approval token generation and patch preflight.
8. RED: `apply` rejects missing/invalid/reused/expired approval, dirty workspace, HEAD drift, cross-mode source-send tokens, and proposal patch-hash drift without mutation. GREEN: token/worktree/HEAD guards and token consumption.
9. RED: failed patch apply reports a failed state and leaves modified, deleted, and newly created files unchanged or explicitly reports `failed_dirty` with `rescue_apply_rollback_failed`. GREEN: snapshot and rollback handling.
10. RED: successful apply records before/after mutation metadata, including untracked files. GREEN: apply command and apply JobRecord persistence.
11. RED: generated DeepSeek/GLM surfaces expose rescue only when support is declared and hide it when capability is false. GREEN: generator update plus sync.
12. RED: README/docs describe API-backed review, API-backed rescue proposal, approved local apply, and manual relay. GREEN: docs update.

## Behavior Preservation

- Existing review, adversarial-review, and custom-review modes remain read-only.
- Existing source-send approval, prompt budget, packet recovery, grants, provider workload lease, credential provenance, and redaction behavior are reused.
- Direct API source-send approval is not reused for applying patches; apply approval is separate and source-free.
- Provider capability metadata controls exposure. A provider without rescue support must reject rescue before source send.
- Rescue patch proposals cannot modify relay runtime/policy surfaces or hidden metadata paths.
- Provider-suggested verification commands are persisted only and never executed.

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

- Patch safety remains intentionally narrow; unsupported but legitimate patch forms will require manual application or a later design.
- Runtime/policy denylist may need expansion if additional generated or approval-state paths are discovered during implementation.
- Existing installed cache may need verification if generated plugin surfaces change.
