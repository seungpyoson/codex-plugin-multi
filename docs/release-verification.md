# Release verification

This runbook records the final fresh-install verification for v0.1.0.

Status: preflight draft. Do not mark this complete until it has been run on a
machine or account state that has not previously installed this marketplace.

## Scope

Verify that a new user can install the marketplace, enable both plugins, and run
one command per target from Codex.

## Preconditions

- Codex is installed and has plugin marketplace support.
- Git and Node.js are available on `PATH`.
- Claude Code is installed and authenticated if verifying `/claude-setup`.
- Gemini CLI is installed and authenticated if verifying `/gemini-setup`.
- The release branch has been merged to the repository location being installed.

## Fresh-install steps

1. Remove any prior marketplace install if present:

```bash
codex plugin marketplace remove codex-plugin-multi
```

It is acceptable if this reports that the marketplace is not installed.

2. Install from GitHub:

```bash
codex plugin marketplace add seungpyoson/codex-plugin-multi
```

Expected: Codex reports marketplace `codex-plugin-multi` was added.

3. Start Codex in a disposable test workspace:

```bash
mkdir -p /tmp/codex-plugin-multi-release-smoke
cd /tmp/codex-plugin-multi-release-smoke
git init
printf '%s\n' '# release smoke' > README.md
git add README.md
git commit -m 'seed release smoke'
codex
```

4. In Codex, open the plugin picker:

```text
/plugins
```

Expected: both `claude` and `gemini` are listed. Enable both.

5. Run one diagnostic command per plugin:

```text
/claude-ping
/gemini-ping
```

Expected: each returns `ok`.

6. Run setup checks if the target CLIs are installed and authenticated:

```text
/claude-setup
/gemini-setup
```

Expected: each reports target CLI readiness. If a target CLI is intentionally
missing on the verification machine, record that as skipped with the reason.

7. Run one read-only review command per target:

```text
/claude-review smoke-check the seeded repository
/gemini-review smoke-check the seeded repository
```

Expected: each command returns a completed result or a clear target-CLI error.
Target-CLI quota/authentication failures are environment failures, not plugin
packaging failures, and must be recorded explicitly.

8. Clean up:

```bash
codex plugin marketplace remove codex-plugin-multi
rm -rf /tmp/codex-plugin-multi-release-smoke
```

## Evidence log

### 2026-04-27 branch-ref verification

Environment:

- Branch/head: `feat/012-t7-6-regression-matrix` at `2338a07`.
- OS: macOS 26.4.1 (25E253), arm64.
- Codex: `codex-cli 0.125.0` at `/Users/spson/.npm-global/bin/codex`.
- Claude Code: `2.1.119 (Claude Code)` at `/Users/spson/.local/bin/claude`.
- Gemini CLI: `0.39.1` at `/Users/spson/.npm-global/bin/gemini`.

Live E2E:

- `CLAUDE_LIVE_E2E=1 npm run e2e:claude`: PASS, 1/1 test passed
  (`live Claude foreground review completes`, 7198 ms). Initial sandboxed run
  failed with `ConnectionRefused`; rerun outside the sandbox passed.
- `GEMINI_LIVE_E2E=1 npm run e2e:gemini`: PASS, 1/1 test passed
  (`live Gemini foreground review completes`, 12050 ms). Initial sandboxed run
  failed when Gemini emitted auth/browser-flow text instead of JSON; rerun
  outside the sandbox passed.

Fresh-install packaging check:

- Isolated home: `CODEX_HOME=/tmp/codex-release-home-hDIDkd`.
- Install command:
  `codex plugin marketplace add seungpyoson/codex-plugin-multi@feat/012-t7-6-regression-matrix`.
- Result: PASS. Codex reported the marketplace was added from
  `https://github.com/seungpyoson/codex-plugin-multi.git#feat/012-t7-6-regression-matrix`.
- Installed config recorded `source_type = "git"`,
  `source = "https://github.com/seungpyoson/codex-plugin-multi.git"`, and
  `ref = "feat/012-t7-6-regression-matrix"`.
- Installed marketplace contained `.agents/plugins/marketplace.json` with both
  `claude` and `gemini`, both plugin manifests at version `0.1.0`, and the
  expected command files for both targets.

Fresh-install TUI check:

- Disposable workspace creation succeeded at
  `/tmp/codex-plugin-multi-release-smoke`.
- ChatGPT device auth for the isolated `CODEX_HOME` succeeded after the initial
  API-key login proved insufficient for remote plugin sync.
- `/plugins` opened the plugin picker. The custom `Codex ↔ Claude/Gemini`
  marketplace listed both `Claude` and `Gemini`.
- Installing both plugins from the picker succeeded. The picker reported
  `Installed Claude plugin` and `Installed Gemini plugin`, and
  `config.toml` recorded both `claude@codex-plugin-multi` and
  `gemini@codex-plugin-multi` as enabled.
- After restarting Codex from the same isolated home, `/claude-ping` was still
  rejected as `Unrecognized command '/claude-ping'`. The fresh-install
  slash-command smoke is therefore not complete.
- `codex debug prompt-input` confirmed `Claude` loaded as an enabled plugin and
  exposed its skills, but the TUI slash-command surface did not expose
  `/claude-ping`. `Gemini` was installed and enabled in config, but did not
  appear in the model-visible plugin list because it contributes no skills,
  apps, or MCP servers.

## Current branch evidence

The branch-local release candidate has already passed:

- Full `npm test` in commit hooks through `2338a07`.
- Manifest/frontmatter lint.
- Mock Claude and Gemini smoke coverage.
- Opt-in live E2E harness skip-by-default checks.

This evidence does not replace the fresh-install verification above.
