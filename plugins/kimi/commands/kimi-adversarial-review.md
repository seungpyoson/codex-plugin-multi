---
description: Get Kimi Code CLI to adversarially challenge the current design under read-only policy.
argument-hint: "[--scope-base <ref>] [focus area]"
---

Adversarial review via Kimi Code CLI. Assumes the author is wrong; looks for failure modes, hidden assumptions, and missing edge cases.

## Arguments

`$ARGUMENTS` — optional `--scope-base <ref>` followed by focus text. If present, pass `--scope-base <ref>` before `--`; pass the remaining focus text after `--`.

## Workflow

Run:
```
node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=adversarial-review --foreground [--scope-base <ref>] -- "<focus text>"
```
`branch-diff` is object-pure: checkout filters, replace refs, and grafts are ignored.
It reduces the selected review scope, but a successful run still sends those
selected source files to Kimi. If a private-repo approval reviewer denies the
run as external-provider disclosure before launch, report the workflow as
blocked before the companion could produce a JobRecord.

For a pinned review bundle, run `preflight`, then use
`run --mode=custom-review --scope-paths <g1,g2,...>` with prompt wording that
names relative paths inside the selected bundle scope.

Render findings by severity. If `mutations` is non-empty, surface it prominently and do not auto-revert. If target read permission denials leave no findings, report review blocked / no findings produced.
