---
name: kimi-delegation
description: Delegate review, adversarial review, rescue, and setup to Kimi Code CLI.
user-invocable: true
---

# Kimi Delegation

Use this skill when the user asks Codex to delegate work to Kimi Code CLI through
the Kimi plugin. This is the supported fallback while Codex CLI 0.125.0 does
not expose plugin `commands/*.md` files as TUI slash commands.

## Companion root

Run the companion from this plugin root:

```bash
node "<plugin-root>/scripts/kimi-companion.mjs" <subcommand> ...
```

`<plugin-root>` is the directory containing this plugin's `.codex-plugin/plugin.json`.
In the repository checkout, it is `plugins/kimi`.

## Workflows

- Setup/OAuth check:
  ```bash
  node "<plugin-root>/scripts/kimi-companion.mjs" ping
  ```
- Read-only review:
  ```bash
  node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=review --foreground --cwd "<workspace>" -- "<review focus>"
  ```
- Adversarial review:
  ```bash
  node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=adversarial-review --foreground --cwd "<workspace>" -- "<design or diff to challenge>"
  ```
- Disclosure/scope preflight:
  ```bash
  node "<plugin-root>/scripts/kimi-companion.mjs" preflight --mode=adversarial-review --cwd "<workspace>"
  ```
- Pinned bundle or selected-file review:
  ```bash
  node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=custom-review --foreground --cwd "<bundle-or-workspace>" --scope-paths "PR.diff,docs/*.md" -- "<review focus using relative paths>"
  ```
- Rescue/investigation:
  ```bash
  node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=rescue --foreground --cwd "<workspace>" -- "<task>"
  ```
- Background rescue:
  ```bash
  node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=rescue --background --cwd "<workspace>" -- "<task>"
  ```
- Status/result:
  ```bash
  node "<plugin-root>/scripts/kimi-companion.mjs" status --cwd "<workspace>" --all
  node "<plugin-root>/scripts/kimi-companion.mjs" result --cwd "<workspace>" --job "<job-id>"
  ```
- Cancel a background job:
  ```bash
  node "<plugin-root>/scripts/kimi-companion.mjs" cancel --job "<job-id>" --cwd "<workspace>"
  ```

## Rendering

Render companion JSON directly and keep the user's attention on `status`,
`result`, `structured_output`, `permission_denials`, `mutations`, and the
diagnostic fields `error_summary`, `error_cause`, `suggested_action`, and
`disclosure_note`. Surface `mutations` prominently for read-only review paths.
If target read permission denials leave no substantive result or findings,
render review blocked / no findings produced and list the denied operations.
For setup failures, tell the user to run `kimi` interactively if OAuth is
missing; never suggest setting `KIMI_API_KEY`.

## Guardrails

- Do not claim slash commands such as `/kimi-ping` are available on Codex CLI
  0.125.0.
- Kimi `cancel --job <job-id>` is wired and operational. Use it to cancel
  queued or running background jobs. For foreground runs, Ctrl+C is still the
  correct interrupt mechanism since there is no background job to target.
- Kimi plan mode alone is not a sandbox. The companion's review paths use Kimi
  plan mode, disposable scoped input, and post-run mutation detection.
- `branch-diff` reduces which files are reviewed, but a successful Kimi
  review still sends selected source content to the Kimi provider. If a
  private-repo approval reviewer denies that disclosure before the companion
  starts, report the review workflow as blocked before launch; the companion
  cannot emit a JobRecord when Codex prevents the process from starting.
- For review bundles, use `custom-review` with explicit `--scope-paths` and
  prompt Kimi with relative paths inside the granted scope. Do not point it
  at an absolute parent checkout path.
- Do not run `kimi` directly; use the companion so job records, mutation
  detection, and Kimi session identity handling remain consistent.
