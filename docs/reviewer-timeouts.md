# Reviewer Timeouts

External review commands use an explicit review timeout contract so long-running
reviews fail in a debuggable way instead of depending on provider-specific
defaults.

## Default

The review timeout default is `600000` ms. This applies to:

- Claude companion review runs.
- Gemini companion review runs.
- Kimi companion review runs.
- DeepSeek and GLM direct API reviewer requests.
- Grok Web tunnel review requests.

Doctor and ping commands keep their own shorter readiness timeouts. Those
timeouts test local setup and tunnel health; they are not the review request
budget.

## Overrides

Use the foreground companion flag when invoking companion-backed reviewers:

```sh
node plugins/claude/scripts/claude-companion.mjs run --mode=review --foreground --timeout-ms 900000 -- "<prompt>"
node plugins/gemini/scripts/gemini-companion.mjs run --mode=review --foreground --timeout-ms 900000 -- "<prompt>"
node plugins/kimi/scripts/kimi-companion.mjs run --mode=review --foreground --timeout-ms 900000 -- "<prompt>"
```

The same flag is accepted by companion `continue --job <id>` paths.

Kimi also has an independent model step budget. If Kimi sends selected source
but returns `error_code: "step_limit_exceeded"`, increasing `--timeout-ms` is
not enough; rerun with a higher `--max-steps-per-turn <n>` or a narrower
scope. The timeout controls wall-clock runtime, while the step budget controls
how many Kimi tool/model steps the companion allows before preserving a failed
JobRecord.

For non-interactive wrappers, these environment variables set the same review
timeout:

- `CLAUDE_REVIEW_TIMEOUT_MS`
- `GEMINI_REVIEW_TIMEOUT_MS`
- `KIMI_REVIEW_TIMEOUT_MS`
- `API_REVIEWERS_TIMEOUT_MS`
- `GROK_WEB_TIMEOUT_MS`

When both are present on companion commands, `--timeout-ms` wins over the
provider-specific environment variable.

On companion `continue --job <id>` paths, timeout precedence is:

1. `--timeout-ms`
2. provider-specific review timeout environment variable
3. prior job runtime sidecar or audit-manifest timeout
4. default `600000` ms

## Audit Trail

Every completed external review JobRecord writes the effective timeout to:

```text
review_metadata.audit_manifest.request.timeout_ms
```

Timeout failures keep provider-specific classifications:

- Companion wall-clock timeout: `error_code: "timeout"`.
- Direct API provider timeout after source transmission: `error_code: "timeout"` with `external_review.source_content_transmission: "sent"`.
- Grok tunnel review timeout: `error_code: "tunnel_timeout"`.
- Grok doctor chat timeout: `error_code: "grok_chat_timeout"`.
- Kimi model step exhaustion after source transmission: `error_code: "step_limit_exceeded"`; use `--max-steps-per-turn <n>` or reduce scope.
- Ping/doctor timeouts stay on ping/doctor JSON and do not imply source was sent.

Do not silently retry, extend, truncate, shard, or mutate runtime configuration.
If a review needs a larger budget, set the timeout explicitly and rely on the
JobRecord audit manifest to confirm the effective value.
