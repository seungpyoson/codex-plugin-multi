---
name: grok-adversarial-review
description: Use when asking Grok Web for a forced-dissent branch review.
user-invocable: true
---

# Grok Adversarial Review

Use the Grok Web adversarial-review workflow. Current Codex builds expose it as
`grok:grok-adversarial-review` in the skill picker; its skill frontmatter name
is `grok-adversarial-review`; the command contract is
`plugins/grok/commands/grok-adversarial-review.md`.

Run from the repository root:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs run --mode adversarial-review --scope branch-diff --foreground --lifecycle-events jsonl --prompt "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--prompt`.
`<focus>` is the user's review prompt or focus area. Render the returned
JobRecord, render `external_review_launched` as soon as it appears, then render
`external_review` before the review result when present. If the JobRecord
failed, report `error_code`, `error_message`, `http_status` when present, and
`suggested_action`. Never print session cookies, tunnel API-key values, or
bearer token values.
Do not recommend direct xAI API keys as a fallback for subscription web mode.
