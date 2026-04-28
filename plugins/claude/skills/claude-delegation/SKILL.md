---
name: claude-delegation
description: Delegate setup checks, review, adversarial review, rescue, status, result, and cancel workflows to Claude Code through the supported Codex skill surface.
user-invocable: true
---

# Claude Delegation

Use this skill when the user asks Codex to delegate work to Claude Code through
the Claude plugin. This is the supported fallback while Codex CLI 0.125.0 does
not expose plugin `commands/*.md` files as TUI slash commands.

## Companion root

Run the companion from this plugin root:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" <subcommand> ...
```

`<plugin-root>` is the directory containing this plugin's `.codex-plugin/plugin.json`.
In the repository checkout, it is `plugins/claude`.

## Workflows

- Setup/OAuth check:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" ping
  ```
- Read-only review:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" run --mode=review --foreground --cwd "<workspace>" -- "<review focus>"
  ```
- Adversarial review:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" run --mode=adversarial-review --foreground --cwd "<workspace>" -- "<design or diff to challenge>"
  ```
- Rescue/investigation:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" run --mode=rescue --foreground --cwd "<workspace>" -- "<task>"
  ```
- Background rescue:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" run --mode=rescue --background --cwd "<workspace>" -- "<task>"
  ```
- Status/result/cancel:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" status --cwd "<workspace>" --all
  node "<plugin-root>/scripts/claude-companion.mjs" result --cwd "<workspace>" --job "<job-id>"
  node "<plugin-root>/scripts/claude-companion.mjs" cancel --cwd "<workspace>" --job "<job-id>"
  ```

## Rendering

Render companion JSON according to `claude-result-handling`. Surface
`mutations` prominently for read-only review paths. Do not expose full prompts
or secrets. For setup failures, tell the user to run `claude` interactively if
OAuth is missing; never suggest setting `ANTHROPIC_API_KEY`.

## Guardrails

- Do not claim slash commands such as `/claude-ping` are available on Codex CLI
  0.125.0.
- Prefer review or adversarial-review for read-only critique. Use rescue only
  when the user wants Claude Code to investigate or make changes.
- Do not run `claude` directly; use the companion so job records, mutation
  detection, and session identity handling remain consistent.
