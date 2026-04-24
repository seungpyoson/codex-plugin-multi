---
description: Get Claude Code's read-only review of the current diff, files, or focus area. Runs in a disposable worktree (default).
argument-hint: "[--base <ref>] [focus area]"
---

Review via Claude Code. Read-only; changes detected post-hoc, never auto-reverted.

## Arguments

`$ARGUMENTS` — optional focus area or flags. Passed as-is to the companion prompt.

## Workflow

1. Consult the `claude-prompting` skill (if present) for model-tier selection.
2. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" run --mode=review --foreground --isolated --dispose -- "$ARGUMENTS"
   ```
3. Render the returned JSON:
   - If `warning: "mutation_detected"` appears, surface the `mutated_files` list prominently. Do not auto-revert.
   - If `structured_output` is populated (schema runs), render its verdict + findings.
   - Otherwise render `result` as Markdown.

## Guardrails

- Do not relax `--disallowedTools` without explicit user ask.
- Do not disable `--dispose`; the disposable worktree is the main containment layer.
- If Claude returns `is_error: true`, surface stderr verbatim.
