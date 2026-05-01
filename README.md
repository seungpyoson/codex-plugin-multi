# codex-plugin-multi

Two Codex plugins that let Codex delegate work to **Claude Code** and
**Gemini CLI**. This repository is the Codex-side counterpart to
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), which
lets Claude Code delegate to Codex.

- **License:** AGPL-3.0-only. Commercial use is permitted under the AGPL, but
  modified versions distributed or offered over a network must provide
  corresponding source under the same license. Portions are ported from
  MIT-licensed upstream code; see `NOTICE`.
- **State:** active development. Claude and Gemini companion
  review/rescue/status/result/cancel flows are implemented and covered by mock
  smoke tests. Fresh-install verification on Codex CLI
  0.125.0 found that the marketplace installs successfully, but the TUI does
  not register plugin command files as slash commands.

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

## Verify skill discovery after installation

After enabling the plugins, open Codex's skill picker or ask Codex what plugin
skills are available. The installed skill list should include
`claude-delegation` and `gemini-delegation`. If they are missing, the plugin
is either not enabled in that Codex profile or the manifests are not exposing
the bundled `skills/` roots correctly.

## Current Codex 0.125.0 TUI limitation

Codex CLI 0.125.0 does not currently expose plugin `commands/*.md` files as TUI slash commands.
The command docs below are packaged for the intended plugin-command surface and
future or compatible Codex builds, but plugin command files are not valid slash
commands in this Codex build.

Until Codex exposes plugin command files through the TUI, verify runtime behavior
through the user-invocable skill fallback, the mock smoke tests, opt-in live E2E
tests, or the companion scripts under `plugins/<target>/scripts/`.

## Skill fallback

Codex CLI 0.125.0 can load plugin skills, so each plugin exposes one
user-invocable skill fallback:

- **Claude delegation skill:** asks Claude Code to run setup checks, preflight,
  review, adversarial review, custom-review, rescue, status, result, or cancel workflows through
  `plugins/claude/scripts/claude-companion.mjs`.
- **Gemini delegation skill:** asks Gemini CLI to run setup checks, preflight,
  review, adversarial review, custom-review, rescue, status, result, or cancel workflows through
  `plugins/gemini/scripts/gemini-companion.mjs`.

Example prompts:

```text
Use the Claude delegation skill to review the current diff for regressions.
Use the Gemini delegation skill for an adversarial review of this design.
```

## Deferred command docs

The plugin still packages command docs for the intended future slash-command
surface, except diagnostic ping command docs are deferred until upstream Codex
registers plugin command files. The ping follow-up is tracked in
https://github.com/seungpyoson/codex-plugin-multi/issues/13. Example future
command docs:

```text
/claude-review check this diff for regressions
/gemini-review check this diff for regressions
```

## Command inventory

| Command | Status | Behavior |
|---|---|---|
| `/claude-setup` / `/gemini-setup` | Packaged | Target CLI availability and OAuth readiness check. |
| `/claude-review [focus]` / `/gemini-review [focus]` | Packaged | Read-only review profile over the selected scope. |
| `/claude-adversarial-review [focus]` / `/gemini-adversarial-review [focus]` | Packaged | Read-only forced-dissent review profile. |
| `/claude-rescue <task>` / `/gemini-rescue <task>` | Packaged | Background investigation or fix by the target CLI. |
| `/claude-status` / `/gemini-status` | Packaged | List active and recent jobs for the current workspace. |
| `/claude-result <job-id>` / `/gemini-result <job-id>` | Packaged | Show the persisted result for a job. |
| `/claude-cancel <job-id>` | Packaged | Cancel a running Claude background job. Use Ctrl+C for foreground runs. |
| `/gemini-cancel <job-id>` | Packaged | Cancel a running Gemini background job. Use Ctrl+C for foreground runs. |

Background jobs return a `job_id`. In a Codex build that supports plugin command
files, use `/<target>-status` to list jobs and `/<target>-result <job-id>` to
inspect the terminal record.

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
- **Scope narrowing is not provider isolation.** `branch-diff` reduces which
  files are reviewed, but a successful external review still sends selected
  source content to the target provider.
- **Preflight before uncertain disclosure.** `preflight` reports selected files,
  file count, and byte count without launching the target provider. Use
  `custom-review` plus explicit `--scope-paths` for pinned review bundles, and
  prompt with relative paths inside the selected scope.
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
  docs/architecture-record.md
  docs/e2e.md
  docs/release-verification.md
  docs/superpowers/specs/2026-04-23-codex-plugin-multi-design.md
  docs/archive/
  scripts/ci/check-manifests.mjs
  tests/
```

`docs/archive/` contains historical implementation plans, smoke notes, and
review records. Treat the README plus the active docs listed above as the
current source of truth.

## Attribution

Ports portions of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
from MIT-licensed upstream code. See `NOTICE` for upstream text and attribution.
