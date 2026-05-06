---
name: glm-review
description: Use when asking GLM direct API to review the current branch diff.
user-invocable: true
---

# GLM Review

Use the API reviewer GLM review workflow. Current Codex builds expose it as `api-reviewers:glm-review` in the skill picker; its skill frontmatter name is `glm-review`; the command contract is `plugins/api-reviewers/commands/glm-review.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode review --scope branch-diff --lifecycle-events jsonl --prompt "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--prompt`. `<focus>` is the user's review prompt or focus area.
The review timeout default is 600000 ms; `API_REVIEWERS_TIMEOUT_MS` is the non-interactive fallback. Rendered prompts above the provider `max_prompt_chars` budget fail before launch with `source_content_transmission: "not_sent"`; use narrower scope shards or override `API_REVIEWERS_MAX_PROMPT_CHARS` only after confirming the provider accepts larger prompts.
Render the returned JobRecord, render `external_review_launched` as soon as it appears, then render `external_review` before the review result when present. If the JobRecord failed, report `error_code`, `error_message`, `http_status` when present, and `suggested_action`. Never print API-key values.
