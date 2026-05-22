# Implementation Plan: No-Mistakes Provider Readiness

**Branch**: `main` | **Date**: 2026-05-18 | **Spec**: `specs/140-no-mistakes-provider-readiness/spec.md`
**Input**: Dogfood review slots failed across auth, source-send approval,
provider runtime, result lookup, quality gates, Grok transport, installed cache,
and visual lifecycle surfaces.

## Summary

Build a provider-readiness system where every reviewer slot is either completed
with proof or failed with a precise class before source is sent.

Closed classes in this work:

1. Default auth no longer means `auto`; operator-facing `--auth-mode auto` is
   rejected, and API fallback is selected only by the shared route policy.
2. Direct API approval no longer blocks on repeated chat permission once the
   approval token matches the same source packet.
3. Prompt-size overflow fails before source send.
4. Result lookup supports `--job-id` and correct launch-workspace diagnostics.
5. Missing verdict and shallow output remain failed review slots, even with
   useful raw prose.
6. Grok CLI is default; Grok tunnel is explicit legacy fallback.
7. Grok CLI sandbox writes are isolated in temp `GROK_HOME` and cleaned.
8. Markdown lifecycle progress is visually explicit instead of raw JSONL.
9. Installed marketplace/cache state is verified after runtime changes.

No code residual remains in the current root-cause map. T035 was proven as a
no-op implementation task: existing runtime rejects changed approval tuples
before source send and re-preflights the shared route state before launch.

## Technical Context

**Language/Version**: Node.js 20+
**Primary Dependencies**: Node built-ins, provider CLIs, direct API providers,
plugin companion scripts, `uv` only for explicit Grok legacy web transport
**Storage**: Local JobRecord JSON, provider state roots, prompt sidecars,
plugin cache dirs, synthetic `/private/tmp` fixture repos
**Testing**: `node:test`, provider smoke tests, installed-cache doctor,
sync lint, `git diff --check`
**Target Platform**: macOS/Linux Codex local sessions
**Project Type**: CLI/plugin bundle
**Constraints**: No secret printing; no full prompt/source persistence; direct
API source send only with matching approval token; no cross-provider fallback;
no merge/push/issue mutation without explicit operator approval
**Scope**: Claude, Gemini, Kimi, Grok, DeepSeek, GLM plus shared panel,
lifecycle, manifest, docs, skills, and installed cache

## Constitution Check

- Evidence first: every root cause has command, code, test, JobRecord, or
  reviewer-proof evidence.
- TDD: runtime changes start with failing tests when a seam is known.
- Audit fields over prose: `source_content_transmission`, verdict quality,
  failure class, selected-source metadata, and cache state are authoritative.
- Privacy: persist hashes, counts, paths, bounded diagnostics, and result text;
  do not persist full prompts, source bodies, credentials, cookies, bearer
  tokens, or API keys.
- Workflow safety: no push, merge, issue closure, destructive cleanup, browser
  session repair, billing, or source-bearing direct API run without approval.

## Work Breakdown

### Phase 0: Evidence Map

1. Reconstruct every observed failure from current artifacts.
2. Separate local runtime failure, provider failure, auth failure, approval
   failure, review-quality failure, prompt-size failure, visual-status failure,
   and stale-cache failure.
3. External-review the map before code.

### Phase 1: Implement Closed Runtime Fixes

1. Add verdict/parser/panel regressions.
2. Add result lookup and lifecycle rows.
3. Add direct API approval-token scope checks.
4. Add Grok CLI default wrapper and explicit legacy web fallback.
5. Add visual markdown progress renderer.
6. Sync shared libraries into plugin copies.

### Phase 2: Preserve Explicit Boundaries

1. Keep CLI/subscription defaults separate from API fallback route selection.
2. Keep API reviewer source-send tied to matching approval token.
3. Keep Grok tunnel/web repair explicit.
4. Keep JSONL lifecycle compatibility.
5. Keep installed cache in proof scope.

### Phase 3: Completion Proof

1. Reject implicit auth/provider/transport fallback.
2. Prove no source is sent after failed preflight or changed approval scope.
3. Re-run cache, unit, and provider smokes.
4. Keep push, merge, issue mutation, browser/session repair, billing, and direct
   API source-bearing runs behind explicit operator approval.

## Verification Gates

Run before any completion claim:

1. `git diff --check`
2. `npm run lint:sync`
3. `node --test tests/unit/review-panel.test.mjs tests/unit/external-model-contracts.test.mjs tests/unit/companion-common.test.mjs`
4. `npm run smoke:api-reviewers`
5. `npm run smoke:claude`
6. `npm run smoke:gemini`
7. `npm run smoke:grok`
8. `npm run smoke:kimi`
9. `npm run doctor:cache`
10. Final evidence ledger mapping changed files to task/checklist/test/residual

## Complexity Tracking

No constitution violations currently identified. The implementation is broad
because the failures crossed runtime, docs, generated skill copies, installed
cache, and operator-visible lifecycle output.
