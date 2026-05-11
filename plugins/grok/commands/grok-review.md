---
description: Ask Grok subscription-backed web tunnel to review the current diff.
argument-hint: "[--scope-base REF] [review prompt]"
---

Run:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs run --mode review --scope branch-diff --foreground --lifecycle-events jsonl --prompt "<focus>"
```

If `$ARGUMENTS` starts with `--scope-base REF`, route `--scope-base REF` before `--prompt` and route the remaining prompt text to `--prompt`. Render the
returned JobRecord, and render `external_review_launched` as soon as it appears, then render `external_review` before the review result when
present. If the JobRecord failed, report `error_code`, `error_message`,
`http_status` when present, and `suggested_action`. Do not print session
cookies, tunnel API keys, or bearer token values.
Do not recommend direct xAI API keys as a fallback for subscription web mode.

Review timeout defaults to 900000 ms. Use `GROK_WEB_TIMEOUT_MS=<ms>` to override it; the effective value is persisted in `review_metadata.audit_manifest.request.timeout_ms`. Rendered prompts above `GROK_WEB_MAX_PROMPT_CHARS` (default 400000) fail before tunnel launch with `source_content_transmission: "not_sent"`; split or narrow the scope instead of relying on truncation. Doctor timeouts remain separate readiness checks.
