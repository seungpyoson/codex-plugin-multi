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

Record final verification here after running the steps.

- Date:
- Codex version:
- OS:
- Marketplace install result:
- Claude command result:
- Gemini command result:
- Notes:

## Current branch evidence

The branch-local release candidate has already passed:

- Full `npm test` in commit hooks through `1099258`.
- Manifest/frontmatter lint.
- Mock Claude and Gemini smoke coverage.
- Opt-in live E2E harness skip-by-default checks.

This evidence does not replace the fresh-install verification above.
