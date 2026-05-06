---
name: deepseek-custom-review
description: Use when asking DeepSeek direct API to review explicit files.
user-invocable: true
---

# DeepSeek Custom Review

Use the API reviewer DeepSeek custom-review workflow. Current Codex builds expose it as `api-reviewers:deepseek-custom-review` in the skill picker; its skill frontmatter name is `deepseek-custom-review`; the command contract is `plugins/api-reviewers/commands/deepseek-custom-review.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs approval-request --provider deepseek --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --prompt "<focus>"
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --lifecycle-events jsonl --prompt "<focus>"
```

Replace `<file1>,<file2>` with comma- or newline-separated concrete relative `--scope-paths`; expand globs before running. `<focus>` is the user's review prompt or focus area. Render `external_review_launched` as soon as it appears, then render `external_review` before the review result when present. If the JobRecord failed, report `error_code`, `error_message`, `http_status` when present, and `suggested_action`. Never print API-key values.
The review timeout default is 600000 ms; `API_REVIEWERS_TIMEOUT_MS` is the non-interactive fallback. Rendered prompts above the provider `max_prompt_chars` budget fail before launch with `source_content_transmission: "not_sent"`; use narrower scope shards or override `API_REVIEWERS_MAX_PROMPT_CHARS` only after confirming the provider accepts larger prompts.
Direct API reviews send selected source content to an external provider. Before launching or retrying, render the `approval-request` output, request explicit approval with `recommended_tool_justification`, and if approval is denied generate a relay prompt instead of running the external API command.
