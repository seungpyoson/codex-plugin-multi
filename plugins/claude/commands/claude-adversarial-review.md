---
description: Get Claude Code to adversarially challenge the current design. Not a linter — a "why will this break" pass.
argument-hint: "[--scope-base REF] [focus area]"
---

Adversarial review via Claude Code. Assumes the author is wrong; looks for failure modes, hidden assumptions, missing edge cases.

## Arguments

`$ARGUMENTS` — optional `--scope-base REF` followed by focus text (e.g., "error handling", "concurrency"). If present, pass `--scope-base REF` before `--`; pass the remaining focus text after `--`.

## Workflow

1. Consult the `claude-prompting` skill for adversarial prompt framing.
2. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" run --mode=adversarial-review --foreground -- "<focus text>"
   ```
   (Containment=worktree, scope=branch-diff, dispose=true all come from the profile — spec §21.4.)
   `branch-diff` is object-pure: checkout filters, replace refs, and grafts are ignored.
   For a pinned review bundle, run `preflight` and then use
   `run --mode=custom-review --scope-paths <g1,g2,...>` with prompt wording
   that names relative paths inside the selected bundle scope.
3. Render findings by severity. Do not downgrade Claude's concerns even if you (Codex) disagree — the job is to surface them.
4. Watch for a non-empty `mutations` list in the result and surface it. If target read permission denials leave no findings, report review blocked / no findings produced.

## Guardrails

- Adversarial mode is read-only (same sandbox layers as `/claude-review`).
- Do not fix issues here — `/claude-adversarial-review` only reviews. Fixing is `/claude-rescue`.
- No style nits. Model prompt is tuned to suppress low-value cleanup feedback.
