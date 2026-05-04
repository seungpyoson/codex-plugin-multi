---
description: Ask Grok subscription-backed web tunnel to review the current diff.
argument-hint: "[--scope-base REF] [review prompt]"
---

Run:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs run --mode review --scope branch-diff --foreground --prompt "<focus>"
```

If `$ARGUMENTS` starts with `--scope-base REF`, route `--scope-base REF` before `--prompt` and route the remaining prompt text to `--prompt`. Render the
returned JobRecord, and render `external_review` before the review result when
present. Do not print session cookies, tunnel API keys, or bearer token values.
Do not recommend direct xAI API keys as a fallback for subscription web mode.
