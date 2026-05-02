---
description: Ask DeepSeek direct API for an adversarial review.
argument-hint: "[review prompt]"
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode adversarial-review --scope branch-diff --foreground --prompt "$ARGUMENTS"
```

Render the returned JobRecord. Do not print API-key values.
