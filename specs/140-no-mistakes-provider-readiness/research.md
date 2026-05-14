# Research: No-Mistakes Provider Readiness

## Decision: Keep no-mistakes configured, but do not rely on it until the fix loop is deterministic

This repo already configures `.no-mistakes.yaml` with `test: "npm ci && npm run lint && npm run test:full"`. Keep that configuration, but do not treat no-mistakes as authoritative PR readiness evidence while `seungpyoson/claude-config#780` is open. That issue documents a review/fix-loop defect where selected findings can remain unresolved without reaching a deterministic terminal state. Until fixed, use direct local verification and GitHub CI as the merge-readiness evidence.

## Decision: Fix Grok uv cache at spawn env boundary

Root cause: Grok auto-start spawns `uv` with fixed `PATH` only. In Codex sandbox, `uv` tries the user's default uv cache directory (for example `$HOME/.cache/uv`) and fails `Operation not permitted`. The spawn env boundary is the correct fix seam because both `uv --version` and `uv run granian` use `uvExecutionEnv`.

## Decision: Treat session tokens separately from tunnel startup

With writable `UV_CACHE_DIR`, default grok2api starts but has zero runtime tokens. This is not same failure as uv startup. Doctor must continue reporting `grok_session_no_runtime_tokens` with sync/import guidance.

## Decision: Live smoke uses synthetic source only

Real project source is not needed to prove wiring. Use git-backed `/private/tmp` fixture and record hashes, source-send state, quality gate, mutations, prompt-persistence checks.

## Decision: Claude continuation must preserve provider project/cwd context

The installed post-merge smoke proved that Claude initial review can pass while `continue --job` fails with `No conversation found with session ID: <parent-job-id>`. The parent JobRecord and continue JobRecord used the same stored session id, and the initial run did not include `--no-session-persistence`; however, the parent session JSONL was stored under the initial Claude project/cwd in `~/.claude/projects/...`, while the continue run used a different neutral cwd. Claude session lookup is therefore not session-id-only in practice. The plugin must persist and reuse provider session lookup context across continuation jobs.

## Decision: Semantic replay must separate classifier-only probes from full audit gates

Short replay prose such as "PASS ... without permission blocks" is useful to prove that `permission_blocked` is not falsely emitted. It is not a full reviewer answer and should not be expected to pass verdict/substance gates. Smoke reports must classify that as a classifier probe result, not as a failed full review.

## Decision: Workflow mutations require explicit current approval

The readiness workflow includes non-code process gates. Merge, issue closure, destructive cleanup, push, or remote mutation must not run from inferred approval or stale context. The approval state must be explicit in the current operator workflow.

## Decision: Spec-kit agent context must point at the real active spec

`.specify/feature.json` points at `specs/140-no-mistakes-provider-readiness`, but AGENTS.md referenced nonexistent `specs/001-no-mistakes-wiring-readiness`. Agent context must be aligned with the active feature directory before planning or checklist work is trusted.
