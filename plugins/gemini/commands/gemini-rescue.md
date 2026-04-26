---
description: Delegate investigation or a fix to Gemini CLI. Supports foreground or background runs.
argument-hint: "[--foreground|--background] [--model <id>] [what Gemini should investigate or fix]"
---

Delegate investigation or fix work to Gemini CLI.

## Workflow

For long-running work, launch a background job:
```
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=rescue --background -- "$ARGUMENTS"
```

For quick attached work, run in the foreground:
```
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=rescue --foreground -- "$ARGUMENTS"
```

Background runs return a `launched` event with a `job_id`; use `/gemini-result <job-id>` to render the terminal JobRecord. Foreground runs return the terminal JobRecord directly. Rescue is write-capable by design.
