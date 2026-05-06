# Canonical contracts

Source-of-truth specifications for the public contracts the reviewer plugins emit and consume. Every claim cites a file path and (where relevant) line number. This directory exists so test invariants, matrix entries, and audit checks can reference one canonical doc instead of inferring from code.

## Structure

The five reviewer plugins split into two architectures:

- **Companion plugins** (`claude`, `gemini`, `kimi`) — wrap a local CLI (`claude`, `gemini`, `kimi`) and emit a unified `JobRecord` JSON.
- **Direct plugins** (`grok`, `api-reviewers`) — different output shapes; do not use `JobRecord`.

The contracts split accordingly:

| Doc | Scope | Plugins covered |
|---|---|---|
| [`job-record.md`](./job-record.md) | The 41-field JobRecord schema, the lifecycle `status` enum, the `error_code` enum, the `external_review` sub-record, classification rules | claude, gemini, kimi |
| [`external-review.md`](./external-review.md) | The `source_content_transmission` enum + disclosure mapping that's shared across architectures | all five (where `buildExternalReview` is invoked) |
| [`lifecycle-events.md`](./lifecycle-events.md) | The two named JSON events emitted by foreground/background launch | claude, gemini, kimi |
| [`redaction.md`](./redaction.md) | Env-stripping (`sanitizeTargetEnv`) + output redaction in direct plugins | all five (different surfaces) |
| [`grok-output.md`](./grok-output.md) | grok-web-reviewer output shape and failure modes | grok |
| [`api-reviewers-output.md`](./api-reviewers-output.md) | api-reviewer output shape and failure modes (DeepSeek + GLM) | api-reviewers |

## Authoring rules

When the underlying code changes:

1. The implementation change must update both the canonical source file (e.g. `scripts/lib/external-review.mjs`) and the relevant doc here.
2. New fields, new enum values, or new failure modes get a row in the matrix.
3. Removing a field is a breaking change — bump `SCHEMA_VERSION` in `plugins/<plugin>/scripts/lib/job-record.mjs` and call out the migration in the doc.

These docs are not aspirational. If a section here doesn't reflect what the code actually does, the doc is wrong, not the code — fix the doc.
