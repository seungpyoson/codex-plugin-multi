---
name: grok-review
description: Use when asking Grok Web to review the current branch diff.
user-invocable: true
---

# Grok Review

Use the Grok Web review workflow. Current Codex builds expose it as
`grok:grok-review` in the skill picker; its skill frontmatter name is
`grok-review`; the command contract is
`plugins/grok/commands/grok-review.md`.

Run from the repository root:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs run --mode review --scope branch-diff --foreground --lifecycle-events jsonl --prompt "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--prompt`.
The review timeout default is 900000 ms; `GROK_WEB_TIMEOUT_MS` is the override.
`<focus>` is the user's review prompt or focus area. Render the returned
JobRecord, render `external_review_launched` as soon as it appears, then render
`external_review` before the review result when present. If the JobRecord
failed, report `error_code`, `error_message`, `http_status` when present, and
`suggested_action`. Never print session cookies, tunnel API-key values, or
bearer token values.
Do not recommend direct xAI API keys as a fallback for subscription web mode.
