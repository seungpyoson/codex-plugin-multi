# codex-plugin-multi

Two Codex plugins that let Codex delegate work to **Claude Code** and **Gemini CLI**. Symmetric inverse of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), which lets Claude Code delegate to Codex.

- **License:** Apache-2.0 (ports portions of MIT-licensed upstream with attribution in `NOTICE`)
- **Status:** M0 — install-path scaffold only. Runtime ships in M2+.

## Status (as of M0)

This milestone ships the install-path + diagnostic ping only. Runtime commands (`rescue`, `review`, etc.) arrive in later milestones per `docs/superpowers/plans/`.

What works today:
- `codex plugin marketplace add seungpyoson/codex-plugin-multi` installs the marketplace.
- Enable either plugin via Codex TUI (`/plugins` → Space to toggle).
- `/claude-ping` and `/gemini-ping` each reply `ok` to prove the dispatch path.

## Planned surface (v0.1.0 target — see spec for details)

| Command | Behavior |
|---|---|
| `/claude-rescue <task>` / `/gemini-rescue <task>` | Background investigation or fix by the target CLI. |
| `/claude-review [<focus>]` / `/gemini-review [<focus>]` | Read-only review of current diff/files. |
| `/claude-adversarial-review` / `/gemini-adversarial-review` | Forced-dissent review that challenges assumptions. |
| `/claude-setup` / `/gemini-setup` | OAuth readiness probe, no API keys touched. |
| `/claude-status` / `/gemini-status` | List running and recent jobs. |
| `/claude-result <id>` / `/gemini-result <id>` | Render the result of a job by ID. |
| `/claude-cancel <id>` / `/gemini-cancel <id>` | Stop a background job. |

## Safety posture

- **OAuth only.** Never reads `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or any `*_API_KEY` env var. OAuth is delegated to each target CLI's native login flow.
- **Read-only reviews are best-effort.** Neither Claude Code nor Gemini CLI exposes an OS-level sandbox. Review paths layer defenses (Claude `--disallowedTools`; Gemini TOML `--policy` deny rules) + run under `--dispose` (default) which clones the workspace into a throwaway git worktree. Mutations to the user's working tree are detected and reported, never auto-reverted.
- **Gemini plan-mode is NOT a sandbox.** Per Gemini's own docs (`plan-mode.md:487-495`), non-interactive plan mode auto-escalates to YOLO when exiting. The only reliable Gemini enforcement layer is a `--policy` file with `decision = "deny"` rules. See `plugins/gemini/policies/read-only.toml` once M7 ships.
- **Claude `--bare` is incompatible with OAuth.** Verified against Claude Code 2.1.118: `--bare` disables OAuth reads. This plugin uses `--setting-sources ""` instead to strip CLAUDE.md bias while preserving OAuth.
- **Worktree isolation.** `--dispose` uses `git worktree add --detach` (verified 2026-04-24: probe writes land in worktree, main tree stays clean).

## Installation (M0 scope)

```bash
# From Codex:
codex plugin marketplace add seungpyoson/codex-plugin-multi
# Then enable both plugins:
# - Open Codex TUI, type /plugins, Space to toggle "claude" and "gemini"
# Test:
# - /claude-ping → "ok"
# - /gemini-ping → "ok"
```

## Repository layout

```
codex-plugin-multi/
  .agents/plugins/marketplace.json       # registers both plugins
  plugins/claude/                        # Codex plugin: claude
  plugins/gemini/                        # Codex plugin: gemini
  docs/superpowers/
    specs/    # design spec (v4 — empirically verified)
    plans/    # implementation plan (M0-M10, 47 tasks)
  scripts/ci/check-manifests.mjs         # manifest linter
```

## Contributing / development

- **Plan-driven.** Every commit's message ends with `Plan-task: T<N.M>` referencing `docs/superpowers/plans/`.
- **Test strategy.** Unit + smoke-with-mock-CLIs in CI. Real-CLI E2E runs manually (OAuth required).
- **Upstream tracking.** `plugins/<target>/scripts/lib/UPSTREAM.md` records the synced commit SHA from `openai/codex-plugin-cc` when libs land in M1.

## Attribution

Ports portions of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (MIT) to Apache-2.0. See `NOTICE` for full upstream MIT text and attribution.
