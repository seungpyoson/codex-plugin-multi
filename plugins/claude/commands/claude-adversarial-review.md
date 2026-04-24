---
description: Get Claude Code to adversarially challenge the current design. Not a linter — a "why will this break" pass.
argument-hint: "[--base <ref>] [focus area]"
---

Adversarial review via Claude Code. Assumes the author is wrong; looks for failure modes, hidden assumptions, missing edge cases.

## Arguments

`$ARGUMENTS` — optional focus area (e.g., "error handling", "concurrency"). Passed as-is.

## Workflow

1. Consult the `claude-prompting` skill for adversarial prompt framing.
2. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" run --mode=adversarial-review --foreground --isolated --dispose -- "$ARGUMENTS"
   ```
3. Render findings by severity. Do not downgrade Claude's concerns even if you (Codex) disagree — the job is to surface them.
4. Watch for `warning: "mutation_detected"` in the result and surface any `mutated_files` list.

## Guardrails

- Adversarial mode is read-only (same sandbox layers as `/claude-review`).
- Do not fix issues here — `/claude-adversarial-review` only reviews. Fixing is `/claude-rescue`.
- No style nits. Model prompt is tuned to suppress low-value cleanup feedback.
