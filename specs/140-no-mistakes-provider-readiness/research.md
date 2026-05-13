# Research: No-Mistakes Provider Readiness

## Decision: Keep no-mistakes configured, but do not rely on it until the fix loop is deterministic

This repo already configures `.no-mistakes.yaml` with `test: "npm ci && npm run lint && npm run test:full"`. Keep that configuration, but do not treat no-mistakes as authoritative PR readiness evidence while `seungpyoson/claude-config#780` is open. That issue documents a review/fix-loop defect where selected findings can remain unresolved without reaching a deterministic terminal state. Until fixed, use direct local verification and GitHub CI as the merge-readiness evidence.

## Decision: Fix Grok uv cache at spawn env boundary

Root cause: Grok auto-start spawns `uv` with fixed `PATH` only. In Codex sandbox, `uv` tries the user's default uv cache directory (for example `$HOME/.cache/uv`) and fails `Operation not permitted`. The spawn env boundary is the correct fix seam because both `uv --version` and `uv run granian` use `uvExecutionEnv`.

## Decision: Treat session tokens separately from tunnel startup

With writable `UV_CACHE_DIR`, default grok2api starts but has zero runtime tokens. This is not same failure as uv startup. Doctor must continue reporting `grok_session_no_runtime_tokens` with sync/import guidance.

## Decision: Live smoke uses synthetic source only

Real project source is not needed to prove wiring. Use git-backed `/private/tmp` fixture and record hashes, source-send state, quality gate, mutations, prompt-persistence checks.
