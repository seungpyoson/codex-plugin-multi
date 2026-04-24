---
description: List active and recent Claude-plugin jobs for the current workspace.
argument-hint: "[--job <id>] [--all]"
---

## Workflow

Run:
```
node "<plugin-root>/scripts/claude-companion.mjs" status $ARGUMENTS
```

Render the returned JSON as a table: `job_id`, `status`, `mode`, `model`, `started_at`, `ended_at`.

## Guardrails

- Do not expose job sidecar file paths unless user explicitly asks.
- `--all` includes terminal jobs; default is running + recent completed/failed.
