---
name: claude-delegation
description: Delegate review, adversarial review, rescue, and setup to Claude Code.
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
  node "<plugin-root>/scripts/claude-companion.mjs" doctor
  ```
For review or adversarial-review, add `--scope-base REF` before `--` when the user provides a base ref.

- Read-only review:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" run --mode=review --foreground --lifecycle-events jsonl --cwd "<workspace>" -- "<review focus>"
  ```
- Adversarial review:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" run --mode=adversarial-review --foreground --lifecycle-events jsonl --cwd "<workspace>" -- "<design or diff to challenge>"
  ```
- Disclosure/scope preflight:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" preflight --mode=adversarial-review --cwd "<workspace>"
  ```
- Pinned bundle or selected-file review:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" run --mode=custom-review --foreground --lifecycle-events jsonl --cwd "<bundle-or-workspace>" --scope-paths "PR.diff,docs/*.md" -- "<review focus using relative paths>"
  ```
- Rescue/investigation:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" run --mode=rescue --foreground --cwd "<workspace>" -- "<task>"
  ```
- Background rescue:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" run --mode=rescue --background --lifecycle-events jsonl --cwd "<workspace>" -- "<task>"
  ```
- Continue a prior external review session:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" continue --job "<job-id>" --foreground --lifecycle-events jsonl --cwd "<workspace>" -- "<follow-up>"
  ```
- Status/result/cancel:
  ```bash
  node "<plugin-root>/scripts/claude-companion.mjs" status --cwd "<workspace>" --all
  node "<plugin-root>/scripts/claude-companion.mjs" result --cwd "<workspace>" --job "<job-id>"
  node "<plugin-root>/scripts/claude-companion.mjs" cancel --cwd "<workspace>" --job "<job-id>"
  ```

## Rendering

Render companion JSON according to `claude-result-handling`. If
`external_review` is present, render its EXTERNAL REVIEW box/rail before normal
status or findings prose. Surface `mutations` prominently for read-only review
paths, and render diagnostic fields such as `error_summary`, `error_cause`,
`suggested_action`, and `disclosure_note` before raw `error_message` when
present. If `external_review.disclosure` is already rendered, do not repeat an
identical `disclosure_note` or a `disclosure_note` that restates a scope failure
was not sent before launch. Do not expose full prompts or secrets. If target
read permission denials leave no substantive result or findings, render review blocked / no
findings produced and list the denied operations. For setup failures, tell the
user to run `claude` interactively if OAuth is missing; never suggest setting
`ANTHROPIC_API_KEY`.

## Guardrails

- Do not claim slash commands such as `/claude-ping` are available on Codex CLI
  0.125.0.
- Prefer review or adversarial-review for read-only critique. Use rescue only
  when the user wants Claude Code to investigate or make changes.
- For review bundles, use `custom-review` with explicit `--scope-paths` and
  prompt Claude with relative paths inside the granted scope. Do not point it
  at an absolute parent checkout path.
- Do not run `claude` directly; use the companion so job records, mutation
  detection, and session identity handling remain consistent.
