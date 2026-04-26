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

For `staged`, `head`, and `branch-diff` scopes, the scoped tree is a git
object-pure snapshot: checkout filters, LFS smudge, EOL conversion, textconv,
hooks, and config-defined shell commands are not applied, and replace refs are
ignored. `working-tree` and `custom` reflect live filesystem content.
