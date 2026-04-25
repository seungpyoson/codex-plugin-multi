---
description: Get Claude Code's read-only review of the current diff, files, or focus area. Runs in a disposable worktree (default).
argument-hint: "[--base <ref>] [focus area]"
---

Review via Claude Code. Read-only; changes detected post-hoc, never auto-reverted.

## Arguments

`$ARGUMENTS` — optional focus area or flags. Passed as-is to the companion prompt.

## Workflow

1. Consult the `claude-prompting` skill for review-mode prompt framing and schema hints.
2. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" run --mode=review --foreground -- "$ARGUMENTS"
   ```
   (Containment + scope + dispose are all carried by the review profile — spec §21.4.)
3. Render the returned JSON:
   - If `mutations` is non-empty, surface that list prominently. Do not auto-revert.
   - If `structured_output` is populated (schema runs), render its verdict + findings.
   - Otherwise render `result` as Markdown.

## Guardrails

- Do not relax `--disallowedTools` without explicit user ask.
- Do not pass `--override-dispose false`; the disposable worktree is the main containment layer and the profile handles cleanup.
- If Claude returns `is_error: true`, surface stderr verbatim.
