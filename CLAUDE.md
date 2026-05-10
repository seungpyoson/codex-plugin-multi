# codex-plugin-multi — Claude Code project notes

## Test

`npm test`

`npm test` defaults to the incremental pre-commit subset. The slow path —
`tests/unit/scope.test.mjs` (real-git scope coverage) — is opted into via
`CODEX_PLUGIN_FULL_TESTS=1` (or `npm run test:full`). CI and no-mistakes
run the full matrix explicitly.

Run `npm run test:full` locally before opening a PR.

## Notes

- All work happens on branch `fix/<issue>-<short-desc>` cut from
  `origin/main`, never directly on local `main`.
- Push WIP branches early so the work is durable across sessions.
- safe_git.py wraps `git commit` / `git merge` / `gh pr` — use it instead of
  raw git for those operations.
