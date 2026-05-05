---
description: Ask DeepSeek direct API for an adversarial review.
argument-hint: "[--scope-base REF] [review prompt]"
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode adversarial-review --scope branch-diff --lifecycle-events jsonl --prompt "<prompt text>"
```

`$ARGUMENTS` may include an optional `--scope-base REF` followed by prompt text. If present, pass `--scope-base REF` before `--prompt` and pass only the remaining prompt text to `--prompt`.
Render the returned JobRecord. Render `external_review_launched` as soon as it appears. If `external_review` is present, render it before the review result. Do not print API-key values.
