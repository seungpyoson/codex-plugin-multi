---
description: Ask GLM direct API to review the current diff.
argument-hint: "[--scope-base REF] [review prompt]"
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode review --scope branch-diff --prompt "<prompt text>"
```

`$ARGUMENTS` may include an optional `--scope-base REF` followed by prompt text. If present, pass `--scope-base REF` before `--prompt` and pass only the remaining prompt text to `--prompt`.
Render the returned JobRecord. If `external_review` is present, render it before the review result. Do not print API-key values.
