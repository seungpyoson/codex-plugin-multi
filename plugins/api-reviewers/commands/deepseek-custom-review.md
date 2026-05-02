---
description: Ask DeepSeek direct API to review explicit files.
argument-hint: "--scope-paths <files> [review prompt]"
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode custom-review --scope custom --scope-paths "$SCOPE_PATHS" --foreground --prompt "$ARGUMENTS"
```

Render the returned JobRecord. Do not print API-key values.
