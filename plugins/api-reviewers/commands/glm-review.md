---
description: Ask GLM direct API to review the current diff.
argument-hint: "[review prompt]"
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode review --scope branch-diff --foreground --prompt "$ARGUMENTS"
```

Render the returned JobRecord. Do not print API-key values.
