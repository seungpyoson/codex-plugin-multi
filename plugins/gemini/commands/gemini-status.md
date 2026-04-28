---
description: List active and recent Gemini-plugin jobs for the current workspace.
argument-hint: "[--job <id>] [--all]"
---

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" status $ARGUMENTS
```

Render the returned JSON as a table: `job_id`, `status`, `mode`, `model`, `started_at`, `ended_at`.

By default, queued/cancelled/stale jobs are hidden; pass `--all` to include them.
