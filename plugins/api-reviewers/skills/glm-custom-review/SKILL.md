---
name: glm-custom-review
description: Use when asking GLM direct API to review explicit files.
user-invocable: true
---

# GLM Custom Review

Use the API reviewer GLM custom-review workflow. Current Codex builds expose it as `api-reviewers:glm-custom-review` in the skill picker; its skill frontmatter name is `glm-custom-review`; the command contract is `plugins/api-reviewers/commands/glm-custom-review.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --lifecycle-events jsonl --prompt "<focus>"
```

Replace `<file1>,<file2>` with comma- or newline-separated concrete relative `--scope-paths`; expand globs before running. `<focus>` is the user's review prompt or focus area. Render `external_review_launched` as soon as it appears, then render `external_review` before the review result when present. If the JobRecord failed, report `error_code`, `error_message`, `http_status` when present, and `suggested_action`. Never print API-key values.
The review timeout default is 600000 ms; `API_REVIEWERS_TIMEOUT_MS` is the non-interactive fallback. Rendered prompts above the provider `max_prompt_chars` budget fail before launch with `source_content_transmission: "not_sent"`; use narrower scope shards or override `API_REVIEWERS_MAX_PROMPT_CHARS` only after confirming the provider accepts larger prompts.
