# Changelog

## 0.1.0 - 2026-04-27

### Features shipped

- Added the Claude and Gemini Codex plugins under one marketplace manifest.
- Shipped the shared command surface for both targets: ping, setup, review,
  adversarial-review, rescue, status, result, and cancel command docs.
- Implemented Claude review/rescue lifecycle with foreground and background job
  records, prompt sidecars, status/result lookup, continuation, and background
  cancellation.
- Implemented Gemini foreground review/rescue plus background rescue and
  `continue --job` lifecycle parity.
- Added object-pure git scope population for working-tree, staged, HEAD,
  branch-diff, and custom scopes.
- Added mock smoke tests, unit coverage enforcement, per-target smoke CI jobs,
  manifest/frontmatter linting, and opt-in live E2E harnesses.

### Known limitations

- Gemini `cancel` is still deferred and returns `not_implemented`.
- Live Claude/Gemini E2E tests require local OAuth state and are opt-in, not CI
  defaults.
- Scope tests include intentionally broad object-pure safety coverage and remain
  relatively slow.
- `git cat-file --batch` optimization is deferred to a performance cleanup.

### Upstream attribution

- Ports portions of `openai/codex-plugin-cc` from MIT to Apache-2.0 with
  attribution in `NOTICE`.
- Shared library provenance is recorded in
  `plugins/claude/scripts/lib/UPSTREAM.md` and
  `plugins/gemini/scripts/lib/UPSTREAM.md`.
