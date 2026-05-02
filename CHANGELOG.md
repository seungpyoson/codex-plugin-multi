# Changelog

## Unreleased

### Changed

- Added Kimi Code CLI as a third plugin with setup, preflight, review,
  adversarial-review, custom-review, rescue, status, result, cancel, mock smoke
  coverage, and opt-in live E2E coverage.
- Added direct API-backed DeepSeek and GLM reviewers with explicit
  `auth_mode: "api_key"` provider config, safe credential-name diagnostics,
  mock smoke coverage, and GLM Coding Plan endpoint support.
- Hardened Claude and Gemini preflight output with explicit safety fields that
  report no target spawn, no selected-scope send, and the external-provider
  consent requirement.
- Made Claude and Gemini setup diagnostics render a consistent
  `ready` / `summary` / `next_action` contract across success, missing auth,
  rate-limit, missing-binary, and generic-error paths.
- Made plugin-managed Claude and Gemini runs ignore provider API-key
  environment variables by policy while reporting ignored key names without
  exposing secret values.
- Added Gemini capacity fallback for configured model candidates and report the
  final fallback hop plus the full hop history used by ping.
- Added a manifest lint guard that rejects plugin `commands` declarations until
  upstream Codex supports plugin command-file registration and dispatch.

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
- Added the plugin `skills` manifest pointer for both targets and hardened
  setup ping so the default probe uses the target CLI's native model selection;
  ping JSON keeps a `model` key and returns `null` when no explicit `--model`
  override was supplied.
- Hardened post-review setup/status edge cases: ping auth classification now
  recognizes common `authentication` / `credentials` variants without matching
  unrelated `author*` text; Gemini generic ping errors now include `exit_code`
  like Claude; orphan reconciliation batches active-job CAS updates under one
  state lock and can reclaim full state-only active records when `meta.json`
  is missing.

### Known limitations

- Codex CLI 0.125.0 does not currently expose plugin `commands/*.md` files as TUI slash commands.
  Fresh-install verification confirmed `/claude-ping` is rejected even after the
  Claude plugin is installed and enabled. The command docs are packaged, but the
  current TUI slash-command registry only dispatches built-ins.
- Diagnostic ping command docs are deferred until upstream Codex exposes plugin
  command files through the TUI. Tracked in
  https://github.com/seungpyoson/codex-plugin-multi/issues/13.
- Live Claude/Gemini/Kimi E2E tests require local OAuth state and are opt-in,
  not CI defaults.
- Scope tests include intentionally broad object-pure safety coverage and remain
  relatively slow.
- `git cat-file --batch` optimization is deferred to a performance cleanup.

### Upstream attribution

- Ports portions of `openai/codex-plugin-cc` from MIT-licensed upstream code
  with attribution in `NOTICE`.
- Shared library provenance is recorded in
  `plugins/claude/scripts/lib/UPSTREAM.md` and
  `plugins/gemini/scripts/lib/UPSTREAM.md`.
