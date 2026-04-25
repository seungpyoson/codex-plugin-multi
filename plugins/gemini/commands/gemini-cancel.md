---
description: Cancel a running Gemini-plugin background job once M8 background support lands. Use Ctrl+C for foreground runs.
argument-hint: "<job-id> [--force]"
---

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" cancel --job "$ARGUMENTS"
```

## Guardrails

- This command is for background jobs only. Foreground runs are owned by the active terminal; interrupt them with Ctrl+C.
- M7 returns `not_implemented`; M8 wires background cancel.
