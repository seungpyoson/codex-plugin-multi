# codex-plugin-multi — Claude Code project notes

## Test

`npm test`

`npm test` defaults to a fast subset (~40s including smoke) so it fits the
60s pre-commit gate. The slow path — `tests/unit/scope.test.mjs` (155
real-git tests, ~140s on its own) — is opted into via
`CODEX_PLUGIN_FULL_TESTS=1` (or `npm run test:full`). CI sets the env var
explicitly so the full unit matrix runs in PRs.

Run `npm run test:full` locally before opening a PR.

## Notes

- All work happens on branch `fix/<issue>-<short-desc>` cut from
  `origin/main`, never directly on local `main`.
- Push WIP branches early so the work is durable across sessions.
- safe_git.py wraps `git commit` / `git merge` / `gh pr` — use it instead of
  raw git for those operations.
