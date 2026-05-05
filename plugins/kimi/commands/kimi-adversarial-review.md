---
description: Get Kimi Code CLI to adversarially challenge the current design under read-only policy.
argument-hint: "[--scope-base REF] [--max-steps-per-turn N] [focus area]"
---

Adversarial review via Kimi Code CLI. Assumes the author is wrong; looks for failure modes, hidden assumptions, and missing edge cases.

## Arguments

`$ARGUMENTS` — optional `--scope-base REF` and `--max-steps-per-turn N` followed by focus text. If present, pass those flags before `--`; pass the remaining focus text after `--`.

## Workflow

Run:
```
node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=adversarial-review --foreground --lifecycle-events jsonl -- "<focus text>"
```
`branch-diff` is object-pure: checkout filters, replace refs, and grafts are ignored.
It reduces the selected review scope, but a successful run still sends those
selected source files to Kimi. If a private-repo approval reviewer denies the
run as external-provider disclosure before launch, report the workflow as
blocked before the companion could produce a JobRecord.

For a pinned review bundle, run `preflight`, then use
`run --mode=custom-review --scope-paths <g1,g2,...>` with prompt wording that
names relative paths inside the selected bundle scope.

If `external_review_launched` appears, render it immediately. If `external_review` is present on the terminal record, render it before the review result.

Render findings by severity. If `mutations` is non-empty, surface it prominently and do not auto-revert. If target read permission denials leave no findings, report review blocked / no findings produced.
