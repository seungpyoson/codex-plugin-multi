---
name: deepseek-custom-review
description: Use when asking DeepSeek direct API to review explicit files.
user-invocable: true
---

# DeepSeek Custom Review

Use the API reviewer DeepSeek custom-review workflow. Current Codex builds expose it as `api-reviewers:deepseek-custom-review` in the skill picker; its skill frontmatter name is `deepseek-custom-review`; the command contract is `plugins/api-reviewers/commands/deepseek-custom-review.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --lifecycle-events jsonl --prompt "<focus>"
```

Replace `<file1>,<file2>` with comma- or newline-separated concrete relative `--scope-paths`; expand globs before running. `<focus>` is the user's review prompt or focus area. Render `external_review_launched` as soon as it appears, then render `external_review` before the review result when present. Never print API-key values.
