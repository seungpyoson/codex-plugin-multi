---
name: gemini-adversarial-review
description: Use when asking Gemini CLI to challenge a design or diff adversarially.
user-invocable: true
---

# Gemini Adversarial Review

Use the Gemini companion adversarial-review workflow. Current Codex builds expose it as `gemini:gemini-adversarial-review` in the skill picker; its skill frontmatter name is `gemini-adversarial-review`; the command contract is `plugins/gemini/commands/gemini-adversarial-review.md`.

`<plugin-root>` is `plugins/gemini` or an absolute path to that plugin directory; `<workspace>` is the repository or bundle directory to review; `<focus>` is the user's review prompt or focus area. Run:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=adversarial-review --foreground --lifecycle-events jsonl --cwd "<workspace>" -- "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--`.

Render findings by severity, render `external_review_launched` as soon as it appears, then render `external_review` before normal prose when present, and surface any `mutations`. Do not claim `/gemini-adversarial-review` is available in Codex builds that do not register plugin command files.
