---
description: Check Gemini CLI availability and OAuth readiness.
---

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" doctor
```

Render results:
- Always show `summary`.
- If `ready: true`, report that Gemini CLI is ready.
- If `model_fallback` is present, mention the fallback was automatic and no user action is needed.
- If `ready: false`, show `next_action` exactly.
- If `status: "sandbox_blocked"`, show `next_action` exactly and explain
  that `~/.gemini` must be in Codex `writable_roots`; the user must start a
  fresh Codex session after changing sandbox roots.
- If `ignored_env_credentials` is present, explain that those env vars were intentionally ignored by plugin policy; never print values.
