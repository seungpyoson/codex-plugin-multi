---
description: Ask GLM direct API for an adversarial review.
argument-hint: "[review prompt]"
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode adversarial-review --scope branch-diff --foreground --prompt "$ARGUMENTS"
```

Render the returned JobRecord. Do not print API-key values.
