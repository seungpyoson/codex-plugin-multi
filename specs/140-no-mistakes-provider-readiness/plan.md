# Implementation Plan: No-Mistakes Provider Readiness

**Branch**: `140-no-mistakes-provider-readiness` | **Date**: 2026-05-11 | **Spec**: `specs/140-no-mistakes-provider-readiness/spec.md`

## Summary

Make delegated reviewer usage auditable across all providers. First TDD slice fixes Grok default startup so `uv` gets a sandbox-writable cache dir. Later slices add a six-provider live-smoke manifest and harden failure classification.

## Technical Context

**Language/Version**: Node.js 20+
**Primary Dependencies**: Node built-ins, plugin companion scripts, `uv` for grok2api
**Storage**: Local JobRecord JSON, plugin data dirs, synthetic `/private/tmp` fixture repos
**Testing**: `node:test`, smoke tests, `npm run lint`, `npm run test:full`, no-mistakes gate
**Target Platform**: macOS/Linux Codex local sessions
**Project Type**: CLI/plugin bundle
**Performance Goals**: Keep unit/smoke tests deterministic; live smoke records elapsed time instead of enforcing brittle provider latency budgets
**Constraints**: No secret printing; no real project source in live smoke; approval before direct API source send; no Docker requirement for Grok
**Scale/Scope**: Six reviewer providers: Claude, Gemini, Kimi, Grok, DeepSeek, GLM

## Constitution Check

- Evidence first: use real command output and audit fields.
- TDD: public CLI seam tests before fixes.
- No full prompt persistence.
- no-mistakes: keep `.no-mistakes.yaml` full gate intact.

## Project Structure

```text
plugins/grok/scripts/grok-web-reviewer.mjs
tests/smoke/grok-web.smoke.test.mjs
tests/smoke/*companion*.smoke.test.mjs
tests/smoke/api-reviewers.smoke.test.mjs
scripts/
docs/
specs/140-no-mistakes-provider-readiness/
```

**Structure Decision**: Existing CLI scripts and smoke tests are the correct public seams. Add shared manifest tooling only after Grok default startup slice is green.
