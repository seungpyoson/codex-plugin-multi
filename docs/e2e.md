# Manual E2E runbook

These checks use the real Claude Code, Gemini CLI, Kimi CLI, DeepSeek API, and
GLM API. They are not run in CI and are skipped by default unless the
maintainer explicitly opts in.

## Mock vs live

- `npm test`, `npm run smoke:claude`, `npm run smoke:gemini`, `npm run smoke:kimi`, and `npm run smoke:api-reviewers` use mock CLIs or mock API responses.
- `npm run e2e:claude`, `npm run e2e:gemini`, and `npm run e2e:kimi` use live CLIs and require local auth.
- Running an E2E command without the opt-in env var exits successfully with a skipped test.

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
  - Direct API companion live checks passed for DeepSeek
    (`DEEPSEEK_API_KEY`, `deepseek-v4-flash`, HTTP 200) and GLM
    (`ZAI_GLM_API_KEY`, `glm-5.1`, `https://api.z.ai/api/coding/paas/v4`,
    HTTP 200). Secret values were not printed.
