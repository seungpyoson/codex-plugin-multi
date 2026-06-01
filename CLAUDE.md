# relay — Claude Code project notes

<!-- SPECKIT START -->
Active spec-kit feature: **provider architecture parity** (spec 171).

For technical context, structure, gates, and the provider parity schema, read:
- `specs/171-provider-architecture-parity/evidence-map.md` — source-backed investigation record
- `specs/171-provider-architecture-parity/spec.md` — problem specification
- `specs/171-provider-architecture-parity/plan.md` — current implementation plan
- `specs/171-provider-architecture-parity/research.md` — Phase 0 research decisions
- `specs/171-provider-architecture-parity/data-model.md` — entities and invariants
- `specs/171-provider-architecture-parity/contracts/` — JSON schemas
- `specs/171-provider-architecture-parity/quickstart.md` — operator runbook
<!-- SPECKIT END -->

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
