# Changelog

## 0.1.0 - 2026-04-27

### Features shipped

- Added the Claude and Gemini Codex plugins under one marketplace manifest.
- Shipped user-invocable Claude and Gemini delegation skills as the supported
  Codex plugin surface for setup, review, adversarial-review, rescue, status,
  result, and cancel-aware workflows.
- Packaged the shared non-ping command docs for both targets: setup, review,
  adversarial-review, rescue, status, result, and cancel.
- Implemented Claude review/rescue lifecycle with foreground and background job
  records, prompt sidecars, status/result lookup, continuation, and background
  cancellation.
- Implemented Gemini foreground review/rescue plus background rescue, status,
  result, continue, and cancellation lifecycle parity.
- Added object-pure git scope population for working-tree, staged, HEAD,
  branch-diff, and custom scopes.
- Added mock smoke tests, unit coverage enforcement, per-target smoke CI jobs,
  manifest/frontmatter linting, and opt-in live E2E harnesses.

### Known limitations

- Codex CLI 0.125.0 does not currently expose plugin `commands/*.md` files as TUI slash commands.
  Fresh-install verification confirmed `/claude-ping` is rejected even after the
  Claude plugin is installed and enabled. The command docs are packaged, but the
  current TUI slash-command registry only dispatches built-ins.
- Diagnostic ping command docs are deferred until upstream Codex exposes plugin
  command files through the TUI. Tracked in
  https://github.com/seungpyoson/codex-plugin-multi/issues/13.
- Live Claude/Gemini E2E tests require local OAuth state and are opt-in, not CI
  defaults.
- Scope tests include intentionally broad object-pure safety coverage and remain
  relatively slow.
- `git cat-file --batch` optimization is deferred to a performance cleanup.

### Upstream attribution

- Ports portions of `openai/codex-plugin-cc` from MIT-licensed upstream code
  with attribution in `NOTICE`.
- Shared library provenance is recorded in
  `plugins/claude/scripts/lib/UPSTREAM.md` and
  `plugins/gemini/scripts/lib/UPSTREAM.md`.
