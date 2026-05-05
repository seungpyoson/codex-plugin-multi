---
name: grok-custom-review
description: Use when asking Grok Web to review explicit files.
user-invocable: true
---

# Grok Custom Review

Use the Grok Web custom-review workflow. Current Codex builds expose it as
`grok:grok-custom-review` in the skill picker; its skill frontmatter name is
`grok-custom-review`; the command contract is
`plugins/grok/commands/grok-custom-review.md`.

Run from the repository root:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs run --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --foreground --lifecycle-events jsonl --prompt "<focus>"
```

Replace `<file1>,<file2>` with comma- or newline-separated concrete relative `--scope-paths`; expand globs before running. `<focus>` is the user's review prompt or focus area. Render `external_review_launched` as soon as it appears, then render `external_review` before the review result when
present. Never print session cookies, tunnel API-key values, or bearer token
values. Do not recommend direct xAI API keys as a fallback for subscription web
mode.
