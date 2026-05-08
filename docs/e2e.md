# Manual E2E runbook

These checks use the real Claude Code, Gemini CLI, Kimi CLI, Grok web tunnel,
DeepSeek API, and GLM API. They are not run in CI and are skipped by default
unless the maintainer explicitly opts in.

## Mock vs live

- `npm test`, `npm run smoke:claude`, `npm run smoke:gemini`, `npm run smoke:kimi`, and `npm run smoke:api-reviewers` use mock CLIs or mock API responses.
- `npm run e2e:claude`, `npm run e2e:gemini`, and `npm run e2e:kimi` use live
  CLIs and require local auth.
- `npm run e2e:grok` uses a live subscription-backed Grok web tunnel and
  requires the tunnel to be running before the test starts.
- Running an E2E command without the opt-in env var exits successfully with a skipped test.

## Running inside Codex sandbox

Live external reviews need host capabilities beyond ordinary local tests. Keep
Codex workspace-write sandboxing enabled, and add only the provider capabilities
needed by the run:

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users/<you>/.kimi/logs"]
```

`network_access = true` is required for DeepSeek and GLM direct API calls. Kimi
may also need a writable root under `~/.kimi` because the first-party CLI writes
logs and auth/session state there. Start with `/Users/<you>/.kimi/logs`; if the
next denial names an OAuth/session file, fall back to `/Users/<you>/.kimi`.

If you do not want persistent sandbox network access, use one-off escalation for
the single trusted E2E command. In an interactive Codex session, keep
`network_access` disabled, run the E2E/reviewer command, and approve only that
command when Codex asks whether to run it outside the sandbox. Do not persist a
broad always-allow rule.

Do not use `danger-full-access` or `--dangerously-bypass-approvals-and-sandbox`
as the default verification setup. Those modes hide the sandbox behavior this
runbook is meant to verify.

## Claude

Prerequisites:

- Claude Code is installed and authenticated.
- Optional: set `CLAUDE_BINARY=/absolute/path/to/claude` if `claude` is not on `PATH`.

Command:

```sh
CLAUDE_LIVE_E2E=1 npm run e2e:claude
```

Expected result:

- The test prints `live Claude foreground review completes`.
- The companion returns a completed Claude `JobRecord`.
- Temporary cwd/data directories are removed after the test.

## Gemini

Prerequisites:

- Gemini CLI is installed and authenticated.
- Optional: set `GEMINI_BINARY=/absolute/path/to/gemini` if `gemini` is not on `PATH`.

Command:

```sh
GEMINI_LIVE_E2E=1 npm run e2e:gemini
```

Expected result:

- The test prints `live Gemini foreground review completes`.
- The companion returns a completed Gemini `JobRecord`.
- Temporary cwd/data directories are removed after the test.

## Kimi

Prerequisites:

- Kimi CLI is installed and authenticated.
- Optional: set `KIMI_BINARY=/absolute/path/to/kimi` if `kimi` is not on `PATH`.

Command:

```sh
KIMI_LIVE_E2E=1 npm run e2e:kimi
```

Expected result:

- The test prints `live Kimi foreground review completes`.
- The companion returns a completed Kimi `JobRecord`.
- Temporary cwd/data directories are removed after the test.

## Grok

Prerequisites:

- A subscription-backed local Grok web tunnel is running.
- The default endpoint targets grok2api:
  `GROK_WEB_BASE_URL=http://127.0.0.1:8000/v1`.
- If the tunnel requires a bearer value, set `GROK_WEB_TUNNEL_API_KEY` to the
  tunnel API key or cookie string. Do not print this value in logs.
- To import a local macOS Chrome-family Grok web session into grok2api, run
  `npm run grok:sync-browser-session` after starting grok2api. The helper reads
  local browser cookies loudly, may require Keychain access, defaults the
  grok2api pool to `super`, and prints only sanitized account status.

Command:

```sh
GROK_LIVE_E2E=1 npm run e2e:grok
```

Expected result:

- The test prints `live Grok subscription-backed local tunnel custom review completes`.
- `doctor` reports `ready: true`, `reachable: true`,
  `auth_mode: "subscription_web"`, and a `/models` probe endpoint.
- The review command returns a completed Grok Web `JobRecord` with
  `source_content_transmission: "sent"`.
- Secret values never appear in stdout.

If the test reports `tunnel_unavailable`, start or repair the local Grok web
tunnel and retry. Do not add xAI API keys as a fallback for this subscription
path.

## Direct API reviewers

Prerequisites:

