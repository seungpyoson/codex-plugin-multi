---
description: Check that Claude Code is installed and OAuth is live. No API keys touched.
---

Setup readiness check for the Claude plugin.

## Workflow

1. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" doctor
   ```
2. Render results:
   - Always show `summary`.
   - If `ready: true`, report that Claude Code is ready.
   - If `ready: false`, show `next_action` exactly.
   - If `ignored_env_credentials` is present, explain that those env vars were intentionally ignored by plugin policy; never print values.
3. Print a smoke-test hint: ask Codex to use the Claude delegation skill for a
   read-only review.

## Guardrails

- Never read or write `ANTHROPIC_API_KEY` or any `*_API_KEY` env var.
- Never persist credentials.
- Never auto-install or auto-update Claude Code.
