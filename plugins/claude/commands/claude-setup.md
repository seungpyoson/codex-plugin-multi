---
description: Check that Claude Code is installed and OAuth is live. No API keys touched.
---

Setup readiness check for the Claude plugin.

## Workflow

1. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" ping
   ```
2. Render results:
   - `status: "ok"` → report "Claude Code ready" + the model ID that responded.
   - `status: "not_authed"` → instruct user to run `claude` interactively to complete OAuth. Do NOT try to set any `ANTHROPIC_API_KEY` env var.
   - `status: "not_found"` → print install URL (https://claude.com/claude-code) and stop.
   - `status: "rate_limited"` → advise retry in a few minutes.
3. Print a smoke-test hint: `/claude-review` or `/claude-ping`.

## Guardrails

- Never read or write `ANTHROPIC_API_KEY` or any `*_API_KEY` env var.
- Never persist credentials.
- Never auto-install or auto-update Claude Code.
