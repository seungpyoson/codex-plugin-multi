---
description: Ask Grok subscription-backed web tunnel to review explicit files.
argument-hint: "--scope-paths <files> [review prompt]"
---

Run:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs run --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --foreground --lifecycle-events jsonl --prompt "<focus>"
```

Parse `$ARGUMENTS` so `--scope-paths <files>` becomes the command's
`--scope-paths` value and route the remaining prompt text to `--prompt`.
Replace `<file1>,<file2>` with comma- or newline-separated concrete relative paths; expand globs before running. Render the returned JobRecord, and render `external_review_launched` as soon as it appears, then render `external_review` before the review result when present. Do not print session
cookies, tunnel API keys, or bearer token values. Do not recommend direct xAI
API keys as a fallback for subscription web mode.
