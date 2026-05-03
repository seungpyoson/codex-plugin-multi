# codex-plugin-multi

Codex plugins that let Codex delegate work to **Claude Code**, **Gemini CLI**,
**Kimi Code CLI**, and direct API-backed reviewers like **DeepSeek** and
**GLM**. This repository is the Codex-side counterpart to
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), which
lets Claude Code delegate to Codex.

- **License:** AGPL-3.0-only. Commercial use is permitted under the AGPL, but
  modified versions distributed or offered over a network must provide
  corresponding source under the same license. Portions are ported from
  MIT-licensed upstream code; see `NOTICE`.
- **State:** active development. Claude, Gemini, Kimi, and API-backed reviewer
  flows are implemented and covered by mock smoke tests. Fresh-install
  verification on Codex CLI
  0.125.0 found that the marketplace installs successfully, but the TUI does
  not register plugin command files as slash commands.

## Requirements

- Codex with plugin marketplace support.
- Git and Node.js available on `PATH`.
- Claude Code installed and authenticated if you enable the Claude plugin.
- Gemini CLI installed and authenticated if you enable the Gemini plugin.
- Kimi Code CLI installed and authenticated if you enable the Kimi plugin.
- `DEEPSEEK_API_KEY` if you enable the DeepSeek direct API reviewer.
- `ZAI_API_KEY` if you enable the GLM direct API reviewer. `ZAI_GLM_API_KEY`
  is accepted as a compatibility alias. GLM Coding Plan calls use
  `https://api.z.ai/api/coding/paas/v4`, not the general Z.ai endpoint.

Claude and Gemini default to each target CLI's native OAuth login and ignore
provider API-key env vars. They also support an explicit companion
`--auth-mode subscription|api_key|auto` option for `setup`/`doctor`, `run`, and
`continue`: `subscription` strips API keys, `api_key` allows only that
provider's key names through intentionally, and `auto` uses API-key env auth
only when a provider key is already present. The selected path is reported as
`selected_auth_path`; secret values are never printed. Kimi remains
subscription/OAuth-only. Direct API reviewers are separate and only use API keys
through explicit `auth_mode: "api_key"` provider config.

## Codex sandbox setup

External review sends selected source content to another provider process or
API. Keep Codex workspace-write sandboxing enabled, but allow the minimum host
capabilities needed for the providers you use.

For DeepSeek and GLM direct API reviewers, Codex must allow outbound network
access:

```toml
[sandbox_workspace_write]
network_access = true
```

