---
description: Cancel a Gemini-plugin job. Runtime support is deferred; use Ctrl+C for foreground runs.
argument-hint: "<job-id> [--force]"
---

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" cancel --job "$ARGUMENTS"
```

## Guardrails

- Gemini `cancel` is not implemented yet; the companion currently returns `not_implemented`.
- Foreground runs are owned by the active terminal; interrupt them with Ctrl+C.
- Background `run` and `continue` are supported, but companion-driven background cancellation remains deferred.
