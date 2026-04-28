---
description: Show the stored result of a finished Claude-plugin job.
argument-hint: "<job-id>"
---

## Workflow

Run:
```
node "<plugin-root>/scripts/claude-companion.mjs" result --job "$ARGUMENTS"
```

Render:
- If mode was `review` or `adversarial-review` and a mutation warning exists, surface it first.
- If `error_summary`, `error_cause`, `suggested_action`, or `disclosure_note` is populated, render those fields before the raw `error_message`.
- Render `result` as Markdown. If `structured_output` is populated, render its fields.
- Include cost/usage in a small footer.

## Guardrails

- Do not re-run the job. This command only renders stored output.
- If `not_found`, suggest `/claude-status --all` to list known job IDs.
