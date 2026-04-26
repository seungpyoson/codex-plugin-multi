# codex-plugin-multi

Two Codex plugins that let Codex delegate work to **Claude Code** and
**Gemini CLI**. This repository is the Codex-side counterpart to
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), which
lets Claude Code delegate to Codex.

- **License:** Apache-2.0. Portions are ported from MIT-licensed upstream code;
  see `NOTICE`.
- **State:** active development. Claude and Gemini review/rescue/status/result
  flows are implemented and covered by mock smoke tests. Gemini `cancel` is deferred.

## Requirements

- Codex with plugin marketplace support.
- Git and Node.js available on `PATH`.
- Claude Code installed and authenticated if you enable the Claude plugin.
- Gemini CLI installed and authenticated if you enable the Gemini plugin.

The plugins use each target CLI's native OAuth login. They do not read
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or any `*_API_KEY` environment variable.

## Install

From Codex:

```bash
codex plugin marketplace add seungpyoson/codex-plugin-multi
```

Then enable the plugins you want:

```text
/plugins
```

In the plugin picker, enable `claude` and/or `gemini`. You can enable one
without the other.

## First commands

Run setup checks first:

```text
/claude-setup
/gemini-setup
```

Then verify dispatch:

```text
/claude-ping
/gemini-ping
```

Each ping should return `ok`. A first useful review command is:

```text
/claude-review check this diff for regressions
/gemini-review check this diff for regressions
```

## Command inventory

| Command | Status | Behavior |
|---|---|---|
| `/claude-ping` / `/gemini-ping` | Shipped | Diagnostic plugin dispatch check. |
| `/claude-setup` / `/gemini-setup` | Shipped | Target CLI availability and OAuth readiness check. |
| `/claude-review [focus]` / `/gemini-review [focus]` | Shipped | Read-only review profile over the selected scope. |
| `/claude-adversarial-review [focus]` / `/gemini-adversarial-review [focus]` | Shipped | Read-only forced-dissent review profile. |
| `/claude-rescue <task>` / `/gemini-rescue <task>` | Shipped | Background investigation or fix by the target CLI. |
| `/claude-status` / `/gemini-status` | Shipped | List active and recent jobs for the current workspace. |
| `/claude-result <job-id>` / `/gemini-result <job-id>` | Shipped | Show the persisted result for a job. |
| `/claude-cancel <job-id>` | Shipped | Cancel a running Claude background job. Use Ctrl+C for foreground runs. |
| `/gemini-cancel <job-id>` | Deferred | Gemini `cancel` currently returns `not_implemented`; use Ctrl+C for foreground runs. |

Background jobs return a `job_id`. Use `/<target>-status` to list jobs and
`/<target>-result <job-id>` to inspect the terminal record.

## Safety posture

- **Review modes are defensive, not magical.** Claude review paths use
  `--disallowedTools`; Gemini review paths use
  `plugins/gemini/policies/read-only.toml`. Mutations are detected and reported
  rather than auto-reverted.
- **Gemini plan-mode is NOT a sandbox.** Gemini's plan mode alone is not the
  enforcement layer for this plugin. The TOML policy file is the real read-only
  control used by Gemini review and adversarial-review paths.
- **`--dispose` is the default for review profiles.** Disposable containment
  materializes the selected scope outside the user's active working tree and
  cleans it up after the run.
- **Rescue is write-capable.** Rescue modes are intended for investigation and
  fixes. Review and adversarial-review are the safer choices when you only want
  critique.
- **Foreground cancellation is terminal-owned.** Use Ctrl+C for foreground
  target runs. Companion cancellation is for background jobs.

## Manual E2E

CI uses deterministic mock target CLIs. Real Claude Code and Gemini CLI checks
are opt-in because they require local OAuth state. See `docs/e2e.md` for the
manual runbook:

```bash
CLAUDE_LIVE_E2E=1 npm run e2e:claude
GEMINI_LIVE_E2E=1 npm run e2e:gemini
```

Without the live env vars, those E2E tests skip by design.

## Development

Common checks:

```bash
npm run lint
npm run lint:self-test
npm test
```

Useful focused checks:

```bash
npm run smoke:claude
npm run smoke:gemini
COVERAGE_ENFORCE_TARGET=1 npm run test:coverage
```

Repository layout:

```text
codex-plugin-multi/
  .agents/plugins/marketplace.json
  plugins/claude/
  plugins/gemini/
  docs/e2e.md
  docs/superpowers/
  scripts/ci/check-manifests.mjs
  tests/
```

## Attribution

Ports portions of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
from MIT to Apache-2.0. See `NOTICE` for upstream text and attribution.
