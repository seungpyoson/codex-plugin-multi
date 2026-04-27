---
description: Get Gemini CLI to adversarially challenge the current design under read-only policy.
argument-hint: "[--scope-base <ref>] [focus area]"
---

Adversarial review via Gemini CLI. Assumes the author is wrong; looks for failure modes, hidden assumptions, and missing edge cases.

## Arguments

`$ARGUMENTS` — optional `--scope-base <ref>` followed by focus text. If present, pass `--scope-base <ref>` before `--`; pass the remaining focus text after `--`.

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=adversarial-review --foreground [--scope-base <ref>] -- "<focus text>"
```
`branch-diff` is object-pure: checkout filters, replace refs, and grafts are ignored.

Render findings by severity. If `mutations` is non-empty, surface it prominently and do not auto-revert.
