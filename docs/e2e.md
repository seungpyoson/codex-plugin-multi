# Manual E2E runbook

These checks use the real Claude Code and Gemini CLI binaries. They are not run
in CI and are skipped by default unless the maintainer explicitly opts in.

## Mock vs live

- `npm test`, `npm run smoke:claude`, and `npm run smoke:gemini` use mock CLIs.
- `npm run e2e:claude` and `npm run e2e:gemini` use live CLIs and require local auth.
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

## Recording live verification

When a maintainer runs live E2E, record:

- Date/time and machine.
- Exact command.
- CLI binary path/version.
- Result summary.
- Any relevant session or log path from the CLI.

Latest live verification:

- Not run in this branch session. The skip-by-default E2E harness was verified locally.
