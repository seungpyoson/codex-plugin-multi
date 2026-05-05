---
name: deepseek-review
description: Use when asking DeepSeek direct API to review the current branch diff.
user-invocable: true
---

# DeepSeek Review

Use the API reviewer DeepSeek review workflow. Current Codex builds expose it as `api-reviewers:deepseek-review` in the skill picker; its skill frontmatter name is `deepseek-review`; the command contract is `plugins/api-reviewers/commands/deepseek-review.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode review --scope branch-diff --lifecycle-events jsonl --prompt "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--prompt`. `<focus>` is the user's review prompt or focus area.
Render the returned JobRecord, render `external_review_launched` as soon as it appears, then render `external_review` before the review result when present, and never print API-key values.
