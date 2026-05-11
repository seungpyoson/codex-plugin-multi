# codex-plugin-multi

Codex plugins that let Codex delegate work to **Claude Code**, **Gemini CLI**,
**Kimi Code CLI**, **Grok**, and direct API-backed reviewers like **DeepSeek**
and **GLM**. This repository is the Codex-side counterpart to
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), which
lets Claude Code delegate to Codex.

- **License:** AGPL-3.0-only. Commercial use is permitted under the AGPL, but
  modified versions distributed or offered over a network must provide
  corresponding source under the same license. Portions are ported from
  MIT-licensed upstream code; see `NOTICE`.
- **State:** active development. Claude, Gemini, Kimi, Grok, and API-backed
  reviewer flows are implemented and covered by mock smoke tests. Fresh-install
  verification on Codex CLI
  0.125.0 found that the marketplace installs successfully, but the TUI does
  not register plugin command files as slash commands.

## Requirements

- Codex with plugin marketplace support.
- Node.js available on `PATH`.
- Git 2.x or newer on macOS/Linux. Reviewer scope collection defaults to the
  hardened `/usr/bin/git` path and does not resolve `git` from the caller's
  ambient `PATH`; set `CODEX_PLUGIN_MULTI_GIT_BINARY` to an absolute executable
  Git path when your supported environment installs Git elsewhere. Relative,
  workspace-local, and `node_modules/.bin` overrides are rejected. The configured
  override is trusted for the current process after first validation, so point it
  at an operator-controlled path that cannot be replaced by the reviewed repo.
- Claude Code installed and OAuth-authenticated if you enable the Claude plugin.
  `claude auth status` alone is not enough for review readiness; `/claude-setup`
  also verifies OAuth-only non-interactive `claude -p` inference because status
  can report logged-in while print-mode inference returns HTTP 401.
- Gemini CLI installed and authenticated if you enable the Gemini plugin.
- Kimi Code CLI installed and authenticated if you enable the Kimi plugin.
- A local Grok web tunnel if you enable the Grok plugin. The default endpoint
  targets grok2api at `GROK_WEB_BASE_URL=http://127.0.0.1:8000/v1`; set
  `GROK_WEB_TUNNEL_API_KEY` only if your local tunnel requires a bearer value.
- `DEEPSEEK_API_KEY` if you enable the DeepSeek direct API reviewer.
- `ZAI_API_KEY` if you enable the GLM direct API reviewer. `ZAI_GLM_API_KEY`
  is accepted as a compatibility alias. GLM Coding Plan calls use
  `https://api.z.ai/api/coding/paas/v4`, not the general Z.ai endpoint.

Claude and Gemini default to `--auth-mode auto`: if the matching provider API
key is already present, the companion allows only that provider key through;
otherwise it falls back to each target CLI's native OAuth login. They also
support explicit `--auth-mode subscription|api_key|auto` for `setup`/`doctor`,
`run`, and `continue`: `subscription` strips API keys and forces OAuth, and
`api_key` requires a matching provider key. The selected path is reported as
`selected_auth_path`; secret values are never printed. Kimi remains
subscription/OAuth-only. Direct API reviewers are separate and only use API keys
through explicit `auth_mode: "api_key"` provider config.

The Grok plugin defaults to Grok subscription usage through a local tunnel that
is backed by a subscription-backed web session. It is not an `api.x.ai`
integration and does not silently fall back to paid xAI API billing. If the
local tunnel is unavailable or the web session expires, the Grok JobRecord
reports that failure instead of switching billing paths. Subscription usage
limits are reported as `usage_limited`; the plugin does not purchase credits,
upgrade tiers, or switch to a paid fallback automatically.
`/grok-setup` and the `doctor` command make a live `GET /models` probe against
the configured tunnel endpoint. `ready: true` means the local tunnel was
reachable; `tunnel_unavailable` means start the local Grok web tunnel and retry.
Grok run records can be inspected with
`node plugins/grok/scripts/grok-web-reviewer.mjs list` and
`node plugins/grok/scripts/grok-web-reviewer.mjs result --job-id <job_id>`.
For grok2api session setup on macOS, `npm run grok:sync-browser-session`
performs a loud local Chrome-family cookie import into `grok2api`; it announces
the browser profile it reads, may require Keychain access, and prints only
sanitized pool/quota status.
See `docs/grok-subscription-tunnel.md` for compatible tunnel setup and live E2E
verification.

## Codex sandbox setup

