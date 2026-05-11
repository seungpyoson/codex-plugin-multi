# Research: No-Mistakes Provider Readiness

## Decision: Use no-mistakes as PR gate, not replacement for tests

`no-mistakes` pushes through a local git proxy, runs validation in a disposable worktree, forwards upstream only after checks pass, and can open a clean PR. This repo already configures `.no-mistakes.yaml` with `test: "npm ci && npm run lint && npm run test:full"`. Keep that gate; add tests that make the gate meaningful.

## Decision: Fix Grok uv cache at spawn env boundary

Root cause: Grok auto-start spawns `uv` with fixed `PATH` only. In Codex sandbox, `uv` tries `/Users/spson/.cache/uv` and fails `Operation not permitted`. The spawn env boundary is the correct fix seam because both `uv --version` and `uv run granian` use `uvExecutionEnv`.

## Decision: Treat session tokens separately from tunnel startup

With writable `UV_CACHE_DIR`, default grok2api starts but has zero runtime tokens. This is not same failure as uv startup. Doctor must continue reporting `grok_session_no_runtime_tokens` with sync/import guidance.

## Decision: Live smoke uses synthetic source only

Real project source is not needed to prove wiring. Use git-backed `/private/tmp` fixture and record hashes, source-send state, quality gate, mutations, prompt-persistence checks.
