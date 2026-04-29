---
description: Get Gemini CLI's read-only review of the current diff, files, or focus area. Runs with TOML policy enforcement.
argument-hint: "[--scope-base <ref>] [focus area]"
---

Review via Gemini CLI. Read-only policy is mandatory; changes detected post-hoc, never auto-reverted.

## Arguments

`$ARGUMENTS` — optional `--scope-base <ref>` followed by focus text. If present, pass `--scope-base <ref>` before `--`; pass the remaining focus text after `--`.

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=review --foreground [--scope-base <ref>] -- "<focus text>"
```

For a pinned review bundle or selected files, first run `preflight`, then use
`run --mode=custom-review --scope-paths <g1,g2,...>` and refer to files by
relative paths inside the selected scope.

Render the returned JobRecord. If `mutations` is non-empty, surface it prominently and do not auto-revert. If target read permission denials leave no findings, report review blocked / no findings produced.