External review sends selected source content to another provider process or
API. Keep Codex workspace-write sandboxing enabled, but allow the minimum host
capabilities needed for the providers you use.

For DeepSeek and GLM direct API reviewers, Codex must allow outbound network
access. Their setup commands perform a source-free live chat readiness probe, so
network or auth failures are reported before any selected repository source is
sent:

```toml
[sandbox_workspace_write]
network_access = true
```

Claude, Gemini, and Kimi use first-party CLIs that read or write local OAuth,
session, config, or log state. If setup or review returns `sandbox_blocked`
with a `.claude`, `.gemini`, or `.kimi` path, add the provider state directory
as a writable root and start a fresh Codex session before retrying. Claude and
Gemini usually need their full state trees because OAuth/session files can move
across releases:

```toml
[sandbox_workspace_write]
writable_roots = [
  "/Users/<you>/.claude",
  "/Users/<you>/.gemini"
]
```

For Kimi, the first-party CLI normally writes state and logs below `~/.kimi`;
Kimi alone does not require `network_access = true`.
If Kimi setup (`ping`) returns `sandbox_blocked` with a `.kimi` path, add a
provider-specific writable root and start a fresh Codex session. If a review
fails with a `.kimi` permission denial before setup catches it, use the same
staged writable-root remediation:

