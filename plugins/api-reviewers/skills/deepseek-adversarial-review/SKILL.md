---
name: deepseek-adversarial-review
description: Use when asking DeepSeek direct API for an adversarial review.
user-invocable: true
---

# DeepSeek Adversarial Review

Use the API reviewer DeepSeek adversarial-review workflow. Current Codex builds expose it as `api-reviewers:deepseek-adversarial-review` in the skill picker; its skill frontmatter name is `deepseek-adversarial-review`; the command contract is `plugins/api-reviewers/commands/deepseek-adversarial-review.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode adversarial-review --scope branch-diff --lifecycle-events jsonl --prompt "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--prompt`. `<focus>` is the user's review prompt or focus area.
Render the returned JobRecord, render `external_review_launched` as soon as it appears, then render `external_review` before the review result when present. If the JobRecord failed, report `error_code`, `error_message`, `http_status` when present, and `suggested_action`. Never print API-key values.
