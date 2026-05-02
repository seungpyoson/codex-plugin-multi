---
description: Check Kimi Code CLI availability and OAuth readiness.
---

## Workflow

Run:
```
node "<plugin-root>/scripts/kimi-companion.mjs" doctor
```

Render results:
- Always show `summary`.
- If `ready: true`, report that Kimi Code CLI is ready.
- If `model_fallback` is present, mention the fallback was automatic and no user action is needed.
- If `ready: false`, show `next_action` exactly.
- If `ignored_env_credentials` is present, explain that those env vars were intentionally ignored by plugin policy; never print values.