For Kimi, the first-party CLI normally writes state and logs below `~/.kimi`.
If Kimi setup or review returns `sandbox_blocked` with a `.kimi` path, add a
provider-specific writable root and start a fresh Codex session:

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users/<you>/.kimi/logs"]
```

Use the narrowest root that works for your Kimi installation. Start with
`/Users/<you>/.kimi/logs`; if the next denial names an OAuth/session file under
`/Users/<you>/.kimi`, fall back to the full `/Users/<you>/.kimi` tree. The
companion classifies `.kimi` permission denials as a writable-root problem so
users see this action instead of a generic auth or CLI error.

Gemini has a different sandbox interaction: Gemini CLI's native `-s` sandbox can
fail when launched from inside Codex's outer sandbox. The Gemini companion omits
only that native Gemini sandbox flag when `CODEX_SANDBOX` is active, while still
keeping the read-only TOML policy, `--approval-mode plan`, `--skip-trust`,
scoped input, and mutation detection.

If you do not want sandbox-wide network access, use one-off escalation for a
specific trusted reviewer command instead. In an interactive Codex session,
leave `network_access` disabled, run the reviewer command, and when Codex asks
whether to run that command outside the sandbox, approve only that command. Do
not persist a broad always-allow rule. Do not make `danger-full-access` or
`--dangerously-bypass-approvals-and-sandbox` the default; those modes remove
more protection than the reviewers require.

Troubleshooting signals:

- Direct API reviewers with `provider_unavailable`, `fetch failed`,
  `ENOTFOUND`, `EAI_AGAIN`, or `ECONNREFUSED` usually need network access or a
  one-off escalation. HTTP 5xx responses mean the provider was reached; retry
  later or switch provider instead of weakening sandbox policy.
- Kimi `Operation not permitted`, `Permission denied`, `EACCES`, or `EPERM`
  errors on `.kimi` paths need a Kimi writable root.
- Claude/Gemini/Kimi subscription/OAuth modes intentionally ignore unrelated
  API-key env vars. Do not treat stripped API keys as the cause unless you
  explicitly selected API-key auth for a provider that supports it.

## Install

From Codex:

```bash
codex plugin marketplace add seungpyoson/codex-plugin-multi
```

Then enable the plugins you want:

```text
/plugins
```

In the plugin picker, enable `claude`, `gemini`, `kimi`, and/or
`api-reviewers`. You can enable
one without the others.

## Verify skill discovery after installation

After enabling the plugins, open Codex's skill picker or ask Codex what plugin
skills are available. Current Codex builds expose plugin skills with their
plugin namespace; the installed skill list should include
`claude:claude-delegation`, `gemini:gemini-delegation`, and
`kimi:kimi-delegation`. The API-backed reviewer plugin exposes
`api-reviewers:api-reviewers-delegation`.

For a non-interactive check against the current Codex profile, run:

```bash
codex debug prompt-input 'list skills'
```

If you are testing a disposable profile, set `CODEX_HOME` to that profile before
running the same command. If the namespaced skills are missing, the plugin is
either not enabled in that Codex profile or the manifests are not exposing the
bundled `skills/` roots correctly.

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
- **Kimi delegation skill:** asks Kimi Code CLI to run setup checks, preflight,
  review, adversarial review, custom-review, rescue, status, result, or cancel workflows through
  `plugins/kimi/scripts/kimi-companion.mjs`.
- **API reviewers delegation skill:** asks DeepSeek or GLM direct API to run
  setup checks, review, adversarial review, or custom-review workflows through
  `plugins/api-reviewers/scripts/api-reviewer.mjs`.

Example prompts:

```text
Use the Claude delegation skill to review the current diff for regressions.
Use the Gemini delegation skill for an adversarial review of this design.
Use the Kimi delegation skill to review this branch for missed edge cases.
Use the API reviewers delegation skill to ask GLM to review selected files.
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
/kimi-review check this diff for regressions
/deepseek-review check this diff for regressions
/glm-review check this diff for regressions
```

## Command inventory

| Command | Status | Behavior |
|---|---|---|
| `/claude-setup` / `/gemini-setup` / `/kimi-setup` | Packaged | Target CLI availability and OAuth readiness check. |
| `/deepseek-setup` / `/glm-setup` | Packaged | Direct API-key readiness check; reports key names only. |
| `/claude-review [focus]` / `/gemini-review [focus]` / `/kimi-review [focus]` | Packaged | Read-only review profile over the selected scope. |
| `/deepseek-review [focus]` / `/glm-review [focus]` | Packaged | Direct API-backed review over the selected scope. |
| `/claude-adversarial-review [focus]` / `/gemini-adversarial-review [focus]` / `/kimi-adversarial-review [focus]` | Packaged | Read-only forced-dissent review profile. |
| `/deepseek-adversarial-review [focus]` / `/glm-adversarial-review [focus]` | Packaged | Direct API-backed forced-dissent review. |
| `/deepseek-custom-review --scope-paths <files>` / `/glm-custom-review --scope-paths <files>` | Packaged | Direct API-backed review of explicit files. |
| `/claude-rescue <task>` / `/gemini-rescue <task>` / `/kimi-rescue <task>` | Packaged | Background investigation or fix by the target CLI. |
| `/claude-status` / `/gemini-status` / `/kimi-status` | Packaged | List active and recent jobs for the current workspace. |
| `/claude-result <job-id>` / `/gemini-result <job-id>` / `/kimi-result <job-id>` | Packaged | Show the persisted result for a job. |
| `/claude-cancel <job-id>` | Packaged | Cancel a running Claude background job. Use Ctrl+C for foreground runs. |
| `/gemini-cancel <job-id>` | Packaged | Cancel a running Gemini background job. Use Ctrl+C for foreground runs. |
| `/kimi-cancel <job-id>` | Packaged | Cancel a running Kimi background job. Use Ctrl+C for foreground runs. |

Background jobs return a `job_id`. In a Codex build that supports plugin command
files, use `/<target>-status` to list jobs and `/<target>-result <job-id>` to
inspect the terminal record.

## Safety posture

- **Review modes are defensive, not magical.** Claude review paths use
  `--disallowedTools`; Gemini review paths use
  `plugins/gemini/policies/read-only.toml`; Kimi review paths use Kimi plan
  mode plus disposable scoped input. Mutations are detected and reported rather
  than auto-reverted.
- **Gemini plan-mode is NOT a sandbox.** Gemini's plan mode alone is not the
  enforcement layer for this plugin. The TOML policy file is the real read-only
  control used by Gemini review and adversarial-review paths.
- **`--dispose` is the default for review profiles.** Disposable containment
  materializes the selected scope outside the user's active working tree and
  cleans it up after the run.
- **Scope narrowing is not provider isolation.** `branch-diff` reduces which
  files are reviewed, but a successful external review still sends selected
  source content to the target provider.
- **API-key auth is explicit.** Claude and Gemini use `--auth-mode subscription`
  by default and strip provider API-key env vars. `--auth-mode api_key` allows
  only Claude or Gemini provider key names through; `--auth-mode auto` gives
  those key names precedence only when they are already present. DeepSeek and
  GLM direct API reviewers use `auth_mode: "api_key"` in
  `plugins/api-reviewers/config/providers.json`. Diagnostics report key names
  only and never print secret values.
- **Preflight before uncertain disclosure.** `preflight` reports selected files,
  file count, and byte count without launching the target provider. Use
  `custom-review` plus explicit `--scope-paths` for pinned review bundles, and
  prompt with relative paths inside the selected scope.
- **Host-owned pre-launch denials stay outside companion control.** If Codex
  blocks an external provider review before launching the companion process, the
  plugin cannot emit a JobRecord. That host-owned gap is tracked in
  https://github.com/seungpyoson/codex-plugin-multi/issues/13. Choose
  an approved provider, run local/Codex-only review, or use `preflight` to
  inspect disclosure before requesting an external review.
- **Rescue is write-capable.** Rescue modes are intended for investigation and
  fixes. Review and adversarial-review are the safer choices when you only want
  critique.
- **Foreground cancellation is terminal-owned.** Use Ctrl+C for foreground
  target runs. Companion cancellation is for background jobs.

## Manual E2E

CI uses deterministic mock target CLIs and mock API responses. Real Claude
Code, Gemini CLI, Kimi CLI, DeepSeek API, and GLM API checks are opt-in because
they require local OAuth state or live credentials. See `docs/e2e.md` for the
manual runbook:

```bash
CLAUDE_LIVE_E2E=1 npm run e2e:claude
GEMINI_LIVE_E2E=1 npm run e2e:gemini
KIMI_LIVE_E2E=1 npm run e2e:kimi
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
npm run smoke:kimi
npm run smoke:api-reviewers
COVERAGE_ENFORCE_TARGET=1 npm run test:coverage
```

Repository layout:

```text
codex-plugin-multi/
  .agents/plugins/marketplace.json
  plugins/claude/
  plugins/gemini/
  plugins/kimi/
  plugins/api-reviewers/
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
