---
description: Get Claude Code's read-only review of the current diff, files, or focus area. Runs in a disposable worktree (default).
argument-hint: "[--scope-base REF] [focus area]"
---

Review via Claude Code. Read-only; changes detected post-hoc, never auto-reverted.

## Arguments

`$ARGUMENTS` — optional `--scope-base REF` followed by focus text. If present, pass `--scope-base REF` before `--`; pass the remaining focus text after `--`.

## Workflow

1. Consult the `claude-prompting` skill for review-mode prompt framing and schema hints.
2. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" run --mode=review --foreground --lifecycle-events jsonl -- "<focus text>"
   ```
   (Containment + scope + dispose are all carried by the review profile — spec §21.4.)
   For a pinned review bundle or hand-picked files, first run `preflight`, then use
   `run --mode=custom-review --scope-paths <g1,g2,...>` and refer to files by
   relative paths inside the selected scope.
3. Render the returned JSON:
   - If `external_review_launched` appears, render it immediately.
   - If `external_review` is present on the terminal record, render it before the review result.
   - If `mutations` is non-empty, surface that list prominently. Do not auto-revert.
   - If target read permission denials leave no findings, report review blocked / no findings produced.
   - If `structured_output` is populated (schema runs), render its verdict + findings.
   - Otherwise render `result` as Markdown.

## Guardrails

- Do not relax `--disallowedTools` without explicit user ask.
- Do not pass `--override-dispose false`; the disposable worktree is the main containment layer and the profile handles cleanup.
- If Claude returns `is_error: true`, surface stderr verbatim.
