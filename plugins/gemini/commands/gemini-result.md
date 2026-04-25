---
description: Show the persisted result for a Gemini-plugin job.
argument-hint: "<job-id>"
---

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" result --job "$ARGUMENTS"
```

Render the returned JobRecord. Do not expose sidecar file paths unless the user asks.
