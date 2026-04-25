---
description: Check Gemini CLI availability and OAuth readiness.
---

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" ping
```

If the binary is missing or OAuth is not ready, surface the returned JSON verbatim.
