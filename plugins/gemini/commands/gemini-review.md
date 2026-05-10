---
description: Get Gemini CLI's read-only review of the current diff, files, or focus area. Runs with TOML policy enforcement.
argument-hint: "[--scope-base REF] [--timeout-ms MS] [focus area]"
---

Review via Gemini CLI. Read-only policy is mandatory; changes detected post-hoc, never auto-reverted.

## Arguments

`$ARGUMENTS` — optional `--scope-base REF` and `--timeout-ms MS` followed by focus text. If `--scope-base REF` is present, pass `--scope-base REF` before `--`. If `--timeout-ms MS` is present, pass it before `--`. Pass the remaining focus text after `--`.

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=review --foreground --lifecycle-events jsonl -- "<focus text>"
```

Review timeout defaults to 900000 ms. Use `--timeout-ms <ms>` or `GEMINI_REVIEW_TIMEOUT_MS`; the effective value is persisted in `review_metadata.audit_manifest.request.timeout_ms`.

For a pinned review bundle or selected files, first run `preflight`, then use
`run --mode=custom-review --scope-paths <g1,g2,...>` and refer to files by
relative paths inside the selected scope.

Render the returned JobRecord. If `external_review_launched` appears, render it immediately. If `external_review` is present on the terminal record, render it before the review result. If `mutations` is non-empty, surface it prominently and do not auto-revert. If target read permission denials leave no findings, report review blocked / no findings produced.
