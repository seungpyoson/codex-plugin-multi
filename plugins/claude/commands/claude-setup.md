---
description: Check that Claude Code is installed and a usable Claude auth path is live.
---

Setup readiness check for the Claude plugin.

## Workflow

1. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" doctor --auth-mode auto
   ```
2. Render results:
   - Always show `summary`.
   - If `ready: true`, report that Claude Code is ready.
   - If `ready: false`, show `next_action` exactly.
   - If `status: "oauth_inference_rejected"`, explain that OAuth status is
     present but non-interactive `claude -p` inference failed; this is a failed
     review slot, not a model verdict.
   - If `status: "sandbox_blocked"`, show `next_action` exactly and explain
     that `~/.claude` must be in Codex `writable_roots`; the user must start a
     fresh Codex session after changing sandbox roots.
   - If `selected_auth_path: "api_key_env"` is present, report that Claude is
     ready through API-key auth selected by `--auth-mode auto`; never print
     values.
   - If `ignored_env_credentials` is present, explain that those env vars were
     intentionally ignored by plugin policy; never print values.
3. Print a smoke-test hint: ask Codex to use the Claude delegation skill for a
   read-only review.

## Guardrails

- Never print `ANTHROPIC_API_KEY` or any `*_API_KEY` env var value.
- `--auth-mode auto` may select API-key auth when a Claude provider key is
  already present. Do not read, write, persist, or expose that credential.
- Never persist credentials.
- Never auto-install or auto-update Claude Code.
