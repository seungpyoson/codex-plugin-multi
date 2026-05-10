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
Replace `<file1>,<file2>` with comma- or newline-separated concrete relative paths; expand globs before running. Render the returned JobRecord, and render `external_review_launched` as soon as it appears, then render `external_review` before the review result when present. If the JobRecord failed, report `error_code`, `error_message`, `http_status` when present, and `suggested_action`. Do not print session
cookies, tunnel API keys, or bearer token values. Do not recommend direct xAI
API keys as a fallback for subscription web mode.

Review timeout defaults to 900000 ms. Use `GROK_WEB_TIMEOUT_MS=<ms>` to override it; the effective value is persisted in `review_metadata.audit_manifest.request.timeout_ms`. Rendered prompts above `GROK_WEB_MAX_PROMPT_CHARS` (default 400000) fail before tunnel launch with `source_content_transmission: "not_sent"`; split or narrow the scope instead of relying on truncation. Doctor timeouts remain separate readiness checks.