```toml
[sandbox_workspace_write]
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
- Direct API reviewers with `sandbox_blocked` need `API_REVIEWERS_PLUGIN_DATA`
  to resolve to a writable path inside the workspace or another approved
  writable root. Runs preflight this data root before collecting scope or
  sending source.
- Claude `Operation not permitted`, `Permission denied`, `EACCES`, or `EPERM`
  errors on `.claude` paths need `/Users/<you>/.claude` in writable roots.
- Gemini `Operation not permitted`, `Permission denied`, `EACCES`, or `EPERM`
  errors on `.gemini` paths need `/Users/<you>/.gemini` in writable roots.
- Kimi `Operation not permitted`, `Permission denied`, `EACCES`, or `EPERM`
  errors on `.kimi` paths need a Kimi writable root.
- Grok `tunnel_unavailable` means the subscription-backed local tunnel is not
  reachable at `GROK_WEB_BASE_URL`. Start or repair the tunnel rather than
  adding xAI API keys.
- Grok `models_ok_chat_400` is now the generic fallback only after local
  session probes fail to identify a sharper cause. `grok_session_no_runtime_tokens`
  means the tunnel has no active runtime session, `grok_session_malformed_active_token`
  means the active token is not JWT-shaped, and
  `grok_session_runtime_admin_divergence` means grok2api admin state has active
  tokens while runtime status still reports an empty token table.
- Reviewer runs with `review_not_completed` and
  `error_cause: "review_quality"` reached the provider or companion but did
  not return a usable review. Treat shallow summaries, permission-denied
  output, or text that admits the selected files were not inspected as failed
  review slots; rerun with a reviewer that can inspect the selected source
  instead of counting the slot as approved.
- Claude/Gemini/Kimi subscription/OAuth modes intentionally ignore unrelated
  API-key env vars. Do not treat stripped API keys as the cause unless you
  explicitly selected API-key auth for a provider that supports it.

Review-quality A/B prompts:

- `node scripts/review-quality-ab-fixture.mjs --packet packet1_correctness`
- `node scripts/review-quality-ab-fixture.mjs --packet packet2_security`
- `node scripts/review-quality-ab-fixture.mjs --packet packet3_clean`
- `node scripts/review-quality-ab-fixture.mjs --judge-context`

Use the packet prompt for both plugin and manual-relay reviewers. Use the
judge context only for scoring; it contains the seeded answer key and must not
be pasted into reviewer prompts.

Render collected JobRecords into a provider panel before judging quality:

```bash
node scripts/review-panel.mjs /path/to/job-records.json
```

The panel shows one row per provider with readiness, status, source
transmission, elapsed milliseconds, semantic failed-slot state, inspection
state, error code, HTTP status, and semantic failure reasons. A provider that
could not inspect files, returned shallow output, or hit Grok chat/session
readiness must appear as a failed row instead of being buried in prose.

## Install

From Codex:

```bash
codex plugin marketplace add seungpyoson/codex-plugin-multi
```

Then enable the plugins you want:

```text
/plugins
```

In the plugin picker, enable `claude`, `gemini`, `kimi`, `grok`, and/or
`api-reviewers`. You can enable
one without the others.

## Verify skill discovery after installation

After enabling the plugins, open Codex's skill picker or ask Codex what plugin
skills are available. Current Codex builds expose plugin skills with their
plugin namespace. The discoverable UX is `<plugin>:<provider-workflow>` through
workflow-specific skills such as `claude:claude-review`,
`gemini:gemini-rescue`, `kimi:kimi-status`, `grok:grok-review`,
`api-reviewers:deepseek-review`, and `api-reviewers:glm-setup`. The installed
skill list should also include the broad fallback skills
`claude:claude-delegation`, `gemini:gemini-delegation`,
`kimi:kimi-delegation`, `grok:grok-delegation`, and
`api-reviewers:api-reviewers-delegation`.

For a non-interactive check against the current Codex profile, run:

```bash
codex debug prompt-input 'list skills'
```

If you are testing a disposable profile, set `CODEX_HOME` to that profile before
running the same command. If the namespaced skills are missing, the plugin is
either not enabled in that Codex profile or the manifests are not exposing the
bundled `skills/` roots correctly.

## Repair stale plugin skill discovery

`npm install` only refreshes this repository's Node dependencies. It does not
refresh Codex's marketplace clone, runtime plugin cache, enabled plugin config,
or an already-open TUI session's in-memory skill inventory.

Run the read-only cache doctor before manually copying files:

```bash
npm run doctor:cache
```

For `second-codex`, inspect both profiles:

```bash
npm run doctor:cache -- --second-codex-home "$HOME/.codex-second"
```

The report compares both marketplace/plugin files and this repo's `plugins/`
tree against `plugins/cache/codex-plugin-multi/<plugin>/0.1.0`, including
SHA-256 checks for bundled `commands/`, `skills/`, `scripts/`, and `config/`
files. It reports `missing_files`, `extra_files`, `changed_files`, and
`repo_changed_files`, checks whether each plugin is enabled in `config.toml`,
and prints next actions. `cache_in_sync: true` with
`repo_cache_in_sync: false` means new Codex sessions will still run stale
installed plugin code. For Git marketplace installs, start with:

```bash
codex plugin marketplace upgrade codex-plugin-multi
```

If Codex reports that the marketplace is not configured as Git, remove and
re-add it from GitHub. After marketplace/cache or enablement changes, restart
the relevant Codex or `second-codex` TUI session; existing sessions do not
reliably hot-reload plugin skill inventory. Verify the target profile with:

```bash
codex debug prompt-input 'list skills'
```

## Current Codex 0.125.0 TUI limitation

Codex CLI 0.125.0 does not currently expose plugin `commands/*.md` files as TUI slash commands.
The command docs below are packaged for the intended plugin-command surface and
future or compatible Codex builds, but plugin command files are not valid slash
commands in this Codex build.

Until Codex exposes plugin command files through the TUI, verify runtime behavior
through user-invocable workflow-specific skills, the broad delegation skill
fallbacks, the mock smoke tests, opt-in live E2E tests, or the companion scripts
under `plugins/<target>/scripts/`.

## Workflow Skills

Codex CLI 0.125.0 can load plugin skills, so each provider workflow is exposed
as a user-invocable skill. Current Codex builds list these skills with plugin
namespaces. These are thin wrappers around the existing companion/API reviewer
contracts:

- **Claude:** `claude:claude-review`,
  `claude:claude-adversarial-review`, `claude:claude-rescue`,
  `claude:claude-setup`, `claude:claude-status`, `claude:claude-result`,
  `claude:claude-cancel`.
- **Gemini:** `gemini:gemini-review`,
  `gemini:gemini-adversarial-review`, `gemini:gemini-rescue`,
  `gemini:gemini-setup`, `gemini:gemini-status`, `gemini:gemini-result`,
  `gemini:gemini-cancel`.
- **Kimi:** `kimi:kimi-review`, `kimi:kimi-adversarial-review`,
  `kimi:kimi-rescue`, `kimi:kimi-setup`, `kimi:kimi-status`,
  `kimi:kimi-result`, `kimi:kimi-cancel`.
- **Grok:** `grok:grok-review`, `grok:grok-adversarial-review`,
  `grok:grok-custom-review`, `grok:grok-setup`.
- **DeepSeek:** `api-reviewers:deepseek-review`,
  `api-reviewers:deepseek-adversarial-review`,
  `api-reviewers:deepseek-custom-review`, `api-reviewers:deepseek-setup`.
- **GLM:** `api-reviewers:glm-review`,
  `api-reviewers:glm-adversarial-review`,
  `api-reviewers:glm-custom-review`, `api-reviewers:glm-setup`.

The broad delegation skills remain available as fallback/overview entries:
`claude:claude-delegation`, `gemini:gemini-delegation`,
`kimi:kimi-delegation`, `grok:grok-delegation`, and
`api-reviewers:api-reviewers-delegation`.

The original user-invocable skill fallback remains available for users who
prefer one overview entry per plugin. The Claude, Gemini, Kimi, Grok, and API
reviewers delegation skills still route to their companion/API reviewer scripts
as broad overview entries.
For Claude, Gemini, and Kimi, advanced `custom-review` and `preflight` flows
remain available through those broad delegation skills.

Example prompts:

```text
Use claude:claude-review to review the current diff for regressions.
Use gemini:gemini-adversarial-review for an adversarial review of this design.
Use kimi:kimi-rescue to investigate this failing test in the background, then use kimi:kimi-status and kimi:kimi-result.
Use grok:grok-review to review the current diff using my subscription.
Use api-reviewers:deepseek-custom-review to review selected files.
```

## Deferred command docs

The slash-command files remain packaged for the intended future slash-command
surface, except diagnostic ping command docs are deferred until upstream Codex
registers plugin command files. The ping follow-up is tracked in
https://github.com/seungpyoson/codex-plugin-multi/issues/13. Example future
command docs:

```text
/claude-review check this diff for regressions
/gemini-review check this diff for regressions
/kimi-review check this diff for regressions
/grok-review check this diff for regressions
/deepseek-review check this diff for regressions
/glm-review check this diff for regressions
```

## Command inventory

| Command | Status | Behavior |
|---|---|---|
| `/claude-setup` / `/gemini-setup` / `/kimi-setup` | Packaged | Target CLI availability and OAuth readiness check. Claude setup includes an OAuth-only non-interactive inference probe, not just `claude auth status`. |
| `/deepseek-setup` / `/glm-setup` | Packaged | Direct API-key readiness check plus source-free live provider probe; reports key names and probe status only. |
| `/grok-setup` | Packaged | Grok subscription-backed local tunnel readiness check; probes `/v1/models` by default and reports key names only. |
| `/claude-review [focus]` / `/gemini-review [focus]` / `/kimi-review [focus]` | Packaged | Read-only review profile over the selected scope. |
| `/grok-review [focus]` | Packaged | Subscription-backed Grok web review over the selected scope. |
| `/deepseek-review [focus]` / `/glm-review [focus]` | Packaged | Direct API-backed review over the selected scope. |
| `/claude-adversarial-review [focus]` / `/gemini-adversarial-review [focus]` / `/kimi-adversarial-review [focus]` | Packaged | Read-only forced-dissent review profile. |
| `/grok-adversarial-review [focus]` | Packaged | Subscription-backed Grok web forced-dissent review. |
| `/deepseek-adversarial-review [focus]` / `/glm-adversarial-review [focus]` | Packaged | Direct API-backed forced-dissent review. |
| `/grok-custom-review --scope-paths <files>` | Packaged | Subscription-backed Grok web review of explicit files. |
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
- **Claude/Gemini auth is explicit and reported.** Claude and Gemini default to
  `--auth-mode auto`: existing provider API-key env vars are allowed through by
  name only, otherwise the companion falls back to subscription/OAuth.
  `--auth-mode subscription` still strips provider keys and forces OAuth;
  `--auth-mode api_key` requires a matching provider key. DeepSeek and GLM
  direct API reviewers use `auth_mode: "api_key"` in
  `plugins/api-reviewers/config/providers.json`. Diagnostics report key names
  only and never print secret values.
- **Grok subscription is the default Grok path.** Grok uses
  `auth_mode: "subscription_web"` through a local tunnel and does not silently
  fall back to paid xAI API billing. Tunnel bearer values and session cookies
  must stay in user-managed env or tunnel state and must not be printed.
- **Cost/quota diagnostics are safe metadata only.** Reviewer records may include
  bounded `runtime_diagnostics.provider_request` metadata such as timeout,
  prompt-character count, and request-default summaries. Failed reviewer records
  may also include `runtime_diagnostics.cost_quota`, plus provider-reported
  `cost_usd` or `usage` where a target already returns those fields. They must not include invoices, payment details, secrets, cookies, full prompts, source
  bundles, or raw provider payloads. The plugin never purchases credits, upgrades
  usage tiers, or changes billing state automatically; any financial transaction
  must be a separate explicit user-approved action.
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
