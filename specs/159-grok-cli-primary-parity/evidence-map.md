# #159 Evidence Map: Grok CLI-Primary Transport Parity

## Live Issue State

- #159 is open and still describes Grok as web-tunnel-only.
- Current `main` no longer matches that old statement. Grok now defaults to the
  CLI transport, supports explicit web transport, and supports auto fallback.
- #176 is closed and records the completed Grok CLI login readiness / auto
  doctor fallback slice. Treat #176 as completed #159-adjacent behavior, not the
  whole #159 architecture goal.

## Current Code Evidence

- `plugins/grok/scripts/grok-companion.mjs` is the generic entrypoint and imports
  `runCli` from `plugins/grok/scripts/grok-web-reviewer.mjs`.
- `plugins/grok/scripts/grok-web-reviewer.mjs` currently contains:
  - transport normalization for `cli`, `web`, and `auto`
  - `cliConfig`, `webConfig`, `config`, `fallbackConfig`
  - trusted Grok CLI binary resolution
  - CLI readiness preflight and CLI launch
  - web tunnel readiness preflight and web launch
  - auto-doctor fallback logic
  - run-time auto fallback logic
  - CLI fallback diagnostics projection
  - JobRecord/runtime diagnostics construction for both transports
- This proves the remaining problem is locality/depth, not missing transport
  behavior.

## Current Behavior Evidence

- `config()` defaults to CLI transport when no option or `GROK_TRANSPORT` is
  provided.
- CLI config uses `auth_mode:"subscription_cli"`, provider `grok`, default model
  from `GROK_CLI_MODEL || DEFAULT_CLI_MODEL`, and direct Grok API capability
  facts only as ignored/default policy metadata.
- Web config uses `auth_mode:"subscription_web"`, provider `grok-web`, the local
  web tunnel base URL, and `GROK_WEB_MODEL`.
- `--transport auto` starts as CLI and can fallback to web only when the CLI
  failure is pre-source and in the eligible fallback set.
- Auto fallback carries CLI failure diagnostics into the web JobRecord under
  `runtime_diagnostics.cli_request`.
- Existing tests cover default CLI behavior, explicit CLI failure, explicit web
  isolation, auto CLI success, auto web fallback, auto-doctor fallback, prompt
  budget behavior, and help output.

## Root Problem

The root problem is that Grok transport behavior is not behind a deep Module
Interface. CLI and web are real Adapters in behavior, but their Interface is
implicit and spread across one large reviewer implementation. This lowers
locality: changing transport selection, config, prompt budgets, fallback
eligibility, or diagnostics requires editing and reviewing multiple unrelated
runtime branches.

## Non-Goals

- Do not reimplement #176.
- Do not change the default transport away from CLI.
- Do not make web fallback silent.
- Do not introduce paid xAI API fallback.
- Do not add browser/session repair automation.
- Do not close #172 large-packet recovery under this issue.

## Evidence Commands

```bash
gh issue view 159 --json number,title,state,body,labels,url
gh issue view 176 --json number,title,state,body,labels,url
rg -n "transport|subscription_cli|subscription_web|GROK_CLI_AUTO_FALLBACK_CODES" plugins/grok/scripts/grok-web-reviewer.mjs
rg -n "auto transport|explicit web transport|grok-companion" tests/smoke/grok-web.smoke.test.mjs tests/unit/manifests.test.mjs tests/unit/docs-contracts.test.mjs
npm test
```

## Baseline Verification

- Fresh #159 worktree baseline `npm test`: 2218 tests, 2206 pass, 0 fail,
  12 skipped.
