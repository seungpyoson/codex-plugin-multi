---
description: Get Gemini CLI to adversarially challenge the current design under read-only policy.
argument-hint: "[--base <ref>] [focus area]"
---

Adversarial review via Gemini CLI. Assumes the author is wrong; looks for failure modes, hidden assumptions, and missing edge cases.

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=adversarial-review --foreground -- "$ARGUMENTS"
```

Render findings by severity. If `mutations` is non-empty, surface it prominently and do not auto-revert.
