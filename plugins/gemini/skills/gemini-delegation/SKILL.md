---
name: gemini-delegation
description: Delegate setup checks, review, adversarial review, rescue, status, result, and cancel-aware workflows to Gemini CLI through the supported Codex skill surface.
user-invocable: true
---

# Gemini Delegation

Use this skill when the user asks Codex to delegate work to Gemini CLI through
the Gemini plugin. This is the supported fallback while Codex CLI 0.125.0 does
not expose plugin `commands/*.md` files as TUI slash commands.

## Companion root

Run the companion from this plugin root:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" <subcommand> ...
```

`<plugin-root>` is the directory containing this plugin's `.codex-plugin/plugin.json`.
In the repository checkout, it is `plugins/gemini`.

## Workflows

- Setup/OAuth check:
  ```bash
  node "<plugin-root>/scripts/gemini-companion.mjs" ping
  ```
- Read-only review:
  ```bash
  node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=review --foreground --cwd "<workspace>" -- "<review focus>"
  ```
- Adversarial review:
  ```bash
  node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=adversarial-review --foreground --cwd "<workspace>" -- "<design or diff to challenge>"
  ```
- Rescue/investigation:
  ```bash
  node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=rescue --foreground --cwd "<workspace>" -- "<task>"
  ```
- Background rescue:
  ```bash
  node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=rescue --background --cwd "<workspace>" -- "<task>"
  ```
- Status/result:
  ```bash
  node "<plugin-root>/scripts/gemini-companion.mjs" status --cwd "<workspace>" --all
  node "<plugin-root>/scripts/gemini-companion.mjs" result --cwd "<workspace>" --job "<job-id>"
  ```
- Cancel a background job:
  ```bash
  node "<plugin-root>/scripts/gemini-companion.mjs" cancel --job "<job-id>" --cwd "<workspace>"
  ```

## Rendering

Render companion JSON directly and keep the user's attention on `status`,
`result`, `structured_output`, `permission_denials`, `mutations`, and the
diagnostic fields `error_summary`, `error_cause`, `suggested_action`, and
`disclosure_note`. Surface `mutations` prominently for read-only review paths.
For setup failures, tell the user to run `gemini` interactively if OAuth is
missing; never suggest setting `GEMINI_API_KEY`.

## Guardrails

- Do not claim slash commands such as `/gemini-ping` are available on Codex CLI
  0.125.0.
- Gemini `cancel --job <job-id>` is wired and operational. Use it to cancel
  queued or running background jobs. For foreground runs, Ctrl+C is still the
  correct interrupt mechanism since there is no background job to target.
- Gemini plan mode alone is not a sandbox. The companion's review paths use the
  bundled TOML read-only policy and disposable containment.
- `branch-diff` reduces which files are reviewed, but a successful Gemini
  review still sends selected source content to the Gemini provider. If a
  private-repo approval reviewer denies that disclosure, treat it as a policy
  decision rather than a plugin/runtime failure.
- Do not run `gemini` directly; use the companion so job records, mutation
  detection, and Gemini session identity handling remain consistent.