- DeepSeek: `DEEPSEEK_API_KEY` is available in the Codex process.
- GLM: `ZAI_API_KEY` is available in the Codex process. `ZAI_GLM_API_KEY` is
  accepted as a compatibility alias.
- GLM Coding Plan calls use `https://api.z.ai/api/coding/paas/v4`.

Mock CI command:

```sh
npm run smoke:api-reviewers
```

Manual live readiness checks:

```sh
node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek
node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm
```

Manual live custom review:

```sh
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode custom-review --scope custom --scope-paths README.md --foreground --prompt "Review for correctness risks."
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode custom-review --scope custom --scope-paths README.md --foreground --prompt "Review for correctness risks."
```

Custom review scope sends the exact `--scope-paths` file contents to the direct
API provider. It does not apply gitignore filtering to explicitly selected
files, so do not include secrets, credentials, private keys, `.env` files, or
other sensitive local-only content.

Expected result:

- The doctor command reports `ready: true` and a `credential_ref` key name.
- The review command returns a completed `JobRecord`.
- Secret values never appear in stdout.

## Recording live verification

When a maintainer runs live E2E, record:

- Date/time and machine.
- Exact command.
- CLI binary path/version.
- Result summary.
- Any relevant session or log path from the CLI.

Latest live verification:

- 2026-05-02 on `SP-MB-Pro.local`, branch `issue-38-kimi-provider`:
  - `CLAUDE_LIVE_E2E=1 npm run e2e:claude` passed.
  - `GEMINI_LIVE_E2E=1 npm run e2e:gemini` passed.
  - `KIMI_LIVE_E2E=1 npm run e2e:kimi` passed.
  - Direct API companion live checks passed for the then-current DeepSeek default
    (`DEEPSEEK_API_KEY`, `deepseek-v4-flash`, HTTP 200) and GLM
    (`ZAI_GLM_API_KEY`, `glm-5.1`, `https://api.z.ai/api/coding/paas/v4`,
    HTTP 200). Secret values were not printed.

- Current Grok branch:
  - `GROK_WEB_MODEL=grok-4.3-beta GROK_LIVE_E2E=1 npm run e2e:grok` passed
    against `grok2api` after `npm run grok:sync-browser-session -- --browser
    chrome --profile Default --pool super` imported the local SuperGrok web
    session without printing secret values.

- 2026-05-03 03:18 KST on `SP-MB-Pro.local`, branch
  `fix/49-api-reviewers-installed-layout`, head
  `921f83609d26c95830f468bca6216681ce5f6e36`:
  - `CLAUDE_LIVE_E2E=1 npm run e2e:claude` passed with Claude Code
    `2.1.126`; this verifies model-bearing companion invocations with
    `--effort max`.
  - `GEMINI_LIVE_E2E=1 npm run e2e:gemini` passed with Gemini CLI `0.40.1`.
  - `KIMI_LIVE_E2E=1 npm run e2e:kimi` passed with Kimi CLI `1.41.0`.
  - `node plugins/kimi/scripts/kimi-companion.mjs ping` passed with Kimi CLI
    `1.41.0`; this verifies `--thinking` on the ping profile without an
    explicit model.
  - `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek`
    reported `ready: true`, `credential_ref: DEEPSEEK_API_KEY`,
    `endpoint: https://api.deepseek.com`, and `model: deepseek-v4-pro`.
  - `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm`
    reported `ready: true`, `credential_ref: ZAI_GLM_API_KEY`,
    `endpoint: https://api.z.ai/api/coding/paas/v4`, and `model: glm-5.1`.
  - A live DeepSeek `custom-review` scoped to `README.md` completed with
    `raw_model: deepseek-v4-pro`, `http_status: 200`,
    `endpoint: https://api.deepseek.com`, and
    `credential_ref: DEEPSEEK_API_KEY`, verifying `thinking.type=enabled`,
    `reasoning_effort=max`, and `max_tokens=65536`.
  - A live GLM `custom-review` scoped to `README.md` completed with
    `raw_model: glm-5.1`, `http_status: 200`,
    `endpoint: https://api.z.ai/api/coding/paas/v4`, and
    `credential_ref: ZAI_GLM_API_KEY`, verifying `thinking.type=enabled` and
    `max_tokens=131072`.
  - The direct API verification printed only redacted `JobRecord` metadata;
    secret values were not printed.
  - Provider quota, usage-tier, billing, credit-limit, or quota-bearing
    rate-limit failures are classified as `usage_limited` and may include safe
    `runtime_diagnostics.cost_quota` metadata. Direct API E2E does not query
    billing endpoints, purchase credits, upgrade tiers, or mutate billing
    state.
