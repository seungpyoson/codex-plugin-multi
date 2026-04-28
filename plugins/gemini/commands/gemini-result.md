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
If `error_summary`, `error_cause`, `suggested_action`, or `disclosure_note` is
present, render those fields before the raw `error_message`.

For `staged`, `head`, and `branch-diff` scopes, the scoped tree is a git
object-pure snapshot: checkout filters, LFS smudge, EOL conversion, textconv,
hooks, and config-defined shell commands are not applied, and replace refs and
grafts are ignored. `working-tree` reflects live filesystem content for
**tracked + untracked-non-ignored** files only — gitignored files (e.g. `.env`)
are excluded by default to avoid exposing secrets to the target model. Use
`custom` with explicit globs when a caller deliberately needs to include
ignored files.
