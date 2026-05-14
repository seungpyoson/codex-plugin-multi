# Implementation Plan: No-Mistakes Provider Readiness

**Branch**: `main` | **Date**: 2026-05-14 | **Spec**: `specs/140-no-mistakes-provider-readiness/spec.md`
**Input**: Post-merge complex installed smoke failed on Claude continuation while initial six-provider review passed; semantic replay probes also had ambiguous pass criteria.

## Summary

Address all confirmed failure classes end to end:

1. Claude continuation must reuse the provider session lookup context from the parent JobRecord. The confirmed failure is not stale cache, source leakage, `--no-session-persistence`, E2BIG, or stderr masking; it is a changed Claude project/cwd between parent and continue jobs.
2. Regression tests must model the real session-resolution invariant, not only argv shape.
3. Semantic replay smoke must split classifier-only checks from full review-quality audit checks.
4. Spec-kit and agent context must point at the real active feature directory.
5. Merge/remote mutation workflow must preserve explicit approval gates.

## Technical Context

**Language/Version**: Node.js 20+
**Primary Dependencies**: Node built-ins, provider CLIs, plugin companion scripts, `uv` for Grok tunnel runtime
**Storage**: Local JobRecord JSON, runtime option sidecars, plugin data dirs, synthetic `/private/tmp` fixture repos
**Testing**: `node:test`, smoke tests, targeted installed-cache smoke, `npm run lint`, GitHub CI
**Target Platform**: macOS/Linux Codex local sessions
**Project Type**: CLI/plugin bundle
**Performance Goals**: Deterministic local tests; live smoke records elapsed time but does not enforce provider latency budgets
**Constraints**: No secret printing; no real project source in live smoke; approval before direct API source send; no full prompt persistence; no merge/remote mutation without explicit approval
**Scale/Scope**: Six reviewer providers plus continuation for providers that support follow-up: Claude, Gemini, Kimi; direct API result retrieval for DeepSeek/GLM

## Constitution Check

- Evidence first: every root cause needs artifact or code/test proof.
- TDD: failing test before fix when a correct seam exists.
- Audit fields over prose: `failed_review_slot`, `semantic_failure_reasons`, selected-source metadata, and source-send fields are authoritative.
- Privacy: synthetic `/private/tmp` fixture source only for live provider source-bearing smoke.
- No full prompt persistence: keep rendered prompt hash and content hashes, not full prompt bodies.
- Workflow safety: no merge, issue closure, destructive cleanup, push, or GitHub mutation without explicit current-turn approval.

## Project Structure

### Documentation (this feature)

```text
specs/140-no-mistakes-provider-readiness/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
plugins/claude/scripts/claude-companion.mjs
plugins/claude/scripts/lib/claude.mjs
plugins/*/scripts/lib/review-prompt.mjs
plugins/api-reviewers/scripts/api-reviewer.mjs
tests/smoke/claude-companion.smoke.test.mjs
tests/smoke/api-reviewers.smoke.test.mjs
tests/unit/claude-dispatcher.test.mjs
tests/unit/review-prompt.test.mjs
scripts/sync-review-prompt.mjs
specs/140-no-mistakes-provider-readiness/
```

**Structure Decision**: Use existing public CLI seams and smoke tests. Do not add new runtime abstractions until a failing test proves the seam is insufficient.

## Phase 0: Confirmed Diagnosis

### Claude continuation

- Symptom: installed Claude initial review passed; `continue --job` failed with `parse_error`, empty stdout, and stderr `No conversation found with session ID: 749b07ee-4ac3-4618-b2c6-d088fc6e74a8`.
- Artifact proof: parent record stored `claude_session_id` equal to plugin job id and `runtime_diagnostics.child_cwd` under one `claude-neutral-cwd-*`; continue record used same session id but a different `claude-neutral-cwd-*`.
- External runtime proof: Claude persisted the parent session JSONL under `~/.claude/projects/<initial-neutral-cwd>/749b07ee-...jsonl`; lookup from another project/cwd failed.
- Falsified: cache drift, source-selection leak, `--no-session-persistence`, E2BIG, stderr diagnostic masking, direct API result parity.
- Root cause: plugin changed Claude project/session lookup cwd between parent and continue jobs.

### Semantic replay

- Symptom: exact passing permission prose did not trigger `permission_blocked`, but full audit still failed as `shallow_output` / `missing_verdict`.
- Root cause: smoke expected tiny classifier probes to satisfy full review-quality gates. That is an invalid acceptance criterion, not a permission-block classifier regression.

### Workflow gate

- Symptom: prior merge happened without explicit approval.
- Root cause: process invariant was not encoded as a hard workflow requirement in this feature spec/plan.

## Phase 1: Test-First Work

1. Add/keep regression proving Claude continue reuses parent provider session lookup cwd, not only `--resume`.
2. Strengthen mock seam if needed so a changed cwd reproduces `No conversation found with session ID`.
3. Keep stderr promotion regression for empty stdout with actionable stderr.
4. Add semantic replay tests that assert classifier outputs only for short snippets.
5. Keep full review-quality tests limited to review-shaped output with verdict and adequate substance.
6. Add/update workflow checklist so merge/remote mutation requires explicit current-turn approval.

## Phase 2: Implementation Work

1. Persist Claude provider project/cwd in runtime sidecars and/or JobRecord diagnostics.
2. On `continue --job`, reuse parent provider project/cwd for Claude session lookup.
3. Keep throwaway worktree/source-safety behavior separate from provider session lookup cwd.
4. Preserve cleanup of temporary neutral cwds when safe.
5. Update smoke harness semantics so classifier-only probes do not report overall audit failure unless the classifier reason is wrong.

## Phase 3: Verification

Required before any merge request:

1. `git diff --check`
2. Targeted Claude continue smoke test red/green evidence.
3. Full Claude smoke tests.
4. Review-prompt semantic tests.
5. `npm run lint`
6. `npm run doctor:cache` before installed-runtime validation; after local source changes this may be `ok:false` until reinstall/cache refresh.
7. Installed synthetic fixture live smoke after reinstall/cache sync:
   - source-free readiness for all providers
   - initial source-bearing review for all approved providers
   - continuation for Claude/Gemini/Kimi
   - direct API `result --job` for DeepSeek/GLM
   - classifier-only semantic probes reported separately from full audit probes
8. Explicit approval captured before merge/push/issue closure/remote mutation.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No constitution violations currently identified.
