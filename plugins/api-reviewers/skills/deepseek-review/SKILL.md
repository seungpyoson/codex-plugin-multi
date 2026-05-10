---
name: deepseek-review
description: Use when asking DeepSeek direct API to review the current branch diff.
user-invocable: true
---

# DeepSeek Review

Use the API reviewer DeepSeek review workflow. Current Codex builds expose it as `api-reviewers:deepseek-review` in the skill picker; its skill frontmatter name is `deepseek-review`; the command contract is `plugins/api-reviewers/commands/deepseek-review.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs approval-request --provider deepseek --mode review --scope branch-diff --prompt "<focus>"
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode review --scope branch-diff --approval-token "<approval_token.value>" --lifecycle-events jsonl --prompt "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--prompt`. `<focus>` is the user's review prompt or focus area.
The review timeout default is 900000 ms; `API_REVIEWERS_TIMEOUT_MS` is the non-interactive fallback. Rendered prompts above the provider `max_prompt_chars` budget fail before launch with `source_content_transmission: "not_sent"`; use narrower scope shards or override `API_REVIEWERS_MAX_PROMPT_CHARS` only after confirming the provider accepts larger prompts.
Direct API reviews send selected source content to an external provider. Before launching or retrying, render the `approval-request` output, request explicit approval with `recommended_tool_justification`, and pass `approval_token.value` to `run` with `--approval-token` only after approval. If approval is denied, follow `denial_action` and generate a relay prompt instead of running the external API command.
Render the returned JobRecord, render `external_review_launched` as soon as it appears, then render `external_review` before the review result when present. If the JobRecord failed, report `error_code`, `error_message`, `http_status` when present, and `suggested_action`. Never print API-key values.
