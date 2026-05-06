---
description: Ask DeepSeek direct API to review the current diff.
argument-hint: "[--scope-base REF] [review prompt]"
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs approval-request --provider deepseek --mode review --scope branch-diff --prompt "<prompt text>"
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode review --scope branch-diff --lifecycle-events jsonl --prompt "<prompt text>"
```

`$ARGUMENTS` may include an optional `--scope-base REF` followed by prompt text. If present, pass `--scope-base REF` before `--prompt` and pass only the remaining prompt text to `--prompt`.
The review timeout default is 600000 ms; `API_REVIEWERS_TIMEOUT_MS` is the non-interactive fallback. Rendered prompts above the provider `max_prompt_chars` budget fail before launch with `source_content_transmission: "not_sent"`; use narrower scope shards or override `API_REVIEWERS_MAX_PROMPT_CHARS` only after confirming the provider accepts larger prompts.
Direct API reviews send selected source content to an external provider. Before launching or retrying, render the `approval-request` output, request explicit approval with `recommended_tool_justification`, and if approval is denied generate a relay prompt instead of running the external API command.
Render the returned JobRecord. Render `external_review_launched` as soon as it appears. If `external_review` is present, render it before the review result. If the JobRecord failed, report `error_code`, `error_message`, `http_status` when present, and `suggested_action`. Do not print API-key values.
