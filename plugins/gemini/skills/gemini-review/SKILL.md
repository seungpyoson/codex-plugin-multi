---
name: gemini-review
description: Use when asking Gemini CLI to review the current diff, files, or focus area.
user-invocable: true
---

# Gemini Review

Use the Gemini companion review workflow. Current Codex builds expose it as `gemini:gemini-review` in the skill picker; its skill frontmatter name is `gemini-review`; the command contract is `plugins/gemini/commands/gemini-review.md`.

`<plugin-root>` is `plugins/gemini` or an absolute path to that plugin directory; `<workspace>` is the repository or bundle directory to review; `<focus>` is the user's review prompt or focus area. Run:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=review --foreground --lifecycle-events jsonl --cwd "<workspace>" -- "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--`.

Render the returned JobRecord, render `external_review_launched` as soon as it appears, then render `external_review` before normal prose when present, and surface `mutations`. Do not claim `/gemini-review` is available in Codex builds that do not register plugin command files.
