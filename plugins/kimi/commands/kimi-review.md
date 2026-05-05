---
description: Get Kimi Code CLI's read-only review of the current diff, files, or focus area.
argument-hint: "[--scope-base REF] [--timeout-ms MS] [--max-steps-per-turn N] [focus area]"
---

Review via Kimi Code CLI. Runs in Kimi plan mode over disposable scoped input; changes are detected post-hoc and never auto-reverted.

## Arguments

`$ARGUMENTS` — optional `--scope-base REF`, `--timeout-ms MS`, and `--max-steps-per-turn N` followed by focus text. If present, pass those flags before `--`; pass the remaining focus text after `--`.

## Workflow

Run:
```
node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=review --foreground --lifecycle-events jsonl -- "<focus text>"
```

Review timeout defaults to 600000 ms. Use `--timeout-ms <ms>` or `KIMI_REVIEW_TIMEOUT_MS`; the effective value is persisted in `review_metadata.audit_manifest.request.timeout_ms`.

For a pinned review bundle or selected files, first run `preflight`, then use
`run --mode=custom-review --scope-paths <g1,g2,...>` and refer to files by
relative paths inside the selected scope.

Render the returned JobRecord. If `external_review_launched` appears, render it immediately. If `external_review` is present on the terminal record, render it before the review result. If `mutations` is non-empty, surface it prominently and do not auto-revert. If target read permission denials leave no findings, report review blocked / no findings produced.
