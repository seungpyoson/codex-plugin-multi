---
description: Delegate investigation or a fix to Gemini CLI. Foreground only until M8 background support lands.
argument-hint: "[--model <id>] [what Gemini should investigate or fix]"
---

Delegate investigation or fix work to Gemini CLI.

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=rescue --foreground -- "$ARGUMENTS"
```

Render the returned JobRecord. Rescue is write-capable by design.
