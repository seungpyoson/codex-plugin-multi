---
description: Get Gemini CLI to adversarially challenge the current design under read-only policy.
argument-hint: "[--scope-base REF] [--timeout-ms MS] [focus area]"
---

Adversarial review via Gemini CLI. Assumes the author is wrong; looks for failure modes, hidden assumptions, and missing edge cases.

## Arguments

`$ARGUMENTS` — optional `--scope-base REF` and `--timeout-ms MS` followed by focus text. If `--scope-base REF` is present, pass `--scope-base REF` before `--`. If `--timeout-ms MS` is present, pass it before `--`. Pass the remaining focus text after `--`.

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=adversarial-review --foreground --lifecycle-events jsonl -- "<focus text>"
```
Review timeout defaults to 600000 ms. Use `--timeout-ms <ms>` or `GEMINI_REVIEW_TIMEOUT_MS`; the effective value is persisted in `review_metadata.audit_manifest.request.timeout_ms`.
`branch-diff` is object-pure and committed-only: checkout filters, replace refs,
grafts, and dirty working-tree edits are ignored. If the target changes are
uncommitted, do not use adversarial branch-diff as the review evidence; use
`run --mode=review` for working-tree scope or an explicit `custom-review` bundle
instead.
It reduces the selected review scope, but a successful run still sends those
selected source files to Gemini. If a private-repo approval reviewer denies the
run as external-provider disclosure before launch, report the workflow as
blocked before the companion could produce a JobRecord.

For a pinned review bundle, run `preflight`, then use
`run --mode=custom-review --scope-paths <g1,g2,...>` with prompt wording that
names relative paths inside the selected bundle scope.

If `external_review_launched` appears, render it immediately. If `external_review` is present on the terminal record, render it before the review result.

Render findings by severity. If `mutations` is non-empty, surface it prominently and do not auto-revert. If target read permission denials leave no findings, report review blocked / no findings produced.
